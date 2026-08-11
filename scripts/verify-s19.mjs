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
const contractRelativePath = "contracts/slices/S19.json";
const contractPath = path.join(repoRoot, contractRelativePath);
const inputRelativePaths = [
  "artifacts/s17/completion-receipt.json",
  "artifacts/s18/completion-receipt.json",
];
const reportRelativePath = "artifacts/s19/session-foundation-report.json";
const receiptRelativePath = "artifacts/s19/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;
const surfacePaths = [
  "src/controller/production/app-server-client.ts",
  "src/controller/production/app-server-fresh-task-session.ts",
  "src/controller/production/codex-app-server-development-task.ts",
  "src/controller/production/codex-app-server-task-host.ts",
  "src/controller/production/index.ts",
  "test/app-server-fresh-task-session.test.ts",
  "test/fixtures/process/fake-s19-app-server.mjs",
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
    throw new Error(`S19 production surface is missing ${label}.`);
  }
}

function verifyContract() {
  if (!existsSync(contractPath)) throw new Error(`${contractRelativePath} is missing.`);
  const contract = parseJsonFile(contractPath);
  if (
    contract?.id !== "S19" ||
    contract.contract_version !== 1 ||
    canonicalJson(contract.requires) !== canonicalJson(["S17", "S18"])
  ) {
    throw new Error("contracts/slices/S19.json is not the expected SliceSpec v1.");
  }
  for (const relativePath of inputRelativePaths) {
    const input = contract.inputs?.find((entry) => entry?.path === relativePath);
    if (input?.digest !== sha256File(path.join(repoRoot, relativePath))) {
      throw new Error(`S19 input does not match its frozen CompletionReceipt: ${relativePath}`);
    }
  }
  const budgets = contract.budgets;
  if (
    budgets?.shared_app_server_clients_per_host !== 1 ||
    budgets.active_turns_per_fresh_thread !== 1 ||
    budgets.maximum_turns_per_fresh_thread !== 16 ||
    budgets.maximum_completed_items_per_turn !== 64 ||
    budgets.maximum_completed_item_bytes !== 1024 * 1024 ||
    budgets.maximum_turn_projection_bytes !== 2 * 1024 * 1024 ||
    budgets.controller_raw_content_fields !== 0
  ) {
    throw new Error("S19 contract budgets drifted from the fresh-task session foundation.");
  }
  return contract;
}

function verifyProductionSurface() {
  for (const relativePath of surfacePaths) {
    if (!existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`S19 surface is missing: ${relativePath}`);
    }
  }
  const client = readFileSync(path.join(repoRoot, surfacePaths[0]), "utf8");
  const sessions = readFileSync(path.join(repoRoot, surfacePaths[1]), "utf8");
  const development = readFileSync(path.join(repoRoot, surfacePaths[2]), "utf8");
  const host = readFileSync(path.join(repoRoot, surfacePaths[3]), "utf8");
  const tests = readFileSync(path.join(repoRoot, surfacePaths[5]), "utf8");

  for (const [source, fragment, label] of [
    [client, "attachPrivateNotificationRouter", "the single private notification router"],
    [client, 'privateRoute === "UNHANDLED"', "private-first raw notification demux"],
    [client, "this.firewall.project(message)", "the existing Controller firewall fallback"],
    [sessions, "decodeAppServerFreshThreadStartResponse", "fresh-root protocol decoding"],
    [sessions, 'phase: "READY" | "TURN_STARTING" | "TURN_ACTIVE" | "TURN_TERMINAL" | "FAILED"', "the private Turn state machine"],
    [sessions, "maximumCompletedItemBytes", "the per-item private projection bound"],
    [sessions, "projectedTypes", "the completed-item allowlist"],
    [development, "sharedClient?: CodexAppServerClient", "borrowed shared client support"],
    [development, "this.ownsClient", "client ownership separation"],
    [host, "this.client = new CodexAppServerClient(options)", "one Host-owned App Server client"],
    [host, "this.fresh_task_sessions", "the Host fresh-task session port"],
    [host, "this.disposePromise ??= this.disposeOnce()", "single client disposal"],
    [tests, "s19-cross-thread", "cross-thread failure coverage"],
    [tests, "s19-late-item", "late item failure coverage"],
    [tests, "PRIVATE_CANARY", "private content canary coverage"],
  ]) {
    requireIncludes(source, fragment, label);
  }

  return {
    schema_version: 1,
    shared_connection: {
      clients_per_task_host: 1,
      initialization_count: 1,
      roots_in_trace: 3,
      distinct_root_uuids: true,
      dispose_once: true,
    },
    fresh_root: {
      method: "thread/start",
      resume_calls: 0,
      fork_calls: 0,
      requires_session_id_equal_id: true,
      requires_parentless_unforked_persistent_empty_history: true,
    },
    turn_registry: {
      active_turns_per_thread: 1,
      maximum_turns_per_session: 16,
      transition: "TURN_ACTIVE -> TURN_TERMINAL -> TURN_ACTIVE",
      rejects_cross_thread: true,
      rejects_cross_turn: true,
      rejects_late_item: true,
    },
    private_projection: {
      maximum_completed_items_per_turn: 64,
      maximum_completed_item_bytes: 1024 * 1024,
      maximum_turn_projection_bytes: 2 * 1024 * 1024,
      completed_item_type_allowlist: true,
      controller_raw_content_fields: 0,
      raw_content_in_error_details: false,
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
      throw new Error(`S19 check ${String(check.id)} has an invalid argv.`);
    }
    const result = runCommand(check.argv, timeoutFor(check.id));
    if (result.exitCode !== check.expected_exit_code) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `S19 deterministic check ${String(check.id)} failed with exit ${String(result.exitCode)}.`,
      );
    }
    process.stdout.write(`S19_CHECK_PASS ${String(check.id)}\n`);
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
    if (typeof ownedPath !== "string") throw new Error("S19 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) =>
        normalizeRepoPath(path.relative(repoRoot, filePath))
      ));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S19 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(contract, surface, checks) {
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  const report = {
    ...surface,
    slice_id: "S19",
    result: "PASS",
    surface_digest: surfaceDigest,
    negative_contracts: [
      "two active Turns rejected",
      "late completed item rejected",
      "cross-thread and cross-Turn private events rejected",
      "ephemeral, parented, forked, reused, or non-empty roots rejected",
      "oversized private item rejected without content leakage",
      "Controller listeners receive zero private item content",
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
    slice_id: "S19",
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
    process.stdout.write(`S19_SURFACE_PASS ${surfaceDigest}\n`);
    return;
  }
  const checks = runChecks(contract);
  writeEvidence(contract, surface, checks);
  process.stdout.write(`S19_SURFACE_PASS ${surfaceDigest}\n`);
  process.stdout.write(`S19_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S19 CompletionReceipt: ${receiptRelativePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
