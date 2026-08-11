import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  ContinuationCoordinator,
  ContinuationError,
  type ContinuationDecision,
  type ContinuationLauncher,
  type LeaseReceipt,
  type ProgressReceipt,
  type ReadyReceipt,
  type ResumeEnvelope,
} from "../src/controller/continuation/index.js";
import type {
  HandoffReceipt,
  SynthesizeFirstConsumerContract,
} from "../src/controller/handoff/index.js";
import type { ModelDecision } from "../src/controller/model-policy/index.js";
import type { SliceContractV1 } from "../src/controller/slices/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type Sha256Digest,
  type StoredRun,
} from "../src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
  type ProjectLease,
} from "../src/controller/workspace/index.js";

const SOURCE_THREAD_ID = "00000000-0000-7000-8000-000000001001";
const COMPRESSION_TASK_ID = "00000000-0000-7000-8000-000000001002";
const CONTINUATION_TASK_ID = "00000000-0000-7000-8000-000000001003";
const COMPACTION_ID = "compaction-s10";
const CURRENT_SLICE_ID = "slice-current-s10";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const OBSERVED_AT = "2026-08-09T08:00:00.000Z";
const EXPECTED_OWNED_DIFF_DIGEST = sha256Bytes("owned-before-continuation");

const CONTINUATION_DECISION = {
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
} as const satisfies ModelDecision;

const CONSUMER_CONTRACT = {
  formatVersion: 1,
  kind: "codex-handoff-synthesize-first-consumer-contract",
  mode: "synthesize_first",
  firstDeliverableIds: ["resume-current-slice"],
  preDraftEvidenceReads: 0,
  maxTargetedReads: 2,
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
  forbidBroadSearch: true,
  forbidFullFileReread: true,
} as const satisfies SynthesizeFirstConsumerContract;

const SLICE_CONTRACT = {
  slice_id: CURRENT_SLICE_ID,
  contract_version: 1,
  objective: "Continue the interrupted current Slice from its verified Handoff.",
  exclusions: ["Do not start a new Slice."],
  owned_paths: ["src/current-slice/**"],
  checks: [
    {
      id: "current-slice-check",
      argv: ["node", "--version"],
      cwd: ".",
      timeout_ms: 1_000,
      env_allowlist: ["PATH"],
      expected_exit_code: 0,
      expected_artifacts: [],
    },
  ],
  expected_artifacts: [
    { path: "artifacts/current-slice/result.json", kind: "durable_result" },
  ],
} as const satisfies SliceContractV1;

interface Fixture {
  readonly root: string;
  readonly workspace_root: string;
  readonly store: FileRunStore;
  readonly guard: FileWorkspaceGuard;
  readonly run_id: string;
  readonly lease: ProjectLease;
  readonly rotated_lease: ProjectLease;
  readonly state_version: number;
  readonly handoff_receipt: HandoffReceipt;
}

interface LauncherOptions {
  readonly task_id?: string;
  readonly start_error?: Error;
  readonly ready_error?: Error;
  readonly grant_error?: Error;
  readonly progress_error?: Error;
  readonly ready_transform?: (
    receipt: Readonly<Record<string, unknown>>,
    envelope: ResumeEnvelope,
  ) => unknown;
  readonly lease_transform?: (
    receipt: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly progress_transform?: (
    receipt: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly on_ready?: () => void;
}

function temporaryDirectory(context: TestContext, suffix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), `auto-slice-s10-${suffix}-`));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function openStore(root: string): FileRunStore {
  const store = FileRunStore.open(root, { now: () => new Date(OBSERVED_AT) });
  if (store instanceof StateStoreError) {
    assert.fail(`${store.code}: ${store.message}`);
  }
  return store;
}

function openGuard(root: string, leaseId: string): FileWorkspaceGuard {
  const guard = FileWorkspaceGuard.open(root, {
    now: () => new Date(OBSERVED_AT),
    leaseIdFactory: () => leaseId,
    leaseDurationMs: 120_000,
  });
  if (guard instanceof WorkspaceGuardError) {
    assert.fail(`${guard.code}: ${guard.message}`);
  }
  return guard;
}

