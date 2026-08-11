import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { MonitorDecision } from "../src/controller/compaction-monitor/index.js";
import type {
  ContinuationDecision,
  ContinueFromHandoffInput,
} from "../src/controller/continuation/index.js";
import type { CompressionHandoffDecision, HandoffReceipt } from "../src/controller/handoff/index.js";
import type { ModelInvocationDecision } from "../src/controller/model-policy/index.js";
import {
  ProductionOrchestrator,
  ProductionRuntimeError,
  type DevelopmentTaskEvent,
  type DevelopmentTaskPort,
  type DevelopmentTaskReceipt,
  type ProductionPlanV1,
  type ProductionSliceV1,
  type ResolvedProductionPlanV1,
} from "../src/controller/production/index.js";
import type {
  ExecutionId,
  ExecutionReceipt,
  SliceContractV1,
  VerificationReceipt,
} from "../src/controller/slices/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type StoredRun,
} from "../src/controller/state/index.js";
import type { SourceInterruptionDecision } from "../src/controller/thread-control/index.js";
import type {
  ChangeSet,
  OwnedPatch,
  ProjectLease,
  ProtectedBaseline,
  ReleasedLease,
  WorkspaceSnapshot,
} from "../src/controller/workspace/index.js";

const FIXED_TIME = "2026-08-09T14:00:00.000Z";
const WORKSPACE = {
  canonical_root: "E:\\workspace\\production-orchestrator-fixture",
  filesystem_identity: "win32:sha256:production-orchestrator-fixture",
} as const;
const DEVELOPMENT_MODEL = {
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
} as const satisfies ModelInvocationDecision;

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "auto-slice-production-orchestrator-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function unwrapStored(result: StoredRun | StateStoreError): StoredRun {
  if (result instanceof StateStoreError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function contract(sliceId: string): SliceContractV1 {
  return {
    slice_id: sliceId,
    contract_version: 1,
    objective: `Complete ${sliceId}.`,
    exclusions: ["Do not push."],
    owned_paths: [`src/${sliceId}.ts`],
    checks: [{
      id: `check-${sliceId}`,
      argv: ["node", "--version"],
      cwd: ".",
      timeout_ms: 1_000,
      env_allowlist: ["PATH"],
      expected_exit_code: 0,
      expected_artifacts: [],
    }],
    expected_artifacts: [],
  };
}

function productionSlice(sliceId: string): ProductionSliceV1 {
  return { contract: contract(sliceId), instructions: `Implement ${sliceId}.` };
}

function sliceStateBindingDigest(
  planDigest: `sha256:${string}`,
  sliceId: string,
): `sha256:${string}` {
  return sha256Json({
    kind: "PRODUCTION_SLICE_STATE",
    plan_digest: planDigest,
    slice_id: sliceId,
  });
}

function emptyEvents(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}

function eventsOf(...events: readonly DevelopmentTaskEvent[]): AsyncIterable<DevelopmentTaskEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () => {
          const value = events[index];
          index += 1;
          return Promise.resolve(value === undefined
            ? { done: true, value: undefined }
            : { done: false, value });
        },
      };
    },
  };
}

