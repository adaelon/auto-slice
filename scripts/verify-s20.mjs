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
const contractRelativePath = "contracts/slices/S20.json";
const contractPath = path.join(repoRoot, contractRelativePath);
const inputRelativePaths = [
  "artifacts/s18/completion-receipt.json",
  "artifacts/s19/completion-receipt.json",
];
const reportRelativePath = "artifacts/s20/compression-launcher-report.json";
const receiptRelativePath = "artifacts/s20/completion-receipt.json";
const maximumOutputBytes = 64 * 1024 * 1024;
const surfacePaths = [
  "src/controller/continuation/types.ts",
  "src/controller/handoff/app-server-compression-task-launcher.ts",
  "src/controller/handoff/compression-handoff-coordinator.ts",
  "src/controller/handoff/index.ts",
  "src/controller/handoff/types.ts",
  "src/controller/production/codex-app-server-task-host.ts",
  "test/handoff.test.ts",
  "test/file-production-runtime.test.ts",
  "test/production-orchestrator.test.ts",
  "test/fixtures/export-codex-handoff/SKILL.md",
  "test/fixtures/export-codex-handoff/scripts/export-handoff.mjs",
  "test/fixtures/process/fake-s20-app-server.mjs",
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
    throw new Error(`S20 production surface is missing ${label}.`);
  }
}

function verifyContract() {
  if (!existsSync(contractPath)) throw new Error(`${contractRelativePath} is missing.`);
  const contract = parseJsonFile(contractPath);
  if (
    contract?.id !== "S20" ||
    contract.contract_version !== 1 ||
    canonicalJson(contract.requires) !== canonicalJson(["S18", "S19"])
  ) {
    throw new Error("contracts/slices/S20.json is not the expected SliceSpec v1.");
  }
  for (const relativePath of inputRelativePaths) {
    const input = contract.inputs?.find((entry) => entry?.path === relativePath);
    if (input?.digest !== sha256File(path.join(repoRoot, relativePath))) {
      throw new Error(`S20 input does not match its frozen CompletionReceipt: ${relativePath}`);
    }
  }
  const budgets = contract.budgets;
  if (
    budgets?.resolved_export_skills !== 1 ||
    budgets.compression_turn_input_items !== 2 ||
    budgets.handoff_target_files_per_attempt !== 2 ||
    budgets.accepted_command_evidence_items !== 2 ||
    budgets.maximum_command_output_bytes !== 64 * 1024 ||
    budgets.verify_evidence_timeout_ms !== 120_000 ||
    budgets.project_write_leases !== 0 ||
    budgets.model_final_reply_fields !== 0
  ) {
    throw new Error("S20 contract budgets drifted from the Compression launcher boundary.");
  }
  return contract;
}

