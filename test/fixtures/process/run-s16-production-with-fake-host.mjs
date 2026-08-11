#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runControllerCli } from "../../../dist/src/controller/main.js";
import { CodexAppServerTaskHost } from "../../../dist/src/controller/production/index.js";
import {
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
} from "../../../dist/src/controller/state/index.js";

const scenario = process.argv[2];
const planPath = process.argv[3];
const workspaceRoot = process.argv[4];
const storageRoot = process.argv[5];
const protocolTracePath = process.argv[6];
const allowedScenarios = new Set([
  "normal-short",
  "normal-large",
  "compaction-29999",
  "timeout-revision-available",
  "timeout-revision-unavailable",
  "probe-fallback",
  "worker-failed",
  "worker-interrupted",
]);
const sourceRevision = "a".repeat(64);
const compressionTaskId = "019feb16-0000-7000-8000-000000000003";
const continuationTaskId = "019feb16-0000-7000-8000-000000000004";
const consumerContract = {
  formatVersion: 1,
  kind: "codex-handoff-synthesize-first-consumer-contract",
  mode: "synthesize_first",
  firstDeliverableIds: ["s16-first-draft"],
  preDraftEvidenceReads: 0,
  maxTargetedReads: 1,
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
  forbidBroadSearch: true,
  forbidFullFileReread: true,
};

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function parseProtocolTrace(tracePath) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function handoffArtifactDigest(receipt) {
  return sha256Json({
    compression_task_id: receipt.compression_task_id,
    consumer_contract: receipt.consumer_contract,
    evidence_index_digest: receipt.evidence_index_digest,
    evidence_index_path: receipt.evidence_index_path,
    frame_digest: receipt.frame_digest,
    handoff_digest: receipt.handoff_digest,
    markdown_path: receipt.markdown_path,
    source_revision: receipt.source_revision,
    source_thread_id: receipt.source_thread_id,
    verify_evidence: receipt.verify_evidence,
    workflow_version: receipt.workflow_version,
  });
}

function createHostClock(profile) {
  if (profile === "probe") {
    const baseMillis = Date.now();
    let currentMillis = baseMillis;
    const usedOffsets = [];
    return {
      baseMillis,
      usedOffsets,
      now: () => {
        usedOffsets.push(currentMillis - baseMillis);
        return new Date(currentMillis);
      },
      advanceTo: (deadline) => {
        currentMillis = Math.max(currentMillis, deadline.getTime());
      },
    };
  }
  const baseMillis = profile === "timeout"
    ? Date.now() - 31_000
    : Date.now() + 5_000;
  const configuredOffsets = profile === "compaction-29999"
    ? [0, 0, 29_999]
    : [0];
  const usedOffsets = [];
  return {
    baseMillis,
    usedOffsets,
    now: () => {
      const offset = configuredOffsets[Math.min(usedOffsets.length, configuredOffsets.length - 1)];
      usedOffsets.push(offset);
      return new Date(baseMillis + offset);
    },
  };
}

class ImmediateProbeScheduler {
  constructor(clock) {
    this.clock = clock;
    this.jobs = new Map();
  }

  schedule(key, deadline, callback) {
    const job = { deadline: new Date(deadline), callback };
    this.jobs.set(key, job);
    setImmediate(() => {
      if (this.jobs.get(key) !== job) return;
      this.jobs.delete(key);
      this.clock.advanceTo(job.deadline);
      job.callback();
    });
  }

  cancel(key) {
    this.jobs.delete(key);
  }
}

class DeterministicHandoffLaunchers {
  constructor(runId, stateRoot, workspace, baseMillis) {
    this.runId = runId;
    this.stateRoot = stateRoot;
    this.workspace = workspace;
    this.baseMillis = baseMillis;
    this.compressionStarts = 0;
    this.continuationStarts = 0;
    this.grants = 0;
    this.progressReceipts = 0;
    this.compressionRequest = null;
    this.resumeEnvelope = null;
    this.handoffReceipt = null;
    this.compression_launcher = {
      start: this.startCompression.bind(this),
      awaitHandoff: this.awaitHandoff.bind(this),
    };
    this.continuation_launcher = {
      start: this.startContinuation.bind(this),
      awaitReady: this.awaitReady.bind(this),
      grantWrite: this.grantWrite.bind(this),
      awaitProgress: this.awaitProgress.bind(this),
    };
  }

  timestamp(offsetMillis) {
    return new Date(this.baseMillis + offsetMillis).toISOString();
  }

