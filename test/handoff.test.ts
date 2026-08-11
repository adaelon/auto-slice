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
  CompressionHandoffCoordinator,
  CompressionHandoffError,
  type CompressionHandoffDecision,
  type CompressionRequest,
  type CompressionTaskLauncher,
  type HandoffReceipt,
  type SynthesizeFirstConsumerContract,
} from "../src/controller/handoff/index.js";
import type { ModelDecision } from "../src/controller/model-policy/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type RunTransition,
  type Sha256Digest,
  type StoredRun,
} from "../src/controller/state/index.js";
import type { InterruptReceipt } from "../src/controller/thread-control/index.js";

const SOURCE_THREAD_ID = "00000000-0000-7000-8000-000000000901";
const COMPRESSION_TASK_ID = "00000000-0000-7000-8000-000000000902";
const COMPACTION_ID = "compaction-s09";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const OBSERVED_AT = "2026-08-09T00:00:31.000Z";
const CREATED_AT = "2026-08-09T00:00:32.000Z";

const COMPRESSION_DECISION = {
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "medium",
} as const satisfies ModelDecision;

const CONSUMER_CONTRACT = {
  formatVersion: 1,
  kind: "codex-handoff-synthesize-first-consumer-contract",
  mode: "synthesize_first",
  firstDeliverableIds: ["continue-s09"],
  preDraftEvidenceReads: 0,
  maxTargetedReads: 2,
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
  forbidBroadSearch: true,
  forbidFullFileReread: true,
} as const satisfies SynthesizeFirstConsumerContract;

interface Fixture {
  readonly root: string;
  readonly workspace_root: string;
  readonly store: FileRunStore;
  readonly run_id: string;
  readonly state_version: number;
  readonly interrupt_receipt: InterruptReceipt;
}

interface LauncherOptions {
  readonly start_error?: Error;
  readonly handoff_error?: Error;
  readonly launch_transform?: (
    receipt: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly handoff_transform?: (
    receipt: Readonly<Record<string, unknown>>,
    paths: { readonly markdown: string; readonly evidence: string },
  ) => unknown;
}

function temporaryDirectory(context: TestContext, suffix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), `auto-slice-s09-${suffix}-`));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function openStore(root: string): FileRunStore {
  const store = FileRunStore.open(root, { now: () => new Date(CREATED_AT) });
  if (store instanceof StateStoreError) {
    assert.fail(`${store.code}: ${store.message}`);
  }
  return store;
}