function verifyProductionSurface() {
  for (const relativePath of surfacePaths) {
    if (!existsSync(path.join(repoRoot, relativePath))) {
      throw new Error(`S20 surface is missing: ${relativePath}`);
    }
  }
  const continuationTypes = readFileSync(path.join(repoRoot, surfacePaths[0]), "utf8");
  const launcher = readFileSync(path.join(repoRoot, surfacePaths[1]), "utf8");
  const coordinator = readFileSync(path.join(repoRoot, surfacePaths[2]), "utf8");
  const handoffTypes = readFileSync(path.join(repoRoot, surfacePaths[4]), "utf8");
  const host = readFileSync(path.join(repoRoot, surfacePaths[5]), "utf8");
  const tests = readFileSync(path.join(repoRoot, surfacePaths[6]), "utf8");
  const runtimeTests = readFileSync(path.join(repoRoot, surfacePaths[7]), "utf8");
  const helper = readFileSync(path.join(repoRoot, surfacePaths[10]), "utf8");
  const fakeServer = readFileSync(path.join(repoRoot, surfacePaths[11]), "utf8");

  for (const [source, fragment, label] of [
    [launcher, 'this.options.client.request("skills/list"', "forced skills/list resolution"],
    [launcher, "forceReload: true", "forced skill cache refresh"],
    [launcher, "planArtifactAttempt", "persistent attempt planning"],
    [launcher, "materializeArtifactAttempt", "post-journal attempt materialization"],
    [launcher, 'project_completed_item_types: ["commandExecution"]', "command-only private projection"],
    [launcher, 'type: "skill"', "explicit skill Turn input"],
    [launcher, '"verify-evidence"', "Host verify-evidence invocation"],
    [launcher, "shell: false", "direct helper process execution"],
    [launcher, "receipt_schema_version: HANDOFF_RECEIPT_SCHEMA_VERSION", "HandoffReceiptV2 builder"],
    [launcher, "artifact_digest: sha256Json(material)", "canonical receipt digest"],
    [coordinator, "type HandoffReceiptV2", "V2 coordinator boundary"],
    [coordinator, "HANDOFF_RECEIPT_SCHEMA_VERSION", "V2 schema verification"],
    [handoffTypes, "export interface HandoffReceiptV2", "machine-verifiable V2 type"],
    [handoffTypes, "LEGACY_HANDOFF_WORKFLOW_VERSION", "legacy S21 migration type"],
    [continuationTypes, "HandoffReceipt | HandoffReceiptV2", "explicit S21 compatibility union"],
    [host, "new AppServerCompressionTaskLauncher", "default production Compression launcher"],
    [tests, "S20 default Host publishes", "real launcher happy-path coverage"],
    [tests, "duplicate-prepare", "duplicate command rejection"],
    [tests, "final-message-only", "model final reply rejection"],
    [tests, "journals an occupied attempt", "old attempt collision coverage"],
    [tests, "symlinked Handoff directory", "reparse escape coverage"],
    [runtimeTests, "wires Compression and keeps Continuation fail closed", "composition regression coverage"],
    [helper, 'command === "prepare"', "real helper prepare fixture"],
    [helper, 'command === "publish"', "real helper publish fixture"],
    [helper, 'command === "verify-evidence"', "real helper verifier fixture"],
    [fakeServer, "sendCompressionEvidence", "private command evidence fixture"],
    [fakeServer, "malformed-prepare-output", "bounded helper JSON failure fixture"],
  ]) {
    requireIncludes(source, fragment, label);
  }

  const claimIndex = launcher.indexOf(
    "await this.writeJournal(allocation.journalPath, allocatedJournal)",
  );
  const materializeIndex = launcher.indexOf(
    "await this.materializeArtifactAttempt(request, allocation)",
  );
  if (claimIndex < 0 || materializeIndex < 0 || claimIndex >= materializeIndex) {
    throw new Error("S20 attempt directory is not ordered after its persistent journal claim.");
  }
  if (launcher.includes("request.prompt") || launcher.includes("agentMessage")) {
    throw new Error("S20 launcher must not trust request prose or a model final reply as receipt evidence.");
  }

  return {
    schema_version: 1,
    launcher: {
      default_host_composition: true,
      resolved_export_skills: 1,
      compression_turn_input_items: 2,
      projected_completed_item_types: ["commandExecution"],
      attempt_transition: "JOURNAL_ALLOCATED -> ATTEMPT_DIRECTORY -> FRESH_TASK",
      handoff_target_files_per_attempt: 2,
      project_write_lease: false,
      model_final_reply_fields: 0,
    },
    receipt: {
      receipt_schema_version: 2,
      workflow_version: 2,
      accepted_command_chain: "prepare -> publish",
      accepted_command_evidence_items: 2,
      source_revision_authority: "export-codex-handoff",
      host_verify_evidence: true,
      canonical_artifact_digest: true,
      legacy_receipt_retained_for_s21: true,
    },
    persistence: {
      completed_effect_replay_without_skill: true,
      failed_attempt_preserved: true,
      retry_uses_incremented_attempt: true,
      occupied_attempt_never_overwritten: true,
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
      throw new Error(`S20 check ${String(check.id)} has an invalid argv.`);
    }
    const result = runCommand(check.argv, timeoutFor(check.id));
    if (result.exitCode !== check.expected_exit_code) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `S20 deterministic check ${String(check.id)} failed with exit ${String(result.exitCode)}.`,
      );
    }
    process.stdout.write(`S20_CHECK_PASS ${String(check.id)}\n`);
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
    if (typeof ownedPath !== "string") throw new Error("S20 owned_paths contains a non-string value.");
    if (ownedPath.endsWith("/**")) {
      const directory = path.join(repoRoot, ownedPath.slice(0, -3));
      if (!existsSync(directory)) continue;
      paths.push(...listFiles(directory).map((filePath) =>
        normalizeRepoPath(path.relative(repoRoot, filePath))
      ));
      continue;
    }
    const filePath = path.join(repoRoot, ownedPath);
    if (!existsSync(filePath)) throw new Error(`S20 owned path is missing: ${ownedPath}`);
    paths.push(ownedPath);
  }
  return [...new Set(paths)].sort();
}

function writeEvidence(contract, surface, checks) {
  const surfaceDigest = sha256Bytes(Buffer.from(canonicalJson(surface), "utf8"));
  const report = {
    ...surface,
    slice_id: "S20",
    result: "PASS",
    surface_digest: surfaceDigest,
    negative_contracts: [
      "ambiguous, disabled, errored, or noncanonical skill rejected",
      "missing, duplicate, reordered, composed, default-output, or substituted command rejected",
      "model final message and unrelated echo command provide zero receipt fields",
      "malformed or oversized helper JSON rejected",
      "SOURCE_CHANGED and failed Host verify-evidence publish no receipt",
      "missing pair, hardlink alias, digest drift, path drift, consumer-contract drift, and symlink escape rejected",
      "occupied and failed attempts remain untouched while retry increments attempt_number",
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
    slice_id: "S20",
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
    process.stdout.write(`S20_SURFACE_PASS ${surfaceDigest}\n`);
    return;
  }
  const checks = runChecks(contract);
  writeEvidence(contract, surface, checks);
  process.stdout.write(`S20_SURFACE_PASS ${surfaceDigest}\n`);
  process.stdout.write(`S20_RELEASE_PASS ${reportRelativePath}\n`);
  process.stdout.write(`S20 CompletionReceipt: ${receiptRelativePath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
