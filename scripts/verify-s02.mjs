#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S02.json");
const receiptRelativePath = "artifacts/s02/completion-receipt.json";
const matrixRelativePath = "artifacts/s02/state-transition-matrix.json";
const crashReportRelativePath = "artifacts/s02/crash-recovery-report.json";
const goldenRelativePath = "test/fixtures/state/event-log.golden.json";
const maximumOutputBytes = 32 * 1024 * 1024;

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(relativePath, payload) {
  const target = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function resolveEnvironment(allowlist) {
  const environment = {};
  for (const requestedName of allowlist) {
    const actualName = Object.keys(process.env).find(
      (candidate) => candidate.toLocaleLowerCase("en-US") === requestedName.toLocaleLowerCase("en-US"),
    );
    if (actualName !== undefined && process.env[actualName] !== undefined) {
      environment[actualName] = process.env[actualName];
    }
  }
  return environment;
}

function resolveExecutable(command, args) {
  if (command === "npm") {
    const npmCandidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    const npmCli = npmCandidates.find((candidate) => existsSync(candidate));
    if (npmCli !== undefined) {
      return { command: process.execPath, args: [npmCli, ...args] };
    }
    throw new Error("npm-cli.js could not be located without invoking a command shell.");
  }
  return { command, args };
}

function runCommand(argv, options = {}) {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new Error("Cannot run an empty argv array.");
  }
  const executable = resolveExecutable(command, args);
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(executable.command, executable.args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const stdout = result.stdout ?? "";
  const errorText = result.error === undefined ? "" : `${result.error.name}: ${result.error.message}\n`;
  const stderr = `${result.stderr ?? ""}${errorText}`;
  const exitCode = result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1);
  return { argv, durationMs, exitCode, stderr, stdout };
}

