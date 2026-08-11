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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S14.json");
const whitelistRelativePath = "artifacts/s14/event-whitelist-report.json";
const canaryRelativePath = "artifacts/s14/canary-leak-report.json";
const equivalenceRelativePath = "artifacts/s14/content-equivalence-receipt.json";
const receiptRelativePath = "artifacts/s14/completion-receipt.json";
const maximumOutputBytes = 32 * 1024 * 1024;
const canaries = [
  "S14_MESSAGE_CANARY",
  "S14_REASONING_CANARY",
  "S14_COMMAND_CANARY",
  "S14_DIFF_CANARY",
  "S14_TOOL_CANARY",
  "S14_PLAN_CANARY",
];
const expectedOptOuts = [
  "turn/diff/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
];

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

function isS14OwnedPath(relativePath) {
  const exact = new Set([
    "contracts/slices/S14.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/run-s14-firewall.mjs",
    "scripts/verify-s14.mjs",
    "src/controller/production/app-server-client.ts",
    "src/controller/production/codex-app-server-development-task.ts",
    "src/controller/production/index.ts",
    "src/controller/production/production-orchestrator.ts",
    "src/controller/production/types.ts",
    "test/app-server-client.test.ts",
    "test/app-server-development-task.test.ts",
    "test/file-production-runtime.test.ts",
    "test/fixtures/process/fake-codex-app-server.mjs",
    "test/fixtures/process/run-s14-production-with-fake-host.mjs",
    "test/production-orchestrator.test.ts",
  ]);
  return exact.has(relativePath) || relativePath.startsWith("artifacts/s14/");
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S14" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S13"]) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.checks)
  ) {
    throw new Error("contracts/slices/S14.json is not the expected SliceSpec v1.");
  }
  for (const input of sliceSpec.inputs) {
    const inputPath = path.join(repoRoot, input?.path ?? "");
    if (
      typeof input?.path !== "string" ||
      typeof input.digest !== "string" ||
      !existsSync(inputPath) ||
      sha256File(inputPath) !== input.digest
    ) {
      throw new Error(`S14 input digest changed for ${String(input?.path)}.`);
    }
  }
  const expectedChecks = [
    "build",
    "typecheck",
    "target_test",
    "test",
    "firewall_evidence_first",
    "firewall_evidence_repeat",
    "markdown_links",
    "plugin_validation",
    "lint",
  ];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S14 deterministic check order changed.");
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
    if (!check.id.startsWith("firewall_evidence_")) process.stdout.write(result.stdout);
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
  if (failed) throw new Error("One or more S14 deterministic checks failed.");
  return { receipts, outputs };
}

function parseFirewallEvidence(outputs) {
  const first = JSON.parse(outputs.get("firewall_evidence_first")?.stdout ?? "null");
  const repeated = JSON.parse(outputs.get("firewall_evidence_repeat")?.stdout ?? "null");
  if (JSON.stringify(first) !== JSON.stringify(repeated)) {
    throw new Error("Repeated S14 firewall evidence is not normalized and reproducible.");
  }
  const expectedTypes = ["COMPACTION", "TURN_TERMINAL", "THREAD_LIFECYCLE", "MODEL_REROUTED"];
  const expectedCategories = ["agent_message", "reasoning", "command_output", "diff", "tool_payload", "plan"];
  if (
    first?.schema_version !== 1 ||
    first.slice_id !== "S14" ||
    first.result !== "PASS" ||
    JSON.stringify(first.notification_opt_out_methods) !== JSON.stringify(expectedOptOuts) ||
    JSON.stringify(first.projected_signal_types) !== JSON.stringify(expectedTypes) ||
    JSON.stringify(first.dropped_content_categories) !== JSON.stringify(expectedCategories) ||
    first.dropped_notification_count !== expectedCategories.length ||
    first.canary_count !== canaries.length ||
    first.normalized_short_digest !== first.normalized_large_digest ||
    first.normalized_short_run_events_digest !== first.normalized_large_run_events_digest ||
    first.normalized_short_production_receipt_digest !==
      first.normalized_large_production_receipt_digest ||
    !Number.isSafeInteger(first.normalized_controller_bytes) ||
    first.normalized_controller_bytes <= 0 ||
    !Number.isSafeInteger(first.maximum_signal_bytes) ||
    first.maximum_signal_bytes <= 0 ||
    !Number.isSafeInteger(first.run_event_count) ||
    first.run_event_count <= 0 ||
    !Number.isSafeInteger(first.controller_state_file_count) ||
    first.controller_state_file_count <= 0 ||
    Object.values(first.assertions ?? {}).some((value) => value !== true)
  ) {
    throw new Error("S14 firewall evidence is incomplete or failing.");
  }
  return first;
}

