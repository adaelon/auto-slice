import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  CompactionMonitor,
  CompactionMonitorError,
  type Clock,
  type DeadlineScheduler,
  type HostCompactionObservability,
  type MonitorDecision,
} from "../src/controller/compaction-monitor/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
  type StoredRun,
} from "../src/controller/state/index.js";

const STARTED_AT = "2026-08-08T00:00:00.000Z";
const SOURCE_THREAD_ID = "thread-source-s07";
const COMPACTION_ID = "compaction-s07";
const OBSERVABILITY: HostCompactionObservability = {
  stable_compaction_ids: true,
  structured_phase_events: true,
  ordered_host_sequence: true,
};

class VirtualClock implements Clock {
  private current: Date;

  public constructor(now: string = STARTED_AT) {
    this.current = new Date(now);
  }

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public set(now: string): void {
    this.current = new Date(now);
  }
}

interface ScheduledJob {
  readonly deadline: Date;
  readonly callback: () => void;
}

class VirtualScheduler implements DeadlineScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();

  public constructor(private readonly clock: VirtualClock) {}

  public schedule(key: string, deadline: Date, callback: () => void): void {
    this.jobs.set(key, { deadline: new Date(deadline.getTime()), callback });
  }

  public cancel(key: string): void {
    this.jobs.delete(key);
  }

  public size(): number {
    return this.jobs.size;
  }

  public advanceTo(now: string): void {
    this.clock.set(now);
    const current = this.clock.now().getTime();
    const due = [...this.jobs.entries()]
      .filter(([, job]) => job.deadline.getTime() <= current)
      .sort((left, right) => left[1].deadline.getTime() - right[1].deadline.getTime());
    for (const [key, job] of due) {
      this.jobs.delete(key);
      job.callback();
    }
  }
}

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s07-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function openStore(storageRoot: string): FileRunStore {
  const store = FileRunStore.open(storageRoot, { now: () => new Date(STARTED_AT) });
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

function unwrapDecision(result: MonitorDecision | CompactionMonitorError): MonitorDecision {
  if (result instanceof CompactionMonitorError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function initializeRunningStore(store: FileRunStore, runId: string): FileRunStore {
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: {
      canonical_root: "E:\\workspace\\s07-fixture",
      filesystem_identity: "win32:sha256:s07-fixture",
    },
    plan_digest: sha256Bytes("s07-plan"),
    commit_mode: "after_slice",
    current_slice_id: "S07",
    protected_baseline_digest: sha256Bytes("s07-baseline"),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s07_fixture",
    to: "PREPARING",
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s07_fixture",
    to: "SLICE_RUNNING",
    updates: { source_thread_id: SOURCE_THREAD_ID },
  }));
  return store;
}

function runningStore(context: TestContext, runId: string): FileRunStore {
  return initializeRunningStore(openStore(temporaryDirectory(context)), runId);
}

function monitor(store: FileRunStore, clock = new VirtualClock()): {
  readonly clock: VirtualClock;
  readonly monitor: CompactionMonitor;
  readonly scheduler: VirtualScheduler;
} {
  const scheduler = new VirtualScheduler(clock);
  return {
    clock,
    scheduler,
    monitor: new CompactionMonitor({
      run_store: store,
      clock,
      scheduler,
      observability: OBSERVABILITY,
    }),
  };
}

function started(sequence = 1, overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    type: "AUTO_COMPACTION_STARTED",
    thread_id: SOURCE_THREAD_ID,
    compaction_id: COMPACTION_ID,
    host_sequence: sequence,
    observed_at: STARTED_AT,
    ...overrides,
  };
}

function completed(observedAt: string, sequence = 2, overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    type: "AUTO_COMPACTION_COMPLETED",
    thread_id: SOURCE_THREAD_ID,
    compaction_id: COMPACTION_ID,
    host_sequence: sequence,
    observed_at: observedAt,
    ...overrides,
  };
}

void test("29.999s and exactly 30s completion recover, while 30.001s takes the timeout path", (context) => {
  const scenarios = [
    ["before", "2026-08-08T00:00:29.999Z", "RECOVERED", "SLICE_RUNNING"],
    ["boundary", "2026-08-08T00:00:30.000Z", "RECOVERED", "SLICE_RUNNING"],
    ["late", "2026-08-08T00:00:30.001Z", "TIMED_OUT", "SOURCE_INTERRUPTING"],
  ] as const;

  for (const [label, observedAt, outcome, status] of scenarios) {
    const runId = `timing-${label}`;
    const store = runningStore(context, runId);
    const fixture = monitor(store);
    const waiting = unwrapDecision(fixture.monitor.onEvent(runId, started(), 2));
    assert.equal(waiting.outcome, "WAITING");
    assert.equal(waiting.deadline_at, "2026-08-08T00:00:30.000Z");
    const decision = unwrapDecision(fixture.monitor.onEvent(runId, completed(observedAt), 3));
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.status, status);
    assert.equal(unwrapStored(store.load(runId)).state.state_version, 4);
    assert.equal(fixture.scheduler.size(), 0);
  }
});

