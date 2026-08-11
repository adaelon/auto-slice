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
const contractRelativePath = "contracts/slices/S21.json";
const contractPath = path.join(repoRoot, contractRelativePath);
const inputRelativePaths = ["artifacts/s20/completion-receipt.json"];
const reportRelativePath = "artifacts/s21/continuation-launcher-report.json";
const receiptRelativePath = "artifacts/s21/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;
const surfacePaths = [
  "src/controller/continuation/app-server-continuation-launcher.ts",
  "src/controller/continuation/continuation-coordinator.ts",
  "src/controller/continuation/index.ts",
  "src/controller/continuation/types.ts",
  "src/controller/production/codex-app-server-task-host.ts",
  "test/continuation.test.ts",
  "test/file-production-runtime.test.ts",
  "test/production-orchestrator.test.ts",
  "test/fixtures/process/fake-s21-app-server.mjs",
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
    throw new Error(`S21 production surface is missing ${label}.`);
  }
}

function verifyContract() {
  if (!existsSync(contractPath)) throw new Error(`${contractRelativePath} is missing.`);
  const contract = parseJsonFile(contractPath);
  if (
    contract?.id !== "S21" ||
    contract.contract_version !== 1 ||
    canonicalJson(contract.requires) !== canonicalJson(["S20"])
  ) {
    throw new Error("contracts/slices/S21.json is not the expected SliceSpec v1.");
  }
  for (const relativePath of inputRelativePaths) {
    const input = contract.inputs?.find((entry) => entry?.path === relativePath);
    if (input?.digest !== sha256File(path.join(repoRoot, relativePath))) {
      throw new Error(`S21 input does not match its frozen CompletionReceipt: ${relativePath}`);
    }
  }
  const budgets = contract.budgets;
  if (
    budgets?.continuation_thread_roots !== 1 ||
    budgets.continuation_turns !== 2 ||
    budgets.first_turn_input_items !== 2 ||
    budgets.maximum_handoff_markdown_bytes !== 1024 * 1024 ||
    budgets.first_turn_tool_or_write_items !== 0 ||
    budgets.workspace_write_turns_before_ready !== 0 ||
    budgets.model_reported_receipt_fields !== 0
  ) {
    throw new Error("S21 contract budgets drifted from the Continuation launcher boundary.");
  }
  return contract;
}

