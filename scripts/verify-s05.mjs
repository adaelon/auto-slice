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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S05.json");
const receiptRelativePath = "artifacts/s05/completion-receipt.json";
const processMatrixRelativePath = "artifacts/s05/process-scenario-matrix.json";
const artifactFixtureRelativePath = "artifacts/s05/artifact-digest-fixture.json";
const verificationSampleRelativePath = "artifacts/s05/verification-receipt.sample.json";
const maximumOutputBytes = 32 * 1024 * 1024;
const expectedFailureCodes = [
  "slice_contract_invalid",
  "path_outside_workspace",
  "write_capability_unavailable",
  "model_decision_invalid",
  "execution_not_found",
  "execution_already_collected",
  "check_spawn_failed",
  "check_timeout",
  "check_nonzero_exit",
  "check_output_limit_exceeded",
  "artifact_missing",
  "artifact_digest_mismatch",
  "unowned_change_detected",
  "protected_change_overlap",
  "workspace_inspection_failed",
  "verification_receipt_invalid",
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

function isS05OwnedPath(relativePath) {
  const exactPaths = new Set([
    "contracts/slices/S05.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/verify-s05-evidence.mjs",
    "scripts/verify-s05.mjs",
    "test/slice-executor.test.ts",
  ]);
  const prefixes = [
    "artifacts/s05/",
    "src/controller/slices/",
    "test/fixtures/process/",
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
    if (typeof output?.path === "string" && isS05OwnedPath(output.path)) {
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
    sliceSpec?.id !== "S05" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S02", "S03", "S04"])
  ) {
    throw new Error("contracts/slices/S05.json is not SliceSpec v1 requiring S02, S03, and S04.");
  }
  if (
    JSON.stringify(sliceSpec.failure_codes) !== JSON.stringify(expectedFailureCodes) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.checks)
  ) {
    throw new Error("S05 SliceSpec must freeze its failure codes, inputs, and checks.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S05 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S05 input digest changed for ${input.path}.`);
    }
  }
  validatePrerequisiteReceipt("artifacts/s02/completion-receipt.json", "S02");
  validatePrerequisiteReceipt("artifacts/s03/completion-receipt.json", "S03");
  validatePrerequisiteReceipt("artifacts/s04/completion-receipt.json", "S04");
  const expectedChecks = ["build", "typecheck", "test", "s05_evidence", "lint"];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S05 deterministic check order changed.");
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
      throw new Error("S05 contains an invalid CheckSpec.");
    }
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    if (check.id !== "s05_evidence") {
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
    throw new Error("One or more S05 deterministic checks failed.");
  }
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const serialized = outputs.get("s05_evidence");
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("The s05_evidence check produced no JSON evidence.");
  }
  const evidence = JSON.parse(serialized);
  if (
    evidence?.process_scenario_matrix?.result !== "PASS" ||
    evidence?.artifact_digest_fixture?.result !== "PASS" ||
    evidence?.verification_receipt_sample?.result !== "PASS" ||
    evidence.verification_receipt_sample.receipt_digest_valid !== true ||
    evidence.verification_receipt_sample.repeated_verification_equal !== true
  ) {
    throw new Error("The s05_evidence check returned an invalid or failing report.");
  }
  return evidence;
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S05 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S05 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyCommittedEvidence(sliceSpec, checkReceipts, evidence) {
  assertEvidenceMatches(processMatrixRelativePath, evidence.process_scenario_matrix);
  assertEvidenceMatches(artifactFixtureRelativePath, evidence.artifact_digest_fixture);
  assertEvidenceMatches(verificationSampleRelativePath, evidence.verification_receipt_sample);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S05" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The committed S05 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const committedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(committedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The committed S05 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`Committed S05 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The committed S05 owned diff digest is invalid.");
  }
  const dirtyS05Paths = collectTouchedPaths("HEAD").filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && isS05OwnedPath(entry),
  );
  if (dirtyS05Paths.length > 0) {
    throw new Error(`S05-owned paths changed after its receipt was committed: ${dirtyS05Paths.join(", ")}`);
  }
  process.stdout.write(`S05 CompletionReceipt verified: ${receiptRelativePath}\n`);
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

  writeJsonAtomic(processMatrixRelativePath, evidence.process_scenario_matrix);
  writeJsonAtomic(artifactFixtureRelativePath, evidence.artifact_digest_fixture);
  writeJsonAtomic(verificationSampleRelativePath, evidence.verification_receipt_sample);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths(startHead).filter(
    (entry) => entry !== "SESSION_CHECKPOINT.md" && entry !== receiptRelativePath,
  );
  const unownedPaths = touchedBeforeReceipt.filter((entry) => !isS05OwnedPath(entry));
  if (unownedPaths.length > 0) {
    throw new Error(`S05 touched paths outside its ownership: ${unownedPaths.join(", ")}`);
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
    slice_id: "S05",
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
  process.stdout.write(`S05 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
