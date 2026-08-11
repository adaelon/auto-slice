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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S15.json");
const matrixRelativePath = "artifacts/s15/revision-capability-matrix.json";
const traceRelativePath = "artifacts/s15/full-turn-read-trace.json";
const gateRelativePath = "artifacts/s15/source-interruption-handoff-report.json";
const receiptRelativePath = "artifacts/s15/completion-receipt.json";
const maximumOutputBytes = 32 * 1024 * 1024;

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
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
    if (npmCli !== undefined) return { command: process.execPath, args: [npmCli, ...args] };
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
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
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

function matchesOwnedPath(relativePath, ownedPaths) {
  return ownedPaths.some((ownedPath) => {
    if (ownedPath.endsWith("/**")) {
      return relativePath.startsWith(ownedPath.slice(0, -2));
    }
    return relativePath === ownedPath;
  });
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S15" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S14", "S08", "S09"]) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.owned_paths) ||
    !Array.isArray(sliceSpec.checks)
  ) {
    throw new Error("contracts/slices/S15.json is not the expected SliceSpec v1.");
  }
  for (const input of sliceSpec.inputs) {
    const inputPath = path.join(repoRoot, input?.path ?? "");
    if (
      typeof input?.path !== "string" ||
      typeof input.digest !== "string" ||
      !existsSync(inputPath) ||
      sha256File(inputPath) !== input.digest
    ) {
      throw new Error(`S15 input digest changed for ${String(input?.path)}.`);
    }
  }
  const expectedChecks = [
    "build",
    "typecheck",
    "target_test",
    "test",
    "metadata_revision_evidence_first",
    "metadata_revision_evidence_repeat",
    "markdown_links",
    "plugin_validation",
    "lint",
  ];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S15 deterministic check order changed.");
  }
  const expectedReasons = [
    "thread_revision_unavailable",
    "thread_revision_invalid",
    "thread_revision_mismatch",
  ];
  if (JSON.stringify(sliceSpec.failure_reasons) !== JSON.stringify(expectedReasons)) {
    throw new Error("S15 revision failure reasons changed.");
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
    if (!check.id.startsWith("metadata_revision_evidence_")) process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    outputs.set(check.id, { stdout: result.stdout, stderr: result.stderr });
    const missingArtifacts = (check.expected_artifacts ?? []).filter(
      (artifact) => typeof artifact !== "string" || !existsSync(path.join(repoRoot, artifact)),
    );
    if (result.exitCode !== check.expected_exit_code || missingArtifacts.length > 0) failed = true;
    receipts.push({
      check_id: check.id,
      argv: check.argv,
      exit_code: result.exitCode,
      stdout_digest: sha256Bytes(Buffer.from(result.stdout, "utf8")),
      stderr_digest: sha256Bytes(Buffer.from(result.stderr, "utf8")),
      duration_ms: Math.round(result.durationMs),
    });
  }
  if (failed) throw new Error("One or more S15 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const first = JSON.parse(outputs.get("metadata_revision_evidence_first")?.stdout ?? "null");
  const repeated = JSON.parse(outputs.get("metadata_revision_evidence_repeat")?.stdout ?? "null");
  if (JSON.stringify(first) !== JSON.stringify(repeated)) {
    throw new Error("Repeated S15 metadata revision evidence is not reproducible.");
  }
  const expectedScenarios = [
    ["stable", "INTERRUPTED", null, "HANDOFF_EXPORTING"],
    ["unavailable", "FAIL_CLOSED", "thread_revision_unavailable", "NEEDS_USER"],
    ["invalid", "FAIL_CLOSED", "thread_revision_invalid", "NEEDS_USER"],
    ["mismatch", "FAIL_CLOSED", "thread_revision_mismatch", "NEEDS_USER"],
    ["malicious_turns", "FAIL_CLOSED", "thread_inspection_failed", "NEEDS_USER"],
    ["malicious_items", "FAIL_CLOSED", "thread_inspection_failed", "NEEDS_USER"],
  ];
  const actualScenarios = (first?.revision_capability_matrix ?? []).map((entry) => [
    entry.scenario,
    entry.outcome,
    entry.reason,
    entry.run_status,
  ]);
  const stable = first?.source_interruption_handoff?.stable_identity_binding;
  const failures = first?.source_interruption_handoff?.failure_closures;
  if (
    first?.schema_version !== 1 ||
    first.slice_id !== "S15" ||
    JSON.stringify(actualScenarios) !== JSON.stringify(expectedScenarios) ||
    first.full_turn_read_trace?.include_turns_true_count !== 0 ||
    first.full_turn_read_trace?.all_requests_summary_only !== true ||
    first.full_turn_read_trace?.thread_read_count !== 4 ||
    stable?.source_thread_bound !== true ||
    stable.source_revision_bound !== true ||
    stable.compression_launcher_calls !== 1 ||
    JSON.stringify(stable.lease_events) !== JSON.stringify(["ACQUIRED", "FROZEN", "EPOCH_ROTATED"]) ||
    !Array.isArray(failures) ||
    failures.length !== 5 ||
    failures.some((entry) =>
      entry.compression_launcher_calls !== 0 ||
      JSON.stringify(entry.lease_events) !== JSON.stringify(["ACQUIRED", "FROZEN"])
    )
  ) {
    throw new Error("S15 metadata revision evidence is incomplete or failing.");
  }
  return first;
}

