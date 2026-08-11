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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S16.json");
const budgetRelativePath = "artifacts/s16/content-budget-report.json";
const canaryRelativePath = "artifacts/s16/canary-scan-report.json";
const revisionRelativePath = "artifacts/s16/revision-failure-trace.json";
const receiptRelativePath = "artifacts/s16/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;

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
    if (ownedPath.endsWith("/**")) return relativePath.startsWith(ownedPath.slice(0, -2));
    return relativePath === ownedPath;
  });
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S16" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S14", "S15"]) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.owned_paths) ||
    !Array.isArray(sliceSpec.checks) ||
    sliceSpec.budgets?.maximum_controller_signal_bytes !== 8192 ||
    sliceSpec.budgets?.worker_content_canary_types !== 8 ||
    sliceSpec.budgets?.full_turn_read_count !== 0
  ) {
    throw new Error("contracts/slices/S16.json is not the expected SliceSpec v1.");
  }
  for (const input of sliceSpec.inputs) {
    const inputPath = path.join(repoRoot, input?.path ?? "");
    if (
      typeof input?.path !== "string" ||
      typeof input.digest !== "string" ||
      !existsSync(inputPath) ||
      sha256File(inputPath) !== input.digest
    ) {
      throw new Error(`S16 input digest changed for ${String(input?.path)}.`);
    }
  }
  const expectedChecks = [
    "build",
    "typecheck",
    "target_test",
    "test",
    "content_budget_evidence_first",
    "content_budget_evidence_repeat",
    "markdown_links",
    "plugin_validation",
    "lint",
  ];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S16 deterministic check order changed.");
  }
  const targetTest = sliceSpec.checks.find((check) => check?.id === "target_test");
  const requiredAcceptanceTests = [
    "dist/test/app-server-client.test.js",
    "dist/test/app-server-development-task.test.js",
    "dist/test/thread-control.test.js",
    "dist/test/production-orchestrator.test.js",
    "dist/test/file-production-runtime.test.js",
    "dist/test/run-store.test.js",
    "dist/test/control-plane.test.js",
    "dist/test/auto-slice-control-skill.test.js",
  ];
  if (
    !Array.isArray(targetTest?.argv) ||
    requiredAcceptanceTests.some((testPath) => !targetTest.argv.includes(testPath))
  ) {
    throw new Error("S16 target tests do not cover the final S-ACC-1 compatibility matrix.");
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
    if (!check.id.startsWith("content_budget_evidence_")) process.stdout.write(result.stdout);
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
  if (failed) throw new Error("One or more S16 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const first = JSON.parse(outputs.get("content_budget_evidence_first")?.stdout ?? "null");
  const repeated = JSON.parse(outputs.get("content_budget_evidence_repeat")?.stdout ?? "null");
  if (JSON.stringify(first) !== JSON.stringify(repeated)) {
    throw new Error("Repeated S16 content-budget evidence is not normalized and reproducible.");
  }
  const scenarioIds = (first?.scenarios ?? []).map((scenario) => scenario.id);
  const expectedScenarioIds = [
    "normal-short",
    "normal-large",
    "compaction-29999",
    "timeout-revision-available",
    "timeout-revision-unavailable",
    "probe-fallback",
    "worker-failed",
    "worker-interrupted",
  ];
  const normalShort = first?.scenarios?.find((scenario) => scenario.id === "normal-short");
  const normalLarge = first?.scenarios?.find((scenario) => scenario.id === "normal-large");
  const completed29999 = first?.scenarios?.find((scenario) => scenario.id === "compaction-29999");
  const probeFallback = first?.scenarios?.find((scenario) => scenario.id === "probe-fallback");
  const workerFailed = first?.scenarios?.find((scenario) => scenario.id === "worker-failed");
  const workerInterrupted = first?.scenarios?.find((scenario) => scenario.id === "worker-interrupted");
  const available = first?.revision_gate?.available;
  const unavailable = first?.revision_gate?.unavailable;
  const acceptance = first?.acceptance_matrix;
  if (
    first?.schema_version !== 1 ||
    first.slice_id !== "S16" ||
    first.result !== "PASS" ||
    JSON.stringify(scenarioIds) !== JSON.stringify(expectedScenarioIds) ||
    first.signal_budget?.limit_bytes !== 8192 ||
    !Number.isSafeInteger(first.signal_budget?.maximum_bytes) ||
    first.signal_budget.maximum_bytes <= 0 ||
    first.signal_budget.maximum_bytes > 8192 ||
    first.signal_budget.signals?.some((signal) => signal.bytes > 8192) ||
    first.normal_content_equivalence?.equal !== true ||
    first.normal_content_equivalence?.state_file_count <= 0 ||
    first.normal_content_equivalence?.state_total_bytes <= 0 ||
    first.canary_scan?.matches !== 0 ||
    first.canary_scan?.canary_types?.length !== 8 ||
    first.canary_scan?.scenario_count !== 8 ||
    first.canary_scan?.state_files_scanned <= 0 ||
    first.canary_scan?.bytes_scanned <= 0 ||
    first.scenarios.some((scenario) => scenario.full_turn_read_count !== 0 || scenario.canary_matches !== 0) ||
    completed29999?.host_clock_offsets_used?.[2] - completed29999?.host_clock_offsets_used?.[1] !== 29_999 ||
    completed29999?.run_status !== "DONE" ||
    completed29999?.probe_call_count !== 0 ||
    normalShort?.completed_slice_count !== 2 ||
    normalLarge?.completed_slice_count !== 2 ||
    normalShort?.commit_mode !== "after_slice" ||
    normalShort?.head_commit_delta !== 0 ||
    normalShort?.checkpoint_exists !== false ||
    normalShort?.extra_file_count !== 2 ||
    normalShort?.legacy_expected_artifact_exists !== false ||
    normalShort?.legacy_contract_fields_present !== true ||
    normalShort?.run_status_chain?.some((status) =>
      ["VERIFYING", "COMMITTING", "CHECKPOINTING"].includes(status)
    ) ||
    probeFallback?.outcome !== "DONE" ||
    probeFallback?.run_status !== "DONE" ||
    probeFallback?.host_compaction_capability !== "UNAVAILABLE" ||
    probeFallback?.probe_call_count !== 1 ||
    JSON.stringify(probeFallback?.probe_elapsed_ms) !== JSON.stringify([20 * 60_000]) ||
    probeFallback?.probe_compaction_id_shape_valid !== true ||
    workerFailed?.outcome !== "FAIL_CLOSED" ||
    workerFailed?.run_status !== "NEEDS_USER" ||
    workerFailed?.error_code !== "slice_execution_failed" ||
    workerFailed?.development_start_count !== 1 ||
    workerInterrupted?.outcome !== "FAIL_CLOSED" ||
    workerInterrupted?.run_status !== "NEEDS_USER" ||
    workerInterrupted?.error_code !== "slice_execution_failed" ||
    workerInterrupted?.development_start_count !== 1 ||
    available?.outcome !== "CONTINUATION_STARTED" ||
    available?.run_status !== "SLICE_RUNNING" ||
    available?.summary_only_thread_reads !== 1 ||
    available?.final_source_is_continuation !== true ||
    unavailable?.outcome !== "FAIL_CLOSED" ||
    unavailable?.run_status !== "NEEDS_USER" ||
    unavailable?.error_code !== "source_interrupt_failed" ||
    unavailable?.full_turn_read_count !== 0 ||
    unavailable?.compression_starts !== 0 ||
    unavailable?.continuation_starts !== 0 ||
    first.scenarios.some((scenario) => scenario.controller_git_invocation_count !== 0) ||
    acceptance?.trusted_completion?.legacy_acceptance_states_seen !== false ||
    acceptance?.failure_closure?.next_slice_starts !== 0 ||
    acceptance?.compaction_observability?.event_path_probe_calls !== 0 ||
    acceptance?.compaction_observability?.fallback_probe_calls !== 1 ||
    acceptance?.controller_observation?.git_process_calls !== 0 ||
    acceptance?.controller_observation?.full_turn_reads !== 0 ||
    acceptance?.controller_observation?.worker_content_matches !== 0 ||
    acceptance?.compatibility?.production_plan_version !== 1 ||
    acceptance?.compatibility?.legacy_slice_fields_present_and_inert !== true ||
    acceptance?.compatibility?.legacy_acceptance_snapshot_tests_required !== true
  ) {
    throw new Error("S16 content-budget evidence is incomplete or failing.");
  }
  return first;
}

function buildEvidenceArtifacts(report) {
  const completed29999 = report.scenarios.find((scenario) => scenario.id === "compaction-29999");
  return {
    budget: {
      schema_version: 1,
      slice_id: "S16",
      signal_budget: report.signal_budget,
      acceptance_matrix: report.acceptance_matrix,
      normal_content_equivalence: report.normal_content_equivalence,
      scenarios: report.scenarios,
      result: "PASS",
    },
    canary: {
      schema_version: 1,
      slice_id: "S16",
      ...report.canary_scan,
      result: "PASS",
    },
    revision: {
      schema_version: 1,
      slice_id: "S16",
      compaction_completed_29999: {
        elapsed_ms:
          completed29999.host_clock_offsets_used[2] - completed29999.host_clock_offsets_used[1],
        run_status: completed29999.run_status,
        full_turn_read_count: completed29999.full_turn_read_count,
      },
      ...report.revision_gate,
      failure_closure: report.acceptance_matrix.failure_closure,
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
  if (missing.length > 0) throw new Error(`S16 expected artifacts are missing: ${missing.join(", ")}`);
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S16 evidence.`);
  }
}

function currentS16Paths(sliceSpec) {
  return collectTouchedPaths()
    .filter((entry) => matchesOwnedPath(entry, sliceSpec.owned_paths))
    .sort();
}

function verifyExistingEvidence(sliceSpec, checkReceipts, artifacts) {
  assertEvidenceMatches(budgetRelativePath, artifacts.budget);
  assertEvidenceMatches(canaryRelativePath, artifacts.canary);
  assertEvidenceMatches(revisionRelativePath, artifacts.revision);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S16" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    JSON.stringify(receipt.check_receipts?.map((entry) => entry.check_id)) !==
      JSON.stringify(checkReceipts.map((entry) => entry.check_id))
  ) {
    throw new Error("The S16 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S16 output changed: ${String(output?.path)}.`);
    }
  }
  if (
    receipt.owned_diff_digest !==
      sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"))
  ) {
    throw new Error("The S16 owned diff digest is invalid.");
  }
  if (JSON.stringify(currentS16Paths(sliceSpec)) !== JSON.stringify(receipt.touched_paths)) {
    throw new Error("Current S16 worktree paths differ from the CompletionReceipt boundary.");
  }
  process.stdout.write(`S16 CompletionReceipt verified: ${receiptRelativePath}\n`);
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
  writeJsonAtomic(budgetRelativePath, artifacts.budget);
  writeJsonAtomic(canaryRelativePath, artifacts.canary);
  writeJsonAtomic(revisionRelativePath, artifacts.revision);
  validateExpectedArtifacts(sliceSpec, false);
  const touchedBeforeReceipt = currentS16Paths(sliceSpec).filter(
    (entry) => entry !== receiptRelativePath,
  );
  const outputDigests = touchedBeforeReceipt.map((relativePath) => ({
    path: relativePath,
    digest: sha256File(path.join(repoRoot, relativePath)),
  }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S16",
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
  process.stdout.write(`S16 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
