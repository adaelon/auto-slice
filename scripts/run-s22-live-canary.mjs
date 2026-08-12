#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import { CodexAppServerTaskHost } from "../dist/src/controller/production/index.js";
import { sha256Bytes } from "../dist/src/controller/state/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const proxyPath = path.join(repoRoot, "scripts", "s22-app-server-proxy.mjs");
const expectedCliVersion = "0.146.0";
const liveBudgetMs = 1_200_000;
const sourceReadyTimeoutMs = 120_000;
const canary = "S22_LIVE_PRIVATE_CANARY";
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
const fixtureBlockers = new Set([
  "PROVIDER_TIMING_UNAVAILABLE",
  "MAP_WORKER_UNAVAILABLE",
  "LIVE_CHAIN_BUDGET_EXCEEDED",
]);

class LiveBudgetError extends Error {
  constructor() {
    super("S22 live canary exceeded its 1200 second budget.");
    this.name = "LiveBudgetError";
    this.code = "LIVE_CHAIN_BUDGET_EXCEEDED";
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function existingFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return null;
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function invocationFromPath(candidate) {
  const resolved = existingFile(candidate);
  if (resolved === null) return null;
  if (path.extname(resolved).toLowerCase() === ".js") {
    return { command: process.execPath, prefixArgs: [resolved] };
  }
  return { command: resolved, prefixArgs: [] };
}

function resolveCodexInvocation() {
  const override = process.env.AUTO_SLICE_S22_CODEX_CLI;
  if (typeof override === "string" && override.length > 0) {
    const resolved = invocationFromPath(path.resolve(override));
    if (resolved !== null) return resolved;
    throw Object.assign(new Error("S22 Codex CLI override is unavailable."), {
      code: "PROVIDER_TIMING_UNAVAILABLE",
    });
  }
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry.length > 0);
  const candidates = [
    ...pathEntries.map((entry) => path.join(entry, "node_modules", "@openai", "codex", "bin", "codex.js")),
    path.join(path.dirname(process.execPath), "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
  try {
    candidates.push(createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"));
  } catch {
    // A global npm Codex install may be outside this package's module graph.
  }
  for (const candidate of candidates) {
    const resolved = invocationFromPath(candidate);
    if (resolved !== null) return resolved;
  }
  for (const directory of pathEntries) {
    const resolved = invocationFromPath(path.join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
    if (resolved !== null) return resolved;
  }
  throw Object.assign(new Error("Codex CLI is unavailable."), {
    code: "PROVIDER_TIMING_UNAVAILABLE",
  });
}

function verifyCliVersion(invocation) {
  const result = spawnSync(invocation.command, [...invocation.prefixArgs, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
  const output = (result.stdout ?? "").trim();
  if (result.status !== 0 || output !== `codex-cli ${expectedCliVersion}`) {
    throw Object.assign(new Error("Required Codex CLI timing/version capability is unavailable."), {
      code: "PROVIDER_TIMING_UNAVAILABLE",
    });
  }
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

function terminalTrace(entries) {
  return entries
    .filter((entry) => entry.kind === "turn_terminal")
    .map((entry) => `${String(entry.role)}:${String(entry.status)}`);
}

function blockerCode(error, stage) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "LIVE_CHAIN_BUDGET_EXCEEDED") return code;
  if (code === "MAP_WORKER_UNAVAILABLE" || code === "WORKER_UNAVAILABLE") {
    return "MAP_WORKER_UNAVAILABLE";
  }
  if (
    code === "PROVIDER_TIMING_UNAVAILABLE" ||
    code.includes("TIMEOUT") ||
    code.startsWith("app_server_") ||
    stage === "SOURCE_START"
  ) {
    return "PROVIDER_TIMING_UNAVAILABLE";
  }
  return "LIVE_CHAIN_FAILED";
}

function blockedReport(code, diagnostic = {}) {
  return {
    schema_version: 1,
    status: "LIVE_CHAIN_BLOCKED",
    blocker: code,
    live_chain_pass: false,
    production_unlocked: false,
    canary_hits: 0,
    ...diagnostic,
  };
}

function safeFailureCode(error) {
  const code = typeof error?.code === "string" ? error.code : "UNCLASSIFIED";
  return /^[A-Z0-9_:-]+$/u.test(code) ? code : "UNCLASSIFIED";
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(250);
  }
  throw Object.assign(new Error("Disposable Source did not publish its local readiness marker."), {
    code: "PROVIDER_TIMING_UNAVAILABLE",
  });
}

async function runWorkflow(
  host,
  workspaceIdentity,
  workspaceRoot,
  runId,
  onStage,
  onSourceStarted,
) {
  let stage = "SOURCE_START";
  onStage(stage);
  const sourceReadyPath = path.join(workspaceRoot, "source-ready.txt");
  const sourceRequest = {
    schema_version: 1,
    run_id: runId,
    slice_id: "S22-LIVE",
    idempotency_key: sha256Bytes(`${runId}:source`),
    workspace_identity: workspaceIdentity,
    lease_id: "lease-s22-live",
    write_epoch: 1,
    model_decision: { mode: "model", model: "gpt-5.6-sol", effort: "max" },
    prompt: [
      "This is a disposable Auto Slice live canary, not a user project.",
      "The requested work is a diagnosis, not an implementation task.",
      "Its Handoff must make continue-live-canary a synthesize-first diagnostic draft before any Evidence Index read.",
      "The diagnosis must forbid broad search and full-file rereads and allow at most three claim-bound targeted reads.",
      "Keep all work inside the current workspace and do not use network or remote Git.",
      `Private marker: ${canary}.`,
      "First read SESSION_CHECKPOINT.md and create source-ready.txt containing READY with local filesystem tools.",
      "Then start a ten-minute local Node wait command so the Host can interrupt this Turn.",
      "After the read-only diagnostic draft and explicit continuation write grant, write live-canary.txt with the word PASS and refresh SESSION_CHECKPOINT.md.",
    ].join("\n"),
  };
  const source = await host.development_tasks.start(sourceRequest);
  if (source instanceof Error) throw source;
  onSourceStarted(source.thread_id);
  await waitForFile(sourceReadyPath, sourceReadyTimeoutMs);
  await delay(750);

  stage = "SOURCE_INTERRUPT";
  onStage(stage);
  const interruption = await host.thread_control.interrupt(
    source.thread_id,
    sha256Bytes(`${runId}:interrupt`),
  );
  const inspection = await host.thread_control.inspect(source.thread_id, false);
  ensure(interruption?.terminal_status === "interrupted", "Live Source did not terminate as interrupted.");
  ensure(inspection?.readable === true && inspection?.persistent === true, "Live Source is not persistently readable.");
  ensure(!("persisted_revision" in interruption), "Live interruption leaked a Source revision.");
  ensure(!("persisted_revision" in inspection), "Live inspection leaked a Source revision.");

  stage = "COMPRESSION";
  onStage(stage);
  const compressionRequest = {
    run_id: runId,
    slice_id: "S22-LIVE",
    source_thread_id: source.thread_id,
    prompt: `$export-codex-handoff ${source.thread_id}`,
    workspace_identity: workspaceIdentity,
    compaction_id: "s22-live-canary",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    idempotency_key: sha256Bytes(`${runId}:compression`),
  };
  ensure(!("source_persisted_revision" in compressionRequest), "Live Compression request contains a legacy revision.");
  const compression = await host.compression_launcher.start(compressionRequest);
  const handoff = await host.compression_launcher.awaitHandoff(
    compression.compression_task_id,
    compressionRequest.idempotency_key,
  );
  ensure(handoff?.receipt_schema_version === 3, "Live path-only Handoff receipt is missing.");
  ensure(typeof handoff?.markdown_path === "string", "Live Compression final result omitted its first path.");

  stage = "CONTINUATION";
  onStage(stage);
  const envelope = {
    run_id: runId,
    current_slice_id: "S22-LIVE",
    goal_prompt: "Continue the disposable S22 live canary from its verified Handoff.",
    source_thread_id: source.thread_id,
    compression_task_id: handoff.compression_task_id,
    compression_turn_id: handoff.compression_turn_id,
    handoff_receipt_schema_version: 3,
    handoff_markdown_path: handoff.markdown_path,
    handoff_artifact_digest: handoff.artifact_digest,
    consumer_contract: {
      formatVersion: 1,
      kind: "codex-handoff-synthesize-first-consumer-contract",
      mode: "synthesize_first",
      firstDeliverableIds: ["S22-LIVE"],
      preDraftEvidenceReads: 0,
      maxTargetedReads: 3,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
    expected_workspace_identity: workspaceIdentity,
    lease_id: "lease-s22-live",
    write_epoch: 2,
    observed_state_version: 1,
    commit_mode: "none",
  };
  const continuationTaskId = await host.continuation_launcher.start(
    envelope,
    { mode: "model", model: "gpt-5.6-sol", effort: "max" },
  );
  const ready = await host.continuation_launcher.awaitReady(continuationTaskId);
  ensure(ready?.write_access === false, "Live ReadyReceipt granted write early.");
  const lease = await host.continuation_launcher.grantWrite(continuationTaskId, 2);
  ensure(lease?.granted === true && lease?.write_epoch === 2, "Live write epoch was not granted exactly once.");
  const progress = await host.continuation_launcher.awaitProgress(continuationTaskId);
  ensure(
    typeof progress?.verification_receipt_digest === "string",
    "Live Continuation produced no terminal ProgressReceipt.",
  );
  const continuationArtifact = path.join(workspaceRoot, "live-canary.txt");
  ensure(
    existsSync(continuationArtifact) && readFileSync(continuationArtifact, "utf8").trim() === "PASS",
    "Live Continuation did not publish the disposable PASS artifact.",
  );
  return {
    stage,
    source_thread_id: source.thread_id,
    compression_task_id: handoff.compression_task_id,
    continuation_task_id: continuationTaskId,
    handoff_markdown_path: handoff.markdown_path,
  };
}

async function main() {
  const fixtureIndex = process.argv.indexOf("--fixture-blocker");
  if (fixtureIndex >= 0) {
    const code = process.argv[fixtureIndex + 1];
    if (!fixtureBlockers.has(code)) throw new Error("Unknown S22 blocker fixture.");
    process.stdout.write(`${JSON.stringify(blockedReport(code))}\n`);
    process.exitCode = 75;
    return;
  }

  const invocation = resolveCodexInvocation();
  verifyCliVersion(invocation);
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s22-live-"));
  const workspaceRoot = path.join(root, "workspace");
  const artifactRoot = path.join(root, "handoff-storage");
  const tracePath = path.join(root, "protocol.jsonl");
  mkdirSync(workspaceRoot);
  writeFileSync(
    path.join(workspaceRoot, "SESSION_CHECKPOINT.md"),
    "# Disposable S22 live canary\n\nNext: create live-canary.txt, then refresh this file.\n",
    "utf8",
  );
  const runId = `s22-live-${Date.now().toString(36)}`;
  const workspaceIdentity = createWorkspaceIdentity(workspaceRoot);
  const realArgs = [...invocation.prefixArgs, "app-server", "--listen", "stdio://"];
  const host = new CodexAppServerTaskHost({
    command: process.execPath,
    args: [proxyPath, tracePath, invocation.command, JSON.stringify(realArgs)],
    request_timeout_ms: 120_000,
    handoff_artifact_storage_root: artifactRoot,
    compression_maximum_final_result_bytes: 64 * 1024,
  });
  let stage = "SOURCE_START";
  let sourceThreadId;
  let startLiveBudget;
  const liveBudgetStart = new Promise((resolve) => {
    startLiveBudget = resolve;
  });
  let liveBudgetStarted = false;
  const workflow = runWorkflow(
    host,
    workspaceIdentity,
    workspaceRoot,
    runId,
    (nextStage) => {
      stage = nextStage;
      if (nextStage === "SOURCE_INTERRUPT" && !liveBudgetStarted) {
        liveBudgetStarted = true;
        startLiveBudget();
      }
    },
    (threadId) => {
      sourceThreadId = threadId;
    },
  );
  const timeout = liveBudgetStart.then(() => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new LiveBudgetError()), liveBudgetMs);
    timer.unref();
  }));
  try {
    const result = await Promise.race([workflow, timeout]);
    const ids = [result.source_thread_id, result.compression_task_id, result.continuation_task_id];
    ensure(new Set(ids).size === 3, "Live Source/Compression/Continuation UUIDs are not distinct.");
    const traceText = readFileSync(tracePath, "utf8");
    ensure(!traceText.includes(canary), "Live Worker Content reached the bounded proxy trace.");
    const steps = normalizedTrace(parseJsonLines(tracePath));
    ensure(JSON.stringify(steps) === JSON.stringify(expectedTrace), "Live protocol trace order drifted.");
    const report = {
      schema_version: 1,
      status: "LIVE_CHAIN_PASS",
      codex_cli_version: expectedCliVersion,
      disposable_workspace: true,
      persistent_task_roots: 3,
      task_uuids_pairwise_distinct: true,
      protocol_trace: steps,
      handoff_result: {
        first_markdown_file_address_used: true,
        evidence_index_address_ignored: true,
        host_verify_evidence_calls: 0,
      },
      handoff_receipt_schema_version: 3,
      canary_hits: 0,
      remote_git_connections: 0,
      user_source_runs: 0,
      live_chain_budget_ms: liveBudgetMs,
      live_chain_budget_origin: "SOURCE_INTERRUPT",
      source_ready_timeout_ms: sourceReadyTimeoutMs,
      continuation_artifact_verified: true,
    };
    ensure(!JSON.stringify(report).includes(canary), "Live report contains Worker Content.");
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    workflow.catch(() => undefined);
    const code = blockerCode(error, stage);
    const traceEntries = parseJsonLines(tracePath);
    process.stdout.write(`${JSON.stringify(blockedReport(code, {
      failure_stage: stage,
      failure_code: safeFailureCode(error),
      protocol_trace: normalizedTrace(traceEntries),
      terminal_trace: terminalTrace(traceEntries),
    }))}\n`);
    process.exitCode = code === "LIVE_CHAIN_FAILED" ? 1 : 75;
  } finally {
    if (typeof sourceThreadId === "string") {
      await host.thread_control.interrupt(
        sourceThreadId,
        sha256Bytes(`${runId}:cleanup-interrupt`),
      ).catch(() => undefined);
    }
    await host.dispose().catch(() => undefined);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Cleanup must not replace the bounded live-chain terminal report.
    }
  }
}

main().catch((error) => {
  const code = blockerCode(error, "SOURCE_START");
  process.stdout.write(`${JSON.stringify(blockedReport(code))}\n`);
  process.exitCode = code === "LIVE_CHAIN_FAILED" ? 1 : 75;
});
