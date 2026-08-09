#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S10.json");
const receiptRelativePath = "artifacts/s10/completion-receipt.json";
const traceRelativePath = "artifacts/s10/continuation-trace.json";
const leaseLogRelativePath = "artifacts/s10/lease-rotation-log.json";
const progressRelativePath = "artifacts/s10/progress-receipt.json";
const failureMatrixRelativePath = "artifacts/s10/failure-closure-matrix.json";
const maximumOutputBytes = 32 * 1024 * 1024;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/u;

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
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    const npmCli = candidates.find((candidate) => existsSync(candidate));
    if (npmCli !== undefined) {
      return { command: process.execPath, args: [npmCli, ...args] };
    }
    throw new Error("npm-cli.js could not be located without invoking a command shell.");
  }
  return { command, args };
}

function runCommand(argv, options = {}) {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("Cannot run an empty argv array.");
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

function runGitBuffer(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: maximumOutputBytes,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error !== undefined) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
    throw new Error(`git ${args.join(" ")} failed: ${stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function sha256IndexFile(relativePath) {
  return sha256Bytes(runGitBuffer(["show", `:${relativePath}`]));
}

function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean).map(normalizeRepoPath);
}

function collectTouchedPathsAgainstIndex() {
  const tracked = parseNullSeparated(runGit(["diff", "--name-only", "-z", "--"]));
  const untracked = parseNullSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function collectStagedPaths() {
  return parseNullSeparated(runGit(["diff", "--cached", "--name-only", "-z", "--"])).sort();
}

function isProtectedBaselinePath(relativePath) {
  return relativePath === "SESSION_CHECKPOINT.md" ||
    /^handoff-[^/]+(?:\.md|\.evidence\.json)$/u.test(relativePath);
}

function isS10OwnedPath(relativePath) {
  const exactPaths = new Set([
    "contracts/slices/S10.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/verify-s10-evidence.mjs",
    "scripts/verify-s10.mjs",
    "test/continuation.test.ts",
  ]);
  const prefixes = ["artifacts/s10/", "src/controller/continuation/"];
  return exactPaths.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateS09IndexBoundary() {
  const receipt = parseJsonFile(path.join(repoRoot, "artifacts/s09/completion-receipt.json"));
  if (receipt?.slice_id !== "S09" || !Array.isArray(receipt.touched_paths)) {
    throw new Error("S09 CompletionReceipt does not expose its selective boundary.");
  }
  const staged = collectStagedPaths();
  if (staged.length > 0 && !sameStringSet(staged, receipt.touched_paths)) {
    throw new Error("The index is neither clean nor the exact verified S09 selective boundary.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      sha256IndexFile(output.path) !== output.digest
    ) {
      throw new Error(`S09 index prerequisite changed: ${String(output?.path)}.`);
    }
  }
  return staged;
}

function validatePrerequisiteReceipt(sliceId, relativePath) {
  const receipt = parseJsonFile(path.join(repoRoot, relativePath));
  if (
    receipt?.slice_id !== sliceId ||
    !Array.isArray(receipt.check_receipts) ||
    receipt.check_receipts.some((entry) => entry.exit_code !== 0) ||
    !Array.isArray(receipt.output_digests)
  ) {
    throw new Error(`${sliceId} CompletionReceipt does not prove the prerequisite completed.`);
  }
  if (sliceId === "S09") return;
  for (const output of receipt.output_digests) {
    if (typeof output?.path === "string" && isS10OwnedPath(output.path)) continue;
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`Required ${sliceId} output changed: ${String(output?.path)}.`);
    }
  }
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S10" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S03", "S04", "S09"])
  ) {
    throw new Error("contracts/slices/S10.json is not SliceSpec v1 requiring S03/S04/S09.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S10 SliceSpec must contain inputs and checks arrays.");
  }
  for (const failureCode of [
    "continuation_start_failed",
    "handoff_integrity_failed",
    "model_policy_unavailable",
  ]) {
    if (!sliceSpec.failure_codes?.includes(failureCode)) {
      throw new Error(`S10 must freeze ${failureCode}.`);
    }
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S10 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S10 input digest changed for ${input.path}.`);
    }
  }
  validatePrerequisiteReceipt("S03", "artifacts/s03/completion-receipt.json");
  validatePrerequisiteReceipt("S04", "artifacts/s04/completion-receipt.json");
  validatePrerequisiteReceipt("S09", "artifacts/s09/completion-receipt.json");
  const expectedChecks = ["build", "typecheck", "test", "s10_evidence", "lint"];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S10 deterministic check order changed.");
  }
}