function runGit(args) {
  const result = runCommand(["git", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseNullSeparated(value) {
  return value.split("\0").filter((entry) => entry.length > 0).map(normalizeRepoPath);
}

function collectTouchedPaths(baseRevision) {
  const tracked = parseNullSeparated(runGit(["diff", "--name-only", "-z", baseRevision, "--"]));
  const untracked = parseNullSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function isS02OwnedPath(relativePath) {
  const exactPaths = new Set([
    "contracts/slices/S02.json",
    "docs/adr/0005-directory-event-store.md",
    "docs/架构.md",
    "docs/代码链路.md",
    "package.json",
    "scripts/replay-run-events.mjs",
    "scripts/verify-s02-replay.mjs",
    "scripts/verify-s02.mjs",
    "test/helpers/cas-worker.ts",
    "test/run-store.test.ts",
  ]);
  const prefixes = ["artifacts/s02/", "src/controller/state/", "test/fixtures/state/"];
  return exactPaths.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S02" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S01"])
  ) {
    throw new Error("contracts/slices/S02.json is not the expected SliceSpec v1 requiring S01.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S02 SliceSpec must contain inputs and checks arrays.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S02 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S02 input digest changed for ${input.path}.`);
    }
  }
  const s01Receipt = parseJsonFile(path.join(repoRoot, "artifacts", "s01", "completion-receipt.json"));
  if (
    s01Receipt?.slice_id !== "S01" ||
    !Array.isArray(s01Receipt.check_receipts) ||
    s01Receipt.check_receipts.some((receipt) => receipt.exit_code !== 0)
  ) {
    throw new Error("S01 CompletionReceipt does not prove that the required slice completed.");
  }
}

function runChecks(sliceSpec) {
  const receipts = [];
  let failed = false;
  for (const check of sliceSpec.checks) {
    if (
      typeof check?.id !== "string" ||
      !Array.isArray(check.argv) ||
      check.argv.some((entry) => typeof entry !== "string") ||
      typeof check.cwd !== "string" ||
      typeof check.timeout_ms !== "number" ||
      !Array.isArray(check.env_allowlist) ||
      typeof check.expected_exit_code !== "number"
    ) {
      throw new Error("S02 contains an invalid CheckSpec.");
    }
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const missingArtifacts = (check.expected_artifacts ?? []).filter(
      (artifact) => typeof artifact !== "string" || !existsSync(path.join(repoRoot, artifact)),
    );
    if (result.exitCode !== check.expected_exit_code || missingArtifacts.length > 0) {
      failed = true;
      if (missingArtifacts.length > 0) {
        process.stderr.write(`Check ${check.id} is missing artifacts: ${missingArtifacts.join(", ")}\n`);
      }
    }
    receipts.push({
      check_id: check.id,
      argv: check.argv,
      exit_code: result.exitCode,
      stdout_digest: sha256Bytes(Buffer.from(result.stdout, "utf8")),
      stderr_digest: sha256Bytes(Buffer.from(result.stderr, "utf8")),
      duration_ms: Math.round(result.durationMs),
    });
  }
  if (failed) {
    throw new Error("One or more S02 deterministic checks failed.");
  }
  return receipts;
}

function unwrap(result, StateStoreError) {
  if (result instanceof StateStoreError) {
    throw result;
  }
  return result;
}

function expectCode(result, StateStoreError, expectedCode) {
  if (!(result instanceof StateStoreError) || result.code !== expectedCode) {
    throw new Error(`Expected ${expectedCode}, received ${result?.code ?? "success"}.`);
  }
  return result.code;
}

async function buildEvidence() {
  const stateModule = await import("../dist/src/controller/state/index.js");
  const {
    buildRunTransitionMatrix,
    createEffectIdempotencyKey,
    createInitialRunState,
    FileRunStore,
    RUN_STATUSES,
    sha256Bytes: stateDigest,
    StateStoreError,
  } = stateModule;
  const matrix = buildRunTransitionMatrix();
  const matrixEvidence = {
    schema_version: 1,
    slice_id: "S02",
    statuses: RUN_STATUSES,
    allowed_count: matrix.filter((entry) => entry.allowed).length,
    denied_count: matrix.filter((entry) => !entry.allowed).length,
    matrix,
  };

  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s02-evidence-"));
  const createState = (runId) => createInitialRunState({
    run_id: runId,
    workspace_identity: {
      canonical_root: "E:\\workspace\\fixture",
      filesystem_identity: "win32:sha256:fixture",
    },
    plan_digest: stateDigest("plan"),
    commit_mode: "after_slice",
    current_slice_id: "S02",
    protected_baseline_digest: stateDigest("baseline"),
  });
  try {
    const base = unwrap(FileRunStore.open(storageRoot), StateStoreError);
    unwrap(base.create(createState("event-crash")), StateStoreError);
    const eventCrash = unwrap(FileRunStore.open(storageRoot, {
      faultInjector: (point) => {
        if (point === "after_run_event_persisted") {
          throw new Error("injected run-event crash");
        }
      },
    }), StateStoreError);
    const eventFailureCode = expectCode(
      eventCrash.compareAndSwap("event-crash", 0, { action: "prepare", to: "PREPARING" }),
      StateStoreError,
      "state_persist_failed",
    );
    const eventRecovered = unwrap(
      unwrap(FileRunStore.open(storageRoot), StateStoreError).load("event-crash"),
      StateStoreError,
    );

    unwrap(base.create(createState("intent-crash")), StateStoreError);
    const intentKey = createEffectIdempotencyKey("intent-crash", 0, "create_task", "task-1");
    const intentCrash = unwrap(FileRunStore.open(storageRoot, {
      faultInjector: (point) => {
        if (point === "after_effect_intent_persisted") {
          throw new Error("injected intent crash");
        }
      },
    }), StateStoreError);
    const intentFailureCode = expectCode(
      intentCrash.appendEffectIntent(intentKey, stateDigest("payload")),
      StateStoreError,
      "state_persist_failed",
    );
    const incomplete = unwrap(
      unwrap(FileRunStore.open(storageRoot), StateStoreError).recoverIncompleteEffects("intent-crash"),
      StateStoreError,
    );

    unwrap(base.create(createState("completion-crash")), StateStoreError);
    const completionKey = createEffectIdempotencyKey(
      "completion-crash",
      0,
      "interrupt_source",
      "thread-1",
    );
    const completionPayloadDigest = stateDigest("payload");
    unwrap(base.appendEffectIntent(completionKey, completionPayloadDigest), StateStoreError);
    const completionCrash = unwrap(FileRunStore.open(storageRoot, {
      faultInjector: (point) => {
        if (point === "after_effect_completion_persisted") {
          throw new Error("injected completion crash");
        }
      },
    }), StateStoreError);
    const completionFailureCode = expectCode(
      completionCrash.completeEffect(completionKey, stateDigest("receipt")),
      StateStoreError,
      "state_persist_failed",
    );
    const recoveredCompletionStore = unwrap(FileRunStore.open(storageRoot), StateStoreError);
    const remaining = unwrap(
      recoveredCompletionStore.recoverIncompleteEffects("completion-crash"),
      StateStoreError,
    );
    const completed = unwrap(
      recoveredCompletionStore.appendEffectIntent(completionKey, completionPayloadDigest),
      StateStoreError,
    );
    const unchangedSnapshot = unwrap(
      recoveredCompletionStore.load("completion-crash"),
      StateStoreError,
    );

    const crashEvidence = {
      schema_version: 1,
      slice_id: "S02",
      scenarios: [
        {
          id: "event_persisted_snapshot_stale",
          injected_at: "after_run_event_persisted",
          operation_result: eventFailureCode,
          recovered_state_version: eventRecovered.state.state_version,
          recovered_status: eventRecovered.state.status,
          recovered_from_event_log: eventRecovered.recovered_from_event_log,
          result: "PASS",
        },
        {
          id: "effect_intent_without_receipt",
          injected_at: "after_effect_intent_persisted",
          operation_result: intentFailureCode,
          recovered_incomplete_count: incomplete.length,
          recovered_effect_status: incomplete[0]?.status,
          result: "PASS",
        },
        {
          id: "effect_receipt_before_run_snapshot_update",
          injected_at: "after_effect_completion_persisted",
          operation_result: completionFailureCode,
          snapshot_state_version: unchangedSnapshot.state.state_version,
          recovered_incomplete_count: remaining.length,
          recovered_effect_status: completed.status,
          result: "PASS",
        },
      ],
      golden_fixture: {
        path: goldenRelativePath,
        digest: sha256File(path.join(repoRoot, goldenRelativePath)),
      },
    };
    if (
      eventRecovered.state.state_version !== 1 ||
      eventRecovered.state.status !== "PREPARING" ||
      eventRecovered.recovered_from_event_log !== true ||
      incomplete.length !== 1 ||
      incomplete[0]?.status !== "INTENDED" ||
      remaining.length !== 0 ||
      completed.status !== "COMPLETED" ||
      completed.receipt_digest !== stateDigest("receipt") ||
      unchangedSnapshot.state.state_version !== 0
    ) {
      throw new Error("Crash evidence did not satisfy the S02 recovery contract.");
    }
    return { matrixEvidence, crashEvidence };
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S02 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S02 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyCommittedEvidence(sliceSpec, checkReceipts, evidence) {
  assertEvidenceMatches(matrixRelativePath, evidence.matrixEvidence);
  assertEvidenceMatches(crashReportRelativePath, evidence.crashEvidence);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S02" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The committed S02 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const committedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(committedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The committed S02 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`Committed S02 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The committed S02 owned diff digest is invalid.");
  }
  const dirtyS02Paths = collectTouchedPaths("HEAD").filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && isS02OwnedPath(entry),
  );
  if (dirtyS02Paths.length > 0) {
    throw new Error(`S02-owned paths changed after its receipt was committed: ${dirtyS02Paths.join(", ")}`);
  }
  process.stdout.write(`S02 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

async function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const checkReceipts = runChecks(sliceSpec);
  const evidence = await buildEvidence();
  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyCommittedEvidence(sliceSpec, checkReceipts, evidence);
    return;
  }

  writeJsonAtomic(matrixRelativePath, evidence.matrixEvidence);
  writeJsonAtomic(crashReportRelativePath, evidence.crashEvidence);
  validateExpectedArtifacts(sliceSpec, false);
  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths(startHead).filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && entry !== receiptRelativePath,
  );
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS02OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S02 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
  }
  const outputDigests = touchedBeforeReceipt
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S02",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((input) => ({ path: input.path, digest: input.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    check_receipts: checkReceipts,
    start_head: startHead,
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  validateExpectedArtifacts(sliceSpec);
  process.stdout.write(`S02 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
