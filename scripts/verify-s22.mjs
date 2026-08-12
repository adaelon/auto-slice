#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const contractRelativePath = "contracts/slices/S22.json";
const contractPath = path.join(repoRoot, contractRelativePath);
const inputRelativePaths = [
  "artifacts/s20/completion-receipt.json",
  "artifacts/s21/completion-receipt.json",
];
const hermeticReportRelativePath = "artifacts/s22/hermetic-chain-report.json";
const liveReportRelativePath = "artifacts/s22/live-chain-report.json";
const reportRelativePath = "artifacts/s22/default-production-chain-report.json";
const receiptRelativePath = "artifacts/s22/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;
const expectedTrace = [
  "SOURCE:turn/interrupt",
  "SOURCE:thread/read",
  "COMPRESSION:skills/list",
  "COMPRESSION:thread/start",
  "COMPRESSION:turn/start",
  "CONTINUATION:thread/start",
  "CONTINUATION:turn/start:readOnly",
  "CONTINUATION:turn/start:workspaceWrite",
];
const surfacePaths = [
  "src/controller/production/file-production-runtime.ts",
  "scripts/run-s22-hermetic.mjs",
  "scripts/run-s22-live-canary.mjs",
  "scripts/s22-app-server-proxy.mjs",
  "test/fixtures/process/fake-s22-app-server.mjs",
  "test/fixtures/s22-export-codex-handoff/SKILL.md",
  "test/fixtures/s22-export-codex-handoff/scripts/export-handoff.mjs",
  "src/controller/handoff/app-server-compression-task-launcher.ts",
];

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
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

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function requireIncludes(source, fragment, label) {
  if (!source.includes(fragment)) {
    throw new Error(`S22 production surface is missing ${label}.`);
  }
}

function verifyContract() {
  if (!existsSync(contractPath)) throw new Error(`${contractRelativePath} is missing.`);
  const contract = parseJsonFile(contractPath);
  if (
    contract?.id !== "S22" ||
    contract.contract_version !== 1 ||
    canonicalJson(contract.requires) !== canonicalJson(["S20", "S21"])
  ) {
    throw new Error("contracts/slices/S22.json is not the expected SliceSpec v1.");
  }
  for (const relativePath of inputRelativePaths) {
    const input = contract.inputs?.find((entry) => entry?.path === relativePath);
    if (input?.digest !== sha256File(path.join(repoRoot, relativePath))) {
      throw new Error(`S22 input does not match its frozen CompletionReceipt: ${relativePath}`);
    }
  }
  const budgets = contract.budgets;
  if (
    budgets?.hermetic_timeout_boundary_ms !== 30_000 ||
    budgets.live_chain_budget_ms !== 1_200_000 ||
    budgets.live_chain_budget_origin !== "SOURCE_INTERRUPT" ||
    budgets.source_ready_timeout_ms !== 120_000 ||
    budgets.task_roots !== 3 ||
    budgets.protocol_steps !== expectedTrace.length ||
    budgets.receipt_command_evidence_items !== 0 ||
    budgets.receipt_final_result_file_addresses !== 1 ||
    budgets.receipt_evidence_index_addresses !== 0 ||
    budgets.host_verify_evidence_calls !== 0 ||
    budgets.controller_worker_content_canary_hits !== 0 ||
    budgets.remote_connections !== 0 ||
    budgets.user_source_runs !== 0
  ) {
    throw new Error("S22 contract budgets drifted from the two-layer production gate.");
  }
  return contract;
}

