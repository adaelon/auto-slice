import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  AppServerCompressionLauncherError,
  CompressionHandoffCoordinator,
  CompressionHandoffError,
  type CompressionHandoffDecision,
  type CompressionRequest,
  type CompressionTaskLauncher,
  type CompressionTaskLaunchReceipt,
  type HandoffReceiptV2,
  type HandoffResultReceipt,
  type SynthesizeFirstConsumerContract,
} from "../src/controller/handoff/index.js";
import type { ModelDecision } from "../src/controller/model-policy/index.js";
import { CodexAppServerTaskHost } from "../src/controller/production/index.js";
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
const COMPRESSION_TURN_ID = "00000000-0000-7000-8000-000000000904";
const COMPACTION_ID = "compaction-s09";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const OBSERVED_AT = "2026-08-09T00:00:31.000Z";
const CREATED_AT = "2026-08-09T00:00:32.000Z";
const S20_APP_SERVER_FIXTURE = path.resolve("test/fixtures/process/fake-s20-app-server.mjs");

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
      turn_id: "00000000-0000-7000-8000-000000000903",
      terminal_status: "interrupted",
      execution_stopped: true,
      thread_persisted: true,
      observed_at: OBSERVED_AT,
    } as unknown as InterruptReceipt,
  };
}

function receiptArtifactDigest(
  receipt: Omit<HandoffReceiptV2, "artifact_digest">,
): Sha256Digest {
  return sha256Json(receipt);
}

function s20Request(workspaceRoot: string, suffix: string): CompressionRequest {
  return {
    run_id: `run-s20-${suffix}`,
    slice_id: "S20",
    source_thread_id: SOURCE_THREAD_ID,
    prompt: `$export-codex-handoff ${SOURCE_THREAD_ID}`,
    workspace_identity: createWorkspaceIdentity(workspaceRoot),
    compaction_id: `compaction-s20-${suffix}`,
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    idempotency_key: sha256Bytes(`s20-effect-${suffix}`),
  };
}

function s20Host(
  scenario: string,
  storageRoot: string,
  tracePath: string,
): CodexAppServerTaskHost {
  return new CodexAppServerTaskHost({
    command: process.execPath,
    args: [S20_APP_SERVER_FIXTURE, scenario, tracePath],
    request_timeout_ms: 5_000,
    handoff_artifact_storage_root: storageRoot,
    compression_maximum_final_result_bytes: 64 * 1024,
  });
}

function s20Trace(tracePath: string): readonly Readonly<Record<string, unknown>>[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
}

function unwrapS20Launch(value: unknown): CompressionTaskLaunchReceipt {
  assert.equal(typeof value, "object");
  assert.ok(value !== null);
  assert.equal((value as CompressionTaskLaunchReceipt).source_thread_id, SOURCE_THREAD_ID);
  return value as CompressionTaskLaunchReceipt;
}