function unwrapStored(result: StoredRun | StateStoreError): StoredRun {
  if (result instanceof StateStoreError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function fixture(context: TestContext, suffix: string): Fixture {
  const root = temporaryDirectory(context, suffix);
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  const store = openStore(path.join(root, "state"));
  const runId = `run-s09-${suffix}`;
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: createWorkspaceIdentity(workspaceRoot),
    plan_digest: sha256Bytes(`plan-${suffix}`),
    commit_mode: "after_slice",
    current_slice_id: "S09",
    protected_baseline_digest: sha256Bytes(`baseline-${suffix}`),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s09_fixture",
    to: "PREPARING",
    updates: { source_thread_id: SOURCE_THREAD_ID },
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s09_fixture",
    to: "SLICE_RUNNING",
  }));
  unwrapStored(store.compareAndSwap(runId, 2, {
    action: "observe_s09_compaction",
    to: "COMPACTION_WAIT",
    updates: {
      compaction: {
        compaction_id: COMPACTION_ID,
        observed_started_at: "2026-08-09T00:00:00.000Z",
        deadline_at: "2026-08-09T00:00:30.000Z",
        handoff_attempted: false,
      },
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 3, {
    action: "observe_s09_deadline",
    to: "SOURCE_INTERRUPTING",
  }));
  const exporting = unwrapStored(store.compareAndSwap(runId, 4, {
    action: "complete_s09_source_interruption",
    to: "HANDOFF_EXPORTING",
  }));
  return {
    root,
    workspace_root: workspaceRoot,
    store,
    run_id: runId,
    state_version: exporting.state.state_version,
    interrupt_receipt: {
      thread_id: SOURCE_THREAD_ID,
      execution_stopped: true,
      thread_persisted: true,
      persisted_revision: SOURCE_REVISION,
      observed_at: OBSERVED_AT,
    },
  };
}

function receiptArtifactDigest(
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

class MemoryCompressionLauncher implements CompressionTaskLauncher {
  public start_invocations = 0;
  public start_side_effects = 0;
  public handoff_invocations = 0;
  public handoff_side_effects = 0;
  private readonly starts = new Map<Sha256Digest, Promise<unknown>>();
  private readonly handoffs = new Map<Sha256Digest, Promise<unknown>>();
  private readonly requests = new Map<string, CompressionRequest>();

  public constructor(private readonly options: LauncherOptions = {}) {}

  public start(request: CompressionRequest): Promise<unknown> {
    this.start_invocations += 1;
    assert.equal(
      request.prompt,
      `$export-codex-handoff ${SOURCE_THREAD_ID}`,
    );
    const existing = this.starts.get(request.idempotency_key);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.start_error !== undefined) {
        throw this.options.start_error;
      }
      this.start_side_effects += 1;
      this.requests.set(COMPRESSION_TASK_ID, request);
      const receipt = {
        compression_task_id: COMPRESSION_TASK_ID,
        source_thread_id: request.source_thread_id,
        workspace_identity: request.workspace_identity,
        history_empty: true,
        project_write_lease: false,
        model: request.model,
        reasoning_effort: request.reasoning_effort,
        created_at: CREATED_AT,
      };
      return this.options.launch_transform?.(receipt) ?? receipt;
    });
    this.starts.set(request.idempotency_key, pending);
    return pending;
  }

  public awaitHandoff(
    compressionTaskId: string,
    idempotencyKey: Sha256Digest,
  ): Promise<unknown> {
    this.handoff_invocations += 1;
    const existing = this.handoffs.get(idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve().then(() => {
      if (this.options.handoff_error !== undefined) {
        throw this.options.handoff_error;
      }
      const request = this.requests.get(compressionTaskId);
      assert.ok(request !== undefined);
      this.handoff_side_effects += 1;
      const markdownPath = path.join(
        request.workspace_identity.canonical_root,
        `handoff-${request.source_thread_id}.md`,
      );
      const evidencePath = path.join(
        request.workspace_identity.canonical_root,
        `handoff-${request.source_thread_id}.evidence.json`,
      );
      const markdown = "# Codex Handoff\n\nworkflow: handoff-v2\n";
      const evidence = `${JSON.stringify({
        source: { sourceRevision: request.source_persisted_revision },
        anchors: [],
        semanticCoverage: { turns: [], claims: [] },
        integrity: { indexDigest: "b".repeat(64) },
      }, null, 2)}\n`;
      writeFileSync(markdownPath, markdown, "utf8");
      writeFileSync(evidencePath, evidence, "utf8");
      const material = {
        compression_task_id: compressionTaskId,
        source_thread_id: request.source_thread_id,
        workflow_version: "v2",
        markdown_path: markdownPath,
        evidence_index_path: evidencePath,
        source_revision: request.source_persisted_revision,
        frame_digest: `sha256:${"c".repeat(64)}`,
        handoff_digest: sha256Bytes(markdown),
        evidence_index_digest: sha256Bytes(evidence),
        verify_evidence: "PASS",
        consumer_contract: CONSUMER_CONTRACT,
      } as const satisfies Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">;
      const receipt = {
        ...material,
        artifact_digest: receiptArtifactDigest(material),
      };
      return this.options.handoff_transform?.(receipt, {
        markdown: markdownPath,
        evidence: evidencePath,
      }) ?? receipt;
    });
    this.handoffs.set(idempotencyKey, pending);
    return pending;
  }
}

function coordinator(
  value: Fixture,
  launcher: CompressionTaskLauncher,
  runStore: FileRunStore | {
    load: FileRunStore["load"];
    compareAndSwap: FileRunStore["compareAndSwap"];
    appendEffectIntent: FileRunStore["appendEffectIntent"];
    completeEffect: FileRunStore["completeEffect"];
  } = value.store,
): CompressionHandoffCoordinator {
  return new CompressionHandoffCoordinator({
    run_store: runStore,
    launcher,
    now: () => new Date(CREATED_AT),
    export_timeout_ms: 1_000,
  });
}