function unwrapStored(result: StoredRun | StateStoreError): StoredRun {
  if (result instanceof StateStoreError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapLease<T>(result: T | WorkspaceGuardError): T {
  if (result instanceof WorkspaceGuardError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function handoffArtifactDigest(
  receipt: Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">,
): Sha256Digest {
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

function fixture(context: TestContext, suffix: string): Fixture {
  const root = temporaryDirectory(context, suffix);
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  const identity = createWorkspaceIdentity(workspaceRoot);
  const runId = `run-s10-${suffix}`;
  const guard = openGuard(path.join(root, "workspace-guard"), `lease-s10-${suffix}`);
  const lease = unwrapLease(guard.acquire(identity, runId));
  const frozen = unwrapLease(guard.freezeWrites(lease.lease_id, lease.epoch));
  const rotated = unwrapLease(guard.rotateEpoch(frozen));

  const markdownPath = path.join(workspaceRoot, "handoff-source.md");
  const evidencePath = path.join(workspaceRoot, "handoff-source.evidence.json");
  const markdown = "# Codex Handoff\n\nworkflow: handoff-v2\n";
  const evidence = `${JSON.stringify({
    source: { sourceRevision: SOURCE_REVISION },
    anchors: [],
    semanticCoverage: { turns: [], claims: [] },
    integrity: { indexDigest: "b".repeat(64) },
  }, null, 2)}\n`;
  writeFileSync(markdownPath, markdown, "utf8");
  writeFileSync(evidencePath, evidence, "utf8");
  const handoffMaterial = {
    compression_task_id: COMPRESSION_TASK_ID,
    source_thread_id: SOURCE_THREAD_ID,
    workflow_version: "v2",
    markdown_path: markdownPath,
    evidence_index_path: evidencePath,
    source_revision: SOURCE_REVISION,
    frame_digest: `sha256:${"c".repeat(64)}`,
    handoff_digest: sha256Bytes(markdown),
    evidence_index_digest: sha256Bytes(evidence),
    verify_evidence: "PASS",
    consumer_contract: CONSUMER_CONTRACT,
  } as const satisfies Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">;
  const handoffReceipt: HandoffReceipt = {
    ...handoffMaterial,
    artifact_digest: handoffArtifactDigest(handoffMaterial),
  };

  const store = openStore(path.join(root, "state"));
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: identity,
    plan_digest: sha256Bytes(`plan-${suffix}`),
    commit_mode: "after_slice",
    current_slice_id: CURRENT_SLICE_ID,
    protected_baseline_digest: sha256Bytes(`baseline-${suffix}`),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s10_fixture",
    to: "PREPARING",
    updates: {
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: SOURCE_THREAD_ID,
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s10_fixture",
    to: "SLICE_RUNNING",
  }));
  unwrapStored(store.compareAndSwap(runId, 2, {
    action: "observe_s10_compaction",
    to: "COMPACTION_WAIT",
    updates: {
      compaction: {
        compaction_id: COMPACTION_ID,
        observed_started_at: "2026-08-09T07:59:00.000Z",
        deadline_at: "2026-08-09T07:59:30.000Z",
        handoff_attempted: false,
      },
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 3, {
    action: "observe_s10_deadline",
    to: "SOURCE_INTERRUPTING",
  }));
  unwrapStored(store.compareAndSwap(runId, 4, {
    action: "complete_s10_source_interruption",
    to: "HANDOFF_EXPORTING",
    updates: { write_epoch: rotated.epoch },
  }));
  unwrapStored(store.compareAndSwap(runId, 5, {
    action: "mark_handoff_attempted",
    to: "HANDOFF_EXPORTING",
    updates: {
      compaction: {
        compaction_id: COMPACTION_ID,
        observed_started_at: "2026-08-09T07:59:00.000Z",
        deadline_at: "2026-08-09T07:59:30.000Z",
        handoff_attempted: true,
      },
    },
  }));
  const continuing = unwrapStored(store.compareAndSwap(runId, 6, {
    action: "complete_s10_handoff_export",
    to: "CONTINUATION_STARTING",
    updates: {
      handoff: {
        compression_task_id: COMPRESSION_TASK_ID,
        markdown_path: markdownPath,
        evidence_index_path: evidencePath,
        artifact_digest: handoffReceipt.artifact_digest,
      },
    },
  }));
  return {
    root,
    workspace_root: workspaceRoot,
    store,
    guard,
    run_id: runId,
    lease,
    rotated_lease: rotated,
    state_version: continuing.state.state_version,
    handoff_receipt: handoffReceipt,
  };
}

class MemoryContinuationLauncher implements ContinuationLauncher {
  public start_invocations = 0;
  public start_side_effects = 0;
  public ready_invocations = 0;
  public ready_side_effects = 0;
  public grant_invocations = 0;
  public grant_side_effects = 0;
  public progress_invocations = 0;
  public progress_side_effects = 0;
  public write_enabled = false;
  public write_observed_before_ready = false;
  private readonly taskId: string;
  private readonly starts = new Map<Sha256Digest, Promise<unknown>>();
  private readonly ready = new Map<string, Promise<unknown>>();
  private readonly grants = new Map<string, Promise<unknown>>();
  private readonly progress = new Map<string, Promise<unknown>>();
  private readonly envelopes = new Map<string, ResumeEnvelope>();

  public constructor(
    private readonly value: Fixture,
    private readonly options: LauncherOptions = {},
  ) {
    this.taskId = options.task_id ?? CONTINUATION_TASK_ID;
  }

  public start(envelope: ResumeEnvelope, modelDecision: ModelDecision): Promise<unknown> {
    this.start_invocations += 1;
    assert.equal(
      envelope.goal_prompt,
      `设定goal：阅读[Handoff Markdown](${envelope.handoff_markdown_path.replaceAll("\\", "/")})，继续实现${CURRENT_SLICE_ID}，完成后commit，刷新checkpoint`,
    );
    const key = sha256Json({ envelope, model_decision: modelDecision });
    const existing = this.starts.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.start_error !== undefined) {
        throw this.options.start_error;
      }
      this.start_side_effects += 1;
      this.write_observed_before_ready ||= this.write_enabled;
      this.envelopes.set(this.taskId, envelope);
      return this.taskId;
    });
    this.starts.set(key, pending);
    return pending;
  }

  public awaitReady(taskId: string): Promise<unknown> {
    this.ready_invocations += 1;
    const existing = this.ready.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.ready_error !== undefined) {
        throw this.options.ready_error;
      }
      const envelope = this.envelopes.get(taskId);
      assert.ok(envelope !== undefined);
      this.ready_side_effects += 1;
      this.write_observed_before_ready ||= this.write_enabled;
      const receipt = {
        task_id: taskId,
        run_id: envelope.run_id,
        slice_id: envelope.current_slice_id,
        workspace_identity: envelope.expected_workspace_identity,
        handoff_artifact_digest: this.value.handoff_receipt.artifact_digest,
        consumer_contract_digest: sha256Json(envelope.consumer_contract),
        handoff_read: true,
        first_deliverable_ids: envelope.consumer_contract.firstDeliverableIds,
        first_deliverable_draft_digest: sha256Bytes("first-substantive-draft"),
        pre_draft_evidence_reads: 0,
        targeted_evidence_reads: 1,
        targeted_read_reasons: ["claim_verification"],
        broad_search_count: 0,
        full_file_reread_count: 0,
        rollout_digest: sha256Bytes("persisted-continuation-rollout"),
        write_access: false,
        observed_state_version: this.value.state_version,
        observed_at: OBSERVED_AT,
      } as const satisfies ReadyReceipt;
      this.options.on_ready?.();
      return this.options.ready_transform?.(receipt, envelope) ?? receipt;
    });
    this.ready.set(taskId, pending);
    return pending;
  }

  public grantWrite(taskId: string, newWriteEpoch: number): Promise<unknown> {
    this.grant_invocations += 1;
    const key = `${taskId}\u0000${String(newWriteEpoch)}`;
    const existing = this.grants.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.grant_error !== undefined) {
        throw this.options.grant_error;
      }
      this.grant_side_effects += 1;
      this.write_enabled = true;
      const receipt = {
        task_id: taskId,
        lease_id: this.value.rotated_lease.lease_id,
        write_epoch: newWriteEpoch,
        workspace_identity: this.value.rotated_lease.workspace_identity,
        granted: true,
        observed_at: OBSERVED_AT,
      } as const satisfies LeaseReceipt;
      return this.options.lease_transform?.(receipt) ?? receipt;
    });
    this.grants.set(key, pending);
    return pending;
  }

  public awaitProgress(taskId: string): Promise<unknown> {
    this.progress_invocations += 1;
    const existing = this.progress.get(taskId);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.progress_error !== undefined) {
        throw this.options.progress_error;
      }
      assert.equal(this.write_enabled, true);
      this.progress_side_effects += 1;
      const receipt = {
        task_id: taskId,
        slice_id: CURRENT_SLICE_ID,
        durable_artifact_digest: sha256Bytes("durable-progress-after-resume"),
        observed_state_version: this.value.state_version,
      } as const satisfies ProgressReceipt;
      return this.options.progress_transform?.(receipt) ?? receipt;
    });
    this.progress.set(taskId, pending);
    return pending;
  }
}