void test("only a structured STARTED event arms a timer, and the virtual deadline times out", (context) => {
  const silentRun = "silent-run";
  const silentStore = runningStore(context, silentRun);
  const silent = monitor(silentStore);
  silent.scheduler.advanceTo("2026-08-08T00:01:00.000Z");
  assert.equal(unwrapStored(silentStore.load(silentRun)).state.status, "SLICE_RUNNING");
  assert.equal(silent.scheduler.size(), 0);

  const timedRun = "timer-run";
  const timedStore = runningStore(context, timedRun);
  const timed = monitor(timedStore);
  unwrapDecision(timed.monitor.onEvent(timedRun, started(), 2));
  assert.equal(timed.scheduler.size(), 1);
  timed.scheduler.advanceTo("2026-08-08T00:00:30.000Z");
  const state = unwrapStored(timedStore.load(timedRun)).state;
  assert.equal(state.status, "SOURCE_INTERRUPTING");
  assert.equal(state.state_version, 4);
  assert.equal(state.compaction?.compaction_id, COMPACTION_ID);
});

void test("duplicates, out-of-order events, unknown IDs, and stale thread IDs are diagnostic no-ops", (context) => {
  const runId = "diagnostic-run";
  const store = runningStore(context, runId);
  const fixture = monitor(store);

  const staleThread = unwrapDecision(fixture.monitor.onEvent(
    runId,
    started(1, { thread_id: "thread-old" }),
    2,
  ));
  assert.equal(staleThread.outcome, "NOOP");
  assert.equal(staleThread.diagnostic, "thread_mismatch");
  assert.equal(fixture.scheduler.size(), 0);

  unwrapDecision(fixture.monitor.onEvent(runId, started(10), 2));
  const duplicate = unwrapDecision(fixture.monitor.onEvent(runId, started(10), 3));
  assert.equal(duplicate.outcome, "NOOP");
  assert.equal(duplicate.diagnostic, "duplicate_host_sequence");

  const outOfOrder = unwrapDecision(fixture.monitor.onEvent(
    runId,
    completed("2026-08-08T00:00:10.000Z", 9),
    3,
  ));
  assert.equal(outOfOrder.outcome, "NOOP");
  assert.equal(outOfOrder.diagnostic, "out_of_order_host_event");

  const unknown = unwrapDecision(fixture.monitor.onEvent(
    runId,
    completed("2026-08-08T00:00:10.000Z", 11, { compaction_id: "unknown" }),
    3,
  ));
  assert.equal(unknown.outcome, "NOOP");
  assert.equal(unknown.diagnostic, "unknown_compaction_id");

  const recovered = unwrapDecision(fixture.monitor.onEvent(
    runId,
    completed("2026-08-08T00:00:10.000Z", 12),
    3,
  ));
  assert.equal(recovered.outcome, "RECOVERED");
  const repeatedCompletion = unwrapDecision(fixture.monitor.onEvent(
    runId,
    completed("2026-08-08T00:00:10.000Z", 12),
    4,
  ));
  assert.equal(repeatedCompletion.outcome, "NOOP");
  assert.equal(repeatedCompletion.diagnostic, "duplicate_host_sequence");
  assert.equal(unwrapStored(store.load(runId)).state.state_version, 4);
});

void test("missing Host observability fails closed without scheduling a guessed timer", (context) => {
  const variants: readonly [keyof HostCompactionObservability, string][] = [
    ["stable_compaction_ids", "stable_compaction_id_unavailable"],
    ["structured_phase_events", "structured_phase_unavailable"],
    ["ordered_host_sequence", "ordered_sequence_unavailable"],
  ];

  for (const [field, reason] of variants) {
    const runId = `observability-${field}`;
    const store = runningStore(context, runId);
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler(clock);
    const unavailable = new CompactionMonitor({
      run_store: store,
      clock,
      scheduler,
      observability: { ...OBSERVABILITY, [field]: false },
    });
    const result = unavailable.onEvent(runId, started(), 2);
    assert.ok(result instanceof CompactionMonitorError);
    assert.equal(result.code, "compaction_observability_unavailable");
    assert.equal(result.reason, reason);
    assert.equal(scheduler.size(), 0);
    assert.equal(unwrapStored(store.load(runId)).state.status, "SLICE_RUNNING");
  }
});