function unwrapDecision(
  result: CompressionHandoffDecision | CompressionHandoffError,
): CompressionHandoffDecision {
  if (result instanceof CompressionHandoffError) {
    assert.fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function expectHandoffError(
  result: CompressionHandoffDecision | CompressionHandoffError,
  reason: CompressionHandoffError["reason"],
  code?: CompressionHandoffError["code"],
): CompressionHandoffError {
  assert.ok(result instanceof CompressionHandoffError);
  assert.equal(result.reason, reason);
  if (code !== undefined) {
    assert.equal(result.code, code);
  }
  return result;
}

void test("exports one isolated Handoff v2 and replays the terminal receipt", async (context) => {
  const value = fixture(context, "success");
  const launcher = new MemoryCompressionLauncher();
  const subject = coordinator(value, launcher);

  const first = unwrapDecision(await subject.exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  ));
  const repeated = unwrapDecision(await subject.exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  ));

  assert.equal(first.outcome, "EXPORTED");
  assert.equal(repeated.outcome, "ALREADY_EXPORTED");
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.handoff_side_effects, 1);
  const state = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(state.status, "CONTINUATION_STARTING");
  assert.equal(state.state_version, value.state_version + 2);
  assert.ok(state.compaction !== undefined);
  assert.ok(state.handoff !== undefined);
  assert.equal(state.compaction.handoff_attempted, true);
  assert.equal(state.handoff.compression_task_id, COMPRESSION_TASK_ID);
  assert.equal(state.handoff.artifact_digest, first.receipt.artifact_digest);
});

void test("concurrent callers claim one compaction and create one Compression Task", async (context) => {
  const value = fixture(context, "concurrent");
  const launcher = new MemoryCompressionLauncher();
  const subject = coordinator(value, launcher);
  const invoke = async (): Promise<CompressionHandoffDecision | CompressionHandoffError> =>
    subject.exportHandoff(
      value.run_id,
      value.interrupt_receipt,
      COMPRESSION_DECISION,
      value.state_version,
    );

  const decisions = (await Promise.all([invoke(), invoke()])).map(unwrapDecision);
  assert.deepEqual(
    decisions.map((entry) => entry.outcome).sort(),
    ["ALREADY_EXPORTED", "EXPORTED"],
  );
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.handoff_side_effects, 1);
});

void test("a persisted attempt claim recovers without explicit user retry", async (context) => {
  const value = fixture(context, "claim-recovery");
  const before = unwrapStored(value.store.load(value.run_id)).state;
  assert.ok(before.compaction !== undefined);
  unwrapStored(value.store.compareAndSwap(value.run_id, value.state_version, {
    action: "mark_handoff_attempted",
    to: "HANDOFF_EXPORTING",
    updates: {
      compaction: { ...before.compaction, handoff_attempted: true },
    },
  }));

  const decision = unwrapDecision(await coordinator(
    value,
    new MemoryCompressionLauncher(),
  ).exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  ));
  assert.equal(decision.outcome, "EXPORTED");
});

void test("a completed export effect recovers after the final Run transition fails", async (context) => {
  const value = fixture(context, "transition-recovery");
  const launcher = new MemoryCompressionLauncher();
  let rejectTransition = true;
  const interruptedStore = {
    load: value.store.load.bind(value.store),
    appendEffectIntent: value.store.appendEffectIntent.bind(value.store),
    completeEffect: value.store.completeEffect.bind(value.store),
    compareAndSwap: (
      runId: string,
      expectedVersion: number,
      transition: RunTransition,
    ): StoredRun | StateStoreError => {
      if (transition.action === "complete_handoff_export" && rejectTransition) {
        rejectTransition = false;
        return new StateStoreError("state_persist_failed", "injected final transition failure");
      }
      return value.store.compareAndSwap(runId, expectedVersion, transition);
    },
  };
  const interrupted = await coordinator(
    value,
    launcher,
    interruptedStore,
  ).exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  );
  assert.ok(interrupted instanceof CompressionHandoffError);
  assert.equal(interrupted.code, "state_persist_failed");
  assert.equal(unwrapStored(value.store.load(value.run_id)).state.status, "HANDOFF_EXPORTING");

  const recovered = unwrapDecision(await coordinator(value, launcher).exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  ));
  assert.equal(recovered.outcome, "EXPORTED");
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.handoff_side_effects, 1);
});

const LAUNCH_FAILURES = [
  {
    id: "source_reused",
    reason: "task_identity_conflict" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      compression_task_id: SOURCE_THREAD_ID,
    }),
  },
  {
    id: "history_copied",
    reason: "task_history_not_empty" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      history_empty: false,
    }),
  },
  {
    id: "write_lease_granted",
    reason: "task_write_lease_present" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      project_write_lease: true,
    }),
  },
  {
    id: "wrong_model",
    reason: "task_model_mismatch" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      reasoning_effort: "max",
    }),
  },
] as const;

