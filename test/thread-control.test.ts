import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  SourceInterruptionCoordinator,
  SourceInterruptionError,
  type SourceInterruptionDecision,
  type ThreadControlPort,
} from "../src/controller/thread-control/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
  type RunTransition,
  type Sha256Digest,
  type StoredRun,
} from "../src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
  type FileWorkspaceGuardOptions,
  type ProjectLease,
} from "../src/controller/workspace/index.js";

const OBSERVED_AT = "2026-08-08T00:00:31.000Z";
const INSPECTED_AT = "2026-08-08T00:00:31.001Z";
const SOURCE_THREAD_ID = "thread-source-s08";
const COMPACTION_ID = "compaction-s08";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

interface MemoryThreadControlOptions {
  readonly gate?: Promise<void>;
  readonly hang_interrupt?: boolean;
  readonly reject_interrupt?: boolean;
  readonly reject_inspection?: boolean;
  readonly on_interrupt?: () => void;
  readonly receipt_transform?: (
    receipt: Readonly<Record<string, unknown>>,
    invocation: number,
  ) => unknown;
  readonly inspection_transform?: (
    inspection: Readonly<Record<string, unknown>>,
  ) => unknown;
}

class MemoryThreadControl implements ThreadControlPort {
  public interrupt_invocations = 0;
  public interrupt_side_effects = 0;
  public execution_stopped = false;
  public readable = true;
  public archived = false;
  public deleted = false;
  public persisted_revision = "revision-s08-0001";
  private readonly receipts = new Map<Sha256Digest, Readonly<Record<string, unknown>>>();

  public constructor(private readonly options: MemoryThreadControlOptions = {}) {}

  public async interrupt(
    threadId: string,
    idempotencyKey: Sha256Digest,
  ): Promise<unknown> {
    this.interrupt_invocations += 1;
    this.options.on_interrupt?.();
    if (this.options.hang_interrupt === true) {
      return new Promise<never>(() => undefined);
    }
    if (this.options.reject_interrupt === true) {
      throw new Error("injected interrupt failure");
    }
    await this.options.gate;
    let receipt = this.receipts.get(idempotencyKey);
    if (receipt === undefined) {
      this.interrupt_side_effects += 1;
      this.execution_stopped = true;
      receipt = {
        thread_id: threadId,
        execution_stopped: true,
        thread_persisted: true,
        persisted_revision: this.persisted_revision,
        observed_at: OBSERVED_AT,
      };
      this.receipts.set(idempotencyKey, receipt);
    }
    return this.options.receipt_transform?.(receipt, this.interrupt_invocations) ?? receipt;
  }

  public inspect(threadId: string): Promise<unknown> {
    if (this.options.reject_inspection === true) {
      return Promise.reject(new Error("injected inspection failure"));
    }
    const inspection = {
      thread_id: threadId,
      persisted_revision: this.persisted_revision,
      readable: this.readable,
      archived: this.archived,
      deleted: this.deleted,
      observed_at: INSPECTED_AT,
    };
    return Promise.resolve(this.options.inspection_transform?.(inspection) ?? inspection);
  }
}

interface Fixture {
  readonly root: string;
  readonly run_id: string;
  readonly store_root: string;
  readonly guard_root: string;
  readonly store: FileRunStore;
  readonly guard: FileWorkspaceGuard;
  readonly lease: ProjectLease;
  readonly state_version: number;
}