function verifyPriorCompletionReceipts() {
  return Array.from({ length: 21 }, (_, index) => `S${String(index + 1).padStart(2, "0")}`)
    .map((sliceId) => {
      const contractFile = path.join(repoRoot, "contracts", "slices", `${sliceId}.json`);
      const receiptFile = path.join(
        repoRoot,
        "artifacts",
        sliceId.toLowerCase(),
        "completion-receipt.json",
      );
      if (!existsSync(contractFile) || !existsSync(receiptFile)) {
        throw new Error(`S22 prerequisite evidence is missing for ${sliceId}.`);
      }
      const receipt = parseJsonFile(receiptFile);
      const currentContractBindingRequired = Number.parseInt(sliceId.slice(1), 10) >= 17;
      const historicalPass =
        receipt?.result === undefined &&
        typeof receipt?.completed_at === "string" &&
        Array.isArray(receipt?.check_receipts) &&
        receipt.check_receipts.length > 0 &&
        receipt.check_receipts.every((entry) => entry?.exit_code === 0);
      if (
        receipt?.slice_id !== sliceId ||
        (receipt.result !== "PASS" && !historicalPass) ||
        (currentContractBindingRequired && receipt.contract_digest !== sha256File(contractFile))
      ) {
        throw new Error(`S22 prerequisite CompletionReceipt is invalid for ${sliceId}.`);
      }
      return {
        slice_id: sliceId,
        contract_digest: receipt.contract_digest,
        contract_binding: currentContractBindingRequired ? "current" : "historical_receipt",
        receipt_digest: sha256File(receiptFile),
      };
    });
}

function verifyProductionSurface() {
  for (const relativePath of surfacePaths) {
    if (!existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`S22 surface is missing: ${relativePath}`);
    }
  }
  const runtime = readFileSync(path.join(repoRoot, surfacePaths[0]), "utf8");
  const hermetic = readFileSync(path.join(repoRoot, surfacePaths[1]), "utf8");
  const live = readFileSync(path.join(repoRoot, surfacePaths[2]), "utf8");
  const proxy = readFileSync(path.join(repoRoot, surfacePaths[3]), "utf8");
  const compressionLauncher = readFileSync(path.join(repoRoot, surfacePaths.at(-1)), "utf8");

  for (const status of [
    "COMPACTION_WAIT",
    "SOURCE_INTERRUPTING",
    "HANDOFF_EXPORTING",
    "CONTINUATION_STARTING",
  ]) {
    requireIncludes(runtime, `  "${status}",`, `${status} lease heartbeat coverage`);
  }
  for (const [source, fragment, label] of [
    [hermetic, "new CodexAppServerTaskHost", "default hermetic Host composition"],
    [hermetic, "elapsedMs >= 29_000", "real 30 second timeout boundary"],
    [hermetic, 'status: "HERMETIC_CHAIN_PASS"', "hermetic PASS marker"],
    [hermetic, "canary_hits: 0", "hermetic canary budget"],
    [live, 'const expectedCliVersion = "0.146.0"', "pinned live CLI version"],
    [live, "const liveBudgetMs = 1_200_000", "bounded live budget"],
    [live, "const sourceReadyTimeoutMs = 120_000", "bounded Source readiness handshake"],
    [live, 'status: "LIVE_CHAIN_PASS"', "live PASS marker"],
    [live, 'status: "LIVE_CHAIN_BLOCKED"', "live blocker marker"],
    [live, "remote_git_connections: 0", "live remote connection budget"],
    [live, "user_source_runs: 0", "live user Source budget"],
    [live, "cleanup-interrupt", "disposable Source cleanup on every exit"],
    [proxy, 'kind: "turn_terminal"', "bounded live terminal trace"],
    [proxy, "Never retain raw output in the trace.", "content-blind live trace"],
    [compressionLauncher, 'project_completed_item_types: ["agentMessage"]', "final-result-only projection"],
    [compressionLauncher, "firstMarkdownFileAddress", "first file-address extraction"],
    [compressionLauncher, "HANDOFF_RESULT_RECEIPT_SCHEMA_VERSION", "path-only receipt binding"],
  ]) {
    requireIncludes(source, fragment, label);
  }
  if (compressionLauncher.includes("spawnVerifyEvidence") || compressionLauncher.includes('"verify-evidence"')) {
    throw new Error("S22 production surface still invokes HANDOFF_VERIFY.");
  }

  return {
    schema_version: 1,
    lease_heartbeat_statuses: [
      "PREPARING",
      "SLICE_RUNNING",
      "COMPACTION_WAIT",
      "SOURCE_INTERRUPTING",
      "HANDOFF_EXPORTING",
      "CONTINUATION_STARTING",
      "VERIFYING",
      "COMMITTING",
      "CHECKPOINTING",
    ],
    hermetic_gate: {
      timeout_boundary_ms: 30_000,
      default_host_composition: true,
      fake_app_server: true,
      real_export_helper_fixture: true,
    },
    live_gate: {
      codex_cli_version: "0.146.0",
      disposable_workspace: true,
      live_chain_budget_ms: 1_200_000,
      live_chain_budget_origin: "SOURCE_INTERRUPT",
      source_ready_timeout_ms: 120_000,
      blocker_is_not_pass: true,
    },
    prerequisite_completion_receipts: verifyPriorCompletionReceipts(),
    surfaces: surfacePaths.map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    })),
  };
}

