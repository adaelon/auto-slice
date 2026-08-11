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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S13.json");
const reportRelativePath = "artifacts/s13/production-entry-report.json";
const checklistRelativePath = "artifacts/s13/release-readiness-checklist.json";
const receiptRelativePath = "artifacts/s13/completion-receipt.json";
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

function isS13OwnedPath(relativePath) {
  const exact = new Set([
    "CONTEXT.md",
    "contracts/slices/S13.json",
    "docs/adr/0007-codex-app-server-production-adapter.md",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/run-s13-production-entry.mjs",
    "scripts/verify-s13.mjs",
    "src/controller/main.ts",
    "src/controller/state/file-run-store.ts",
    "src/controller/state/index.ts",
    "src/controller/state/transitions.ts",
    "src/controller/state/types.ts",
    "src/controller/state/validation.ts",
    "test/app-server-development-task.test.ts",
    "test/controller.test.ts",
    "test/file-production-runtime.test.ts",
    "test/fixtures/process/fake-codex-app-server.mjs",
    "test/fixtures/process/run-production-cli-with-fake-host.mjs",
    "test/production-orchestrator.test.ts",
    "test/production-plan.test.ts",
    "test/run-store.test.ts",
  ]);
  return exact.has(relativePath) ||
    relativePath.startsWith("artifacts/s13/") ||
    relativePath.startsWith("src/controller/production/");
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S13" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S12"]) ||
    !Array.isArray(sliceSpec.inputs) ||
    !Array.isArray(sliceSpec.checks)
  ) {
    throw new Error("contracts/slices/S13.json is not the expected SliceSpec v1.");
  }
  for (const input of sliceSpec.inputs) {
    const inputPath = path.join(repoRoot, input?.path ?? "");
    if (
      typeof input?.path !== "string" ||
      typeof input.digest !== "string" ||
      !existsSync(inputPath) ||
      sha256File(inputPath) !== input.digest
    ) {
      throw new Error(`S13 input digest changed for ${String(input?.path)}.`);
    }
  }
  const expectedChecks = [
    "build",
    "typecheck",
    "test",
    "production_entry_first",
    "production_entry_repeat",
    "markdown_links",
    "plugin_validation",
    "lint",
  ];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S13 deterministic check order changed.");
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
    if (!check.id.startsWith("production_entry_")) process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    outputs.set(check.id, result.stdout);
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
  if (failed) throw new Error("One or more S13 deterministic checks failed.");
  return { receipts, outputs };
}

function parseProductionEvidence(outputs) {
  const first = JSON.parse(outputs.get("production_entry_first") ?? "null");
  const repeated = JSON.parse(outputs.get("production_entry_repeat") ?? "null");
  if (JSON.stringify(first) !== JSON.stringify(repeated)) {
    throw new Error("Repeated S13 production-entry output is not normalized and reproducible.");
  }
  const assertions = first?.assertions;
  const booleanAssertions = [
    "compiled_bin_advertises_run_plan",
    "production_plan_reached_orchestrator",
    "default_development_adapter_protocol_exercised",
    "head_unchanged",
    "state_storage_outside_workspace",
    "workspace_state_directory_absent",
    "deterministic_checks_passed",
    "task_host_disposed",
  ];
  if (
    first?.slice_id !== "S13" ||
    first.result !== "PASS" ||
    assertions?.commit_mode !== "none" ||
    assertions.commit_count_delta !== 0 ||
    assertions.remote_count !== 0 ||
    assertions.push_count !== 0 ||
    booleanAssertions.some((key) => assertions?.[key] !== true) ||
    JSON.stringify(first.workspace_status) !== JSON.stringify([
      "?? SESSION_CHECKPOINT.md",
      "?? owned.txt",
      "?? result.json",
    ])
  ) {
    throw new Error("S13 production-entry evidence is incomplete or failing.");
  }
  return first;
}

function buildChecklist(checkReceipts, report) {
  const passed = new Set(
    checkReceipts.filter((entry) => entry.exit_code === 0).map((entry) => entry.check_id),
  );
  const items = [
    ["build", passed.has("build")],
    ["typecheck", passed.has("typecheck")],
    ["test", passed.has("test")],
    ["normalized_production_entry_repeat", passed.has("production_entry_first") && passed.has("production_entry_repeat")],
    ["real_file_plan_to_orchestrator", report.assertions.production_plan_reached_orchestrator === true],
    ["commit_mode_none", report.assertions.commit_mode === "none"],
    ["no_commit_or_head_change", report.assertions.commit_count_delta === 0 && report.assertions.head_unchanged === true],
    ["no_remote_or_push", report.assertions.remote_count === 0 && report.assertions.push_count === 0],
    ["state_outside_workspace", report.assertions.state_storage_outside_workspace === true],
    ["unconfigured_handoff_fails_closed", passed.has("test")],
    ["markdown_links", passed.has("markdown_links")],
    ["plugin_validation", passed.has("plugin_validation")],
    ["lint", passed.has("lint")],
    ["temporary_pilot_only", true],
  ].map(([id, itemPassed]) => ({ id, passed: itemPassed }));
  return {
    schema_version: 1,
    slice_id: "S13",
    items,
    next_gate: "personal_plugin_install_and_temporary_pilot",
    production_workspace_run_authorized: false,
    result: items.every((entry) => entry.passed) ? "PASS" : "FAIL",
  };
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) throw new Error(`S13 expected artifacts are missing: ${missing.join(", ")}`);
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S13 evidence.`);
  }
}

function currentS13Paths() {
  return collectTouchedPaths().filter(isS13OwnedPath).sort();
}

function verifyExistingEvidence(sliceSpec, checkReceipts, report, checklist) {
  assertEvidenceMatches(reportRelativePath, report);
  assertEvidenceMatches(checklistRelativePath, checklist);
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S13" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    JSON.stringify(receipt.check_receipts?.map((entry) => entry.check_id)) !==
      JSON.stringify(checkReceipts.map((entry) => entry.check_id))
  ) {
    throw new Error("The S13 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S13 output changed: ${String(output?.path)}.`);
    }
  }
  if (
    receipt.owned_diff_digest !==
      sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"))
  ) {
    throw new Error("The S13 owned diff digest is invalid.");
  }
  if (JSON.stringify(currentS13Paths()) !== JSON.stringify(receipt.touched_paths)) {
    throw new Error("Current S13 worktree paths differ from the CompletionReceipt boundary.");
  }
  process.stdout.write(`S13 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const { receipts, outputs } = runChecks(sliceSpec);
  const report = parseProductionEvidence(outputs);
  const checklist = buildChecklist(receipts, report);
  if (checklist.result !== "PASS") throw new Error("S13 release-readiness checklist failed.");

  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, report, checklist);
    return;
  }

  writeJsonAtomic(reportRelativePath, report);
  writeJsonAtomic(checklistRelativePath, checklist);
  validateExpectedArtifacts(sliceSpec, false);
  const touchedBeforeReceipt = currentS13Paths().filter((entry) => entry !== receiptRelativePath);
  const outputDigests = touchedBeforeReceipt.map((relativePath) => ({
    path: relativePath,
    digest: sha256File(path.join(repoRoot, relativePath)),
  }));
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S13",
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
  process.stdout.write(`S13 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