function buildEvidenceArtifacts(report) {
  return {
    matrix: {
      schema_version: 1,
      slice_id: "S15",
      opaque_revision_bytes: 64,
      scenarios: report.revision_capability_matrix,
      result: "PASS",
    },
    trace: {
      schema_version: 1,
      slice_id: "S15",
      ...report.full_turn_read_trace,
      result: "PASS",
    },
    gate: {
      schema_version: 1,
      slice_id: "S15",
      ...report.source_interruption_handoff,
      result: "PASS",
    },
  };
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) =>
      typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath))
    );
  if (missing.length > 0) throw new Error(`S15 expected artifacts are missing: ${missing.join(", ")}`);
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S15 evidence.`);
  }
}

function currentS15Paths(sliceSpec) {
  return collectTouchedPaths()
    .filter((entry) => matchesOwnedPath(entry, sliceSpec.owned_paths))
    .sort();
}

function verifyExistingEvidence(sliceSpec, checkReceipts, artifacts) {
  assertEvidenceMatches(matrixRelativePath, artifacts.matrix);
  assertEvidenceMatches(traceRelativePath, artifacts.trace);
  assertEvidenceMatches(gateRelativePath, artifacts.gate);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S15" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    JSON.stringify(receipt.check_receipts?.map((entry) => entry.check_id)) !==
      JSON.stringify(checkReceipts.map((entry) => entry.check_id))
  ) {
    throw new Error("The S15 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S15 output changed: ${String(output?.path)}.`);
    }
  }
  if (
    receipt.owned_diff_digest !==
      sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"))
  ) {
    throw new Error("The S15 owned diff digest is invalid.");
  }
  if (JSON.stringify(currentS15Paths(sliceSpec)) !== JSON.stringify(receipt.touched_paths)) {
    throw new Error("Current S15 worktree paths differ from the CompletionReceipt boundary.");
  }
  process.stdout.write(`S15 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const artifacts = buildEvidenceArtifacts(parseEvidence(outputs));
  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, artifacts);
    return;
  }
  writeJsonAtomic(matrixRelativePath, artifacts.matrix);
  writeJsonAtomic(traceRelativePath, artifacts.trace);
  writeJsonAtomic(gateRelativePath, artifacts.gate);
  validateExpectedArtifacts(sliceSpec, false);
  const touchedBeforeReceipt = currentS15Paths(sliceSpec).filter(
    (entry) => entry !== receiptRelativePath,
  );
  const outputDigests = touchedBeforeReceipt.map((relativePath) => ({
    path: relativePath,
    digest: sha256File(path.join(repoRoot, relativePath)),
  }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S15",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((entry) => ({ path: entry.path, digest: entry.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    check_receipts: receipts,
    start_head: runGit(["rev-parse", "HEAD"]).trim(),
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  validateExpectedArtifacts(sliceSpec);
  process.stdout.write(`S15 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
