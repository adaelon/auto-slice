#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  SourceInterruptionCoordinator,
  SourceInterruptionError,
} from "../dist/src/controller/thread-control/index.js";
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

const OBSERVED_AT = "2026-08-08T00:00:31.000Z";
const INSPECTED_AT = "2026-08-08T00:00:31.001Z";
const SOURCE_THREAD_ID = "thread-source-s08-evidence";
const COMPACTION_ID = "compaction-s08-evidence";

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

class MemoryThreadControl {
  constructor(options = {}) {
    this.options = options;
    this.interruptInvocations = 0;
    this.interruptSideEffects = 0;
    this.persistedRevision = "revision-s08-evidence-0001";
    this.receipts = new Map();
  }

  async interrupt(threadId, idempotencyKey) {
    this.interruptInvocations += 1;
    this.options.onInterrupt?.();
    if (this.options.hangInterrupt === true) {
      return new Promise(() => undefined);
    }
    if (this.options.rejectInterrupt === true) {
      throw new Error("injected interrupt failure");
    }
    await this.options.gate;
    let receipt = this.receipts.get(idempotencyKey);
    if (receipt === undefined) {
      this.interruptSideEffects += 1;
      receipt = {
        thread_id: threadId,
        execution_stopped: true,
        thread_persisted: true,
        persisted_revision: this.persistedRevision,
        observed_at: OBSERVED_AT,
      };
      this.receipts.set(idempotencyKey, receipt);
    }
    return this.options.receiptTransform?.(receipt, this.interruptInvocations) ?? receipt;
  }

  async inspect(threadId) {
    if (this.options.rejectInspection === true) {
      throw new Error("injected inspection failure");
    }
    const inspection = {
      thread_id: threadId,
      persisted_revision: this.persistedRevision,
      readable: true,
      archived: false,
      deleted: false,
      observed_at: INSPECTED_AT,
    };
    return this.options.inspectionTransform?.(inspection) ?? inspection;
  }
}