function coordinator(
  value: Fixture,
  launcher: ContinuationLauncher,
): ContinuationCoordinator {
  return new ContinuationCoordinator({
    run_store: value.store,
    workspace_guard: value.guard,
    launcher,
    now: () => new Date(OBSERVED_AT),
    operation_timeout_ms: 1_000,
  });
}

function input(
  value: Fixture,
  overrides: Partial<Parameters<ContinuationCoordinator["continueFromHandoff"]>[0]> = {},
): Parameters<ContinuationCoordinator["continueFromHandoff"]>[0] {
  return {
    run_id: value.run_id,
    lease_id: value.rotated_lease.lease_id,
    handoff_receipt: value.handoff_receipt,
    slice_contract: SLICE_CONTRACT,
    model_decision: CONTINUATION_DECISION,
    expected_state_version: value.state_version,
    ...overrides,
  };
}

function unwrapDecision(
  result: ContinuationDecision | ContinuationError,
): ContinuationDecision {
  if (result instanceof ContinuationError) {
    assert.fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function expectContinuationError(
  result: ContinuationDecision | ContinuationError,
  reason: ContinuationError["reason"],
  code?: ContinuationError["code"],
): ContinuationError {
  assert.ok(result instanceof ContinuationError);
  assert.equal(result.reason, reason);
  if (code !== undefined) {
    assert.equal(result.code, code);
  }
  return result;
}

void test("starts one fresh Continuation, grants the rotated epoch, records progress, and replays", async (context) => {
  const value = fixture(context, "success");
  const launcher = new MemoryContinuationLauncher(value);
  const subject = coordinator(value, launcher);

  const first = unwrapDecision(await subject.continueFromHandoff(input(value)));
  const repeated = unwrapDecision(await subject.continueFromHandoff(input(value)));

  assert.equal(first.outcome, "CONTINUED");
  assert.equal(repeated.outcome, "ALREADY_CONTINUED");
  assert.equal(first.old_source_thread_id, SOURCE_THREAD_ID);
  assert.equal(first.continuation_task_id, CONTINUATION_TASK_ID);
  assert.equal(first.current_slice_id, CURRENT_SLICE_ID);
  assert.equal(first.write_epoch, value.lease.epoch + 1);
  assert.equal("expected_owned_diff_digest" in first.envelope, false);
  assert.equal(launcher.write_observed_before_ready, false);
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.ready_side_effects, 1);
  assert.equal(launcher.grant_side_effects, 1);
  assert.equal(launcher.progress_side_effects, 1);
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "SLICE_RUNNING");
  assert.equal(final.source_thread_id, CONTINUATION_TASK_ID);
  assert.equal(final.current_slice_id, CURRENT_SLICE_ID);
  assert.equal(final.handoff?.continuation_task_id, CONTINUATION_TASK_ID);
  assert.equal(final.compaction, undefined);
  assert.equal(
    unwrapLease(value.guard.assertWritable(value.rotated_lease.lease_id, value.rotated_lease.epoch)).status,
    "ACTIVE",
  );
  const oldEpoch = value.guard.assertWritable(value.lease.lease_id, value.lease.epoch);
  assert.ok(oldEpoch instanceof WorkspaceGuardError);
  assert.equal(oldEpoch.code, "stale_write_epoch");
});