function temporaryDirectory(context: TestContext, prefix = "auto-slice-s08-"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function openStore(storageRoot: string): FileRunStore {
  const store = FileRunStore.open(storageRoot, { now: () => new Date(OBSERVED_AT) });
  if (store instanceof StateStoreError) {
    assert.fail(`${store.code}: ${store.message}`);
  }
  return store;
}

function openGuard(
  storageRoot: string,
  options: FileWorkspaceGuardOptions = {},
): FileWorkspaceGuard {
  const guard = FileWorkspaceGuard.open(storageRoot, {
    now: () => new Date(OBSERVED_AT),
    leaseDurationMs: 120_000,
    ...options,
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

function expectWorkspaceError(
  result: unknown,
  code: WorkspaceGuardError["code"],
): WorkspaceGuardError {
  assert.ok(result instanceof WorkspaceGuardError);
  assert.equal(result.code, code);
  return result;
}

function unwrapDecision(
  result: SourceInterruptionDecision | SourceInterruptionError,
): SourceInterruptionDecision {
  if (result instanceof SourceInterruptionError) {
    assert.fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function expectInterruptionError(
  result: SourceInterruptionDecision | SourceInterruptionError,
  reason?: SourceInterruptionError["reason"],
): SourceInterruptionError {
  assert.ok(result instanceof SourceInterruptionError);
  assert.equal(result.code, "source_interrupt_failed");
  if (reason !== undefined) {
    assert.equal(result.reason, reason);
  }
  return result;
}

function sourceInterruptingFixture(
  context: TestContext,
  suffix: string,
): Fixture {
  const root = temporaryDirectory(context, `auto-slice-s08-${suffix}-`);
  const workspaceRoot = path.join(root, "workspace");
  const storeRoot = path.join(root, "state");
  const guardRoot = path.join(root, "workspace-guard");
  mkdirSync(workspaceRoot);
  const identity = createWorkspaceIdentity(workspaceRoot);
  const guard = openGuard(guardRoot, {
    leaseIdFactory: () => `lease-${suffix}`,
  });
  const runId = `run-${suffix}`;
  const lease = unwrapLease(guard.acquire(identity, runId));
  const store = openStore(storeRoot);
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: identity,
    plan_digest: sha256Bytes(`plan-${suffix}`),
    commit_mode: "after_slice",
    current_slice_id: "S08",
    protected_baseline_digest: sha256Bytes(`baseline-${suffix}`),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s08_fixture",
    to: "PREPARING",
    updates: {
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: SOURCE_THREAD_ID,
    },
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s08_fixture",
    to: "SLICE_RUNNING",
  }));
  unwrapStored(store.compareAndSwap(runId, 2, {
    action: "observe_s08_compaction",
    to: "COMPACTION_WAIT",
    updates: {
      compaction: {
        compaction_id: COMPACTION_ID,
        observed_started_at: "2026-08-08T00:00:00.000Z",
        deadline_at: "2026-08-08T00:00:30.000Z",
        handoff_attempted: false,
      },
    },
  }));
  const interrupting = unwrapStored(store.compareAndSwap(runId, 3, {
    action: "observe_s08_deadline",
    to: "SOURCE_INTERRUPTING",
  }));
  return {
    root,
    run_id: runId,
    store_root: storeRoot,
    guard_root: guardRoot,
    store,
    guard,
    lease,
    state_version: interrupting.state.state_version,
  };
}

function coordinator(
  fixture: Fixture,
  threadControl: ThreadControlPort,
  overrides: Readonly<Record<string, unknown>> = {},
): SourceInterruptionCoordinator {
  return new SourceInterruptionCoordinator({
    run_store: fixture.store,
    workspace_guard: fixture.guard,
    thread_control: threadControl,
    now: () => new Date(INSPECTED_AT),
    interrupt_timeout_ms: 1_000,
    ...overrides,
  });
}

void test("freezes, verifies, rotates, and replays one idempotent terminal interrupt receipt", async (context) => {
  const fixture = sourceInterruptingFixture(context, "success");
  const control = new MemoryThreadControl();
  const subject = coordinator(fixture, control);

  const first = unwrapDecision(await subject.interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  ));
  const repeated = unwrapDecision(await subject.interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  ));

  assert.equal(first.outcome, "INTERRUPTED");
  assert.equal(repeated.outcome, "ALREADY_INTERRUPTED");
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.equal(control.interrupt_invocations, 2);
  assert.equal(control.interrupt_side_effects, 1);
  const final = unwrapStored(fixture.store.load(fixture.run_id)).state;
  assert.equal(final.status, "HANDOFF_EXPORTING");
  assert.equal(final.source_thread_id, SOURCE_THREAD_ID);
  assert.equal(final.write_epoch, fixture.lease.epoch + 1);
  assert.deepEqual(
    unwrapLease(fixture.guard.inspectLeaseEvents(fixture.lease.lease_id)).map((entry) => entry.action),
    ["ACQUIRED", "FROZEN", "EPOCH_ROTATED"],
  );
});

void test("the lease is frozen before interrupt and rejects writes both during and after the handoff boundary", async (context) => {
  const fixture = sourceInterruptingFixture(context, "late-write");
  const gate = deferred();
  const called = deferred();
  let frozenBeforeInterrupt = false;
  const control = new MemoryThreadControl({
    gate: gate.promise,
    on_interrupt: () => {
      frozenBeforeInterrupt = fixture.guard.assertWritable(
        fixture.lease.lease_id,
        fixture.lease.epoch,
      ) instanceof WorkspaceGuardError;
      called.resolve();
    },
  });
  const pending = coordinator(fixture, control).interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  );

  await called.promise;
  assert.equal(frozenBeforeInterrupt, true);
  expectWorkspaceError(
    fixture.guard.assertWritable(fixture.lease.lease_id, fixture.lease.epoch),
    "lease_lost",
  );
  assert.equal(unwrapStored(fixture.store.load(fixture.run_id)).state.status, "SOURCE_INTERRUPTING");

  gate.resolve();
  const decision = unwrapDecision(await pending);
  expectWorkspaceError(
    fixture.guard.assertWritable(fixture.lease.lease_id, fixture.lease.epoch),
    "stale_write_epoch",
  );
  assert.equal(
    unwrapLease(fixture.guard.assertWritable(fixture.lease.lease_id, decision.write_epoch)).status,
    "ACTIVE",
  );
});

