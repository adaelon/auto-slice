#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ContinuationCoordinator,
  ContinuationError,
} from "../dist/src/controller/continuation/index.js";
import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
} from "../dist/src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";

const sourceThreadId = "00000000-0000-7000-8000-000000001101";
const compressionTaskId = "00000000-0000-7000-8000-000000001102";
const continuationTaskId = "00000000-0000-7000-8000-000000001103";
const currentSliceId = "fixture-current-slice";
const sourceRevision = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-08-09T09:00:00.000Z";
const expectedOwnedDiffDigest = sha256Bytes("owned-diff-before-resume");
const continuationDecision = Object.freeze({
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
});
const consumerContract = Object.freeze({
  formatVersion: 1,
  kind: "codex-handoff-synthesize-first-consumer-contract",
  mode: "synthesize_first",
  firstDeliverableIds: ["resume-fixture-slice"],
  preDraftEvidenceReads: 0,
  maxTargetedReads: 2,
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
  forbidBroadSearch: true,
  forbidFullFileReread: true,
});
const sliceContract = Object.freeze({
  slice_id: currentSliceId,
  contract_version: 1,
  objective: "Continue the fixture Slice.",
  exclusions: ["Do not create a new Slice."],
  owned_paths: ["src/fixture/**"],
  checks: [{
    id: "fixture-check",
    argv: ["node", "--version"],
    cwd: ".",
    timeout_ms: 1_000,
    env_allowlist: ["PATH"],
    expected_exit_code: 0,
    expected_artifacts: [],
  }],
  expected_artifacts: [{ path: "artifacts/fixture/result.json", kind: "result" }],
});

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function unwrapStored(result) {
  if (result instanceof StateStoreError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapLease(result) {
  if (result instanceof WorkspaceGuardError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function createFixture(suffix) {
  const root = mkdtempSync(path.join(os.tmpdir(), `auto-slice-s10-evidence-${suffix}-`));
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  const identity = createWorkspaceIdentity(workspaceRoot);
  const runId = `run-s10-evidence-${suffix}`;
  const guard = FileWorkspaceGuard.open(path.join(root, "workspace-guard"), {
    now: () => new Date(observedAt),
    leaseIdFactory: () => `lease-s10-evidence-${suffix}`,
    leaseDurationMs: 120_000,
  });
  if (guard instanceof WorkspaceGuardError) fail(`${guard.code}: ${guard.message}`);
  const lease = unwrapLease(guard.acquire(identity, runId));
  const frozen = unwrapLease(guard.freezeWrites(lease.lease_id, lease.epoch));
  const rotatedLease = unwrapLease(guard.rotateEpoch(frozen));

  const markdownPath = path.join(workspaceRoot, "verified-handoff.md");
  const evidencePath = path.join(workspaceRoot, "verified-handoff.evidence.json");
  const markdown = "# Codex Handoff\n\nworkflow: handoff-v2\n";
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
    source_thread_id: sourceThreadId,
    workflow_version: "v2",
    markdown_path: markdownPath,
    evidence_index_path: evidencePath,
    source_revision: sourceRevision,
    frame_digest: `sha256:${"c".repeat(64)}`,
    handoff_digest: sha256Bytes(markdown),
    evidence_index_digest: sha256Bytes(evidence),
    verify_evidence: "PASS",
    consumer_contract: consumerContract,
  };
  const handoffReceipt = { ...material, artifact_digest: handoffArtifactDigest(material) };

  const store = FileRunStore.open(path.join(root, "state"), {
    now: () => new Date(observedAt),
  });
  if (store instanceof StateStoreError) fail(`${store.code}: ${store.message}`);
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: identity,
    plan_digest: sha256Bytes(`plan-${suffix}`),
    commit_mode: "after_slice",
    current_slice_id: currentSliceId,
    protected_baseline_digest: sha256Bytes(`baseline-${suffix}`),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s10_evidence",
    to: "PREPARING",
    updates: {
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: sourceThreadId,
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s10_evidence",
    to: "SLICE_RUNNING",
  }));
  unwrapStored(store.compareAndSwap(runId, 2, {
    action: "observe_s10_evidence_compaction",
    to: "COMPACTION_WAIT",
    updates: {
      compaction: {
        compaction_id: `compaction-${suffix}`,
        observed_started_at: "2026-08-09T08:59:00.000Z",
        deadline_at: "2026-08-09T08:59:30.000Z",
        handoff_attempted: false,
      },
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 3, {
    action: "observe_s10_evidence_deadline",
    to: "SOURCE_INTERRUPTING",
  }));
  unwrapStored(store.compareAndSwap(runId, 4, {
    action: "complete_s10_evidence_interrupt",
    to: "HANDOFF_EXPORTING",
    updates: { write_epoch: rotatedLease.epoch },
  }));
  unwrapStored(store.compareAndSwap(runId, 5, {
    action: "mark_handoff_attempted",
    to: "HANDOFF_EXPORTING",
    updates: {
      compaction: {
        compaction_id: `compaction-${suffix}`,
        observed_started_at: "2026-08-09T08:59:00.000Z",
        deadline_at: "2026-08-09T08:59:30.000Z",
        handoff_attempted: true,
      },
    },
  }));
  const continuing = unwrapStored(store.compareAndSwap(runId, 6, {
    action: "complete_s10_evidence_handoff",
    to: "CONTINUATION_STARTING",
    updates: {
      handoff: {
        compression_task_id: compressionTaskId,
        markdown_path: markdownPath,
        evidence_index_path: evidencePath,
        artifact_digest: handoffReceipt.artifact_digest,
      },
    },
  }));
  return {
    root,
    workspaceRoot,
    rolloutPath: path.join(workspaceRoot, "continuation-rollout.jsonl"),
    identity,
    runId,
    guard,
    store,
    lease,
    rotatedLease,
    stateVersion: continuing.state.state_version,
    handoffReceipt,
  };
}

function cleanupFixture(value) {
  rmSync(value.root, { recursive: true, force: true });
}

function analyzePersistedRollout(rolloutPath) {
  const bytes = readFileSync(rolloutPath);
  const events = bytes.toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const draftIndex = events.findIndex((entry) => entry.type === "FIRST_DRAFT_PUBLISHED");
  requireCondition(draftIndex >= 0, "Persisted rollout omitted the first substantive draft.");
  const evidenceTypes = new Set(["TARGETED_EVIDENCE_READ", "BROAD_SEARCH", "FULL_FILE_REREAD"]);
  const preDraftEvidenceReads = events.slice(0, draftIndex).filter((entry) => evidenceTypes.has(entry.type)).length;
  const targeted = events.filter((entry) => entry.type === "TARGETED_EVIDENCE_READ");
  return {
    events,
    rolloutDigest: sha256(bytes),
    draftIndex,
    preDraftEvidenceReads,
    targetedReads: targeted.length,
    targetedReasons: targeted.map((entry) => entry.reason),
    broadSearchCount: events.filter((entry) => entry.type === "BROAD_SEARCH").length,
    fullFileRereadCount: events.filter((entry) => entry.type === "FULL_FILE_REREAD").length,
  };
}

class EvidenceLauncher {
  constructor(value, scenario = "success") {
    this.value = value;
    this.scenario = scenario;
    this.events = [];
    this.startCalls = 0;
    this.readyCalls = 0;
    this.grantCalls = 0;
    this.progressCalls = 0;
    this.writeEnabled = false;
    this.envelope = undefined;
  }

  async start(envelope) {
    this.startCalls += 1;
    if (this.scenario === "start_failure") {
      throw Object.assign(new Error("injected start failure"), { code: "HOST_START_FAILED" });
    }
    this.envelope = envelope;
    this.events.push({ sequence: this.events.length + 1, action: "START_READ_ONLY" });
    return continuationTaskId;
  }

  async awaitReady(taskId) {
    this.readyCalls += 1;
    if (this.scenario === "ready_failure") {
      throw Object.assign(new Error("injected ready failure"), { code: "HOST_READY_FAILED" });
    }
    const rolloutEvents = [
      { sequence: 1, type: "HANDOFF_READ", artifact_digest: this.value.handoffReceipt.artifact_digest },
      { sequence: 2, type: "FIRST_DRAFT_PUBLISHED", digest: sha256Bytes("first-draft") },
      { sequence: 3, type: "TARGETED_EVIDENCE_READ", reason: "claim_verification" },
    ];
    if (this.scenario === "broad_search") {
      rolloutEvents.push({ sequence: 4, type: "BROAD_SEARCH" });
    }
    writeFileSync(
      this.value.rolloutPath,
      `${rolloutEvents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const rollout = analyzePersistedRollout(this.value.rolloutPath);
    this.events.push({ sequence: this.events.length + 1, action: "READY", write_access: this.writeEnabled });
    if (this.scenario === "handoff_swap") {
      writeFileSync(this.value.handoffReceipt.markdown_path, "swapped after ready\n", "utf8");
    }
    const workspaceIdentity = this.scenario === "workspace_mismatch"
      ? { ...this.value.identity, filesystem_identity: "different-filesystem" }
      : this.value.identity;
    return {
      task_id: taskId,
      run_id: this.value.runId,
      slice_id: currentSliceId,
      workspace_identity: workspaceIdentity,
      handoff_artifact_digest: this.value.handoffReceipt.artifact_digest,
      consumer_contract_digest: sha256Json(consumerContract),
      handoff_read: this.scenario !== "handoff_not_read",
      first_deliverable_ids: consumerContract.firstDeliverableIds,
      first_deliverable_draft_digest: sha256Bytes("first-draft"),
      pre_draft_evidence_reads: rollout.preDraftEvidenceReads,
      targeted_evidence_reads: rollout.targetedReads,
      targeted_read_reasons: rollout.targetedReasons,
      broad_search_count: rollout.broadSearchCount,
      full_file_reread_count: rollout.fullFileRereadCount,
      rollout_digest: rollout.rolloutDigest,
      write_access: false,
      observed_state_version: this.value.stateVersion,
      observed_at: observedAt,
    };
  }

  async grantWrite(taskId, writeEpoch) {
    this.grantCalls += 1;
    if (this.scenario === "grant_failure") {
      throw Object.assign(new Error("injected grant failure"), { code: "HOST_GRANT_FAILED" });
    }
    this.writeEnabled = true;
    this.events.push({ sequence: this.events.length + 1, action: "WRITE_GRANTED", write_epoch: writeEpoch });
    return {
      task_id: taskId,
      lease_id: this.value.rotatedLease.lease_id,
      write_epoch: writeEpoch,
      workspace_identity: this.value.identity,
      granted: true,
      observed_at: observedAt,
    };
  }

  async awaitProgress(taskId) {
    this.progressCalls += 1;
    if (this.scenario === "progress_failure") {
      throw Object.assign(new Error("injected progress failure"), { code: "HOST_PROGRESS_FAILED" });
    }
    this.events.push({ sequence: this.events.length + 1, action: "DURABLE_PROGRESS" });
    return {
      task_id: taskId,
      slice_id: currentSliceId,
      durable_artifact_digest: this.scenario === "unchanged_progress"
        ? expectedOwnedDiffDigest
        : sha256Bytes("owned-diff-after-resume"),
      observed_state_version: this.scenario === "stale_progress"
        ? this.value.stateVersion - 1
        : this.value.stateVersion,
    };
  }
}

function inputFor(value, modelDecision = continuationDecision) {
  return {
    run_id: value.runId,
    lease_id: value.rotatedLease.lease_id,
    handoff_receipt: value.handoffReceipt,
    slice_contract: sliceContract,
    model_decision: modelDecision,
    expected_owned_diff_digest: expectedOwnedDiffDigest,
    expected_state_version: value.stateVersion,
  };
}

function coordinatorFor(value, launcher) {
  return new ContinuationCoordinator({
    run_store: value.store,
    workspace_guard: value.guard,
    launcher,
    now: () => new Date(observedAt),
    operation_timeout_ms: 1_000,
  });
}

async function runSuccess() {
  const value = createFixture("success");
  try {
    const launcher = new EvidenceLauncher(value);
    const decision = await coordinatorFor(value, launcher).continueFromHandoff(inputFor(value));
    requireCondition(!(decision instanceof ContinuationError), `Success scenario failed: ${decision.message}`);
    const finalState = unwrapStored(value.store.load(value.runId)).state;
    const leaseEvents = unwrapLease(value.guard.inspectLeaseEvents(value.lease.lease_id));
    const oldEpoch = value.guard.assertWritable(value.lease.lease_id, value.lease.epoch);
    const currentEpoch = value.guard.assertWritable(value.rotatedLease.lease_id, value.rotatedLease.epoch);
    const rollout = analyzePersistedRollout(value.rolloutPath);
    const trace = {
      schema_version: 1,
      result: "PASS",
      source_thread_id: sourceThreadId,
      compression_task_id: compressionTaskId,
      continuation_task_id: decision.continuation_task_id,
      uuid_distinct: new Set([
        sourceThreadId,
        compressionTaskId,
        decision.continuation_task_id,
      ]).size === 3,
      run_id_preserved: decision.run_id === value.runId,
      slice_id_preserved: decision.current_slice_id === currentSliceId,
      owned_diff_digest_preserved:
        decision.envelope.expected_owned_diff_digest === expectedOwnedDiffDigest,
      ready_before_grant: launcher.events.findIndex((entry) => entry.action === "READY") <
        launcher.events.findIndex((entry) => entry.action === "WRITE_GRANTED"),
      pre_ready_write_allowed: launcher.events.find((entry) => entry.action === "READY")?.write_access === true,
      handoff_read: decision.ready_receipt.handoff_read,
      persisted_rollout_verified: true,
      first_draft_before_evidence: rollout.draftIndex >= 0 && rollout.preDraftEvidenceReads === 0,
      targeted_reads: rollout.targetedReads,
      broad_search_count: rollout.broadSearchCount,
      full_file_reread_count: rollout.fullFileRereadCount,
      rollout_digest: rollout.rolloutDigest,
      rollout_events: rollout.events,
      final_status: finalState.status,
      source_replaced: finalState.source_thread_id === continuationTaskId,
      compaction_gate_cleared: finalState.compaction === undefined,
      handoff_preserved: finalState.handoff?.artifact_digest === value.handoffReceipt.artifact_digest,
      trace: launcher.events,
    };
    const leaseLog = {
      schema_version: 1,
      result: "PASS",
      lease_id: value.lease.lease_id,
      old_epoch: value.lease.epoch,
      granted_epoch: value.rotatedLease.epoch,
      lease_events: leaseEvents.map((entry) => ({
        action: entry.action,
        epoch: entry.after_state.epoch,
        status: entry.after_state.status,
      })),
      old_epoch_rejected: oldEpoch instanceof WorkspaceGuardError && oldEpoch.code === "stale_write_epoch",
      granted_epoch_active: !(currentEpoch instanceof WorkspaceGuardError) && currentEpoch.status === "ACTIVE",
      ready_before_grant: trace.ready_before_grant,
      pre_ready_write_allowed: trace.pre_ready_write_allowed,
    };
    return { trace, leaseLog, progressReceipt: decision.progress_receipt };
  } finally {
    cleanupFixture(value);
  }
}

async function runFailureScenario(scenario) {
  const value = createFixture(scenario);
  try {
    const launcher = new EvidenceLauncher(value, scenario);
    const modelDecision = scenario === "model_unavailable"
      ? { mode: "model", model: "gpt-5.6-sol", effort: "medium" }
      : continuationDecision;
    const result = await coordinatorFor(value, launcher).continueFromHandoff(
      inputFor(value, modelDecision),
    );
    requireCondition(result instanceof ContinuationError, `${scenario} unexpectedly succeeded.`);
    const state = unwrapStored(value.store.load(value.runId)).state;
    const oldEpoch = value.guard.assertWritable(value.lease.lease_id, value.lease.epoch);
    const currentEpoch = value.guard.assertWritable(
      value.rotatedLease.lease_id,
      value.rotatedLease.epoch,
    );
    return {
      scenario,
      error_code: result.code,
      reason: result.reason,
      final_status: state.status,
      source_thread_preserved: state.source_thread_id === sourceThreadId,
      handoff_preserved: state.handoff?.artifact_digest === value.handoffReceipt.artifact_digest,
      old_epoch_rejected: oldEpoch instanceof WorkspaceGuardError,
      current_epoch_status: currentEpoch instanceof WorkspaceGuardError
        ? currentEpoch.code
        : currentEpoch.status,
      grant_invocations: launcher.grantCalls,
      progress_invocations: launcher.progressCalls,
      automatic_retry_allowed: false,
    };
  } finally {
    cleanupFixture(value);
  }
}

async function main() {
  const success = await runSuccess();
  const failureScenarios = [
    "start_failure",
    "ready_failure",
    "handoff_not_read",
    "handoff_swap",
    "workspace_mismatch",
    "broad_search",
    "grant_failure",
    "progress_failure",
    "unchanged_progress",
    "stale_progress",
    "model_unavailable",
  ];
  const failures = [];
  for (const scenario of failureScenarios) {
    failures.push(await runFailureScenario(scenario));
  }

  requireCondition(success.trace.uuid_distinct, "Three task UUIDs were not distinct.");
  requireCondition(success.trace.run_id_preserved, "Continuation changed run_id.");
  requireCondition(success.trace.slice_id_preserved, "Continuation changed current_slice_id.");
  requireCondition(success.trace.owned_diff_digest_preserved, "Continuation changed the owned diff binding.");
  requireCondition(success.trace.ready_before_grant, "Write grant preceded readiness.");
  requireCondition(!success.trace.pre_ready_write_allowed, "Continuation could write before readiness.");
  requireCondition(success.trace.first_draft_before_evidence, "Persistent rollout violated synthesize-first.");
  requireCondition(success.trace.broad_search_count === 0, "Persistent rollout used broad search.");
  requireCondition(success.trace.final_status === "SLICE_RUNNING", "Continuation did not resume SLICE_RUNNING.");
  requireCondition(success.trace.compaction_gate_cleared, "Progress did not clear the old compaction gate.");
  requireCondition(success.leaseLog.old_epoch_rejected, "Old write epoch remained valid.");
  requireCondition(success.leaseLog.granted_epoch_active, "New write epoch was not active after success.");
  requireCondition(failures.every((entry) => entry.final_status === "NEEDS_USER"), "Failure did not close to NEEDS_USER.");
  requireCondition(failures.every((entry) => entry.source_thread_preserved), "Failure replaced the Source Thread.");
  requireCondition(failures.every((entry) => entry.handoff_preserved), "Failure discarded the Handoff.");
  requireCondition(failures.every((entry) => entry.old_epoch_rejected), "Failure restored the old write epoch.");
  requireCondition(
    failures.filter((entry) => ["ready_failure", "handoff_not_read", "handoff_swap", "workspace_mismatch", "broad_search"].includes(entry.scenario))
      .every((entry) => entry.grant_invocations === 0),
    "A pre-grant integrity failure still invoked grantWrite.",
  );
  requireCondition(
    failures.filter((entry) => ["grant_failure", "progress_failure", "unchanged_progress", "stale_progress"].includes(entry.scenario))
      .every((entry) => entry.current_epoch_status === "lease_lost"),
    "An ambiguous post-grant failure did not freeze the current epoch.",
  );

  process.stdout.write(`${JSON.stringify({
    continuation_trace: success.trace,
    lease_rotation_log: success.leaseLog,
    progress_receipt: success.progressReceipt,
    failure_closure_matrix: {
      schema_version: 1,
      result: "PASS",
      scenarios: failures,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