void test("rejects a mutated Handoff after readiness and never grants write", async (context) => {
  const value = fixture(context, "mutated-handoff");
  const launcher = new MemoryContinuationLauncher(value, {
    on_ready: () => {
      writeFileSync(value.handoff_receipt.markdown_path, "mutated after ready\n", "utf8");
    },
  });

  const result = await coordinator(value, launcher).continueFromHandoff(input(value));

  expectContinuationError(result, "handoff_artifact_digest_mismatch", "handoff_integrity_failed");
  assert.equal(launcher.grant_side_effects, 0);
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "NEEDS_USER");
  assert.equal(final.source_thread_id, SOURCE_THREAD_ID);
  assert.equal(final.handoff?.compression_task_id, COMPRESSION_TASK_ID);
  assert.equal(final.handoff.continuation_task_id, undefined);
});

void test("rejects consumer-contract violations before write grant", async (context) => {
  const value = fixture(context, "broad-search");
  const launcher = new MemoryContinuationLauncher(value, {
    ready_transform: (receipt) => ({ ...receipt, broad_search_count: 1 }),
  });

  const result = await coordinator(value, launcher).continueFromHandoff(input(value));

  expectContinuationError(result, "consumer_contract_violated");
  assert.equal(launcher.grant_side_effects, 0);
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "NEEDS_USER");
});