const FAILURE_SCENARIOS = [
  {
    id: "receipt_identity_mismatch",
    reason: "interrupt_receipt_identity_mismatch" as const,
    options: {
      receipt_transform: (receipt: Readonly<Record<string, unknown>>) => ({
        ...receipt,
        thread_id: "thread-impostor",
      }),
    },
  },
  {
    id: "execution_not_stopped",
    reason: "interrupt_receipt_invalid" as const,
    options: {
      receipt_transform: (receipt: Readonly<Record<string, unknown>>) => ({
        ...receipt,
        execution_stopped: false,
      }),
    },
  },
  {
    id: "thread_archived",
    reason: "thread_not_persisted" as const,
    options: {
      inspection_transform: (inspection: Readonly<Record<string, unknown>>) => ({
        ...inspection,
        archived: true,
      }),
    },
  },
  {
    id: "thread_deleted",
    reason: "thread_not_persisted" as const,
    options: {
      inspection_transform: (inspection: Readonly<Record<string, unknown>>) => ({
        ...inspection,
        deleted: true,
      }),
    },
  },
  {
    id: "revision_mismatch",
    reason: "thread_revision_mismatch" as const,
    options: {
      inspection_transform: (inspection: Readonly<Record<string, unknown>>) => ({
        ...inspection,
        persisted_revision: "revision-impostor",
      }),
    },
  },
  {
    id: "interrupt_call_failed",
    reason: "interrupt_call_failed" as const,
    options: {
      reject_interrupt: true,
    },
  },
  {
    id: "thread_inspection_failed",
    reason: "thread_inspection_failed" as const,
    options: {
      reject_inspection: true,
    },
  },
] as const;

for (const scenario of FAILURE_SCENARIOS) {
  void test(`fails closed with a frozen lease for ${scenario.id}`, async (context) => {
    const fixture = sourceInterruptingFixture(context, scenario.id);
    const result = await coordinator(
      fixture,
      new MemoryThreadControl(scenario.options),
    ).interruptSource(
      fixture.run_id,
      fixture.lease.lease_id,
      fixture.lease.epoch,
      fixture.state_version,
    );

    expectInterruptionError(result, scenario.reason);
    const state = unwrapStored(fixture.store.load(fixture.run_id)).state;
    assert.equal(state.status, "NEEDS_USER");
    assert.ok(state.last_error !== undefined);
    assert.ok(state.last_error.details !== undefined);
    assert.equal(state.last_error.code, "source_interrupt_failed");
    assert.equal(state.last_error.details.reason, scenario.reason);
    assert.deepEqual(
      unwrapLease(fixture.guard.inspectLeaseEvents(fixture.lease.lease_id)).map((entry) => entry.action),
      ["ACQUIRED", "FROZEN"],
    );
    expectWorkspaceError(
      fixture.guard.assertWritable(fixture.lease.lease_id, fixture.lease.epoch),
      "lease_lost",
    );
  });
}

void test("interrupt timeout closes to NEEDS_USER without rotating the frozen epoch", async (context) => {
  const fixture = sourceInterruptingFixture(context, "timeout");
  const result = await coordinator(
    fixture,
    new MemoryThreadControl({ hang_interrupt: true }),
    { interrupt_timeout_ms: 5 },
  ).interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  );

  expectInterruptionError(result, "interrupt_timeout");
  assert.equal(unwrapStored(fixture.store.load(fixture.run_id)).state.status, "NEEDS_USER");
  assert.deepEqual(
    unwrapLease(fixture.guard.inspectLeaseEvents(fixture.lease.lease_id)).map((entry) => entry.action),
    ["ACQUIRED", "FROZEN"],
  );
});