void test("ProductionOrchestrator trusts matching COMPLETED receipts and never calls legacy acceptance ports", async (context) => {
  const storeResult = FileRunStore.open(temporaryDirectory(context), {
    now: () => new Date(FIXED_TIME),
  });
  assert.ok(!(storeResult instanceof StateStoreError));
  const store = storeResult;
  const slices = [productionSlice("S13-a"), productionSlice("S13-b")] as const;
  const plan = {
    schema_version: 1,
    run_id: "run-production-loop",
    commit_mode: "after_slice",
    model_capabilities: {
      schema_version: 1,
      source: "fake-port-test",
      captured_at: FIXED_TIME,
      expires_at: "2026-08-09T15:00:00.000Z",
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["max", "medium"] }],
    },
    slices,
  } as const satisfies ProductionPlanV1;
  const planDigest = sha256Json(plan);
  const resolved: ResolvedProductionPlanV1 = {
    plan,
    plan_digest: planDigest,
    development_model: DEVELOPMENT_MODEL,
    continuation_model: DEVELOPMENT_MODEL,
    compression_model: { ...DEVELOPMENT_MODEL, effort: "medium" },
  };
  const lease: ProjectLease = {
    schema_version: 1,
    lease_id: "lease-production-loop",
    workspace_identity: WORKSPACE,
    run_id: resolved.plan.run_id,
    epoch: 1,
    revision: 0,
    acquired_at: FIXED_TIME,
    renewed_at: FIXED_TIME,
    expires_at: "2026-08-09T15:00:00.000Z",
    status: "ACTIVE",
  };
  unwrapStored(store.create(createInitialRunState({
    run_id: resolved.plan.run_id,
    workspace_identity: WORKSPACE,
    plan_digest: planDigest,
    commit_mode: "after_slice",
    current_slice_id: slices[0].contract.slice_id,
    protected_baseline_digest: sliceStateBindingDigest(
      planDigest,
      slices[0].contract.slice_id,
    ),
  })));
  unwrapStored(store.compareAndSwap(resolved.plan.run_id, 0, {
    action: "prepare_production_loop",
    to: "PREPARING",
    updates: { project_lock_owner: lease.lease_id, write_epoch: lease.epoch },
  }));

  const calls: string[] = [];
  const forbiddenCalls = {
    change_guard: 0,
    slice_executor: 0,
    slice_verifier: 0,
    goal_completion: 0,
  };
  function forbidden(port: keyof typeof forbiddenCalls): never {
    forbiddenCalls[port] += 1;
    throw new Error(`${port} must not be called on trusted completion.`);
  }
  const developmentTasks: DevelopmentTaskPort = {
    start(request) {
      calls.push(`develop:${request.slice_id}:${String(request.write_epoch)}`);
      assert.equal(
        request.prompt,
        `设定goal：阅读checkpoint，实现${request.slice_id}，完成后commit，刷新checkpoint`,
      );
      const receiptMaterial: Omit<DevelopmentTaskReceipt, "receipt_digest"> = {
        schema_version: 1,
        run_id: request.run_id,
        slice_id: request.slice_id,
        thread_id: `thread-${request.slice_id}`,
        turn_id: `turn-${request.slice_id}`,
        outcome: "COMPLETED",
        started_at: FIXED_TIME,
        completed_at: FIXED_TIME,
      };
      return Promise.resolve({
        thread_id: receiptMaterial.thread_id,
        turn_id: receiptMaterial.turn_id,
        events: emptyEvents(),
        completion: Promise.resolve({
          ...receiptMaterial,
          receipt_digest: sha256Json(receiptMaterial),
        }),
      });
    },
  };
  const executor = {
    start(): ExecutionId {
      return forbidden("slice_executor");
    },
    collect(): Promise<ExecutionReceipt> {
      return forbidden("slice_executor");
    },
  };
  const verifier = {
    verify(): VerificationReceipt {
      return forbidden("slice_verifier");
    },
  };
  const changeGuard = {
    captureBaseline(): ProtectedBaseline {
      return forbidden("change_guard");
    },
    captureCurrent(): WorkspaceSnapshot {
      return forbidden("change_guard");
    },
    classify(): ChangeSet {
      return forbidden("change_guard");
    },
    assertCommittable(): OwnedPatch {
      return forbidden("change_guard");
    },
  };
  const goalCompletion = {
    observe(): never {
      return forbidden("goal_completion");
    },
  };
  let releases = 0;
  const workspaceGuard = {
    assertWritable(leaseId: string, expectedEpoch: number): ProjectLease {
      assert.equal(leaseId, lease.lease_id);
      assert.equal(expectedEpoch, lease.epoch);
      return lease;
    },
    release(leaseId: string, expectedEpoch: number): ReleasedLease {
      releases += 1;
      assert.equal(leaseId, lease.lease_id);
      assert.equal(expectedEpoch, lease.epoch);
      return { ...lease, revision: 1, status: "RELEASED", released_at: FIXED_TIME };
    },
  };
  const orchestrator = new ProductionOrchestrator({
    run_store: store,
    workspace_guard: workspaceGuard,
    development_tasks: developmentTasks,
    slice_executor: executor,
    slice_verifier: verifier,
    goal_completion: goalCompletion,
    change_guard: changeGuard,
    compaction_monitor: {
      onEvent() {
        assert.fail("The no-compaction fixture must not call CompactionMonitor.");
      },
    },
    source_interruption: {
      interruptSource() {
        return Promise.reject(new Error("The no-compaction fixture must not interrupt Source."));
      },
    },
    handoff: {
      exportHandoff() {
        return Promise.reject(new Error("The no-compaction fixture must not export Handoff."));
      },
    },
    continuation: {
      continueFromHandoff() {
        return Promise.reject(new Error("The no-compaction fixture must not start Continuation."));
      },
    },
    now: () => new Date(FIXED_TIME),
  });

  const result = await orchestrator.run(resolved);
  assert.ok(!(result instanceof ProductionRuntimeError));
  if (result.outcome !== "DONE") {
    assert.fail("Trusted completion unexpectedly started a Continuation.");
  }
  assert.deepEqual(
    result.completed_slices.map((entry) => ({
      keys: Object.keys(entry).sort(),
      slice_id: entry.slice_id,
      source_thread_id: entry.source_thread_id,
      state_version: entry.state_version,
    })),
    [
      {
        keys: [
          "development_receipt_digest",
          "slice_id",
          "source_thread_id",
          "state_version",
        ],
        slice_id: "S13-a",
        source_thread_id: "thread-S13-a",
        state_version: 3,
      },
      {
        keys: [
          "development_receipt_digest",
          "slice_id",
          "source_thread_id",
          "state_version",
        ],
        slice_id: "S13-b",
        source_thread_id: "thread-S13-b",
        state_version: 4,
      },
    ],
  );
  assert.equal(releases, 1);
  assert.deepEqual(calls, [
    "develop:S13-a:1",
    "develop:S13-b:1",
  ]);
  assert.deepEqual(forbiddenCalls, {
    change_guard: 0,
    slice_executor: 0,
    slice_verifier: 0,
    goal_completion: 0,
  });
  const final = unwrapStored(store.load(resolved.plan.run_id)).state;
  assert.equal(final.status, "DONE");
  assert.equal(final.state_version, 5);
  assert.equal(final.current_slice_id, "S13-b");
  assert.equal(
    final.protected_baseline_digest,
    sliceStateBindingDigest(planDigest, "S13-b"),
  );
  assert.equal(final.project_lock_owner, null);
  const events = store.inspectRunEvents(resolved.plan.run_id);
  if (events instanceof StateStoreError) assert.fail(events.message);
  const statuses = events.map((event) => event.after_state.status);
  assert.deepEqual(statuses, [
    "IDLE",
    "PREPARING",
    "SLICE_RUNNING",
    "PREPARING",
    "SLICE_RUNNING",
    "DONE",
  ]);
});