void test("closes a failed Handoff read or Ready call before write grant", async (context) => {
  const value = fixture(context, "ready-failure");
  const launcher = new MemoryContinuationLauncher(value, {
    ready_error: new Error("injected Handoff read failure"),
  });

  const result = await coordinator(value, launcher).continueFromHandoff(input(value));

  expectContinuationError(result, "ready_call_failed");
  assert.equal(launcher.grant_side_effects, 0);
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "NEEDS_USER");
  assert.equal(final.source_thread_id, SOURCE_THREAD_ID);
  assert.equal(final.handoff?.artifact_digest, value.handoff_receipt.artifact_digest);
});

void test("rejects a workspace mismatch before write grant", async (context) => {
  const value = fixture(context, "workspace-mismatch");
  const otherWorkspace = path.join(value.root, "other-workspace");
  mkdirSync(otherWorkspace);
  const launcher = new MemoryContinuationLauncher(value, {
    ready_transform: (receipt) => ({
      ...receipt,
      workspace_identity: createWorkspaceIdentity(otherWorkspace),
    }),
  });

  const result = await coordinator(value, launcher).continueFromHandoff(input(value));

  expectContinuationError(result, "ready_workspace_mismatch");
  assert.equal(launcher.grant_side_effects, 0);
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "NEEDS_USER");
});

for (const conflict of [SOURCE_THREAD_ID, COMPRESSION_TASK_ID]) {
  void test(`rejects Continuation UUID reuse for ${conflict}`, async (context) => {
    const value = fixture(context, conflict.slice(-4));
    const launcher = new MemoryContinuationLauncher(value, { task_id: conflict });

    const result = await coordinator(value, launcher).continueFromHandoff(input(value));

    expectContinuationError(result, "task_identity_conflict");
    assert.equal(launcher.ready_side_effects, 0);
    assert.equal(launcher.grant_side_effects, 0);
    assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "NEEDS_USER");
  });
}

void test("freezes the rotated epoch when write grant fails ambiguously", async (context) => {
  const value = fixture(context, "grant-failure");
  const launcher = new MemoryContinuationLauncher(value, {
    grant_error: Object.assign(new Error("injected grant failure"), { code: "HOST_GRANT_FAILED" }),
  });

  const result = await coordinator(value, launcher).continueFromHandoff(input(value));

  expectContinuationError(result, "grant_call_failed");
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "NEEDS_USER");
  assert.equal(final.source_thread_id, SOURCE_THREAD_ID);
  const currentEpoch = value.guard.assertWritable(
    value.rotated_lease.lease_id,
    value.rotated_lease.epoch,
  );
  assert.ok(currentEpoch instanceof WorkspaceGuardError);
  assert.equal(currentEpoch.code, "lease_lost");
  const oldEpoch = value.guard.assertWritable(value.lease.lease_id, value.lease.epoch);
  assert.ok(oldEpoch instanceof WorkspaceGuardError);
  assert.equal(oldEpoch.code, "stale_write_epoch");
});