void test("restart recovery re-arms before the deadline and submits immediately after it", (context) => {
  const beforeRun = "restart-before";
  const beforeStore = runningStore(context, beforeRun);
  const original = monitor(beforeStore);
  unwrapDecision(original.monitor.onEvent(beforeRun, started(), 2));

  const recoveredClock = new VirtualClock("2026-08-08T00:00:20.000Z");
  const recoveredScheduler = new VirtualScheduler(recoveredClock);
  const recoveredMonitor = new CompactionMonitor({
    run_store: beforeStore,
    clock: recoveredClock,
    scheduler: recoveredScheduler,
    observability: OBSERVABILITY,
  });
  const recovery = unwrapDecision(recoveredMonitor.recover(beforeRun, 3));
  assert.equal(recovery.outcome, "WAITING");
  assert.equal(recoveredScheduler.size(), 1);
  recoveredScheduler.advanceTo("2026-08-08T00:00:30.000Z");
  assert.equal(unwrapStored(beforeStore.load(beforeRun)).state.status, "SOURCE_INTERRUPTING");

  const afterRun = "restart-after";
  const afterStore = runningStore(context, afterRun);
  const starter = monitor(afterStore);
  unwrapDecision(starter.monitor.onEvent(afterRun, started(), 2));
  const afterClock = new VirtualClock("2026-08-08T00:00:30.001Z");
  const afterScheduler = new VirtualScheduler(afterClock);
  const afterMonitor = new CompactionMonitor({
    run_store: afterStore,
    clock: afterClock,
    scheduler: afterScheduler,
    observability: OBSERVABILITY,
  });
  const overdue = unwrapDecision(afterMonitor.recover(afterRun, 3));
  assert.equal(overdue.outcome, "TIMED_OUT");
  assert.equal(unwrapStored(afterStore.load(afterRun)).state.status, "SOURCE_INTERRUPTING");
  assert.equal(afterScheduler.size(), 0);
});

void test("completion and deadline contenders resolve through one persisted CAS transition", (context) => {
  for (const winner of ["completion", "deadline"] as const) {
    const runId = `cas-${winner}`;
    const store = runningStore(context, runId);
    const first = monitor(store);
    unwrapDecision(first.monitor.onEvent(runId, started(), 2));
    const contenderClock = new VirtualClock("2026-08-08T00:00:30.000Z");
    const completionMonitor = monitor(store, contenderClock).monitor;
    const deadlineMonitor = monitor(store, contenderClock).monitor;

    const results = winner === "completion"
      ? [
          unwrapDecision(completionMonitor.onEvent(
            runId,
            completed("2026-08-08T00:00:30.000Z"),
            3,
          )),
          unwrapDecision(deadlineMonitor.onDeadline(
            runId,
            COMPACTION_ID,
            "2026-08-08T00:00:30.000Z",
            3,
          )),
        ]
      : [
          unwrapDecision(deadlineMonitor.onDeadline(
            runId,
            COMPACTION_ID,
            "2026-08-08T00:00:30.000Z",
            3,
          )),
          unwrapDecision(completionMonitor.onEvent(
            runId,
            completed("2026-08-08T00:00:30.000Z"),
            3,
          )),
        ];

    assert.equal(results.filter((entry) => entry.outcome !== "NOOP").length, 1);
    assert.equal(unwrapStored(store.load(runId)).state.state_version, 4);
    assert.equal(unwrapStored(store.load(runId)).event_count, 5);
  }
});

void test("a snapshot-write failure after event publication is reconciled from the event log", (context) => {
  const storageRoot = temporaryDirectory(context);
  const runId = "persisted-before-error";
  initializeRunningStore(openStore(storageRoot), runId);
  let faultVersion = 3;
  const faultingStore = FileRunStore.open(storageRoot, {
    now: () => new Date(STARTED_AT),
    faultInjector: (point, faultContext) => {
      if (
        point === "after_run_event_persisted" &&
        faultContext.state_version === faultVersion
      ) {
        faultVersion = -1;
        throw new Error("injected failure after the authoritative event was published");
      }
    },
  });
  if (faultingStore instanceof StateStoreError) {
    assert.fail(`${faultingStore.code}: ${faultingStore.message}`);
  }
  const fixture = monitor(faultingStore);
  const waiting = unwrapDecision(fixture.monitor.onEvent(runId, started(), 2));
  assert.equal(waiting.outcome, "WAITING");
  assert.equal(unwrapStored(faultingStore.load(runId)).state.state_version, 3);

  faultVersion = 4;
  const recovered = unwrapDecision(fixture.monitor.onEvent(
    runId,
    completed("2026-08-08T00:00:20.000Z"),
    3,
  ));
  assert.equal(recovered.outcome, "RECOVERED");
  const final = unwrapStored(faultingStore.load(runId));
  assert.equal(final.state.status, "SLICE_RUNNING");
  assert.equal(final.state.state_version, 4);
  assert.equal(final.event_count, 5);
});