void test("ProductionOrchestrator hands a timed-out probed Slice to a distinct Continuation without workspace inspection", async (context) => {
  const storeResult = FileRunStore.open(temporaryDirectory(context), {
    now: () => new Date(FIXED_TIME),
  });
  assert.ok(!(storeResult instanceof StateStoreError));
  const store = storeResult;
  const slice = productionSlice("S13-timeout");
  const plan = {
    schema_version: 1,
    run_id: "run-production-timeout",
    commit_mode: "after_slice",
    model_capabilities: {
      schema_version: 1,
      source: "fake-port-test",
      captured_at: FIXED_TIME,
      expires_at: "2026-08-09T15:00:00.000Z",
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["max", "medium"] }],
    },
    slices: [slice],
  } as const satisfies ProductionPlanV1;
  const resolved: ResolvedProductionPlanV1 = {
    plan,
    plan_digest: sha256Json(plan),
    development_model: DEVELOPMENT_MODEL,
    continuation_model: DEVELOPMENT_MODEL,
    compression_model: { ...DEVELOPMENT_MODEL, effort: "medium" },
  };
  const lease: ProjectLease = {
    schema_version: 1,
    lease_id: "lease-production-timeout",
    workspace_identity: WORKSPACE,
    run_id: plan.run_id,
    epoch: 1,
    revision: 0,
    acquired_at: FIXED_TIME,
    renewed_at: FIXED_TIME,
    expires_at: "2026-08-09T15:00:00.000Z",
    status: "ACTIVE",
  };
  unwrapStored(store.create(createInitialRunState({
    run_id: plan.run_id,
    workspace_identity: WORKSPACE,
    plan_digest: resolved.plan_digest,
    commit_mode: plan.commit_mode,
    current_slice_id: slice.contract.slice_id,
    protected_baseline_digest: sliceStateBindingDigest(
      resolved.plan_digest,
      slice.contract.slice_id,
    ),
  })));
  unwrapStored(store.compareAndSwap(plan.run_id, 0, {
    action: "prepare_timeout_loop",
    to: "PREPARING",
    updates: { project_lock_owner: lease.lease_id, write_epoch: lease.epoch },
  }));

  const sourceThreadId = "00000000-0000-7000-8000-000000001301";
  const compressionTaskId = "00000000-0000-7000-8000-000000001302";
  const continuationTaskId = "00000000-0000-7000-8000-000000001303";
  const compactionId = `probe-${sha256Bytes("production-probe-timeout").slice("sha256:".length)}`;
  const calls: string[] = [];
  let resolveCompletion: (receipt: DevelopmentTaskReceipt) => void = () => undefined;
  const completion = new Promise<DevelopmentTaskReceipt>((resolve) => {
    resolveCompletion = resolve;
  });
  const handoffReceipt: HandoffReceipt = {
    compression_task_id: compressionTaskId,
    source_thread_id: sourceThreadId,
    workflow_version: "v2",
    markdown_path: "handoff.md",
    evidence_index_path: "handoff.evidence.json",
    source_revision: sha256Bytes("source-revision"),
    frame_digest: sha256Bytes("frame"),
    handoff_digest: sha256Bytes("handoff"),
    evidence_index_digest: sha256Bytes("evidence"),
    artifact_digest: sha256Bytes("artifact"),
    verify_evidence: "PASS",
    consumer_contract: {
      formatVersion: 1,
      kind: "codex-handoff-synthesize-first-consumer-contract",
      mode: "synthesize_first",
      firstDeliverableIds: ["continue-s13"],
      preDraftEvidenceReads: 0,
      maxTargetedReads: 3,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
  };
  const developmentTasks: DevelopmentTaskPort = {
    start(request) {
      calls.push("develop");
      assert.equal(request.slice_id, slice.contract.slice_id);
      return Promise.resolve({
        thread_id: sourceThreadId,
        turn_id: "turn-production-timeout",
        events: eventsOf({
          type: "AUTO_COMPACTION_STARTED",
          thread_id: sourceThreadId,
          compaction_id: compactionId,
          observed_at: FIXED_TIME,
          host_sequence: 1,
        }),
        completion,
      });
    },
  };
  let releases = 0;
  const compactionMonitor = {
    onEvent(runId: string, _event: unknown, expectedVersion: number): MonitorDecision {
      calls.push("compaction-timeout");
      const waiting = unwrapStored(store.compareAndSwap(runId, expectedVersion, {
        action: "observe_timeout_started",
        to: "COMPACTION_WAIT",
        updates: {
          compaction: {
            compaction_id: compactionId,
            observed_started_at: FIXED_TIME,
            deadline_at: FIXED_TIME,
            handoff_attempted: false,
          },
        },
      }));
      queueMicrotask(() => {
        unwrapStored(store.compareAndSwap(runId, waiting.state.state_version, {
          action: "observe_timeout_deadline",
          to: "SOURCE_INTERRUPTING",
        }));
      });
      return {
        outcome: "WAITING",
        run_id: runId,
        compaction_id: compactionId,
        state_version: waiting.state.state_version,
        status: "COMPACTION_WAIT",
      };
    },
  };
  const sourceInterruption = {
    interruptSource(
      runId: string,
      leaseId: string,
      expectedWriteEpoch: number,
      expectedStateVersion: number,
    ): Promise<SourceInterruptionDecision> {
      calls.push("interrupt");
      assert.equal(leaseId, lease.lease_id);
      assert.equal(expectedWriteEpoch, 1);
      const interrupted = unwrapStored(store.compareAndSwap(runId, expectedStateVersion, {
        action: "complete_timeout_interrupt",
        to: "HANDOFF_EXPORTING",
        updates: { write_epoch: 2 },
      }));
      const interruptReceipt = {
        thread_id: sourceThreadId,
        turn_id: "turn-production-timeout",
        terminal_status: "interrupted" as const,
        execution_stopped: true as const,
        thread_persisted: true as const,
        observed_at: FIXED_TIME,
      } as unknown as SourceInterruptionDecision["receipt"];
      const completionMaterial: Omit<DevelopmentTaskReceipt, "receipt_digest"> = {
        schema_version: 1,
        run_id: plan.run_id,
        slice_id: slice.contract.slice_id,
        thread_id: sourceThreadId,
        turn_id: "turn-production-timeout",
        outcome: "INTERRUPTED",
        started_at: FIXED_TIME,
        completed_at: FIXED_TIME,
      };
      resolveCompletion({ ...completionMaterial, receipt_digest: sha256Json(completionMaterial) });
      return Promise.resolve({
        outcome: "INTERRUPTED",
        run_id: runId,
        source_thread_id: sourceThreadId,
        compaction_id: compactionId,
        state_version: interrupted.state.state_version,
        status: "HANDOFF_EXPORTING",
        write_epoch: 2,
        effect_idempotency_key: sha256Bytes("interrupt-effect"),
        receipt: interruptReceipt,
      });
    },
  };
  const handoff = {
    exportHandoff(
      runId: string,
      interruptReceipt: SourceInterruptionDecision["receipt"],
      modelDecision: ModelInvocationDecision,
      expectedStateVersion: number,
    ): Promise<CompressionHandoffDecision> {
      calls.push("handoff");
      assert.equal(interruptReceipt.thread_id, sourceThreadId);
      assert.equal(modelDecision.effort, "medium");
      const exported = unwrapStored(store.compareAndSwap(runId, expectedStateVersion, {
        action: "complete_timeout_handoff",
        to: "CONTINUATION_STARTING",
        updates: {
          handoff: {
            compression_task_id: compressionTaskId,
            markdown_path: handoffReceipt.markdown_path,
            evidence_index_path: handoffReceipt.evidence_index_path,
            artifact_digest: handoffReceipt.artifact_digest,
          },
        },
      }));
      return Promise.resolve({
        outcome: "EXPORTED",
        run_id: runId,
        source_thread_id: sourceThreadId,
        compaction_id: compactionId,
        state_version: exported.state.state_version,
        status: "CONTINUATION_STARTING",
        effect_idempotency_key: sha256Bytes("handoff-effect"),
        receipt: handoffReceipt,
      });
    },
  };
  const continuation = {
    continueFromHandoff(value: ContinueFromHandoffInput): Promise<ContinuationDecision> {
      calls.push("continuation");
      assert.equal("expected_owned_diff_digest" in value, false);
      const continued = unwrapStored(store.compareAndSwap(value.run_id, value.expected_state_version, {
        action: "complete_timeout_continuation",
        to: "SLICE_RUNNING",
        updates: {
          write_epoch: 2,
          source_thread_id: continuationTaskId,
          compaction: null,
          handoff: {
            compression_task_id: compressionTaskId,
            markdown_path: handoffReceipt.markdown_path,
            evidence_index_path: handoffReceipt.evidence_index_path,
            artifact_digest: handoffReceipt.artifact_digest,
            continuation_task_id: continuationTaskId,
          },
        },
      }));
      return Promise.resolve({
        outcome: "CONTINUED",
        run_id: value.run_id,
        old_source_thread_id: sourceThreadId,
        continuation_task_id: continuationTaskId,
        current_slice_id: slice.contract.slice_id,
        state_version: continued.state.state_version,
        status: "SLICE_RUNNING",
        write_epoch: 2,
        envelope: {
          run_id: value.run_id,
          current_slice_id: slice.contract.slice_id,
          goal_prompt: `设定goal：阅读[Handoff Markdown](${handoffReceipt.markdown_path})，继续实现${slice.contract.slice_id}，完成后commit，刷新checkpoint`,
          handoff_markdown_path: handoffReceipt.markdown_path,
          evidence_index_path: handoffReceipt.evidence_index_path,
          consumer_contract: handoffReceipt.consumer_contract,
          expected_workspace_identity: WORKSPACE,
        },
        ready_receipt: {
          task_id: continuationTaskId,
          run_id: value.run_id,
          slice_id: slice.contract.slice_id,
          workspace_identity: WORKSPACE,
          handoff_artifact_digest: handoffReceipt.artifact_digest,
          consumer_contract_digest: sha256Json(handoffReceipt.consumer_contract),
          handoff_read: true,
          first_deliverable_ids: ["continue-s13"],
          first_deliverable_draft_digest: sha256Bytes("first-draft"),
          pre_draft_evidence_reads: 0,
          targeted_evidence_reads: 0,
          targeted_read_reasons: [],
          broad_search_count: 0,
          full_file_reread_count: 0,
          rollout_digest: sha256Bytes("rollout"),
          write_access: false,
          observed_state_version: value.expected_state_version,
          observed_at: FIXED_TIME,
        },
        lease_receipt: {
          task_id: continuationTaskId,
          lease_id: lease.lease_id,
          write_epoch: 2,
          workspace_identity: WORKSPACE,
          granted: true,
          observed_at: FIXED_TIME,
        },
        progress_receipt: {
          task_id: continuationTaskId,
          slice_id: slice.contract.slice_id,
          observed_state_version: continued.state.state_version,
          durable_artifact_digest: sha256Bytes("durable-progress"),
        },
      });
    },
  };
  const workspaceInspectionCalls = {
    captureBaseline: 0,
    captureCurrent: 0,
    classify: 0,
    assertCommittable: 0,
  };
  function forbidWorkspaceInspection(
    method: keyof typeof workspaceInspectionCalls,
  ): never {
    workspaceInspectionCalls[method] += 1;
    throw new Error(`${method} must not be called during compaction recovery.`);
  }
  const orchestrator = new ProductionOrchestrator({
    run_store: store,
    workspace_guard: {
      assertWritable() {
        return lease;
      },
      release() {
        releases += 1;
        return { ...lease, revision: 1, status: "RELEASED", released_at: FIXED_TIME };
      },
    },
    development_tasks: developmentTasks,
    change_guard: {
      captureBaseline() {
        return forbidWorkspaceInspection("captureBaseline");
      },
      captureCurrent() {
        return forbidWorkspaceInspection("captureCurrent");
      },
      classify() {
        return forbidWorkspaceInspection("classify");
      },
      assertCommittable() {
        return forbidWorkspaceInspection("assertCommittable");
      },
    },
    compaction_monitor: compactionMonitor,
    source_interruption: sourceInterruption,
    handoff,
    continuation,
    now: () => new Date(FIXED_TIME),
    poll_interval_ms: 1,
  });

  const result = await orchestrator.run(resolved);
  assert.ok(!(result instanceof ProductionRuntimeError));
  if (result.outcome !== "CONTINUATION_STARTED") {
    assert.fail("Timed-out production run completed instead of handing off.");
  }
  const continued = result;
  assert.equal(continued.source_thread_id, sourceThreadId);
  assert.equal(continued.compression_task_id, compressionTaskId);
  assert.equal(continued.continuation_task_id, continuationTaskId);
  assert.equal(new Set([
    continued.source_thread_id,
    continued.compression_task_id,
    continued.continuation_task_id,
  ]).size, 3);
  assert.equal("expected_owned_diff_digest" in continued, false);
  assert.deepEqual(workspaceInspectionCalls, {
    captureBaseline: 0,
    captureCurrent: 0,
    classify: 0,
    assertCommittable: 0,
  });
  assert.equal(releases, 0);
  assert.deepEqual(calls, [
    "develop",
    "compaction-timeout",
    "interrupt",
    "handoff",
    "continuation",
  ]);
  const final = unwrapStored(store.load(plan.run_id)).state;
  assert.equal(final.status, "SLICE_RUNNING");
  assert.equal(final.current_slice_id, slice.contract.slice_id);
  assert.equal(
    final.protected_baseline_digest,
    sliceStateBindingDigest(resolved.plan_digest, slice.contract.slice_id),
  );
  assert.equal(final.source_thread_id, continuationTaskId);
  assert.equal(final.write_epoch, 2);
});
