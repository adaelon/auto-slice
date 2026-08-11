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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S11.json");
const receiptRelativePath = "artifacts/s11/completion-receipt.json";
const matrixRelativePath = "artifacts/s11/control-matrix.json";
const schemaRelativePath = "artifacts/s11/command-dto.schema.json";
const recoveryRelativePath = "artifacts/s11/recovery-catalog.json";
const invariantRelativePath = "artifacts/s11/control-invariant-report.json";
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

function collectTouchedPaths() {
  const tracked = parseNullSeparated(runGit(["diff", "HEAD", "--name-only", "-z", "--"]));
  const untracked = parseNullSeparated(runGit(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function isProtectedPath(relativePath) {
  return relativePath === "SESSION_CHECKPOINT.md" ||
    /^handoff-[^/]+(?:\.md|\.evidence\.json)$/u.test(relativePath);
}

function isS11OwnedPath(relativePath) {
  const exact = new Set([
    ".codex-plugin/plugin.json",
    "contracts/slices/S11.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/verify-s11-evidence.mjs",
    "scripts/verify-s11.mjs",
    "src/controller/main.ts",
    "src/controller/state/file-run-store.ts",
    "src/controller/state/index.ts",
    "src/controller/state/transitions.ts",
    "src/controller/state/types.ts",
    "src/controller/state/validation.ts",
    "test/control-plane.test.ts",
    "test/controller.test.ts",
  ]);
  const prefixes = [
    "artifacts/s11/",
    "skills/auto-slice-control/",
    "src/controller/control-plane/",
  ];
  return exact.has(relativePath) || prefixes.some((prefix) => relativePath.startsWith(prefix));
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validatePrerequisiteReceipt(sliceId, relativePath) {
  const receipt = parseJsonFile(path.join(repoRoot, relativePath));
  const contractPath = path.join(repoRoot, "contracts", "slices", `${sliceId}.json`);
  if (
    receipt?.slice_id !== sliceId ||
    receipt.contract_digest !== sha256File(contractPath) ||
    !Array.isArray(receipt.check_receipts) ||
    receipt.check_receipts.some((entry) => entry.exit_code !== 0) ||
    !Array.isArray(receipt.output_digests)
  ) {
    throw new Error(`${sliceId} CompletionReceipt does not prove the prerequisite completed.`);
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (receipt.owned_diff_digest !== expectedOwnedDiffDigest) {
    throw new Error(`${sliceId} CompletionReceipt has an invalid owned diff digest.`);
  }
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S11" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S02", "S05", "S06", "S10"])
  ) {
    throw new Error("contracts/slices/S11.json is not SliceSpec v1 requiring S02/S05/S06/S10.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S11 SliceSpec must contain inputs and checks arrays.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S11 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S11 input digest changed for ${input.path}.`);
    }
  }
  validatePrerequisiteReceipt("S02", "artifacts/s02/completion-receipt.json");
  validatePrerequisiteReceipt("S05", "artifacts/s05/completion-receipt.json");
  validatePrerequisiteReceipt("S06", "artifacts/s06/completion-receipt.json");
  validatePrerequisiteReceipt("S10", "artifacts/s10/completion-receipt.json");
  const expectedChecks = ["build", "typecheck", "test", "s11_evidence", "plugin_validation", "lint"];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S11 deterministic check order changed.");
  }
}

function runChecks(sliceSpec) {
  const receipts = [];
  const outputs = new Map();
  let failed = false;
  for (const check of sliceSpec.checks) {
    const result = runCommand(check.argv, {
      cwd: path.resolve(repoRoot, check.cwd),
      env: resolveEnvironment(check.env_allowlist),
      timeoutMs: check.timeout_ms,
    });
    if (check.id !== "s11_evidence") process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    outputs.set(check.id, result.stdout);
    const missingArtifacts = (check.expected_artifacts ?? []).filter(
      (artifact) => typeof artifact !== "string" || !existsSync(path.join(repoRoot, artifact)),
    );
    if (result.exitCode !== check.expected_exit_code || missingArtifacts.length > 0) {
      failed = true;
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
  if (failed) throw new Error("One or more S11 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const serialized = outputs.get("s11_evidence");
  if (typeof serialized !== "string" || serialized.length === 0) {
    throw new Error("The s11_evidence check produced no JSON evidence.");
  }
  const evidence = JSON.parse(serialized);
  if (
    evidence?.control_matrix?.result !== "PASS" ||
    evidence.control_matrix.entries?.length !== 70 ||
    evidence?.recovery_catalog?.result !== "PASS" ||
    evidence.recovery_catalog.entries?.some((entry) => !entry.resolutions?.includes("abort_run")) ||
    evidence?.invariant_report?.result !== "PASS" ||
    evidence.invariant_report.no_push_path !== true ||
    evidence.invariant_report.no_model_fallback_path !== true ||
    evidence.invariant_report.status_omits_raw_error_message !== true ||
    evidence?.command_dto_schema?.properties?.command?.enum?.length !== 6
  ) {
    throw new Error("The s11_evidence check returned invalid or failing evidence.");
  }
  return evidence;
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S11 evidence.`);
  }
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) {
    throw new Error(`S11 expected artifacts are missing: ${missing.join(", ")}`);
  }
}

function verifyExistingEvidence(sliceSpec, checkReceipts, evidence) {
  assertEvidenceMatches(matrixRelativePath, evidence.control_matrix);
  assertEvidenceMatches(schemaRelativePath, evidence.command_dto_schema);
  assertEvidenceMatches(recoveryRelativePath, evidence.recovery_catalog);
  assertEvidenceMatches(invariantRelativePath, evidence.invariant_report);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S11" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The S11 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const recordedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(recordedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The S11 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S11 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The S11 owned diff digest is invalid.");
  }
  const touched = collectTouchedPaths().filter((entry) => !isProtectedPath(entry));
  const unowned = touched.filter((entry) => !isS11OwnedPath(entry));
  if (unowned.length > 0) {
    throw new Error(`S11 worktree contains unowned changes: ${unowned.join(", ")}`);
  }
  if (!sameStringSet(touched, receipt.touched_paths)) {
    throw new Error("Current S11 worktree paths differ from CompletionReceipt.touched_paths.");
  }
  process.stdout.write(`S11 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const evidence = parseEvidence(outputs);
  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, evidence);
    return;
  }

  writeJsonAtomic(matrixRelativePath, evidence.control_matrix);
  writeJsonAtomic(schemaRelativePath, evidence.command_dto_schema);
  writeJsonAtomic(recoveryRelativePath, evidence.recovery_catalog);
  writeJsonAtomic(invariantRelativePath, evidence.invariant_report);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths().filter(
    (entry) => entry !== receiptRelativePath && !isProtectedPath(entry),
  );
  const unowned = touchedBeforeReceipt.filter((entry) => !isS11OwnedPath(entry));
  if (unowned.length > 0) {
    throw new Error(`S11 touched paths outside its ownership: ${unowned.join(", ")}`);
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
    slice_id: "S11",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((entry) => ({ path: entry.path, digest: entry.digest })),
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
  process.stdout.write(`S11 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