function resolveNpm(args) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (npmCli === undefined) throw new Error("npm-cli.js could not be located without a command shell.");
  return { command: process.execPath, args: [npmCli, ...args] };
}

function runCommand(argv, timeoutMs) {
  const [requestedCommand, ...requestedArgs] = argv;
  if (requestedCommand === undefined) throw new Error("Cannot run an empty argv array.");
  const executable = requestedCommand === "npm"
    ? resolveNpm(requestedArgs)
    : { command: requestedCommand, args: requestedArgs };
  const result = spawnSync(executable.command, executable.args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: maximumOutputBytes,
    shell: false,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}${
    result.error === undefined ? "" : `${result.error.name}: ${result.error.message}\n`
  }`;
  return {
    exitCode: result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1),
    stderr,
    stdout,
  };
}

function timeoutFor(checkId) {
  if (checkId === "live_chain") return 1_260_000;
  if (checkId === "test") return 300_000;
  if (checkId === "target_test" || checkId === "hermetic_chain") return 180_000;
  return 120_000;
}

function parseGateReport(result, expectedStatus) {
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1 || result.stderr.length !== 0) {
    throw new Error(`${expectedStatus} did not emit one bounded JSON line.`);
  }
  const report = JSON.parse(lines[0]);
  if (
    report?.status !== expectedStatus ||
    report.canary_hits !== 0 ||
    report.handoff_receipt_schema_version !== 3 ||
    report.handoff_result?.first_markdown_file_address_used !== true ||
    report.handoff_result?.evidence_index_address_ignored !== true ||
    report.handoff_result?.host_verify_evidence_calls !== 0 ||
    canonicalJson(report.protocol_trace) !== canonicalJson(expectedTrace) ||
    report.task_uuids_pairwise_distinct !== true
  ) {
    throw new Error(`${expectedStatus} report failed the common production-chain invariants.`);
  }
  if (
    expectedStatus === "HERMETIC_CHAIN_PASS" &&
    (
      report.cli_status !== "PRODUCTION_CONTINUATION_STARTED" ||
      report.timeout_boundary_ms !== 30_000 ||
      report.default_host_composition !== true ||
      report.remote_connections !== 0 ||
      report.user_source_runs !== 0
    )
  ) {
    throw new Error("HERMETIC_CHAIN_PASS report drifted from the default Host gate.");
  }
  if (
    expectedStatus === "LIVE_CHAIN_PASS" &&
    (
      report.codex_cli_version !== "0.146.0" ||
      report.disposable_workspace !== true ||
      report.live_chain_budget_ms !== 1_200_000 ||
      report.live_chain_budget_origin !== "SOURCE_INTERRUPT" ||
      report.source_ready_timeout_ms !== 120_000 ||
      report.continuation_artifact_verified !== true ||
      report.remote_git_connections !== 0 ||
      report.user_source_runs !== 0
    )
  ) {
    throw new Error("LIVE_CHAIN_PASS report drifted from the disposable App Server gate.");
  }
  return report;
}

function runChecks(contract) {
  const gateReports = new Map();
  const receipts = contract.checks.map((check) => {
    if (!Array.isArray(check.argv) || check.argv.some((entry) => typeof entry !== "string")) {
      throw new Error(`S22 check ${String(check.id)} has an invalid argv.`);
    }
    const result = runCommand(check.argv, timeoutFor(check.id));
    if (result.exitCode !== check.expected_exit_code) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `S22 deterministic check ${String(check.id)} failed with exit ${String(result.exitCode)}.`,
      );
    }
    if (check.id === "hermetic_chain") {
      gateReports.set(check.id, parseGateReport(result, "HERMETIC_CHAIN_PASS"));
    }
    if (check.id === "live_chain") {
      gateReports.set(check.id, parseGateReport(result, "LIVE_CHAIN_PASS"));
    }
    process.stdout.write(`S22_CHECK_PASS ${String(check.id)}\n`);
    return {
      check_id: check.id,
      argv: check.argv,
      exit_code: result.exitCode,
    };
  });
  return { gateReports, receipts };
}

function expandOwnedPaths(contract) {
  const paths = [];
  for (const ownedPath of contract.owned_paths ?? []) {
    if (typeof ownedPath !== "string") throw new Error("S22 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) =>
        normalizeRepoPath(path.relative(repoRoot, filePath))
      ));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S22 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(contract, surface, checkRun) {
  const hermeticReport = checkRun.gateReports.get("hermetic_chain");
  const liveReport = checkRun.gateReports.get("live_chain");
  if (hermeticReport === undefined || liveReport === undefined) {
    throw new Error("S22 cannot publish without both production-chain PASS reports.");
  }
  writeJsonAtomic(hermeticReportRelativePath, hermeticReport);
  writeJsonAtomic(liveReportRelativePath, liveReport);

  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  const report = {
    ...surface,
    slice_id: "S22",
    result: "PASS",
    production_unlocked: true,
    surface_digest: surfaceDigest,
    gates: {
      hermetic: hermeticReport.status,
      live: liveReport.status,
    },
    negative_contracts: [
      "provider timing, worker capacity, and 1200 second budget failures remain blockers",
      "a fake or shortened lease cannot satisfy the real default handoff lifecycle",
      "Source interruption and Compression request contain zero revision fields",
      "Compression helper command trajectories provide zero receipt fields",
      "the first Markdown file address in the Compression final result is the sole Handoff path",
      "Evidence Index and HANDOFF_VERIFY provide zero receipt fields",
      "Controller, RunStore, logs, traces, and reports contain zero Worker Content canary bytes",
      "a hermetic PASS without a disposable live PASS cannot unlock production",
      "no user Source Run or remote Git connection participates in either gate",
    ],
  };
  writeJsonAtomic(reportRelativePath, report);

  const outputDigests = expandOwnedPaths(contract)
    .filter((relativePath) => relativePath !== receiptRelativePath)
    .map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    }));
  const receipt = {
    schema_version: 1,
    slice_id: "S22",
    result: "PASS",
    contract_digest: sha256File(contractPath),
    input_receipt_digests: inputRelativePaths.map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    })),
    surface_digest: surfaceDigest,
    output_digests: outputDigests,
    check_receipts: checkRun.receipts,
  };
  writeJsonAtomic(receiptRelativePath, receipt);
}

function main() {
  const contract = verifyContract();
  const surface = verifyProductionSurface();
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  if (process.argv.includes("--surface-only")) {
    process.stdout.write(`S22_SURFACE_PASS ${surfaceDigest}\n`);
    return;
  }
  const checkRun = runChecks(contract);
  writeEvidence(contract, surface, checkRun);
  process.stdout.write(`S22_SURFACE_PASS ${surfaceDigest}\n`);
  process.stdout.write(`S22_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S22 CompletionReceipt: ${receiptRelativePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