void test("accepts a legacy owned diff digest without using it as a progress gate", async (context) => {
  const value = fixture(context, "legacy-owned-diff");
  const launcher = new MemoryContinuationLauncher(value, {
    progress_transform: (receipt) => ({
      ...receipt,
      durable_artifact_digest: EXPECTED_OWNED_DIFF_DIGEST,
    }),
  });

  const subject = coordinator(value, launcher);
  const legacyInput = input(value, {
    expected_owned_diff_digest: EXPECTED_OWNED_DIFF_DIGEST,
  });
  const result = unwrapDecision(await subject.continueFromHandoff(legacyInput));
  const replayed = unwrapDecision(await subject.continueFromHandoff(legacyInput));

  assert.equal(result.outcome, "CONTINUED");
  assert.equal(replayed.outcome, "ALREADY_CONTINUED");
  assert.equal(result.progress_receipt.durable_artifact_digest, EXPECTED_OWNED_DIFF_DIGEST);
  assert.equal(result.envelope.expected_owned_diff_digest, EXPECTED_OWNED_DIFF_DIGEST);
  assert.equal(launcher.grant_side_effects, 1);
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "SLICE_RUNNING");
  assert.equal(final.source_thread_id, CONTINUATION_TASK_ID);
  assert.ok(!(value.guard.assertWritable(
    value.rotated_lease.lease_id,
    value.rotated_lease.epoch,
  ) instanceof WorkspaceGuardError));
});

void test("accepts a verification receipt as the first durable progress anchor", async (context) => {
  const value = fixture(context, "verification-progress");
  const launcher = new MemoryContinuationLauncher(value, {
    progress_transform: (receipt) => {
      const base = receipt;
      return {
        task_id: base.task_id,
        slice_id: base.slice_id,
        verification_receipt_digest: sha256Bytes("new-verification-receipt"),
        observed_state_version: base.observed_state_version,
      };
    },
  });

  const decision = unwrapDecision(
    await coordinator(value, launcher).continueFromHandoff(input(value)),
  );

  assert.equal(
    decision.progress_receipt.verification_receipt_digest,
    sha256Bytes("new-verification-receipt"),
  );
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "SLICE_RUNNING");
});

void test("an unavailable exact Continuation model closes before task creation", async (context) => {
  const value = fixture(context, "model-unavailable");
  const launcher = new MemoryContinuationLauncher(value);
  const wrongModel = {
    mode: "model",
    model: "gpt-5.6-sol",
    effort: "medium",
  } as const satisfies ModelDecision;

  const result = await coordinator(value, launcher).continueFromHandoff(input(value, {
    model_decision: wrongModel,
  }));

  expectContinuationError(result, "model_policy_invalid", "model_policy_unavailable");
  assert.equal(launcher.start_side_effects, 0);
  const final = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(final.status, "NEEDS_USER");
  assert.equal(final.last_error?.code, "model_policy_unavailable");
});

void test("same-process concurrent callers share one external workflow", async (context) => {
  const value = fixture(context, "concurrent");
  const launcher = new MemoryContinuationLauncher(value);
  const subject = coordinator(value, launcher);

  const decisions = (await Promise.all([
    subject.continueFromHandoff(input(value)),
    subject.continueFromHandoff(input(value)),
  ])).map(unwrapDecision);

  assert.deepEqual(
    decisions.map((entry) => entry.outcome).sort(),
    ["ALREADY_CONTINUED", "CONTINUED"],
  );
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.grant_side_effects, 1);
  assert.equal(launcher.progress_side_effects, 1);
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.state_version, value.state_version + 1);
});

void test("a stale caller cannot repeat Continuation side effects", async (context) => {
  const value = fixture(context, "stale");
  const launcher = new MemoryContinuationLauncher(value);

  const result = await coordinator(value, launcher).continueFromHandoff(input(value, {
    expected_state_version: value.state_version - 1,
  }));

  assert.ok(result instanceof ContinuationError);
  assert.equal(result.code, "stale_state");
  assert.equal(launcher.start_side_effects, 0);
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "CONTINUATION_STARTING");
});
