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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S09.json");
const receiptRelativePath = "artifacts/s09/completion-receipt.json";
const compressionReportRelativePath = "artifacts/s09/compression-task-report.json";
const failureMatrixRelativePath = "artifacts/s09/failure-closure-matrix.json";
const handoffRelativePath = "artifacts/s09/verified-test-handoff.md";
const evidenceIndexRelativePath = "artifacts/s09/verified-test-handoff.evidence.json";
const maximumOutputBytes = 32 * 1024 * 1024;
const protectedBaselinePaths = new Set([
  "SESSION_CHECKPOINT.md",
  "handoff-019fe43b-eef7-7923-8fce-c9a739134c57.evidence.json",
  "handoff-019fe43b-eef7-7923-8fce-c9a739134c57.md",
  "handoff-019fe4d8-cc5a-7210-a572-e0d594452746.evidence.json",
  "handoff-019fe4d8-cc5a-7210-a572-e0d594452746.md",
]);

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

function parseNullSeparated(value) {
  return value.split("\0").filter(Boolean).map(normalizeRepoPath);
}

function collectTouchedPaths(baseRevision) {
  const tracked = parseNullSeparated(runGit(["diff", "--name-only", "-z", baseRevision, "--"]));
  const untracked = parseNullSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function isS09OwnedPath(relativePath) {
  const exactPaths = new Set([
    "contracts/slices/S09.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/verify-s09-evidence.mjs",
    "scripts/verify-s09.mjs",
    "src/controller/state/file-run-store.ts",
    "src/controller/state/transitions.ts",
    "test/handoff.test.ts",
    "test/run-store.test.ts",
  ]);
  const prefixes = ["artifacts/s09/", "src/controller/handoff/", "test/fixtures/handoff/"];
  return exactPaths.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
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
  for (const output of receipt.output_digests) {
    if (typeof output?.path === "string" && isS09OwnedPath(output.path)) continue;
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
    sliceSpec?.id !== "S09" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S02", "S04", "S08"])
  ) {
    throw new Error("contracts/slices/S09.json is not SliceSpec v1 requiring S02/S04/S08.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S09 SliceSpec must contain inputs and checks arrays.");
  }
  if (
    !sliceSpec.failure_codes?.includes("handoff_export_failed") ||
    !sliceSpec.failure_codes?.includes("handoff_integrity_failed")
  ) {
    throw new Error("S09 must freeze both Handoff failure closures.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S09 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S09 input digest changed for ${input.path}.`);
    }
  }
  validatePrerequisiteReceipt("S02", "artifacts/s02/completion-receipt.json");
  validatePrerequisiteReceipt("S04", "artifacts/s04/completion-receipt.json");
  validatePrerequisiteReceipt("S08", "artifacts/s08/completion-receipt.json");
  const expectedChecks = ["build", "typecheck", "test", "s09_evidence", "lint"];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S09 deterministic check order changed.");
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
      throw new Error("S09 contains an invalid CheckSpec.");
    }
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    if (check.id !== "s09_evidence") process.stdout.write(result.stdout);
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
  if (failed) throw new Error("One or more S09 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const serialized = outputs.get("s09_evidence");
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("The s09_evidence check produced no JSON evidence.");
  }
  const evidence = JSON.parse(serialized);
  const report = evidence?.compression_task_report;
  const matrix = evidence?.failure_closure_matrix;
  if (
    report?.result !== "PASS" ||
    matrix?.result !== "PASS" ||
    report.uuid_distinct !== true ||
    report.workspace_identity_equal !== true ||
    report.history_empty !== true ||
    report.project_write_lease !== false ||
    report.model !== "gpt-5.6-sol" ||
    report.reasoning_effort !== "medium" ||
    report.workflow_version !== "v2" ||
    report.verify_evidence !== "PASS" ||
    report.map_worker_processes !== report.initial_maps ||
    matrix.scenarios?.some((entry) => (
      entry.final_status !== "NEEDS_USER" ||
      entry.automatic_retry_allowed !== false ||
      entry.continuation_started !== false
    ))
  ) {
    throw new Error("The s09_evidence check returned invalid or failing evidence.");
  }
  const published = evidence.published_artifacts;
  if (
    published?.handoff_digest !== sha256File(path.join(repoRoot, handoffRelativePath)) ||
    published?.evidence_index_digest !== sha256File(path.join(repoRoot, evidenceIndexRelativePath))
  ) {
    throw new Error("The S09 Handoff pair differs from the helper verification receipt.");
  }
  return evidence;
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S09 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S09 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyCommittedEvidence(sliceSpec, checkReceipts, evidence) {
  assertEvidenceMatches(compressionReportRelativePath, evidence.compression_task_report);
  assertEvidenceMatches(failureMatrixRelativePath, evidence.failure_closure_matrix);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S09" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The committed S09 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const committedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(committedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The committed S09 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`Committed S09 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The committed S09 owned diff digest is invalid.");
  }
  const dirtyOwnedPaths = collectTouchedPaths("HEAD").filter(isS09OwnedPath);
  if (dirtyOwnedPaths.length > 0) {
    throw new Error(`S09-owned paths changed after commit: ${dirtyOwnedPaths.join(", ")}`);
  }
  process.stdout.write(`S09 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

async function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const evidence = parseEvidence(outputs);
  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyCommittedEvidence(sliceSpec, receipts, evidence);
    return;
  }

  assertEvidenceMatches(compressionReportRelativePath, evidence.compression_task_report);
  assertEvidenceMatches(failureMatrixRelativePath, evidence.failure_closure_matrix);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths(startHead).filter(
    (entry) => entry !== receiptRelativePath && !protectedBaselinePaths.has(entry),
  );
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS09OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S09 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
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
    slice_id: "S09",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((input) => ({ path: input.path, digest: input.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    check_receipts: receipts,
    start_head: startHead,
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  validateExpectedArtifacts(sliceSpec);
  process.stdout.write(`S09 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