function hasLauncherCode(error: unknown, code: string): boolean {
  return error instanceof AppServerCompressionLauncherError && error.code === code;
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
    assert.equal("source_persisted_revision" in request, false);
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
        source: { sourceRevision: SOURCE_REVISION },
        anchors: [],
        semanticCoverage: { turns: [], claims: [] },
        integrity: { indexDigest: "b".repeat(64) },
      }, null, 2)}\n`;
      writeFileSync(markdownPath, markdown, "utf8");
      writeFileSync(evidencePath, evidence, "utf8");
      const material = {
        receipt_schema_version: 2,
        compression_task_id: compressionTaskId,
        compression_turn_id: COMPRESSION_TURN_ID,
        source_thread_id: request.source_thread_id,
        workflow_version: 2,
        markdown_path: markdownPath,
        evidence_index_path: evidencePath,
        source_revision: SOURCE_REVISION,
        structural_digest: `sha256:${"c".repeat(64)}`,
        handoff_digest: sha256Bytes(markdown),
        evidence_index_digest: sha256Bytes(evidence),
        verify_evidence: "PASS",
        verify_evidence_result_digest: sha256Json({
          valid: true,
          sourceRevision: SOURCE_REVISION,
        }),
        consumer_contract: CONSUMER_CONTRACT,
      } as const satisfies Omit<HandoffReceiptV2, "artifact_digest">;
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
    id: "noncanonical_export_revision",
    reason: "handoff_receipt_invalid" as const,
    transform: (receipt: Readonly<Record<string, unknown>>) => ({
      ...receipt,
      source_revision: "legacy-opaque-revision",
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

for (const scenario of [
  { code: "SKILL_RESOLUTION_FAILED", reason: "skill_resolution_failed", stage: "start", failure: "handoff_export_failed" },
  { code: "ARTIFACT_ALLOCATION_FAILED", reason: "artifact_allocation_failed", stage: "start", failure: "handoff_export_failed" },
  { code: "COMPRESSION_TURN_FAILED", reason: "compression_turn_failed", stage: "handoff", failure: "handoff_export_failed" },
  { code: "COMMAND_CHAIN_INVALID", reason: "command_chain_invalid", stage: "handoff", failure: "handoff_export_failed" },
  { code: "HELPER_OUTPUT_INVALID", reason: "helper_output_invalid", stage: "handoff", failure: "handoff_export_failed" },
  { code: "HANDOFF_PATH_INVALID", reason: "handoff_path_invalid", stage: "handoff", failure: "handoff_integrity_failed" },
  { code: "HANDOFF_ARTIFACT_MISSING", reason: "handoff_artifact_missing", stage: "handoff", failure: "handoff_integrity_failed" },
  { code: "HANDOFF_ARTIFACT_DIGEST_MISMATCH", reason: "handoff_artifact_digest_mismatch", stage: "handoff", failure: "handoff_integrity_failed" },
  { code: "HANDOFF_VERIFY_FAILED", reason: "handoff_verify_failed", stage: "handoff", failure: "handoff_integrity_failed" },
  { code: "HANDOFF_RECEIPT_INVALID", reason: "handoff_receipt_invalid", stage: "handoff", failure: "handoff_integrity_failed" },
  { code: "RECEIPT_REPLAY_MISMATCH", reason: "receipt_replay_mismatch", stage: "handoff", failure: "handoff_integrity_failed" },
] as const) {
  void test(`S20 maps launcher diagnostic ${scenario.code}`, async (context) => {
    const value = fixture(context, `diagnostic-${scenario.code.toLowerCase()}`);
    const error = Object.assign(new Error("bounded S20 diagnostic"), { code: scenario.code });
    const launcher = new MemoryCompressionLauncher(
      scenario.stage === "start" ? { start_error: error } : { handoff_error: error },
    );
    const result = await coordinator(value, launcher).exportHandoff(
      value.run_id,
      value.interrupt_receipt,
      COMPRESSION_DECISION,
      value.state_version,
    );
    expectHandoffError(result, scenario.reason, scenario.failure);
  });
}

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

void test("S22 default Host takes the first final-result file address and persistently replays it", async (context) => {
  const root = temporaryDirectory(context, "s20-happy");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "handoff-storage");
  const tracePath = path.join(root, "first-protocol.jsonl");
  mkdirSync(workspaceRoot);
  const request = s20Request(workspaceRoot, "happy");
  const host = s20Host("happy", storageRoot, tracePath);
  context.after(async () => host.dispose());

  const launch = unwrapS20Launch(await host.compression_launcher.start(request));
  const rawReceipt = await host.compression_launcher.awaitHandoff(
    launch.compression_task_id,
    request.idempotency_key,
  );
  const receipt = rawReceipt as HandoffResultReceipt;
  assert.equal(receipt.receipt_schema_version, 3);
  assert.equal(receipt.workflow_version, 3);
  assert.equal(receipt.compression_task_id, launch.compression_task_id);
  assert.equal(receipt.source_thread_id, request.source_thread_id);
  assert.match(path.basename(receipt.markdown_path), /^handoff-[0-9a-f-]+\.md$/u);
  assert.equal("evidence_index_path" in receipt, false);
  assert.equal("verify_evidence" in receipt, false);
  const { artifact_digest: artifactDigest, ...receiptMaterial } = receipt;
  assert.equal(artifactDigest, sha256Json(receiptMaterial));
  const relativeArtifact = path.relative(storageRoot, receipt.markdown_path);
  assert.ok(relativeArtifact.length > 0);
  assert.equal(path.isAbsolute(relativeArtifact), false);
  assert.equal(relativeArtifact.startsWith(`..${path.sep}`), false);
  assert.equal(path.relative(workspaceRoot, receipt.markdown_path).startsWith(".."), true);

  const journalPath = path.join(
    storageRoot,
    "handoff-launcher-journal",
    `${request.idempotency_key.slice("sha256:".length)}.json`,
  );
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    readonly attempt_number: number;
    readonly attempt_id: string;
    readonly status: string;
    readonly receipt: HandoffResultReceipt;
  };
  assert.equal(journal.attempt_number, 1);
  assert.match(journal.attempt_id, /^attempt-000001-[0-9a-f]{16}$/u);
  assert.equal(journal.status, "COMPLETED");
  assert.deepEqual(journal.receipt, receipt);

  const replayLaunch = unwrapS20Launch(await host.compression_launcher.start(request));
  const replayReceipt = await host.compression_launcher.awaitHandoff(
    replayLaunch.compression_task_id,
    request.idempotency_key,
  );
  assert.deepEqual(replayLaunch, launch);
  assert.deepEqual(replayReceipt, receipt);
  const methods = s20Trace(tracePath).map((entry) => entry.method);
  assert.equal(methods.filter((method) => method === "skills/list").length, 1);
  assert.equal(methods.filter((method) => method === "thread/start").length, 1);
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);
  await host.dispose();

  const restartTrace = path.join(root, "restart-protocol.jsonl");
  const restartedHost = s20Host("skill-missing", storageRoot, restartTrace);
  context.after(async () => restartedHost.dispose());
  const restartedLaunch = unwrapS20Launch(await restartedHost.compression_launcher.start(request));
  const restartedReceipt = await restartedHost.compression_launcher.awaitHandoff(
    restartedLaunch.compression_task_id,
    request.idempotency_key,
  );
  assert.deepEqual(restartedLaunch, launch);
  assert.deepEqual(restartedReceipt, receipt);
  assert.deepEqual(s20Trace(restartTrace), []);
});

for (const scenario of [
  "missing-prepare",
  "duplicate-prepare",
  "out-of-order",
  "extra-echo",
  "bare-node",
  "combined-shell",
  "call-operator-combined-shell",
  "double-call-operator",
  "default-output",
  "workdir-swap",
  "malformed-prepare-output",
  "oversized-prepare-output",
  "digest-tamper",
  "path-tamper",
  "retain-workdir",
  "single-file",
  "hardlink-pair",
  "consumer-tamper",
  "evidence-session-tamper",
  "evidence-cwd-tamper",
  "evidence-revision-tamper",
  "evidence-json-malformed",
  "verify-fail",
] as const) {
  void test(`S22 trusts the first final-result address without modeling ${scenario}`, async (context) => {
    const root = temporaryDirectory(context, `s22-final-artifacts-${scenario}`);
    const workspaceRoot = path.join(root, "workspace");
    const storageRoot = path.join(root, "handoff-storage");
    mkdirSync(workspaceRoot);
    const request = s20Request(workspaceRoot, scenario);
    const host = s20Host(scenario, storageRoot, path.join(root, "protocol.jsonl"));
    context.after(async () => host.dispose());

    const launch = unwrapS20Launch(await host.compression_launcher.start(request));
    const receipt = await host.compression_launcher.awaitHandoff(
      launch.compression_task_id,
      request.idempotency_key,
    ) as HandoffResultReceipt;
    assert.equal(receipt.receipt_schema_version, 3);
    assert.equal(receipt.compression_task_id, launch.compression_task_id);
    assert.equal(receipt.source_thread_id, request.source_thread_id);
    assert.match(path.basename(receipt.markdown_path), /^handoff-[0-9a-f-]+\.md$/u);
    assert.equal(Object.keys(receipt).includes("evidence_index_path"), false);
    assert.equal(Object.keys(receipt).includes("verify_evidence"), false);
  });
}

void test("S20 failed journal retry claims a new attempt before publishing", async (context) => {
  const root = temporaryDirectory(context, "s20-retry");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "handoff-storage");
  mkdirSync(workspaceRoot);
  const request = s20Request(workspaceRoot, "retry");
  const journalPath = path.join(
    storageRoot,
    "handoff-launcher-journal",
    `${request.idempotency_key.slice("sha256:".length)}.json`,
  );
  const failedHost = s20Host("source-changed", storageRoot, path.join(root, "failed.jsonl"));
  context.after(async () => failedHost.dispose());
  const failedLaunch = unwrapS20Launch(await failedHost.compression_launcher.start(request));
  await assert.rejects(
    failedHost.compression_launcher.awaitHandoff(
      failedLaunch.compression_task_id,
      request.idempotency_key,
    ),
    (error: unknown) => {
      return error instanceof AppServerCompressionLauncherError &&
        error.code === "COMPRESSION_TURN_FAILED" &&
        error.retained_work_dir?.endsWith(`attempt-000001-${request.idempotency_key.slice(7, 23)}`) === true;
    },
  );
  const failedJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    readonly attempt_number: number;
    readonly artifact_root: string;
    readonly status: string;
    readonly diagnostic_code: string;
    readonly retained_work_dir: string;
  };
  assert.equal(failedJournal.attempt_number, 1);
  assert.equal(failedJournal.status, "FAILED");
  assert.equal(failedJournal.diagnostic_code, "COMPRESSION_TURN_FAILED");
  assert.equal(failedJournal.retained_work_dir, failedJournal.artifact_root);
  await failedHost.dispose();

  const retryHost = s20Host("happy", storageRoot, path.join(root, "retry.jsonl"));
  context.after(async () => retryHost.dispose());
  const retryLaunch = unwrapS20Launch(await retryHost.compression_launcher.start(request));
  const receipt = await retryHost.compression_launcher.awaitHandoff(
    retryLaunch.compression_task_id,
    request.idempotency_key,
  ) as HandoffResultReceipt;
  const completedJournal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    readonly attempt_number: number;
    readonly artifact_root: string;
    readonly status: string;
  };
  assert.equal(completedJournal.attempt_number, 2);
  assert.equal(completedJournal.status, "COMPLETED");
  assert.notEqual(completedJournal.artifact_root, failedJournal.artifact_root);
  assert.match(completedJournal.artifact_root, /attempt-000002-[0-9a-f]{16}$/u);
  assert.equal(path.dirname(receipt.markdown_path), completedJournal.artifact_root);
});

for (const [scenario, stage, expectedCode] of [
  ["skill-missing", "start", "SKILL_RESOLUTION_FAILED"],
  ["skill-duplicate", "start", "SKILL_RESOLUTION_FAILED"],
  ["skill-disabled", "start", "SKILL_RESOLUTION_FAILED"],
  ["skill-errors", "start", "SKILL_RESOLUTION_FAILED"],
  ["skill-path-relative", "start", "SKILL_RESOLUTION_FAILED"],
  ["final-message-only", "handoff", "HANDOFF_RESULT_INVALID"],
  ["relative-final-link", "handoff", "HANDOFF_RESULT_INVALID"],
  ["source-changed", "handoff", "COMPRESSION_TURN_FAILED"],
] as const) {
  void test(`S20 fails closed for ${scenario}`, async (context) => {
    const root = temporaryDirectory(context, `s20-${scenario}`);
    const workspaceRoot = path.join(root, "workspace");
    const storageRoot = path.join(root, "handoff-storage");
    mkdirSync(workspaceRoot);
    const request = s20Request(workspaceRoot, scenario);
    const host = s20Host(scenario, storageRoot, path.join(root, "protocol.jsonl"));
    context.after(async () => host.dispose());
    if (stage === "start") {
      await assert.rejects(
        host.compression_launcher.start(request),
        (error: unknown) => hasLauncherCode(error, expectedCode),
      );
      return;
    }
    const launch = unwrapS20Launch(await host.compression_launcher.start(request));
    await assert.rejects(
      host.compression_launcher.awaitHandoff(
        launch.compression_task_id,
        request.idempotency_key,
      ),
      (error: unknown) => hasLauncherCode(error, expectedCode),
    );
  });
}

void test("S22 final-result receipt contains only the first Handoff address", async (context) => {
  const root = temporaryDirectory(context, "s20-retain-workdir");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "handoff-storage");
  mkdirSync(workspaceRoot);
  const request = s20Request(workspaceRoot, "retain-workdir");
  const host = s20Host("retain-workdir", storageRoot, path.join(root, "protocol.jsonl"));
  context.after(async () => host.dispose());
  const launch = unwrapS20Launch(await host.compression_launcher.start(request));
  const receipt = await host.compression_launcher.awaitHandoff(
    launch.compression_task_id,
    request.idempotency_key,
  ) as HandoffResultReceipt;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "artifact_digest",
    "compression_task_id",
    "compression_turn_id",
    "markdown_path",
    "receipt_schema_version",
    "source_thread_id",
    "workflow_version",
  ]);
});

void test("S20 journals an occupied attempt and retries only in a new directory", async (context) => {
  const root = temporaryDirectory(context, "s20-collision");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "handoff-storage");
  mkdirSync(workspaceRoot);
  const request = s20Request(workspaceRoot, "collision");
  const digestHex = request.idempotency_key.slice("sha256:".length);
  const occupiedAttempt = path.join(
    storageRoot,
    "handoffs",
    request.run_id,
    request.slice_id,
    `attempt-000001-${digestHex.slice(0, 16)}`,
  );
  mkdirSync(occupiedAttempt, { recursive: true });
  writeFileSync(path.join(occupiedAttempt, "foreign.txt"), "do not overwrite\n", "utf8");
  const firstHost = s20Host("happy", storageRoot, path.join(root, "first.jsonl"));
  context.after(async () => firstHost.dispose());
  await assert.rejects(
    firstHost.compression_launcher.start(request),
    (error: unknown) => hasLauncherCode(error, "ARTIFACT_ALLOCATION_FAILED"),
  );
  assert.equal(readFileSync(path.join(occupiedAttempt, "foreign.txt"), "utf8"), "do not overwrite\n");
  const journalPath = path.join(storageRoot, "handoff-launcher-journal", `${digestHex}.json`);
  const failed = JSON.parse(readFileSync(journalPath, "utf8")) as {
    readonly attempt_number: number;
    readonly status: string;
  };
  assert.equal(failed.attempt_number, 1);
  assert.equal(failed.status, "FAILED");
  await firstHost.dispose();

  const retryHost = s20Host("happy", storageRoot, path.join(root, "retry.jsonl"));
  context.after(async () => retryHost.dispose());
  const launch = unwrapS20Launch(await retryHost.compression_launcher.start(request));
  const receipt = await retryHost.compression_launcher.awaitHandoff(
    launch.compression_task_id,
    request.idempotency_key,
  ) as HandoffResultReceipt;
  assert.match(path.dirname(receipt.markdown_path), /attempt-000002-[0-9a-f]{16}$/u);
  assert.equal(readFileSync(path.join(occupiedAttempt, "foreign.txt"), "utf8"), "do not overwrite\n");
});

void test("S20 rejects a symlinked Handoff directory before starting a fresh task", async (context) => {
  const root = temporaryDirectory(context, "s20-symlink");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "handoff-storage");
  const outsideRoot = path.join(root, "outside");
  mkdirSync(workspaceRoot);
  mkdirSync(storageRoot);
  mkdirSync(outsideRoot);
  symlinkSync(
    outsideRoot,
    path.join(storageRoot, "handoffs"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const request = s20Request(workspaceRoot, "symlink");
  const tracePath = path.join(root, "protocol.jsonl");
  const host = s20Host("happy", storageRoot, tracePath);
  context.after(async () => host.dispose());
  await assert.rejects(
    host.compression_launcher.start(request),
    (error: unknown) => hasLauncherCode(error, "ARTIFACT_ALLOCATION_FAILED"),
  );
  assert.equal(s20Trace(tracePath).filter((entry) => entry.method === "thread/start").length, 0);
});
