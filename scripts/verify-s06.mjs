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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S06.json");
const receiptRelativePath = "artifacts/s06/completion-receipt.json";
const commitTreeRelativePath = "artifacts/s06/commit-tree-golden.json";
const checkpointSampleRelativePath = "artifacts/s06/checkpoint.sample.md";
const failureMatrixRelativePath = "artifacts/s06/failure-scene-matrix.json";
const maximumOutputBytes = 32 * 1024 * 1024;
const expectedFailureCodes = [
  "verification_failed",
  "verification_receipt_invalid",
  "finish_input_invalid",
  "workspace_not_git_worktree",
  "git_inspection_failed",
  "head_drift",
  "protected_change_overlap",
  "owned_patch_invalid",
  "stage_scope_mismatch",
  "commit_failed",
  "checkpoint_invalid",
  "checkpoint_refresh_failed",
];

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

function writeTextAtomic(relativePath, content) {
  const target = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, content, "utf8");
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

function isS06OwnedPath(relativePath) {
  const exactPaths = new Set([
    "contracts/slices/S06.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/verify-s06-evidence.mjs",
    "scripts/verify-s06.mjs",
    "test/commit-coordinator.test.ts",
  ]);
  const prefixes = [
    "artifacts/s06/",
    "src/controller/git/",
  ];
  return exactPaths.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
}

function validatePrerequisiteReceipt(relativePath, sliceId) {
  const receipt = parseJsonFile(path.join(repoRoot, relativePath));
  if (
    receipt?.slice_id !== sliceId ||
    !Array.isArray(receipt.check_receipts) ||
    receipt.check_receipts.some((entry) => entry.exit_code !== 0) ||
    !Array.isArray(receipt.output_digests)
  ) {
    throw new Error(`${sliceId} CompletionReceipt does not prove the required Slice completed.`);
  }
  for (const output of receipt.output_digests) {
    if (typeof output?.path === "string" && isS06OwnedPath(output.path)) {
      continue;
    }
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
    sliceSpec?.id !== "S06" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S03", "S05"])
  ) {
    throw new Error("contracts/slices/S06.json is not SliceSpec v1 requiring S03 and S05.");
  }
  if (
    JSON.stringify(sliceSpec.failure_codes) !== JSON.stringify(expectedFailureCodes) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.checks) ||
    !Array.isArray(sliceSpec.ports)
  ) {
    throw new Error("S06 SliceSpec must freeze its failure codes, inputs, ports, and checks.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S06 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S06 input digest changed for ${input.path}.`);
    }
  }
  validatePrerequisiteReceipt("artifacts/s03/completion-receipt.json", "S03");
  validatePrerequisiteReceipt("artifacts/s05/completion-receipt.json", "S05");
  const expectedChecks = ["build", "typecheck", "test", "s06_evidence", "lint"];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S06 deterministic check order changed.");
  }
  if (
    JSON.stringify(sliceSpec.ports.map((port) => port?.name)) !==
      JSON.stringify(["finish_slice", "atomic_rewrite_checkpoint"])
  ) {
    throw new Error("S06 public ports changed.");
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
      throw new Error("S06 contains an invalid CheckSpec.");
    }
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    if (check.id !== "s06_evidence") {
      process.stdout.write(result.stdout);
    }
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
  if (failed) {
    throw new Error("One or more S06 deterministic checks failed.");
  }
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const serialized = outputs.get("s06_evidence");
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("The s06_evidence check produced no JSON evidence.");
  }
  const evidence = JSON.parse(serialized);
  const after = evidence?.commit_tree_golden?.after_slice;
  const none = evidence?.commit_tree_golden?.none;
  const matrix = evidence?.failure_scene_matrix;
  const expectedScenes = [
    ["hook_failure", "commit_failed", false, false],
    ["head_drift", "head_drift", false, true],
    ["checkpoint_rename_failure", "checkpoint_refresh_failed", true, true],
    ["stage_scope_mismatch", "stage_scope_mismatch", false, false],
  ];
  if (
    evidence?.commit_tree_golden?.result !== "PASS" ||
    after?.commit_count !== 2 ||
    JSON.stringify(after?.committed_paths) !== JSON.stringify(["owned-new.txt", "owned.txt"]) ||
    JSON.stringify(after?.protected_staged_paths) !== JSON.stringify(["protected.txt"]) ||
    after?.protected_untracked_preserved !== true ||
    after?.checkpoint_references_new_head !== true ||
    after?.push_invocations !== 0 ||
    none?.commit_count_unchanged !== true ||
    none?.head_unchanged !== true ||
    none?.override_effective !== true ||
    none?.diff_digest_preserved !== true ||
    typeof evidence.checkpoint_sample !== "string" ||
    !evidence.checkpoint_sample.includes("`<HEAD>`") ||
    matrix?.result !== "PASS" ||
    !Array.isArray(matrix.scenarios) ||
    JSON.stringify(matrix.scenarios.map((scene) => [
      scene.id,
      scene.failure_code,
      scene.commit_created,
      scene.head_changed,
    ])) !== JSON.stringify(expectedScenes) ||
    matrix.scenarios.some((scene) => scene.checkpoint_preserved !== true)
  ) {
    throw new Error("The s06_evidence check returned an invalid or failing report.");
  }
  return evidence;
}

function assertJsonEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S06 evidence.`);
  }
}

function assertTextEvidenceMatches(relativePath, expected) {
  const actual = readFileSync(path.join(repoRoot, relativePath), "utf8");
  if (actual !== expected) {
    throw new Error(`${relativePath} no longer matches deterministic S06 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S06 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyCommittedEvidence(sliceSpec, checkReceipts, evidence) {
  assertJsonEvidenceMatches(commitTreeRelativePath, evidence.commit_tree_golden);
  assertTextEvidenceMatches(checkpointSampleRelativePath, evidence.checkpoint_sample);
  assertJsonEvidenceMatches(failureMatrixRelativePath, evidence.failure_scene_matrix);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S06" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The committed S06 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const committedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(committedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The committed S06 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`Committed S06 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The committed S06 owned diff digest is invalid.");
  }
  const dirtyS06Paths = collectTouchedPaths("HEAD").filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && isS06OwnedPath(entry),
  );
  if (dirtyS06Paths.length > 0) {
    throw new Error(`S06-owned paths changed after its receipt was committed: ${dirtyS06Paths.join(", ")}`);
  }
  process.stdout.write(`S06 CompletionReceipt verified: ${receiptRelativePath}\n`);
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

  writeJsonAtomic(commitTreeRelativePath, evidence.commit_tree_golden);
  writeTextAtomic(checkpointSampleRelativePath, evidence.checkpoint_sample);
  writeJsonAtomic(failureMatrixRelativePath, evidence.failure_scene_matrix);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths(startHead).filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && entry !== receiptRelativePath,
  );
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS06OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S06 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
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
    slice_id: "S06",
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
  process.stdout.write(`S06 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
