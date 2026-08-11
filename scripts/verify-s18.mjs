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
const contractRelativePath = "contracts/slices/S18.json";
const contractPath = path.join(repoRoot, contractRelativePath);
const inputRelativePath = "artifacts/s17/completion-receipt.json";
const reportRelativePath = "artifacts/s18/migration-report.json";
const receiptRelativePath = "artifacts/s18/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;
const legacyProductionSymbols = [
  "source_persisted_revision",
  "persisted_revision",
  "ThreadRevisionProvider",
  "OpaqueStableRevision",
  "THREAD_REVISION_UNAVAILABLE",
];
const surfacePaths = [
  "src/controller/state/types.ts",
  "src/controller/state/validation.ts",
  "src/controller/compaction-monitor/compaction-monitor.ts",
  "src/controller/thread-control/types.ts",
  "src/controller/thread-control/source-interruption-coordinator.ts",
  "src/controller/production/codex-app-server-development-task.ts",
  "src/controller/handoff/types.ts",
  "src/controller/handoff/compression-handoff-coordinator.ts",
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
    throw new Error(`S18 production surface is missing ${label}.`);
  }
}

function verifyContract() {
  if (!existsSync(contractPath)) throw new Error(`${contractRelativePath} is missing.`);
  const contract = parseJsonFile(contractPath);
  if (
    contract?.id !== "S18" ||
    contract.contract_version !== 1 ||
    !Array.isArray(contract.requires) ||
    !contract.requires.includes("S17")
  ) {
    throw new Error("contracts/slices/S18.json is not the expected SliceSpec v1.");
  }
  const input = contract.inputs?.find((entry) => entry?.path === inputRelativePath);
  if (input?.digest !== sha256File(path.join(repoRoot, inputRelativePath))) {
    throw new Error("S18 input does not match the frozen S17 CompletionReceipt.");
  }
  return contract;
}

function verifyProductionSurface() {
  const sourceFiles = listFiles(path.join(repoRoot, "src"))
    .filter((filePath) => filePath.endsWith(".ts"));
  const legacyMatches = [];
  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, "utf8");
    for (const symbol of legacyProductionSymbols) {
      if (source.includes(symbol)) {
        legacyMatches.push({
          path: normalizeRepoPath(path.relative(repoRoot, filePath)),
          symbol,
        });
      }
    }
  }
  if (legacyMatches.length !== 0) {
    throw new Error(`S18 legacy revision symbols remain under src: ${JSON.stringify(legacyMatches)}.`);
  }

  const stateTypes = readFileSync(path.join(repoRoot, surfacePaths[0]), "utf8");
  const stateValidation = readFileSync(path.join(repoRoot, surfacePaths[1]), "utf8");
  const compactionMonitor = readFileSync(path.join(repoRoot, surfacePaths[2]), "utf8");
  const interruptionTypes = readFileSync(path.join(repoRoot, surfacePaths[3]), "utf8");
  const coordinator = readFileSync(path.join(repoRoot, surfacePaths[4]), "utf8");
  const adapter = readFileSync(path.join(repoRoot, surfacePaths[5]), "utf8");
  const handoffTypes = readFileSync(path.join(repoRoot, surfacePaths[6]), "utf8");
  const handoffCoordinator = readFileSync(path.join(repoRoot, surfacePaths[7]), "utf8");

  requireIncludes(
    stateTypes,
    "readonly source_interruption_schema_version?: 2;",
    "the replay-compatible S18 state marker",
  );
  requireIncludes(
    stateValidation,
    '["source_interruption_schema_version"]',
    "optional legacy state decoding",
  );
  requireIncludes(
    compactionMonitor,
    "source_interruption_schema_version: 2",
    "new compaction marker persistence",
  );
  for (const fragment of [
    "readonly turn_id: string;",
    'readonly terminal_status: "interrupted";',
    "readonly persistent: true;",
  ]) {
    requireIncludes(interruptionTypes, fragment, `InterruptReceiptV2 fragment ${fragment}`);
  }
  requireIncludes(
    coordinator,
    '"source_interruption_migration_required"',
    "legacy in-flight migration closure",
  );
  requireIncludes(
    coordinator,
    "source_interruption_schema_version !== 2",
    "state marker migration branch",
  );
  for (const fragment of [
    "decodeAppServerThreadReadParams",
    "decodeAppServerThreadReadResponse",
    "terminalSignal",
    'terminal.outcome !== "INTERRUPTED"',
    "includeTurns: false",
  ]) {
    requireIncludes(adapter, fragment, `App Server interruption adapter fragment ${fragment}`);
  }
  if (handoffTypes.includes("source_persisted_revision")) {
    throw new Error("CompressionRequest still carries the pre-S18 persisted revision token.");
  }
  requireIncludes(
    handoffCoordinator,
    "!sha256Digest(value.source_revision)",
    "export-owned canonical Source revision validation",
  );

  const surfaces = surfacePaths.map((relativePath) => ({
    path: relativePath,
    digest: sha256File(path.join(repoRoot, relativePath)),
  }));
  return {
    schema_version: 1,
    source_interruption_schema_version: 2,
    source_revision_authority: "export-codex-handoff",
    thread_read: {
      include_turns: false,
      accepts_empty_turns: true,
      rejects_nonempty_turns_or_items: true,
    },
    interrupt_receipt: {
      terminal_status: "interrupted",
      thread_turn_bound: true,
      persisted_revision_present: false,
    },
    legacy_in_flight: {
      outcome: "NEEDS_USER",
      reason: "source_interruption_migration_required",
      rewrites_completed_effect_receipt: false,
    },
    legacy_production_matches: legacyMatches,
    production_typescript_file_count: sourceFiles.length,
    surfaces,
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
      throw new Error(`S18 check ${String(check.id)} has an invalid argv.`);
    }
    const result = runCommand(check.argv, timeoutFor(check.id));
    if (result.exitCode !== check.expected_exit_code) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `S18 deterministic check ${String(check.id)} failed with exit ${String(result.exitCode)}.`,
      );
    }
    process.stdout.write(`S18_CHECK_PASS ${String(check.id)}\n`);
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
    if (typeof ownedPath !== "string") throw new Error("S18 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) =>
        normalizeRepoPath(path.relative(repoRoot, filePath))
      ));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S18 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(contract, surface, checks) {
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  const report = {
    ...surface,
    slice_id: "S18",
    result: "PASS",
    surface_digest: surfaceDigest,
    negative_contracts: [
      "completed terminal after turn/interrupt rejected",
      "non-empty turns or any items rejected",
      "observed delete rejected",
      "legacy in-flight interruption requires migration",
      "non-canonical export revision rejected",
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
    slice_id: "S18",
    result: "PASS",
    contract_digest: sha256File(contractPath),
    input_receipt_digest: sha256File(path.join(repoRoot, inputRelativePath)),
    surface_digest: surfaceDigest,
    output_digests: outputDigests,
    check_receipts: checks,
  };
  writeJsonAtomic(receiptRelativePath, receipt);
  return { report, receipt };
}

function main() {
  const contract = verifyContract();
  const surface = verifyProductionSurface();
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  if (process.argv.includes("--surface-only")) {
    process.stdout.write(`S18_SURFACE_PASS ${surfaceDigest}\n`);
    return;
  }
  const checks = runChecks(contract);
  writeEvidence(contract, surface, checks);
  process.stdout.write(`S18_SURFACE_PASS ${surfaceDigest}\n`);
  process.stdout.write(`S18_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S18 CompletionReceipt: ${receiptRelativePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