  loadState() {
    const store = FileRunStore.open(this.stateRoot);
    ensure(!(store instanceof StateStoreError), "S16 launcher could not open the RunStore.");
    const loaded = store.load(this.runId);
    ensure(!(loaded instanceof StateStoreError), "S16 launcher could not load the active Run.");
    return loaded.state;
  }

  async startCompression(request) {
    this.compressionStarts += 1;
    this.compressionRequest = request;
    return {
      compression_task_id: compressionTaskId,
      source_thread_id: request.source_thread_id,
      workspace_identity: request.workspace_identity,
      history_empty: true,
      project_write_lease: false,
      model: request.model,
      reasoning_effort: request.reasoning_effort,
      created_at: this.timestamp(32_000),
    };
  }

  async awaitHandoff(taskId) {
    ensure(taskId === compressionTaskId, "S16 Compression task identity drifted.");
    ensure(this.compressionRequest !== null, "S16 Compression request was not retained.");
    const markdownPath = path.join(this.workspace, "s16-handoff.md");
    const evidencePath = path.join(this.workspace, "s16-handoff.evidence.json");
    const markdown = "# S16 Handoff\n\nworkflow: handoff-v2\n";
    const evidence = `${JSON.stringify({
      source: { sourceRevision },
      anchors: [],
      semanticCoverage: { turns: [], claims: [] },
      integrity: { indexDigest: "b".repeat(64) },
    }, null, 2)}\n`;
    writeFileSync(markdownPath, markdown, "utf8");
    writeFileSync(evidencePath, evidence, "utf8");
    const material = {
      compression_task_id: compressionTaskId,
      source_thread_id: this.compressionRequest.source_thread_id,
      workflow_version: "v2",
      markdown_path: markdownPath,
      evidence_index_path: evidencePath,
      source_revision: this.compressionRequest.source_persisted_revision,
      frame_digest: sha256Bytes("s16-frame"),
      handoff_digest: sha256Bytes(markdown),
      evidence_index_digest: sha256Bytes(evidence),
      verify_evidence: "PASS",
      consumer_contract: consumerContract,
    };
    this.handoffReceipt = {
      ...material,
      artifact_digest: handoffArtifactDigest(material),
    };
    return this.handoffReceipt;
  }

  async startContinuation(envelope) {
    this.continuationStarts += 1;
    this.resumeEnvelope = envelope;
    return continuationTaskId;
  }

  async awaitReady(taskId) {
    ensure(taskId === continuationTaskId, "S16 Continuation task identity drifted.");
    ensure(this.resumeEnvelope !== null, "S16 ResumeEnvelope was not retained.");
    ensure(this.handoffReceipt !== null, "S16 Handoff receipt is unavailable.");
    const state = this.loadState();
    return {
      task_id: taskId,
      run_id: this.resumeEnvelope.run_id,
      slice_id: this.resumeEnvelope.current_slice_id,
      workspace_identity: this.resumeEnvelope.expected_workspace_identity,
      handoff_artifact_digest: this.handoffReceipt.artifact_digest,
      consumer_contract_digest: sha256Json(this.resumeEnvelope.consumer_contract),
      handoff_read: true,
      first_deliverable_ids: this.resumeEnvelope.consumer_contract.firstDeliverableIds,
      first_deliverable_draft_digest: sha256Bytes("s16-first-substantive-draft"),
      pre_draft_evidence_reads: 0,
      targeted_evidence_reads: 1,
      targeted_read_reasons: ["claim_verification"],
      broad_search_count: 0,
      full_file_reread_count: 0,
      rollout_digest: sha256Bytes("s16-persisted-rollout"),
      write_access: false,
      observed_state_version: state.state_version,
      observed_at: this.timestamp(33_000),
    };
  }

  async grantWrite(taskId, newWriteEpoch) {
    this.grants += 1;
    const state = this.loadState();
    ensure(state.project_lock_owner !== null, "S16 active lease identity is unavailable.");
    return {
      task_id: taskId,
      lease_id: state.project_lock_owner,
      write_epoch: newWriteEpoch,
      workspace_identity: state.workspace_identity,
      granted: true,
      observed_at: this.timestamp(34_000),
    };
  }