function verifyProductionSurface() {
  for (const relativePath of surfacePaths) {
    if (!existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`S21 surface is missing: ${relativePath}`);
    }
  }
  const launcher = readFileSync(path.join(repoRoot, surfacePaths[0]), "utf8");
  const coordinator = readFileSync(path.join(repoRoot, surfacePaths[1]), "utf8");
  const exports = readFileSync(path.join(repoRoot, surfacePaths[2]), "utf8");
  const types = readFileSync(path.join(repoRoot, surfacePaths[3]), "utf8");
  const host = readFileSync(path.join(repoRoot, surfacePaths[4]), "utf8");
  const tests = readFileSync(path.join(repoRoot, surfacePaths[5]), "utf8");
  const runtimeTests = readFileSync(path.join(repoRoot, surfacePaths[6]), "utf8");
  const orchestratorTests = readFileSync(path.join(repoRoot, surfacePaths[7]), "utf8");
  const fakeServer = readFileSync(path.join(repoRoot, surfacePaths[8]), "utf8");

  for (const [source, fragment, label] of [
    [launcher, "validHandoffReceiptBinding", "V2 and legacy receipt binding gate"],
    [launcher, "legacyReplayBinding", "legacy replay compatibility"],
    [launcher, "this.readVerifiedHandoff(envelope)", "pre-launch Handoff byte verification"],
    [launcher, 'kind: "continuation"', "fresh Continuation root"],
    [launcher, '{ type: "text", text: firstTurnGoal(envelope), text_elements: [] }', "bounded first-Turn goal item"],
    [launcher, '{ type: "text", text: handoffInput(markdown), text_elements: [] }', "verified Handoff body item"],
    [launcher, 'sandbox_policy: { type: "readOnly", networkAccess: false }', "read-only first Turn"],
    [launcher, "project_completed_item_types: READ_TURN_PROJECTED_ITEMS", "private readiness projection"],
    [launcher, "PROHIBITED_READ_TURN_ITEMS.has", "tool-before-draft rejection"],
    [launcher, "first_deliverable_draft_digest: sha256Bytes(draft.text)", "machine draft digest"],
    [launcher, "pre_draft_evidence_reads: 0", "synthesize-first read budget"],
    [launcher, "write_access: false", "ReadyReceipt no-write proof"],
    [launcher, 'active.phase !== "READY"', "Ready-before-write state gate"],
    [launcher, 'type: "workspaceWrite"', "workspace-write second Turn"],
    [launcher, "project_completed_item_types: []", "content-blind write Turn projection"],
    [launcher, "verification_receipt_digest: boundedTurnProjectionDigest(terminal)", "terminal ProgressReceipt"],
    [coordinator, "type VerifiedHandoffReceipt = HandoffReceipt | HandoffReceiptV2", "explicit receipt compatibility union"],
    [coordinator, "decodeAndVerifyHandoffReceiptV2", "machine V2 verification"],
    [coordinator, "launcherFailureReason", "launcher failure mapping"],
    [coordinator, 'case "READY_EVIDENCE_INVALID"', "Ready failure mapping"],
    [coordinator, 'case "WRITE_EPOCH_MISMATCH"', "write epoch failure mapping"],
    [coordinator, 'case "CONTINUATION_WRITE_TURN_FAILED"', "Progress failure mapping"],
    [types, "handoff_receipt_schema_version?: 2", "legacy-compatible ResumeEnvelope"],
    [exports, "AppServerContinuationTaskLauncher", "public production launcher export"],
    [host, "new AppServerContinuationTaskLauncher", "default production composition"],
    [tests, "default Host and ContinuationCoordinator consume one HandoffReceiptV2 end to end", "real Coordinator V2 integration"],
    [tests, "default Host replays a legacy Handoff receipt during V2 migration", "legacy replay integration"],
    [tests, "maps ${scenario} through the real Coordinator", "real Coordinator error integration"],
    [tests, '["no-draft", "consumer_contract_violated", "READY_EVIDENCE_INVALID", 1]', "Ready error mapping case"],
    [tests, '["write-turn-failed", "progress_call_failed", "CONTINUATION_WRITE_TURN_FAILED", 2]', "Progress error mapping case"],
    [tests, "changed Handoff bytes before any Continuation turn/start", "pre-input tamper coverage"],
    [tests, "tool-before-draft", "tool-before-draft coverage"],
    [tests, "ignores model-reported receipt fields", "model receipt rejection"],
    [runtimeTests, "wires real Compression and Continuation launchers", "composition regression"],
    [orchestratorTests, "compression_turn_id: handoffReceipt.compression_turn_id", "V2 orchestration envelope"],
    [fakeServer, 'scenario === "tool-before-draft"', "tool-before-draft fixture"],
    [fakeServer, 'scenario === "write-turn-failed"', "write failure fixture"],
  ]) {
    requireIncludes(source, fragment, label);
  }

  const verifyIndex = launcher.indexOf("const markdown = await this.readVerifiedHandoff(envelope)");
  const freshRootIndex = launcher.indexOf("session = await this.options.fresh_task_sessions.start");
  if (verifyIndex < 0 || freshRootIndex < 0 || verifyIndex >= freshRootIndex) {
    throw new Error("S21 Handoff bytes are not verified before fresh Continuation creation.");
  }
  const readyGuardIndex = launcher.indexOf('if (active.phase !== "READY"');
  const writeTurnIndex = launcher.indexOf(
    "const turn = await active.session.startTurn({",
    readyGuardIndex,
  );
  if (readyGuardIndex < 0 || writeTurnIndex < 0 || readyGuardIndex >= writeTurnIndex) {
    throw new Error("S21 workspace-write Turn is not ordered after the Ready state gate.");
  }
  for (const prohibited of ["thread/resume", "thread/fork", "turn/steer", "JSON.parse(draft.text)"]) {
    if (launcher.includes(prohibited)) {
      throw new Error(`S21 launcher contains prohibited production behavior: ${prohibited}`);
    }
  }

  return {
    schema_version: 1,
    launcher: {
      default_host_composition: true,
      continuation_thread_roots: 1,
      continuation_turns: 2,
      first_turn_input_items: 2,
      first_turn_sandbox: "readOnly",
      second_turn_sandbox: "workspaceWrite",
      model: "gpt-5.6-sol/max",
      workspace_write_turns_before_ready: 0,
    },
    receipts: {
      ready_source: "private terminal projection",
      lease_source: "ResumeEnvelope lease and write epoch",
      progress_source: "workspace-write terminal projection",
      model_reported_fields: 0,
    },
    compatibility: {
      handoff_receipt_v2: true,
      legacy_handoff_replay: true,
    },
    failure_mapping: {
      HANDOFF_INTEGRITY_FAILED: "handoff_integrity_failed/handoff_artifact_digest_mismatch",
      READY_EVIDENCE_INVALID: "continuation_start_failed/consumer_contract_violated",
      WRITE_EPOCH_MISMATCH: "continuation_start_failed/write_epoch_mismatch",
      CONTINUATION_WRITE_TURN_FAILED: "continuation_start_failed/progress_call_failed",
    },
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
  if (checkId === "test") return 300_000;
  if (checkId === "target_test") return 180_000;
  return 120_000;
}

