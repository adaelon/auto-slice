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
const sliceSpecPath = path.join(repoRoot, "contracts", "slices", "S12.json");
const fixturePath = path.join(repoRoot, "test", "fixtures", "s12", "scenarios.json");
const reportRelativePath = "artifacts/s12/e2e-report.json";
const coverageRelativePath = "artifacts/s12/contract-coverage.json";
const checklistRelativePath = "artifacts/s12/release-readiness-checklist.json";
const receiptRelativePath = "artifacts/s12/completion-receipt.json";
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

function isProtectedPath(relativePath) {
  return relativePath === "SESSION_CHECKPOINT.md" ||
    /^handoff-[^/]+(?:\.md|\.evidence\.json)$/u.test(relativePath);
}

function isS12OwnedPath(relativePath) {
  const exact = new Set([
    "contracts/slices/S12.json",
    "docs/代码链路.md",
    "docs/架构.md",
    "package.json",
    "scripts/check-markdown-links.mjs",
    "scripts/run-s12-e2e.mjs",
    "scripts/verify-s12.mjs",
    "test/fixtures/s12/scenarios.json",
  ]);
  return exact.has(relativePath) || relativePath.startsWith("artifacts/s12/");
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function validateHistoricalReceipt(sliceId) {
  const lower = sliceId.toLocaleLowerCase("en-US");
  const contractPath = path.join(repoRoot, "contracts", "slices", `${sliceId}.json`);
  const receiptPath = path.join(repoRoot, "artifacts", lower, "completion-receipt.json");
  const contract = parseJsonFile(contractPath);
  const receipt = parseJsonFile(receiptPath);
  if (
    contract?.id !== sliceId ||
    receipt?.slice_id !== sliceId ||
    receipt.contract_digest !== sha256File(contractPath) ||
    !Array.isArray(receipt.check_receipts) ||
    receipt.check_receipts.length === 0 ||
    receipt.check_receipts.some((entry) => entry.exit_code !== 0) ||
    !Array.isArray(receipt.output_digests) ||
    !Array.isArray(receipt.touched_paths)
  ) {
    throw new Error(`${sliceId} CompletionReceipt does not prove the prerequisite completed.`);
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (receipt.owned_diff_digest !== expectedOwnedDiffDigest) {
    throw new Error(`${sliceId} CompletionReceipt has an invalid owned diff digest.`);
  }
  return {
    slice_id: sliceId,
    contract_digest: sha256File(contractPath),
    receipt_digest: sha256File(receiptPath),
    deterministic_checks: receipt.check_receipts.length,
    expected_artifacts: contract.expected_artifacts?.length ?? 0,
    contract_digest_matches: true,
    checks_pass: true,
    completion_receipt_status: "PASS",
    result: "PASS",
  };
}

function validateSliceSpec(sliceSpec) {
  if (
    sliceSpec?.id !== "S12" ||
    sliceSpec.contract_version !== 1 ||
    JSON.stringify(sliceSpec.requires) !== JSON.stringify(["S06", "S10", "S11"])
  ) {
    throw new Error("contracts/slices/S12.json is not SliceSpec v1 requiring S06/S10/S11.");
  }
  if (!Array.isArray(sliceSpec.inputs) || !Array.isArray(sliceSpec.checks)) {
    throw new Error("S12 SliceSpec must contain inputs and checks arrays.");
  }
  for (const input of sliceSpec.inputs) {
    if (typeof input?.path !== "string" || typeof input.digest !== "string") {
      throw new Error("S12 input entries must contain path and digest strings.");
    }
    const inputPath = path.join(repoRoot, input.path);
    if (!existsSync(inputPath) || sha256File(inputPath) !== input.digest) {
      throw new Error(`S12 input digest changed for ${input.path}.`);
    }
  }
  const expectedChecks = [
    "build",
    "typecheck",
    "test",
    "s12_e2e_first",
    "s12_e2e_repeat",
    "markdown_links",
    "plugin_validation",
    "lint",
  ];
  if (JSON.stringify(sliceSpec.checks.map((check) => check?.id)) !== JSON.stringify(expectedChecks)) {
    throw new Error("S12 deterministic check order changed.");
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
    if (!check.id.startsWith("s12_e2e")) process.stdout.write(result.stdout);
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
  if (failed) throw new Error("One or more S12 deterministic checks failed.");
  return { receipts, outputs };
}

function parseEvidence(outputs) {
  const firstText = outputs.get("s12_e2e_first");
  const repeatText = outputs.get("s12_e2e_repeat");
  if (typeof firstText !== "string" || typeof repeatText !== "string") {
    throw new Error("S12 E2E checks did not produce JSON evidence.");
  }
  const first = JSON.parse(firstText);
  const repeat = JSON.parse(repeatText);
  const fixtureConfig = parseJsonFile(fixturePath);
  if (JSON.stringify(first) !== JSON.stringify(repeat)) {
    throw new Error("Repeated S12 harness output is not normalized and reproducible.");
  }
  if (
    first?.slice_id !== "S12" ||
    first.result !== "PASS" ||
    first.normalized !== true ||
    !Array.isArray(first.scenarios) ||
    JSON.stringify(first.scenarios.map((entry) => entry.id)) !== JSON.stringify(fixtureConfig.scenario_ids) ||
    first.scenarios.some((entry) => entry.result !== "PASS") ||
    first.infrastructure?.skill_helper_smoke?.result !== "PASS" ||
    first.infrastructure?.remote_git_connected !== false
  ) {
    throw new Error("S12 E2E evidence is incomplete or failing.");
  }
  const markdown = JSON.parse(outputs.get("markdown_links") ?? "null");
  if (markdown?.result !== "PASS" || !Array.isArray(markdown.failures) || markdown.failures.length !== 0) {
    throw new Error("Markdown relative-link check did not pass.");
  }
  return { report: first, markdown };
}

function buildContractCoverage(sliceSpec, historical, checkReceipts, report) {
  const rows = [...historical, {
    slice_id: "S12",
    contract_digest: sha256File(sliceSpecPath),
    receipt_digest: "self:completion-receipt",
    deterministic_checks: checkReceipts.length,
    expected_artifacts: sliceSpec.expected_artifacts.length,
    contract_digest_matches: true,
    checks_pass: checkReceipts.every((entry) => entry.exit_code === 0),
    completion_receipt_status: "PASS",
    result: "PASS",
  }];
  return {
    schema_version: 1,
    slice_id: "S12",
    covered_slices: rows.map((entry) => entry.slice_id),
    rows,
    scenario_contracts: report.scenarios.map((entry) => ({
      scenario_id: entry.id,
      result: entry.result,
    })),
    all_completion_receipts_verified: historical.length === 11,
    all_scenarios_verified: report.scenarios.length === 10,
    result: rows.every((entry) => entry.result === "PASS") ? "PASS" : "FAIL",
  };
}

function buildReleaseChecklist(checkReceipts, report, coverage, markdown) {
  const checkIds = new Set(checkReceipts.filter((entry) => entry.exit_code === 0).map((entry) => entry.check_id));
  const items = [
    ["all_s01_s12_contracts", coverage.result === "PASS"],
    ["ten_e2e_scenarios", report.scenarios.length === 10 && report.scenarios.every((entry) => entry.result === "PASS")],
    ["normalized_repeat", checkIds.has("s12_e2e_first") && checkIds.has("s12_e2e_repeat")],
    ["real_git_process_lock_helper", report.infrastructure.real_git_cli === true && report.infrastructure.real_process_tree === true && report.infrastructure.real_file_lock === true && report.infrastructure.skill_helper_smoke.result === "PASS"],
    ["build", checkIds.has("build")],
    ["typecheck", checkIds.has("typecheck")],
    ["test", checkIds.has("test")],
    ["lint", checkIds.has("lint")],
    ["plugin_validation", checkIds.has("plugin_validation")],
    ["markdown_relative_links", markdown.result === "PASS"],
    ["no_remote_or_push", report.infrastructure.remote_git_connected === false && report.scenarios.every((entry) => entry.assertions.push_count === undefined || entry.assertions.push_count === 0)],
    ["production_run_not_started", true],
    ["manual_pilot_only", true],
  ].map(([id, passed]) => ({ id, passed }));
  return {
    schema_version: 1,
    slice_id: "S12",
    items,
    next_gate: "manual_first_project_pilot",
    automatic_production_run: false,
    result: items.every((entry) => entry.passed) ? "PASS" : "FAIL",
  };
}

function validateExpectedArtifacts(sliceSpec, includeReceipt = true) {
  const missing = sliceSpec.expected_artifacts
    .map((artifact) => artifact?.path)
    .filter((artifactPath) => includeReceipt || artifactPath !== receiptRelativePath)
    .filter((artifactPath) => typeof artifactPath !== "string" || !existsSync(path.join(repoRoot, artifactPath)));
  if (missing.length > 0) throw new Error(`S12 expected artifacts are missing: ${missing.join(", ")}`);
}

function assertEvidenceMatches(relativePath, expected) {
  const actual = parseJsonFile(path.join(repoRoot, relativePath));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${relativePath} no longer matches deterministic S12 evidence.`);
  }
}

function validateWorktreeBoundary(expectedS12Paths) {
  const touched = collectTouchedPaths().filter((entry) => !isProtectedPath(entry));
  const s12Paths = touched.filter(isS12OwnedPath);
  if (!sameStringSet(s12Paths, expectedS12Paths)) {
    throw new Error("Current S12 worktree paths differ from the S12 CompletionReceipt boundary.");
  }
  const s11Receipt = parseJsonFile(path.join(repoRoot, "artifacts", "s11", "completion-receipt.json"));
  const s11Touched = new Set(s11Receipt.touched_paths);
  const s11Outputs = new Map(s11Receipt.output_digests.map((entry) => [entry.path, entry.digest]));
  const inherited = touched.filter((entry) => !isS12OwnedPath(entry));
  const unowned = inherited.filter((entry) => !s11Touched.has(entry));
  if (unowned.length > 0) {
    throw new Error(`S12 worktree contains paths outside S11 inheritance and S12 ownership: ${unowned.join(", ")}`);
  }
  for (const relativePath of inherited) {
    if (relativePath === "artifacts/s11/completion-receipt.json") continue;
    const expected = s11Outputs.get(relativePath);
    if (
      typeof expected !== "string" ||
      !existsSync(path.join(repoRoot, relativePath)) ||
      sha256File(path.join(repoRoot, relativePath)) !== expected
    ) {
      throw new Error(`Inherited S11 path changed outside S12 ownership: ${relativePath}.`);
    }
  }
  return inherited;
}

function verifyExistingEvidence(sliceSpec, checkReceipts, evidence, coverage, checklist) {
  assertEvidenceMatches(reportRelativePath, evidence.report);
  assertEvidenceMatches(coverageRelativePath, coverage);
  assertEvidenceMatches(checklistRelativePath, checklist);
  for (const scenario of evidence.report.scenarios) {
    assertEvidenceMatches(`artifacts/s12/scenarios/${scenario.id}.json`, scenario);
  }
  validateExpectedArtifacts(sliceSpec);
  const receipt = parseJsonFile(path.join(repoRoot, receiptRelativePath));
  if (
    receipt?.slice_id !== "S12" ||
    receipt.contract_digest !== sha256File(sliceSpecPath) ||
    typeof receipt.owned_diff_digest !== "string"
  ) {
    throw new Error("The S12 CompletionReceipt is inconsistent with its SliceSpec.");
  }
  const expectedCheckIds = checkReceipts.map((entry) => entry.check_id);
  const recordedCheckIds = receipt.check_receipts?.map((entry) => entry.check_id);
  if (JSON.stringify(recordedCheckIds) !== JSON.stringify(expectedCheckIds)) {
    throw new Error("The S12 CompletionReceipt has a different check set.");
  }
  for (const output of receipt.output_digests ?? []) {
    if (
      typeof output?.path !== "string" ||
      typeof output.digest !== "string" ||
      !existsSync(path.join(repoRoot, output.path)) ||
      sha256File(path.join(repoRoot, output.path)) !== output.digest
    ) {
      throw new Error(`S12 output changed: ${String(output?.path)}.`);
    }
  }
  const expectedOwnedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(receipt.output_digests), "utf8"));
  if (expectedOwnedDiffDigest !== receipt.owned_diff_digest) {
    throw new Error("The S12 owned diff digest is invalid.");
  }
  validateWorktreeBoundary(receipt.touched_paths);
  process.stdout.write(`S12 CompletionReceipt verified: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${receipt.owned_diff_digest}\n`);
}

function main() {
  const sliceSpec = parseJsonFile(sliceSpecPath);
  validateSliceSpec(sliceSpec);
  const historical = [];
  for (let index = 1; index <= 11; index += 1) {
    historical.push(validateHistoricalReceipt(`S${String(index).padStart(2, "0")}`));
  }
  const { receipts, outputs } = runChecks(sliceSpec);
  const evidence = parseEvidence(outputs);
  const coverage = buildContractCoverage(sliceSpec, historical, receipts, evidence.report);
  const checklist = buildReleaseChecklist(receipts, evidence.report, coverage, evidence.markdown);
  if (coverage.result !== "PASS" || checklist.result !== "PASS") {
    throw new Error("S12 contract coverage or release checklist failed.");
  }

  const regenerate = process.argv.includes("--regenerate");
  const receiptPath = path.join(repoRoot, receiptRelativePath);
  if (existsSync(receiptPath) && !regenerate) {
    verifyExistingEvidence(sliceSpec, receipts, evidence, coverage, checklist);
    return;
  }

  writeJsonAtomic(reportRelativePath, evidence.report);
  for (const scenario of evidence.report.scenarios) {
    writeJsonAtomic(`artifacts/s12/scenarios/${scenario.id}.json`, scenario);
  }
  writeJsonAtomic(coverageRelativePath, coverage);
  writeJsonAtomic(checklistRelativePath, checklist);
  validateExpectedArtifacts(sliceSpec, false);

  const startHead = runGit(["rev-parse", "HEAD"]).trim();
  const touchedBeforeReceipt = collectTouchedPaths()
    .filter((entry) => entry !== receiptRelativePath && !isProtectedPath(entry) && isS12OwnedPath(entry));
  const outputDigests = touchedBeforeReceipt
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    }));
  const inherited = validateWorktreeBoundary(touchedBeforeReceipt);
  const ownedDiffDigest = sha256Bytes(Buffer.from(JSON.stringify(outputDigests), "utf8"));
  const receipt = {
    schema_version: 1,
    slice_id: "S12",
    contract_digest: sha256File(sliceSpecPath),
    input_digests: sliceSpec.inputs.map((entry) => ({ path: entry.path, digest: entry.digest })),
    output_digests: outputDigests,
    touched_paths: [...touchedBeforeReceipt, receiptRelativePath].sort(),
    inherited_prerequisite_paths: inherited,
    check_receipts: receipts,
    start_head: startHead,
    end_head: null,
    owned_diff_digest: ownedDiffDigest,
    completed_at: new Date().toISOString(),
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  validateExpectedArtifacts(sliceSpec);
  process.stdout.write(`S12 CompletionReceipt: ${receiptRelativePath}\n`);
  process.stdout.write(`Owned diff digest: ${ownedDiffDigest}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
