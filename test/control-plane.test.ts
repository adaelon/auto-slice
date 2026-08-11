import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  buildControlMatrix,
  ControlPlane,
  ControlPlaneError,
  FileCommandJournal,
  NEEDS_USER_ERROR_CODES,
  openFileControlPlane,
  recoveryOptionsFor,
  type ControlCommandReceipt,
  type ControlLifecyclePort,
  type ControlPlaneOptions,
  type ControlPortReceipt,
  type ExplicitRecoveryPort,
  type RecoveryEvidence,
  type RecoveryPortReceipt,
  type RecoveryResolution,
  type RunSnapshot,
  type SlicePhase,
  type SlicePhasePort,
} from "../src/controller/control-plane/index.js";
import {
  canonicalJson,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type RunEventRecord,
  type RunState,
  type RunStatus,
} from "../src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
} from "../src/controller/workspace/index.js";

const FIXED_TIME = "2026-08-09T10:00:00.000Z";

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s11-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function constantClock(): () => Date {
  return () => new Date(FIXED_TIME);
}

class TestLifecycle implements ControlLifecyclePort {
  public pause_calls = 0;
  public resume_calls = 0;
  public abort_calls = 0;

  public pauseAtSafePoint(): ControlPortReceipt {
    this.pause_calls += 1;
    return { applied: true, receipt_digest: sha256Bytes("pause-safe") };
  }

  public resumeFromSafePoint(): ControlPortReceipt {
    this.resume_calls += 1;
    return { applied: true, receipt_digest: sha256Bytes("resume-safe") };
  }

  public revokeWrites(): ControlPortReceipt {
    this.abort_calls += 1;
    return { applied: true, receipt_digest: sha256Bytes("writes-revoked") };
  }
}

class TestRecovery implements ExplicitRecoveryPort {
  public calls: Array<{
    readonly resolution: Exclude<RecoveryResolution, "abort_run">;
    readonly evidence: RecoveryEvidence;
  }> = [];

  public resolve(
    _run: RunState,
    resolution: Exclude<RecoveryResolution, "abort_run">,
    evidence: RecoveryEvidence,
  ): RecoveryPortReceipt {
    this.calls.push({ resolution, evidence });
    return { applied: true, receipt_digest: sha256Bytes(`${resolution}:${evidence.evidence_digest}`) };
  }
}

class TestSlicePhase implements SlicePhasePort {
  public phase: SlicePhase = "PENDING";
  public readonly future_phases = new Map<string, SlicePhase>();

  public getPhase(run: RunState, sliceId: string): SlicePhase {
    return sliceId === run.current_slice_id
      ? this.phase
      : this.future_phases.get(sliceId) ?? "UNKNOWN";
  }
}

interface TestRig {
  readonly plane: ControlPlane;
  readonly store: FileRunStore;
  readonly guard: FileWorkspaceGuard;
  readonly lifecycle: TestLifecycle;
  readonly recovery: TestRecovery;
  readonly phase: TestSlicePhase;
  readonly options: ControlPlaneOptions;
  readonly storage_root: string;
}

function createRig(context: TestContext): TestRig {
  const storageRoot = temporaryDirectory(context);
  const store = FileRunStore.open(storageRoot, { now: constantClock() });
  const guard = FileWorkspaceGuard.open(storageRoot, { now: constantClock() });
  const journal = FileCommandJournal.open(storageRoot);
  if (store instanceof StateStoreError) assert.fail(store.message);
  if (guard instanceof WorkspaceGuardError) assert.fail(guard.message);
  if (journal instanceof ControlPlaneError) assert.fail(journal.message);
  const lifecycle = new TestLifecycle();
  const recovery = new TestRecovery();
  const phase = new TestSlicePhase();
  const options: ControlPlaneOptions = {
    run_store: store,
    command_journal: journal,
    workspace_guard: guard,
    lifecycle,
    recovery,
    slice_phase: phase,
    now: constantClock(),
  };
  return {
    plane: new ControlPlane(options),
    store,
    guard,
    lifecycle,
    recovery,
    phase,
    options,
    storage_root: storageRoot,
  };
}