for (const scenario of LAUNCH_FAILURES) {
  void test(`fails closed when Compression isolation is ${scenario.id}`, async (context) => {
    const value = fixture(context, scenario.id);
    const result = await coordinator(
      value,
      new MemoryCompressionLauncher({ launch_transform: scenario.transform }),
    ).exportHandoff(
      value.run_id,
      value.interrupt_receipt,
      COMPRESSION_DECISION,
      value.state_version,
    );

    expectHandoffError(result, scenario.reason, "handoff_export_failed");
    const state = unwrapStored(value.store.load(value.run_id)).state;
    assert.equal(state.status, "NEEDS_USER");
    assert.equal(state.compaction?.handoff_attempted, true);
    assert.equal(state.last_error?.details?.reason, scenario.reason);
  });
}

const HANDOFF_FAILURES = [
  {
    id: "legacy_v1",
    reason: "handoff_workflow_version_mismatch" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      workflow_version: "v1",
    }),
  },
  {
    id: "revision_drift",
    reason: "handoff_source_revision_mismatch" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      source_revision: `sha256:${"d".repeat(64)}`,
    }),
  },
  {
    id: "verify_failed",
    reason: "handoff_verify_failed" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      verify_evidence: "FAIL",
    }),
  },
  {
    id: "digest_tampered",
    reason: "handoff_artifact_digest_mismatch" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      evidence_index_digest: `sha256:${"e".repeat(64)}`,
    }),
  },
] as const;

for (const scenario of HANDOFF_FAILURES) {
  void test(`fails closed for Handoff ${scenario.id}`, async (context) => {
    const value = fixture(context, scenario.id);
    const result = await coordinator(
      value,
      new MemoryCompressionLauncher({ handoff_transform: scenario.transform }),
    ).exportHandoff(
      value.run_id,
      value.interrupt_receipt,
      COMPRESSION_DECISION,
      value.state_version,
    );

    expectHandoffError(result, scenario.reason, "handoff_integrity_failed");
    const state = unwrapStored(value.store.load(value.run_id)).state;
    assert.equal(state.status, "NEEDS_USER");
    assert.equal(state.handoff, undefined);
    assert.equal(state.last_error?.details?.reason, scenario.reason);
  });
}

void test("a missing half of the publication pair fails integrity", async (context) => {
  const value = fixture(context, "missing-index");
  const result = await coordinator(
    value,
    new MemoryCompressionLauncher({
      handoff_transform: (receipt, paths) => {
        rmSync(paths.evidence);
        return receipt;
      },
    }),
  ).exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  );
  expectHandoffError(result, "handoff_artifact_missing", "handoff_integrity_failed");
});

void test("worker capacity failure is retained and cannot auto-retry", async (context) => {
  const value = fixture(context, "worker-unavailable");
  const retained = path.join(value.root, "managed-workdir");
  const error = Object.assign(new Error("no fresh MAP worker"), {
    code: "MAP_WORKER_UNAVAILABLE",
    workDir: retained,
  });
  const launcher = new MemoryCompressionLauncher({ handoff_error: error });
  const subject = coordinator(value, launcher);
  const first = await subject.exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  );
  expectHandoffError(first, "worker_unavailable", "handoff_export_failed");
  const state = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(state.status, "NEEDS_USER");
  assert.ok(state.last_error !== undefined);
  assert.ok(state.last_error.details !== undefined);
  assert.equal(state.last_error.details.diagnostic_code, "MAP_WORKER_UNAVAILABLE");
  assert.equal(state.last_error.details.retained_work_dir, retained);

  const second = await subject.exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    COMPRESSION_DECISION,
    value.state_version,
  );
  assert.ok(second instanceof CompressionHandoffError);
  assert.equal(launcher.start_side_effects, 1);
  assert.equal(launcher.handoff_side_effects, 0);
});

void test("an unavailable exact model closes before task creation", async (context) => {
  const value = fixture(context, "model-unavailable");
  const launcher = new MemoryCompressionLauncher();
  const result = await coordinator(value, launcher).exportHandoff(
    value.run_id,
    value.interrupt_receipt,
    {
      mode: "model",
      model: "gpt-5.6-sol",
      effort: "max",
    },
    value.state_version,
  );
  expectHandoffError(result, "model_policy_invalid", "model_policy_unavailable");
  assert.equal(launcher.start_side_effects, 0);
  const state = unwrapStored(value.store.load(value.run_id)).state;
  assert.equal(state.status, "NEEDS_USER");
  assert.equal(state.compaction?.handoff_attempted, false);
});