function runChecks(contract) {
  return contract.checks.map((check) => {
    if (!Array.isArray(check.argv) || check.argv.some((entry) => typeof entry !== "string")) {
      throw new Error(`S21 check ${String(check.id)} has an invalid argv.`);
    }
    const result = runCommand(check.argv, timeoutFor(check.id));
    if (result.exitCode !== check.expected_exit_code) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `S21 deterministic check ${String(check.id)} failed with exit ${String(result.exitCode)}.`,
      );
    }
    process.stdout.write(`S21_CHECK_PASS ${String(check.id)}\n`);
    return {
      check_id: check.id,
      argv: check.argv,
      exit_code: result.exitCode,
    };
  });
}

function expandOwnedPaths(contract) {
  const paths = [];
  for (const ownedPath of contract.owned_paths ?? []) {
    if (typeof ownedPath !== "string") throw new Error("S21 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) =>
        normalizeRepoPath(path.relative(repoRoot, filePath))
      ));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S21 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(contract, surface, checks) {
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  const report = {
    ...surface,
    slice_id: "S21",
    result: "PASS",
    surface_digest: surfaceDigest,
    negative_contracts: [
      "changed, missing, linked, oversized, non-UTF-8, or boundary-colliding Handoff rejected before task input",
      "non-fresh or reused Continuation identity rejected",
      "tool/write before draft, missing draft, and non-completed first Turn produce no ReadyReceipt",
      "workspace-write Turn cannot start before verified ReadyReceipt or with a different write epoch",
      "model-reported receipt fields provide zero Ready, Lease, or Progress fields",
      "failed workspace-write terminal produces no ProgressReceipt and freezes the rotated lease",
      "legacy Handoff receipt remains replayable while machine V2 is the production input",
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
    slice_id: "S21",
    result: "PASS",
    contract_digest: sha256File(contractPath),
    input_receipt_digests: inputRelativePaths.map((relativePath) => ({
      path: relativePath,
      digest: sha256File(path.join(repoRoot, relativePath)),
    })),
    surface_digest: surfaceDigest,
    output_digests: outputDigests,
    check_receipts: checks,
  };
  writeJsonAtomic(receiptRelativePath, receipt);
}

function main() {
  const contract = verifyContract();
  const surface = verifyProductionSurface();
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  if (process.argv.includes("--surface-only")) {
    process.stdout.write(`S21_SURFACE_PASS ${surfaceDigest}\n`);
    return;
  }
  const checks = runChecks(contract);
  writeEvidence(contract, surface, checks);
  process.stdout.write(`S21_SURFACE_PASS ${surfaceDigest}\n`);
  process.stdout.write(`S21_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S21 CompletionReceipt: ${receiptRelativePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