function runChecks(sliceSpec) {
  const receipts = [];
  const outputs = new Map();
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
      throw new Error("S10 contains an invalid CheckSpec.");
    }
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    if (check.id !== "s10_evidence") process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    outputs.set(check.id, result.stdout);
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
  if (failed) throw new Error("One or more S10 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const serialized = outputs.get("s10_evidence");
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("The s10_evidence check produced no JSON evidence.");
  }
  const evidence = JSON.parse(serialized);
  const trace = evidence?.continuation_trace;
  const lease = evidence?.lease_rotation_log;
  const progress = evidence?.progress_receipt;
  const matrix = evidence?.failure_closure_matrix;
  if (
    trace?.result !== "PASS" ||
    lease?.result !== "PASS" ||
    matrix?.result !== "PASS" ||
    trace.uuid_distinct !== true ||
    trace.run_id_preserved !== true ||
    trace.slice_id_preserved !== true ||
    trace.owned_diff_digest_preserved !== true ||
    trace.ready_before_grant !== true ||
    trace.pre_ready_write_allowed !== false ||
    trace.persisted_rollout_verified !== true ||
    trace.first_draft_before_evidence !== true ||
    trace.broad_search_count !== 0 ||
    trace.full_file_reread_count !== 0 ||
    trace.final_status !== "SLICE_RUNNING" ||
    trace.source_replaced !== true ||
    trace.compaction_gate_cleared !== true ||
    lease.old_epoch_rejected !== true ||
    lease.granted_epoch_active !== true ||
    typeof progress?.durable_artifact_digest !== "string" ||
    matrix.scenarios?.some((entry) => (
      entry.final_status !== "NEEDS_USER" ||
      entry.source_thread_preserved !== true ||
      entry.handoff_preserved !== true ||
      entry.old_epoch_rejected !== true ||
      entry.automatic_retry_allowed !== false
    ))
  ) {
    throw new Error("The s10_evidence check returned invalid or failing evidence.");
  }
  const preGrantFailures = matrix.scenarios.filter((entry) =>
    ["ready_failure", "handoff_not_read", "handoff_swap", "workspace_mismatch", "broad_search"].includes(entry.scenario)
  );
  if (preGrantFailures.some((entry) => entry.grant_invocations !== 0)) {
    throw new Error("S10 evidence granted write after a pre-grant integrity failure.");
  }
  return evidence;
}

function normalizeContinuationTraceForComparison(value, relativePath) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.rollout_events) ||
    typeof value.rollout_digest !== "string" ||
    !sha256DigestPattern.test(value.rollout_digest)
  ) {
    throw new Error(`${relativePath} does not contain a valid persisted rollout.`);
  }
  const handoffReads = value.rollout_events.filter((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.type === "HANDOFF_READ"
  );
  if (
    handoffReads.length !== 1 ||
    typeof handoffReads[0].artifact_digest !== "string" ||
    !sha256DigestPattern.test(handoffReads[0].artifact_digest)
  ) {
    throw new Error(`${relativePath} does not bind exactly one Handoff artifact digest.`);
  }
  const rolloutBytes = Buffer.from(
    `${value.rollout_events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  if (sha256Bytes(rolloutBytes) !== value.rollout_digest) {
    throw new Error(`${relativePath} rollout_digest does not match rollout_events.`);
  }

  // The real Handoff digest binds absolute fixture paths, so only these two
  // derived fields vary between otherwise identical, isolated evidence runs.
  return {
    ...value,
    rollout_digest: "<validated-ephemeral-rollout-digest>",
    rollout_events: value.rollout_events.map((entry) => (
      entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.type === "HANDOFF_READ"
        ? { ...entry, artifact_digest: "<validated-ephemeral-handoff-digest>" }
        : entry
    )),
  };
}

function assertEvidenceMatches(relativePath, expected, normalize = (value) => value) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (
    JSON.stringify(normalize(actual, relativePath)) !==
    JSON.stringify(normalize(expected, "fresh S10 evidence"))
  ) {
    throw new Error(`${relativePath} no longer matches deterministic S10 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S10 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyExistingEvidence(sliceSpec, checkReceipts, evidence, baselineIndexTree) {
  assertEvidenceMatches(
    traceRelativePath,
    evidence.continuation_trace,
    normalizeContinuationTraceForComparison,
  );
  assertEvidenceMatches(leaseLogRelativePath, evidence.lease_rotation_log);
  assertEvidenceMatches(progressRelativePath, evidence.progress_receipt);
  assertEvidenceMatches(failureMatrixRelativePath, evidence.failure_closure_matrix);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S10" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    receipt.baseline_index_tree !== baselineIndexTree ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The S10 CompletionReceipt is inconsistent with its SliceSpec or index baseline.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const recordedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(recordedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The S10 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S10 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The S10 owned diff digest is invalid.");
  }
  const touched = collectTouchedPathsAgainstIndex().filter((entry) => !isProtectedBaselinePath(entry));
  const unowned = touched.filter((entry) => !isS10OwnedPath(entry));
  if (unowned.length > 0) {
    throw new Error(`S10 worktree contains unowned changes: ${unowned.join(", ")}`);
  }
  if (touched.length > 0 && !sameStringSet(touched, receipt.touched_paths)) {
    throw new Error("Current S10 worktree paths differ from CompletionReceipt.touched_paths.");
  }
  process.stdout.write(`S10 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

async function main() {
  const stagedPrerequisitePaths = validateS09IndexBoundary();
  const baselineIndexTree = runGit(["write-tree"]).trim();
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const evidence = parseEvidence(outputs);
  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, evidence, baselineIndexTree);
    return;
  }

  writeJsonAtomic(traceRelativePath, evidence.continuation_trace);
  writeJsonAtomic(leaseLogRelativePath, evidence.lease_rotation_log);
  writeJsonAtomic(progressRelativePath, evidence.progress_receipt);
  writeJsonAtomic(failureMatrixRelativePath, evidence.failure_closure_matrix);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPathsAgainstIndex().filter(
    (entry) => entry !== receiptRelativePath && !isProtectedBaselinePath(entry),
  );
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS10OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S10 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
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
    slice_id: "S10",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((entry) => ({ path: entry.path, digest: entry.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    check_receipts: receipts,
    start_head: startHead,
    baseline_index_tree: baselineIndexTree,
    baseline_staged_paths: stagedPrerequisitePaths,
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  validateExpectedArtifacts(sliceSpec);
  process.stdout.write(`S10 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