void test("epoch rotation failure preserves the completed interrupt but keeps writes frozen", async (context) => {
  const fixture = sourceInterruptingFixture(context, "rotation-failure");
  const failingGuard = {
    freezeWrites: fixture.guard.freezeWrites.bind(fixture.guard),
    inspectLeaseEvents: fixture.guard.inspectLeaseEvents.bind(fixture.guard),
    rotateEpoch: () => new WorkspaceGuardError(
      "workspace_guard_persist_failed",
      "injected epoch rotation failure",
    ),
  };
  const result = await new SourceInterruptionCoordinator({
    run_store: fixture.store,
    workspace_guard: failingGuard,
    thread_control: new MemoryThreadControl(),
    now: () => new Date(INSPECTED_AT),
    interrupt_timeout_ms: 1_000,
  }).interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  );

  expectInterruptionError(result, "write_epoch_rotation_failed");
  const state = unwrapStored(fixture.store.load(fixture.run_id)).state;
  assert.equal(state.status, "NEEDS_USER");
  assert.equal(state.write_epoch, fixture.lease.epoch);
  assert.deepEqual(
    unwrapLease(fixture.guard.inspectLeaseEvents(fixture.lease.lease_id)).map((entry) => entry.action),
    ["ACQUIRED", "FROZEN"],
  );
  expectWorkspaceError(
    fixture.guard.assertWritable(fixture.lease.lease_id, fixture.lease.epoch),
    "lease_lost",
  );
});

void test("concurrent callers share one interrupt side effect and one Run transition", async (context) => {
  const fixture = sourceInterruptingFixture(context, "concurrent");
  const control = new MemoryThreadControl();
  const subject = coordinator(fixture, control);
  const invoke = async (): Promise<SourceInterruptionDecision | SourceInterruptionError> =>
    subject.interruptSource(
      fixture.run_id,
      fixture.lease.lease_id,
      fixture.lease.epoch,
      fixture.state_version,
    );

  const decisions = (await Promise.all([invoke(), invoke()])).map(unwrapDecision);
  assert.deepEqual(
    decisions.map((entry) => entry.outcome).sort(),
    ["ALREADY_INTERRUPTED", "INTERRUPTED"],
  );
  assert.equal(control.interrupt_side_effects, 1);
  assert.equal(unwrapStored(fixture.store.load(fixture.run_id)).state.state_version, fixture.state_version + 1);
});

void test("a rotated lease is recovered after a crash before the Run transition", async (context) => {
  const fixture = sourceInterruptingFixture(context, "rotate-recovery");
  const control = new MemoryThreadControl();
  let rejectTransition = true;
  const interruptedStore = {
    load: fixture.store.load.bind(fixture.store),
    appendEffectIntent: fixture.store.appendEffectIntent.bind(fixture.store),
    completeEffect: fixture.store.completeEffect.bind(fixture.store),
    compareAndSwap: (
      runId: string,
      expectedVersion: number,
      transition: RunTransition,
    ): StoredRun | StateStoreError => {
      if (transition.action === "complete_source_interruption" && rejectTransition) {
        rejectTransition = false;
        return new StateStoreError("state_persist_failed", "injected crash before Run transition");
      }
      return fixture.store.compareAndSwap(runId, expectedVersion, transition);
    },
  };
  const interrupted = await new SourceInterruptionCoordinator({
    run_store: interruptedStore,
    workspace_guard: fixture.guard,
    thread_control: control,
    now: () => new Date(INSPECTED_AT),
    interrupt_timeout_ms: 1_000,
  }).interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  );
  assert.ok(interrupted instanceof SourceInterruptionError);
  assert.equal(interrupted.code, "state_persist_failed");
  assert.equal(unwrapStored(fixture.store.load(fixture.run_id)).state.status, "SOURCE_INTERRUPTING");
  expectWorkspaceError(
    fixture.guard.assertWritable(fixture.lease.lease_id, fixture.lease.epoch),
    "stale_write_epoch",
  );

  const recovered = unwrapDecision(await coordinator(fixture, control).interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  ));
  assert.equal(recovered.outcome, "INTERRUPTED");
  assert.equal(recovered.write_epoch, fixture.lease.epoch + 1);
  assert.deepEqual(
    unwrapLease(fixture.guard.inspectLeaseEvents(fixture.lease.lease_id)).map((entry) => entry.action),
    ["ACQUIRED", "FROZEN", "EPOCH_ROTATED"],
  );
});

void test("a different terminal receipt on replay is rejected", async (context) => {
  const fixture = sourceInterruptingFixture(context, "receipt-replay");
  let replaying = false;
  const control = new MemoryThreadControl({
    receipt_transform: (receipt, invocation) => {
      replaying = invocation > 1;
      return replaying
        ? { ...receipt, persisted_revision: "revision-s08-0002" }
        : receipt;
    },
    inspection_transform: (inspection) => replaying
      ? { ...inspection, persisted_revision: "revision-s08-0002" }
      : inspection,
  });
  const subject = coordinator(fixture, control);
  unwrapDecision(await subject.interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  ));

  const replay = await subject.interruptSource(
    fixture.run_id,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.state_version,
  );
  expectInterruptionError(replay, "receipt_replay_mismatch");
  assert.equal(unwrapStored(fixture.store.load(fixture.run_id)).state.status, "HANDOFF_EXPORTING");
});