function unwrapStore(result) {
  if (result instanceof StateStoreError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapWorkspace(result) {
  if (result instanceof WorkspaceGuardError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapDecision(result) {
  if (result instanceof SourceInterruptionError) {
    fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function createFixture(root, id) {
  const fixtureRoot = path.join(root, id);
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const identity = createWorkspaceIdentity(workspaceRoot);
  const guard = unwrapWorkspace(FileWorkspaceGuard.open(
    path.join(fixtureRoot, "workspace-guard"),
    {
      now: () => new Date(OBSERVED_AT),
      leaseIdFactory: () => `lease-${id}`,
      leaseDurationMs: 120_000,
    },
  ));
  const runId = `run-${id}`;
  const lease = unwrapWorkspace(guard.acquire(identity, runId));
  const store = unwrapStore(FileRunStore.open(path.join(fixtureRoot, "state"), {
    now: () => new Date(OBSERVED_AT),
  }));
  unwrapStore(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: identity,
    plan_digest: sha256Bytes(`plan-${id}`),
    commit_mode: "after_slice",
    current_slice_id: "S08",
    protected_baseline_digest: sha256Bytes(`baseline-${id}`),
  })));
  unwrapStore(store.compareAndSwap(runId, 0, {
    action: "prepare_s08_evidence",
    to: "PREPARING",
    updates: {
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: SOURCE_THREAD_ID,
    },
  }));
  unwrapStore(store.compareAndSwap(runId, 1, {
    action: "start_s08_evidence",
    to: "SLICE_RUNNING",
  }));
  unwrapStore(store.compareAndSwap(runId, 2, {
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
  const interrupting = unwrapStore(store.compareAndSwap(runId, 3, {
    action: "observe_s08_deadline",
    to: "SOURCE_INTERRUPTING",
  }));
  return {
    runId,
    lease,
    store,
    guard,
    stateVersion: interrupting.state.state_version,
  };
}

function coordinator(fixture, control, timeoutMs = 1_000) {
  return new SourceInterruptionCoordinator({
    run_store: fixture.store,
    workspace_guard: fixture.guard,
    thread_control: control,
    now: () => new Date(INSPECTED_AT),
    interrupt_timeout_ms: timeoutMs,
  });
}

async function interrupt(fixture, control, timeoutMs = 1_000) {
  return coordinator(fixture, control, timeoutMs).interruptSource(
    fixture.runId,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.stateVersion,
  );
}

function leaseActions(fixture) {
  return unwrapWorkspace(
    fixture.guard.inspectLeaseEvents(fixture.lease.lease_id),
  ).map((entry) => entry.action);
}

async function buildThreadAdapterContractReport(root) {
  const fixture = createFixture(root, "adapter-contract");
  const control = new MemoryThreadControl();
  const subject = coordinator(fixture, control);
  const first = unwrapDecision(await subject.interruptSource(
    fixture.runId,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.stateVersion,
  ));
  const repeated = unwrapDecision(await subject.interruptSource(
    fixture.runId,
    fixture.lease.lease_id,
    fixture.lease.epoch,
    fixture.stateVersion,
  ));
  const final = unwrapStore(fixture.store.load(fixture.runId)).state;
  requireCondition(first.outcome === "INTERRUPTED", "The first S08 call did not interrupt.");
  requireCondition(repeated.outcome === "ALREADY_INTERRUPTED", "The repeated S08 call was not idempotent.");
  requireCondition(JSON.stringify(first.receipt) === JSON.stringify(repeated.receipt), "Repeated receipts differ.");
  requireCondition(control.interruptSideEffects === 1, "ThreadControl performed more than one side effect.");
  requireCondition(final.status === "HANDOFF_EXPORTING", "S08 did not unlock HANDOFF_EXPORTING.");
  requireCondition(final.source_thread_id === SOURCE_THREAD_ID, "S08 replaced the Source Thread UUID.");
  return {
    schema_version: 1,
    slice_id: "S08",
    interrupt_invocations: control.interruptInvocations,
    interrupt_side_effects: control.interruptSideEffects,
    same_terminal_receipt: true,
    receipt_digest: sha256Json(first.receipt),
    source_thread_id: final.source_thread_id,
    source_thread_uuid_preserved: true,
    persisted_revision: first.receipt.persisted_revision,
    persisted_revision_readable: true,
    final_status: final.status,
    final_state_version: final.state_version,
    result: "PASS",
  };
}

async function buildLateWriteReport(root) {
  const fixture = createFixture(root, "late-write");
  const gate = deferred();
  const called = deferred();
  let beforeInterruptCode = null;
  const control = new MemoryThreadControl({
    gate: gate.promise,
    onInterrupt: () => {
      const result = fixture.guard.assertWritable(
        fixture.lease.lease_id,
        fixture.lease.epoch,
      );
      beforeInterruptCode = result instanceof WorkspaceGuardError ? result.code : "WRITABLE";
      called.resolve();
    },
  });
  const pending = interrupt(fixture, control);
  await called.promise;
  const during = fixture.guard.assertWritable(
    fixture.lease.lease_id,
    fixture.lease.epoch,
  );
  const statusDuring = unwrapStore(fixture.store.load(fixture.runId)).state.status;
  gate.resolve();
  const decision = unwrapDecision(await pending);
  const oldAfter = fixture.guard.assertWritable(
    fixture.lease.lease_id,
    fixture.lease.epoch,
  );
  const newAfter = fixture.guard.assertWritable(
    fixture.lease.lease_id,
    decision.write_epoch,
  );
  requireCondition(beforeInterruptCode === "lease_lost", "Lease was not frozen before interrupt.");
  requireCondition(during instanceof WorkspaceGuardError && during.code === "lease_lost", "Frozen-period write was accepted.");
  requireCondition(statusDuring === "SOURCE_INTERRUPTING", "Run advanced before the receipt.");
  requireCondition(oldAfter instanceof WorkspaceGuardError && oldAfter.code === "stale_write_epoch", "Old epoch survived rotation.");
  requireCondition(!(newAfter instanceof WorkspaceGuardError) && newAfter.status === "ACTIVE", "Rotated epoch is not active.");
  return {
    schema_version: 1,
    slice_id: "S08",
    freeze_observed_before_interrupt: true,
    status_while_interrupt_pending: statusDuring,
    frozen_period_old_capability: during.code,
    post_success_old_capability: oldAfter.code,
    post_success_new_capability: newAfter.status,
    lease_actions: leaseActions(fixture),
    result: "PASS",
  };
}

const FAILURE_SCENARIOS = [
  {
    id: "interrupt_timeout",
    expectedReason: "interrupt_timeout",
    timeoutMs: 5,
    options: { hangInterrupt: true },
  },
  {
    id: "thread_missing",
    expectedReason: "thread_not_persisted",
    options: {
      inspectionTransform: (inspection) => ({ ...inspection, deleted: true }),
    },
  },
  {
    id: "thread_archived",
    expectedReason: "thread_not_persisted",
    options: {
      inspectionTransform: (inspection) => ({ ...inspection, archived: true }),
    },
  },
  {
    id: "thread_unreadable",
    expectedReason: "thread_not_persisted",
    options: {
      inspectionTransform: (inspection) => ({ ...inspection, readable: false }),
    },
  },
  {
    id: "receipt_identity_mismatch",
    expectedReason: "interrupt_receipt_identity_mismatch",
    options: {
      receiptTransform: (receipt) => ({ ...receipt, thread_id: "thread-impostor" }),
    },
  },
  {
    id: "revision_mismatch",
    expectedReason: "thread_revision_mismatch",
    options: {
      inspectionTransform: (inspection) => ({
        ...inspection,
        persisted_revision: "revision-impostor",
      }),
    },
  },
  {
    id: "interrupt_call_failed",
    expectedReason: "interrupt_call_failed",
    options: { rejectInterrupt: true },
  },
  {
    id: "thread_inspection_failed",
    expectedReason: "thread_inspection_failed",
    options: { rejectInspection: true },
  },
  {
    id: "write_epoch_rotation_failed",
    expectedReason: "write_epoch_rotation_failed",
    rotationFailure: true,
    options: {},
  },
];

async function buildFailureClosureMatrix(root) {
  const scenarios = [];
  for (const scenario of FAILURE_SCENARIOS) {
    const fixture = createFixture(root, scenario.id);
    const control = new MemoryThreadControl(scenario.options);
    const subject = scenario.rotationFailure === true
      ? new SourceInterruptionCoordinator({
        run_store: fixture.store,
        workspace_guard: {
          freezeWrites: fixture.guard.freezeWrites.bind(fixture.guard),
          inspectLeaseEvents: fixture.guard.inspectLeaseEvents.bind(fixture.guard),
          rotateEpoch: () => new WorkspaceGuardError(
            "workspace_guard_persist_failed",
            "injected epoch rotation failure",
          ),
        },
        thread_control: control,
        now: () => new Date(INSPECTED_AT),
        interrupt_timeout_ms: scenario.timeoutMs ?? 1_000,
      })
      : coordinator(fixture, control, scenario.timeoutMs ?? 1_000);
    const result = await subject.interruptSource(
      fixture.runId,
      fixture.lease.lease_id,
      fixture.lease.epoch,
      fixture.stateVersion,
    );
    requireCondition(result instanceof SourceInterruptionError, `${scenario.id} unexpectedly succeeded.`);
    const state = unwrapStore(fixture.store.load(fixture.runId)).state;
    const actions = leaseActions(fixture);
    const oldWrite = fixture.guard.assertWritable(
      fixture.lease.lease_id,
      fixture.lease.epoch,
    );
    requireCondition(result.code === "source_interrupt_failed", `${scenario.id} returned the wrong code.`);
    requireCondition(result.reason === scenario.expectedReason, `${scenario.id} returned the wrong reason.`);
    requireCondition(state.status === "NEEDS_USER", `${scenario.id} did not close to NEEDS_USER.`);
    requireCondition(state.last_error?.code === "source_interrupt_failed", `${scenario.id} did not persist its failure.`);
    requireCondition(JSON.stringify(actions) === JSON.stringify(["ACQUIRED", "FROZEN"]), `${scenario.id} rotated its epoch.`);
    requireCondition(oldWrite instanceof WorkspaceGuardError && oldWrite.code === "lease_lost", `${scenario.id} left writes enabled.`);
    scenarios.push({
      id: scenario.id,
      failure_code: result.code,
      reason: result.reason,
      final_status: state.status,
      lease_status: "FROZEN",
      epoch_rotated: false,
      handoff_exporting_reached: false,
    });
  }
  return {
    schema_version: 1,
    slice_id: "S08",
    scenarios,
    result: "PASS",
  };
}

const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s08-evidence-"));
try {
  const evidence = {
    thread_adapter_contract_report: await buildThreadAdapterContractReport(root),
    late_write_report: await buildLateWriteReport(root),
    failure_closure_matrix: await buildFailureClosureMatrix(root),
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