function assertCanariesAbsent(outputs) {
  const surfaces = [];
  for (const [checkId, output] of outputs) {
    surfaces.push([`${checkId}:stdout`, output.stdout], [`${checkId}:stderr`, output.stderr]);
  }
  for (const [surface, value] of surfaces) {
    if (canaries.some((canary) => value.includes(canary))) {
      throw new Error(`S14 Worker Content canary leaked into ${surface}.`);
    }
  }
  return surfaces.length;
}

function buildEvidenceArtifacts(report, scannedProcessSurfaces) {
  const whitelist = {
    schema_version: 1,
    slice_id: "S14",
    notification_opt_out_methods: report.notification_opt_out_methods,
    projected_signal_types: report.projected_signal_types,
    signal_field_sets: report.signal_field_sets,
    dropped_content_categories: report.dropped_content_categories,
    dropped_notification_count: report.dropped_notification_count,
    maximum_signal_bytes: report.maximum_signal_bytes,
    result: "PASS",
  };
  const canary = {
    schema_version: 1,
    slice_id: "S14",
    canary_count: report.canary_count,
    scanned_surfaces: [
      "ControllerSignal",
      "DevelopmentTaskReceipt",
      "DevelopmentTaskEvent",
      "Controller Run event store",
      "check_stdout",
      "check_stderr",
    ],
    scanned_process_surface_count: scannedProcessSurfaces,
    matches: 0,
    result: "PASS",
  };
  const equivalence = {
    schema_version: 1,
    slice_id: "S14",
    normalized_short_digest: report.normalized_short_digest,
    normalized_large_digest: report.normalized_large_digest,
    normalized_controller_bytes: report.normalized_controller_bytes,
    development_receipt_digest: report.development_receipt_digest,
    normalized_short_run_events_digest: report.normalized_short_run_events_digest,
    normalized_large_run_events_digest: report.normalized_large_run_events_digest,
    normalized_short_production_receipt_digest: report.normalized_short_production_receipt_digest,
    normalized_large_production_receipt_digest: report.normalized_large_production_receipt_digest,
    run_event_count: report.run_event_count,
    controller_state_file_count: report.controller_state_file_count,
    equal: true,
    result: "PASS",
  };
  return { canary, equivalence, whitelist };
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) throw new Error(`S14 expected artifacts are missing: ${missing.join(", ")}`);
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S14 evidence.`);
  }
}

function currentS14Paths() {
  return collectTouchedPaths().filter(isS14OwnedPath).sort();
}

function verifyExistingEvidence(sliceSpec, checkReceipts, artifacts) {
  assertEvidenceMatches(whitelistRelativePath, artifacts.whitelist);
  assertEvidenceMatches(canaryRelativePath, artifacts.canary);
  assertEvidenceMatches(equivalenceRelativePath, artifacts.equivalence);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S14" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    JSON.stringify(receipt.check_receipts?.map((entry) => entry.check_id)) !==
      JSON.stringify(checkReceipts.map((entry) => entry.check_id))
  ) {
    throw new Error("The S14 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S14 output changed: ${String(output?.path)}.`);
    }
  }
  if (
    receipt.owned_diff_digest !==
      sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"))
  ) {
    throw new Error("The S14 owned diff digest is invalid.");
  }
  if (JSON.stringify(currentS14Paths()) !== JSON.stringify(receipt.touched_paths)) {
    throw new Error("Current S14 worktree paths differ from the CompletionReceipt boundary.");
  }
  process.stdout.write(`S14 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const report = parseFirewallEvidence(outputs);
  const scannedProcessSurfaces = assertCanariesAbsent(outputs);
  const artifacts = buildEvidenceArtifacts(report, scannedProcessSurfaces);

  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, artifacts);
    return;
  }

  writeJsonAtomic(whitelistRelativePath, artifacts.whitelist);
  writeJsonAtomic(canaryRelativePath, artifacts.canary);
  writeJsonAtomic(equivalenceRelativePath, artifacts.equivalence);
  validateExpectedArtifacts(sliceSpec, false);
  const touchedBeforeReceipt = currentS14Paths().filter((entry) => entry !== receiptRelativePath);
  const outputDigests = touchedBeforeReceipt.map((relativePath) => ({
    path: relativePath,
    digest: sha256File(path.join(repoRoot, relativePath)),
  }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S14",
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
  process.stdout.write(`S14 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
