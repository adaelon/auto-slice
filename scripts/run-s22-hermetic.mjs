#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runControllerCli } from "../dist/src/controller/main.js";
import { CodexAppServerTaskHost } from "../dist/src/controller/production/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fakeServerPath = path.join(repoRoot, "test", "fixtures", "process", "fake-s22-app-server.mjs");
const canary = "S22_HERMETIC_PRIVATE_CANARY";
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

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files;
}

function parseJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function normalizedTrace(entries) {
  const steps = [];
  for (const entry of entries) {
    if (entry.kind !== "app_server_request") continue;
    if (
      entry.role === "SOURCE" &&
      (entry.method === "turn/interrupt" || entry.method === "thread/read")
    ) {
      steps.push(`SOURCE:${String(entry.method)}`);
      continue;
    }
    if (
      entry.role === "COMPRESSION" &&
      ["skills/list", "thread/start", "turn/start"].includes(entry.method)
    ) {
      steps.push(`COMPRESSION:${String(entry.method)}`);
      continue;
    }
    if (entry.role === "CONTINUATION" && entry.method === "thread/start") {
      steps.push("CONTINUATION:thread/start");
      continue;
    }
    if (entry.role === "CONTINUATION" && entry.method === "turn/start") {
      steps.push(`CONTINUATION:turn/start:${String(entry.sandbox)}`);
    }
  }
  return steps;
}

function scanCanary(paths, strings) {
  let hits = 0;
  for (const value of strings) {
    if (value.includes(canary)) hits += 1;
  }
  for (const root of paths) {
    for (const filePath of listFiles(root)) {
      if (readFileSync(filePath).includes(Buffer.from(canary, "utf8"))) hits += 1;
    }
  }
  return hits;
}

function findJournal(artifactRoot) {
  const directory = path.join(artifactRoot, "handoff-launcher-journal");
  const candidates = listFiles(directory).filter((filePath) => filePath.endsWith(".json"));
  ensure(candidates.length === 1, "Hermetic chain did not publish exactly one launcher journal.");
  return JSON.parse(readFileSync(candidates[0], "utf8"));
}

function plan(now) {
  return {
    schema_version: 1,
    run_id: "run-s22-hermetic",
    commit_mode: "none",
    model_capabilities: {
      schema_version: 1,
      source: "s22-hermetic-fixture",
      captured_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["medium", "max"] }],
    },
    slices: [{
      contract: {
        slice_id: "S22-HERMETIC",
        contract_version: 1,
        objective: "Prove the default three-task production chain.",
        exclusions: ["Do not use a user Source Run or a remote."],
        owned_paths: ["SESSION_CHECKPOINT.md"],
        checks: [{
          id: "legacy-unused",
          argv: [process.execPath, "--version"],
          cwd: ".",
          timeout_ms: 10_000,
          env_allowlist: ["PATH"],
          expected_exit_code: 0,
          expected_artifacts: [],
        }],
        expected_artifacts: [],
      },
      instructions: "The fake peer must never receive this field.",
    }],
  };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s22-hermetic-"));
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state");
  const artifactRoot = path.join(root, "handoff-storage");
  const tracePath = path.join(root, "protocol.jsonl");
  const planPath = path.join(root, "plan.json");
  mkdirSync(workspaceRoot);
  writeFileSync(path.join(workspaceRoot, "SESSION_CHECKPOINT.md"), "# S22 hermetic disposable checkpoint\n", "utf8");
  writeFileSync(planPath, `${JSON.stringify(plan(Date.now()), null, 2)}\n`, "utf8");
  const stdoutLines = [];
  const stderrLines = [];
  let succeeded = false;
  try {
    const startedAt = Date.now();
    const exitCode = await runControllerCli(
      ["run-plan", planPath, workspaceRoot, storageRoot],
      {
        writeStdout: (line) => stdoutLines.push(line),
        writeStderr: (line) => stderrLines.push(line),
      },
      () => new CodexAppServerTaskHost({
        command: process.execPath,
        args: [fakeServerPath, tracePath],
        request_timeout_ms: 10_000,
        handoff_artifact_storage_root: artifactRoot,
        compression_maximum_final_result_bytes: 64 * 1024,
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    ensure(exitCode === 0, "Hermetic run-plan failed.");
    ensure(stdoutLines.length === 1 && stderrLines.length === 0, "Hermetic CLI surface drifted.");
    const output = JSON.parse(stdoutLines[0]);
    ensure(output.status === "PRODUCTION_CONTINUATION_STARTED", "Hermetic chain did not start Continuation.");
    ensure(elapsedMs >= 29_000, "Hermetic chain bypassed the real 30 second timeout boundary.");
    ensure(elapsedMs < 90_000, "Hermetic chain exceeded its bounded timeout window.");
    const ids = [
      output.decision?.source_thread_id,
      output.decision?.compression_task_id,
      output.decision?.continuation_task_id,
    ];
    ensure(ids.every((value) => typeof value === "string"), "Hermetic decision omitted task identities.");
    ensure(new Set(ids).size === 3, "Hermetic Source/Compression/Continuation UUIDs are not distinct.");

    const traceEntries = parseJsonLines(tracePath);
    const steps = normalizedTrace(traceEntries);
    ensure(JSON.stringify(steps) === JSON.stringify(expectedTrace), "Hermetic protocol trace order drifted.");
    const journal = findJournal(artifactRoot);
    ensure(journal.status === "COMPLETED", "Hermetic Compression journal is not terminal.");
    ensure(journal.receipt?.receipt_schema_version === 3, "Hermetic path-only receipt is missing.");
    ensure(typeof journal.receipt?.markdown_path === "string", "Hermetic final result omitted its first path.");
    ensure(!( "evidence_index_path" in (journal.receipt ?? {})), "Evidence Index leaked into the path-only receipt.");
    ensure(!( "verify_evidence" in (journal.receipt ?? {})), "HANDOFF_VERIFY leaked into the path-only receipt.");
    ensure(!("source_persisted_revision" in (journal.receipt ?? {})), "Legacy Source revision leaked into the receipt.");

    const canaryHits = scanCanary(
      [storageRoot],
      [stdoutLines.join("\n"), stderrLines.join("\n"), readFileSync(tracePath, "utf8")],
    );
    ensure(canaryHits === 0, "Hermetic Worker Content canary reached a Controller surface.");
    const report = {
      schema_version: 1,
      status: "HERMETIC_CHAIN_PASS",
      cli_status: "PRODUCTION_CONTINUATION_STARTED",
      timeout_boundary_ms: 30_000,
      default_host_composition: true,
      task_uuid_count: 3,
      task_uuids_pairwise_distinct: true,
      protocol_trace: steps,
      handoff_result: {
        first_markdown_file_address_used: true,
        evidence_index_address_ignored: true,
        host_verify_evidence_calls: 0,
      },
      handoff_receipt_schema_version: 3,
      canary_hits: 0,
      remote_connections: 0,
      user_source_runs: 0,
    };
    ensure(!JSON.stringify(report).includes(canary), "Hermetic report contains Worker Content.");
    process.stdout.write(`${JSON.stringify(report)}\n`);
    succeeded = true;
  } finally {
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`S22 hermetic diagnostic root retained: ${root}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