function receipt(result: ControlCommandReceipt | ControlPlaneError): ControlCommandReceipt {
  if (result instanceof ControlPlaneError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function snapshot(result: ControlCommandReceipt): RunSnapshot {
  assert.ok(result.snapshot);
  return result.snapshot;
}

function startRequest(commandId = "command-start", runId = "run-s11"): unknown {
  return {
    command_id: commandId,
    payload: {
      run_id: runId,
      workspace_identity: {
        canonical_root: `E:\\workspaces\\${runId}`,
        filesystem_identity: `win32:${runId}`,
      },
      plan_digest: sha256Bytes(`plan:${runId}`),
      protected_baseline_digest: sha256Bytes(`baseline:${runId}`),
      commit_mode: "after_slice",
      first_slice_id: "S11",
    },
  };
}

function start(rig: TestRig, commandId = "command-start", runId = "run-s11"): ControlCommandReceipt {
  const result = receipt(rig.plane.execute("start", startRequest(commandId, runId)));
  assert.equal(result.outcome, "OK");
  assert.equal(snapshot(result).status, "PREPARING");
  return result;
}

function appendLegacyStateEvent(
  rig: TestRig,
  runId: string,
  status: RunStatus,
): RunState {
  const loaded = rig.store.load(runId);
  if (loaded instanceof StateStoreError) assert.fail(loaded.message);
  const events = rig.store.inspectRunEvents(runId);
  if (events instanceof StateStoreError) assert.fail(events.message);
  const previous = events.at(-1);
  assert.ok(previous);
  const after = {
    ...loaded.state,
    state_version: loaded.state.state_version + 1,
    status,
  } satisfies RunState;
  const material: Omit<RunEventRecord, "event_digest"> = {
    schema_version: previous.schema_version,
    run_id: runId,
    event_index: after.state_version,
    event_kind: "STATE_TRANSITION",
    action: `legacy_${status.toLowerCase()}`,
    occurred_at: FIXED_TIME,
    previous_event_digest: previous.event_digest,
    before_state: loaded.state,
    before_state_digest: sha256Json(loaded.state),
    after_state: after,
    after_state_digest: sha256Json(after),
  };
  const event: RunEventRecord = {
    ...material,
    event_digest: sha256Json(material),
  };
  const eventPath = path.join(
    rig.storage_root,
    "runs",
    Buffer.from(runId, "utf8").toString("base64url"),
    "events",
    `${String(after.state_version).padStart(20, "0")}.json`,
  );
  writeFileSync(eventPath, `${canonicalJson(event)}\n`, "utf8");
  return after;
}

void test("start/status persist exact command replay across a process-style restart", (context) => {
  const rig = createRig(context);
  const request = startRequest();
  const first = receipt(rig.plane.execute("start", request));
  const firstSnapshot = snapshot(first);
  assert.equal(firstSnapshot.state_version, 1);
  assert.equal(firstSnapshot.current_slice_id, "S11");

  const replay = receipt(rig.plane.execute("start", request));
  assert.deepEqual(replay, first);

  const reopenedStore = FileRunStore.open(rig.storage_root, { now: constantClock() });
  const reopenedJournal = FileCommandJournal.open(rig.storage_root);
  if (reopenedStore instanceof StateStoreError) assert.fail(reopenedStore.message);
  if (reopenedJournal instanceof ControlPlaneError) assert.fail(reopenedJournal.message);
  const restarted = new ControlPlane({
    ...rig.options,
    run_store: reopenedStore,
    command_journal: reopenedJournal,
  });
  assert.deepEqual(receipt(restarted.execute("start", request)), first);
  const status = receipt(restarted.execute("status", {
    command_id: "command-status",
    run_id: "run-s11",
    payload: {},
  }));
  const statusSnapshot = snapshot(status);
  assert.equal(statusSnapshot.state_version, 1);
  assert.equal(statusSnapshot.task_ids.source_thread_id, null);
  assert.equal(snapshot(receipt(restarted.execute("status", {
    command_id: "command-status-2",
    run_id: "run-s11",
    payload: {},
  }))).state_version, 1);
});

void test("pause/resume persist the safe-point origin and stale pause/abort contenders cannot both win", (context) => {
  const rig = createRig(context);
  start(rig);
  const paused = receipt(rig.plane.execute("pause", {
    command_id: "command-pause",
    run_id: "run-s11",
    expected_state_version: 1,
    payload: {},
  }));
  const pausedSnapshot = snapshot(paused);
  assert.equal(pausedSnapshot.status, "PAUSED");
  assert.equal(pausedSnapshot.state_version, 2);
  assert.equal(rig.lifecycle.pause_calls, 1);

  const staleAbort = receipt(rig.plane.execute("abort", {
    command_id: "command-stale-abort",
    run_id: "run-s11",
    expected_state_version: 1,
    payload: {},
  }));
  assert.equal(staleAbort.outcome, "REJECTED");
  assert.equal(staleAbort.error?.code, "stale_state");
  assert.equal(rig.lifecycle.abort_calls, 0);

  const resumed = receipt(rig.plane.execute("resume", {
    command_id: "command-resume",
    run_id: "run-s11",
    expected_state_version: 2,
    payload: {},
  }));
  const resumedSnapshot = snapshot(resumed);
  assert.equal(resumedSnapshot.status, "PREPARING");
  assert.equal(resumedSnapshot.state_version, 3);
  assert.equal(rig.lifecycle.resume_calls, 1);
});

void test("override is allowed before dispatch and for future Slices, but rejected after current dispatch", (context) => {
  const rig = createRig(context);
  start(rig);
  const overridden = receipt(rig.plane.execute("override", {
    command_id: "command-override",
    run_id: "run-s11",
    expected_state_version: 1,
    payload: { slice_id: "S11", mode: "none" },
  }));
  const overriddenSnapshot = snapshot(overridden);
  assert.equal(overriddenSnapshot.state_version, 2);
  assert.equal(overriddenSnapshot.effective_commit_mode, "none");
  assert.deepEqual(overriddenSnapshot.slice_commit_mode_overrides, { S11: "none" });
  assert.deepEqual(receipt(rig.plane.execute("override", {
    command_id: "command-override",
    run_id: "run-s11",
    expected_state_version: 1,
    payload: { slice_id: "S11", mode: "none" },
  })), overridden);

  const running = rig.store.compareAndSwap("run-s11", 2, {
    action: "dispatch_current_slice",
    to: "SLICE_RUNNING",
  });
  if (running instanceof StateStoreError) assert.fail(running.message);
  rig.phase.phase = "RUNNING";
  const rejected = receipt(rig.plane.execute("override", {
    command_id: "command-override-late",
    run_id: "run-s11",
    expected_state_version: 3,
    payload: { slice_id: "S11", mode: "after_slice" },
  }));
  assert.equal(rejected.error?.code, "slice_already_verifying");
  rig.phase.future_phases.set("S12", "PENDING");
  const future = receipt(rig.plane.execute("override", {
    command_id: "command-override-future",
    run_id: "run-s11",
    expected_state_version: 3,
    payload: { slice_id: "S12", mode: "none" },
  }));
  assert.equal(snapshot(future).state_version, 4);
  assert.deepEqual(snapshot(future).slice_commit_mode_overrides, {
    S11: "none",
    S12: "none",
  });
  const stored = rig.store.load("run-s11");
  if (stored instanceof StateStoreError) assert.fail(stored.message);
  assert.equal(stored.state.state_version, 4);
});

void test("legacy acceptance snapshots expose status and abort but reject pause, resume, and override", (context) => {
  const rig = createRig(context);
  start(rig, "legacy-start", "legacy-control");
  const running = rig.store.compareAndSwap("legacy-control", 1, {
    action: "start_legacy_slice",
    to: "SLICE_RUNNING",
  });
  if (running instanceof StateStoreError) assert.fail(running.message);
  appendLegacyStateEvent(rig, "legacy-control", "VERIFYING");
  rig.phase.phase = "VERIFYING";

  const status = receipt(rig.plane.execute("status", {
    command_id: "legacy-status",
    run_id: "legacy-control",
    payload: {},
  }));
  assert.equal(snapshot(status).status, "VERIFYING");
  assert.equal(snapshot(status).state_version, 3);

  for (const command of ["pause", "resume", "override"] as const) {
    const result = receipt(rig.plane.execute(command, {
      command_id: `legacy-${command}`,
      run_id: "legacy-control",
      expected_state_version: 3,
      payload: command === "override"
        ? { slice_id: "S11", mode: "none" }
        : {},
    }));
    assert.equal(result.outcome, "REJECTED");
  }
  assert.equal(rig.lifecycle.pause_calls, 0);
  assert.equal(rig.lifecycle.resume_calls, 0);

  const aborted = receipt(rig.plane.execute("abort", {
    command_id: "legacy-abort",
    run_id: "legacy-control",
    expected_state_version: 3,
    payload: {},
  }));
  assert.equal(snapshot(aborted).status, "ABORTED");
  assert.equal(rig.lifecycle.abort_calls, 1);
});

void test("NEEDS_USER exposes sanitized status and invokes only a matching explicit recovery", (context) => {
  const rig = createRig(context);
  start(rig);
  const failed = rig.store.compareAndSwap("run-s11", 1, {
    action: "inject_model_failure",
    to: "NEEDS_USER",
    updates: {
      last_error: {
        code: "model_policy_unavailable",
        message: "secret provider output must never be projected",
        occurred_at: FIXED_TIME,
        last_successful_status: "PREPARING",
        details: {
          evidence_path: "artifacts/model-policy.json",
          raw_output: "secret-token",
        },
      },
    },
  });
  if (failed instanceof StateStoreError) assert.fail(failed.message);

  const status = receipt(rig.plane.execute("status", {
    command_id: "command-needs-user-status",
    run_id: "run-s11",
    payload: {},
  }));
  assert.equal(status.outcome, "NEEDS_USER");
  const needsUserError = snapshot(status).error;
  assert.ok(needsUserError);
  assert.deepEqual(needsUserError.evidence_paths, ["artifacts/model-policy.json"]);
  assert.deepEqual(needsUserError.recovery_options, ["supply_model_policy", "abort_run"]);
  assert.doesNotMatch(JSON.stringify(status), /secret|raw_output/u);

  const wrong = receipt(rig.plane.execute("resume", {
    command_id: "command-wrong-recovery",
    run_id: "run-s11",
    expected_state_version: 2,
    payload: {
      resolution: "retry_continuation_start",
      evidence: {
        evidence_path: "artifacts/wrong.json",
        evidence_digest: sha256Bytes("wrong"),
      },
    },
  }));
  assert.equal(wrong.error?.code, "invalid_recovery_resolution");
  assert.equal(rig.recovery.calls.length, 0);

  const recovered = receipt(rig.plane.execute("resume", {
    command_id: "command-right-recovery",
    run_id: "run-s11",
    expected_state_version: 2,
    payload: {
      resolution: "supply_model_policy",
      evidence: {
        evidence_path: "artifacts/model-policy.json",
        evidence_digest: sha256Bytes("exact-model-policy"),
      },
    },
  }));
  const recoveredSnapshot = snapshot(recovered);
  assert.equal(recoveredSnapshot.status, "PREPARING");
  assert.equal(recoveredSnapshot.error, undefined);
  assert.equal(rig.recovery.calls.length, 1);
});

void test("abort_run is the explicit terminal resolution for abort-only errors", (context) => {
  const rig = createRig(context);
  start(rig);
  const failed = rig.store.compareAndSwap("run-s11", 1, {
    action: "inject_integrity_failure",
    to: "NEEDS_USER",
    updates: {
      last_error: {
        code: "handoff_integrity_failed",
        message: "digest mismatch",
        occurred_at: FIXED_TIME,
        last_successful_status: "PREPARING",
      },
    },
  });
  if (failed instanceof StateStoreError) assert.fail(failed.message);
  const aborted = receipt(rig.plane.execute("resume", {
    command_id: "command-abort-resolution",
    run_id: "run-s11",
    expected_state_version: 2,
    payload: { resolution: "abort_run" },
  }));
  assert.equal(snapshot(aborted).status, "ABORTED");
  assert.equal(rig.lifecycle.abort_calls, 1);
});

void test("recovery catalog and command-state matrix are exhaustive", () => {
  for (const errorCode of NEEDS_USER_ERROR_CODES) {
    const options = recoveryOptionsFor(errorCode);
    assert.ok(options.length > 0, errorCode);
    assert.ok(options.includes("abort_run"), errorCode);
  }
  const matrix = buildControlMatrix();
  assert.equal(matrix.length, 5 * 14);
  assert.equal(new Set(matrix.map((entry) => `${entry.command}:${entry.status}`)).size, matrix.length);
});

void test("command_id cannot be replayed with a different envelope", (context) => {
  const rig = createRig(context);
  start(rig, "shared-command-id");
  const conflict = rig.plane.execute("start", startRequest("shared-command-id", "other-run"));
  assert.ok(conflict instanceof ControlPlaneError);
  assert.equal(conflict.code, "command_replay_conflict");
});

void test("file runtime freezes on pause, rotates epoch on resume, and releases on abort", (context) => {
  const storageRoot = temporaryDirectory(context);
  const plane = openFileControlPlane(storageRoot, constantClock());
  if (plane instanceof ControlPlaneError) assert.fail(plane.message);
  const started = receipt(plane.execute("start", startRequest("runtime-start", "runtime-run")));
  assert.equal(snapshot(started).write_epoch, 1);
  const paused = receipt(plane.execute("pause", {
    command_id: "runtime-pause",
    run_id: "runtime-run",
    expected_state_version: 1,
    payload: {},
  }));
  assert.equal(snapshot(paused).status, "PAUSED");
  const resumed = receipt(plane.execute("resume", {
    command_id: "runtime-resume",
    run_id: "runtime-run",
    expected_state_version: 2,
    payload: {},
  }));
  assert.equal(snapshot(resumed).write_epoch, 2);
  const aborted = receipt(plane.execute("abort", {
    command_id: "runtime-abort",
    run_id: "runtime-run",
    expected_state_version: 3,
    payload: {},
  }));
  assert.equal(snapshot(aborted).status, "ABORTED");
});