  async awaitProgress(taskId) {
    this.progressReceipts += 1;
    const state = this.loadState();
    const progressPath = path.join(this.workspace, "s16-continuation-progress.json");
    const content = `${JSON.stringify({ task_id: taskId, result: "durable" })}\n`;
    writeFileSync(progressPath, content, "utf8");
    return {
      task_id: taskId,
      slice_id: state.current_slice_id,
      durable_artifact_digest: sha256Bytes(content),
      observed_state_version: state.state_version,
    };
  }

  counts() {
    return {
      compression_starts: this.compressionStarts,
      continuation_starts: this.continuationStarts,
      write_grants: this.grants,
      progress_receipts: this.progressReceipts,
    };
  }
}

async function main() {
  ensure(
    allowedScenarios.has(scenario) &&
      typeof planPath === "string" &&
      typeof workspaceRoot === "string" &&
      typeof storageRoot === "string" &&
      typeof protocolTracePath === "string",
    "S16 production runner arguments are invalid.",
  );
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fake-s16-app-server.mjs",
  );
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const profile = scenario === "compaction-29999"
    ? "compaction-29999"
    : scenario === "probe-fallback"
      ? "probe"
    : scenario.startsWith("timeout-")
      ? "timeout"
      : "normal";
  const hostClock = createHostClock(profile);
  const launchers = new DeterministicHandoffLaunchers(
    plan.run_id,
    storageRoot,
    workspaceRoot,
    hostClock.baseMillis,
  );
  const stdoutLines = [];
  const stderrLines = [];
  const probeElapsedMs = [];
  const io = {
    writeStdout: (line) => stdoutLines.push(line),
    writeStderr: (line) => stderrLines.push(line),
  };
  const revisionProvider = scenario === "timeout-revision-available"
    ? { read: () => Promise.resolve(sourceRevision) }
    : undefined;
  const eventCapability = scenario === "probe-fallback" ? "UNAVAILABLE" : "AVAILABLE";
  const compactionProbe = {
    probe(_threadId, _turnId, elapsedMs) {
      probeElapsedMs.push(elapsedMs);
      const privateContent = "S16_MESSAGE_CANARY";
      ensure(privateContent.length > 0, "S16 private probe fixture is unavailable.");
      return Promise.resolve(scenario === "probe-fallback"
        ? { kind: "COMPACTION_SEEN", observedAt: hostClock.now().toISOString() }
        : { kind: "NO_COMPACTION" });
    },
  };
  const cliExitCode = await runControllerCli(
    ["run-plan", planPath, workspaceRoot, storageRoot],
    io,
    () => new CodexAppServerTaskHost({
      command: process.execPath,
      args: [
        fixturePath,
        scenario,
        protocolTracePath,
        String(hostClock.baseMillis),
        JSON.stringify(plan.slices.map((slice) => slice.contract.slice_id)),
        plan.commit_mode,
      ],
      request_timeout_ms: 10_000,
      now: hostClock.now,
      host_capabilities: { context_compaction_events: eventCapability },
      compaction_content_probe: compactionProbe,
      ...(scenario === "probe-fallback"
        ? { compaction_probe_scheduler: new ImmediateProbeScheduler(hostClock) }
        : {}),
      ...(revisionProvider === undefined ? {} : { thread_revision_provider: revisionProvider }),
      compression_launcher: launchers.compression_launcher,
      continuation_launcher: launchers.continuation_launcher,
    }),
  );
  const expectedExitCode = [
    "timeout-revision-unavailable",
    "worker-failed",
    "worker-interrupted",
  ].includes(scenario) ? 1 : 0;
  ensure(cliExitCode === expectedExitCode, `S16 run-plan exit drifted for ${scenario}.`);
  const stdout = stdoutLines.map((line) => JSON.parse(line));
  const stderr = stderrLines.map((line) => JSON.parse(line));
  if (expectedExitCode === 0) {
    ensure(stdout.length === 1 && stderr.length === 0, "S16 successful run emitted an unexpected surface.");
  } else {
    ensure(stdout.length === 0 && stderr.length === 1, "S16 failed run emitted an unexpected surface.");
  }
  const wrapper = {
    schema_version: 1,
    scenario,
    cli_exit_code: cliExitCode,
    stdout,
    stderr,
    protocol_trace: parseProtocolTrace(protocolTracePath),
    host_clock_offsets_used: hostClock.usedOffsets,
    host_compaction_capability: eventCapability,
    probe_elapsed_ms: probeElapsedMs,
    launcher_counts: launchers.counts(),
  };
  process.stdout.write(`${JSON.stringify(wrapper)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
