#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const workerPath = path.join(repoRoot, "dist", "test", "helpers", "compaction-race-worker.js");
const BASE_TIME = "2026-08-08T00:00:00.000Z";
const SOURCE_THREAD_ID = "thread-source-s07";
const COMPACTION_ID = "compaction-s07";
const OBSERVABILITY = {
  stable_compaction_ids: true,
  structured_phase_events: true,
  ordered_host_sequence: true,
};

const monitorModule = await import("../dist/src/controller/compaction-monitor/index.js");
const stateModule = await import("../dist/src/controller/state/index.js");
const { CompactionMonitor, CompactionMonitorError } = monitorModule;
const {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
} = stateModule;

function fail(message) {
  throw new Error(message);
}

class VirtualClock {
  constructor(now = BASE_TIME) {
    this.current = new Date(now);
  }

  now() {
    return new Date(this.current.getTime());
  }

  set(now) {
    this.current = new Date(now);
  }
}

class VirtualScheduler {
  constructor(clock) {
    this.clock = clock;
    this.jobs = new Map();
    this.scheduleCount = 0;
  }

  schedule(key, deadline, callback) {
    this.scheduleCount += 1;
    this.jobs.set(key, { deadline: new Date(deadline.getTime()), callback });
  }

  cancel(key) {
    this.jobs.delete(key);
  }

  advanceTo(now) {
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

function openStore(storageRoot) {
  const result = FileRunStore.open(storageRoot, { now: () => new Date(BASE_TIME) });
  if (result instanceof StateStoreError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapStored(result) {
  if (result instanceof StateStoreError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapDecision(result) {
  if (result instanceof CompactionMonitorError) {
    fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function createRunningRun(store, runId) {
  unwrapStored(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: {
      canonical_root: "E:\\workspace\\s07-evidence",
      filesystem_identity: "win32:sha256:s07-evidence",
    },
    plan_digest: sha256Bytes("s07-evidence-plan"),
    commit_mode: "after_slice",
    current_slice_id: "S07",
    protected_baseline_digest: sha256Bytes("s07-evidence-baseline"),
  })));
  unwrapStored(store.compareAndSwap(runId, 0, {
    action: "prepare_s07_evidence",
    to: "PREPARING",
  }));
  unwrapStored(store.compareAndSwap(runId, 1, {
    action: "start_s07_evidence",
    to: "SLICE_RUNNING",
    updates: { source_thread_id: SOURCE_THREAD_ID },
  }));
}

function createMonitor(store, clock, scheduler, observability = OBSERVABILITY) {
  return new CompactionMonitor({
    run_store: store,
    clock,
    scheduler,
    observability,
  });
}

function started() {
  return {
    type: "AUTO_COMPACTION_STARTED",
    thread_id: SOURCE_THREAD_ID,
    compaction_id: COMPACTION_ID,
    host_sequence: 1,
    observed_at: BASE_TIME,
  };
}

function completed(observedAt) {
  return {
    type: "AUTO_COMPACTION_COMPLETED",
    thread_id: SOURCE_THREAD_ID,
    compaction_id: COMPACTION_ID,
    host_sequence: 2,
    observed_at: observedAt,
  };
}

function eventActions(store, runId) {
  const events = store.inspectRunEvents(runId);
  if (events instanceof StateStoreError) {
    fail(`${events.code}: ${events.message}`);
  }
  return events.map((event) => `${event.action}:${event.after_state.status}`);
}

function timingScenario(store, id, completedAt) {
  const runId = `trace-${id}`;
  createRunningRun(store, runId);
  const clock = new VirtualClock();
  const scheduler = new VirtualScheduler(clock);
  const monitor = createMonitor(store, clock, scheduler);
  const waiting = unwrapDecision(monitor.onEvent(runId, started(), 2));
  const decision = unwrapDecision(monitor.onEvent(runId, completed(completedAt), 3));
  const final = unwrapStored(store.load(runId)).state;
  return {
    id,
    completed_at: completedAt,
    deadline_at: waiting.deadline_at,
    outcome: decision.outcome,
    final_status: final.status,
    final_state_version: final.state_version,
    event_actions: eventActions(store, runId),
  };
}

function buildVirtualClockTrace(store) {
  const scenarios = [
    timingScenario(store, "completion_29_999", "2026-08-08T00:00:29.999Z"),
    timingScenario(store, "completion_30_000", "2026-08-08T00:00:30.000Z"),
    timingScenario(store, "completion_30_001", "2026-08-08T00:00:30.001Z"),
  ];

  const restartBeforeRun = "trace-restart-before";
  createRunningRun(store, restartBeforeRun);
  const originalClock = new VirtualClock();
  const originalScheduler = new VirtualScheduler(originalClock);
  unwrapDecision(createMonitor(store, originalClock, originalScheduler).onEvent(
    restartBeforeRun,
    started(),
    2,
  ));
  const beforeClock = new VirtualClock("2026-08-08T00:00:20.000Z");
  const beforeScheduler = new VirtualScheduler(beforeClock);
  const beforeMonitor = createMonitor(store, beforeClock, beforeScheduler);
  const beforeRecovery = unwrapDecision(beforeMonitor.recover(restartBeforeRun, 3));
  beforeScheduler.advanceTo("2026-08-08T00:00:30.000Z");
  const beforeFinal = unwrapStored(store.load(restartBeforeRun)).state;
  scenarios.push({
    id: "restart_before_deadline",
    completed_at: null,
    deadline_at: beforeRecovery.deadline_at,
    outcome: beforeRecovery.outcome,
    final_status: beforeFinal.status,
    final_state_version: beforeFinal.state_version,
    event_actions: eventActions(store, restartBeforeRun),
  });

  const restartAfterRun = "trace-restart-after";
  createRunningRun(store, restartAfterRun);
  const starterClock = new VirtualClock();
  const starterScheduler = new VirtualScheduler(starterClock);
  unwrapDecision(createMonitor(store, starterClock, starterScheduler).onEvent(
    restartAfterRun,
    started(),
    2,
  ));
  const afterClock = new VirtualClock("2026-08-08T00:00:30.001Z");
  const afterScheduler = new VirtualScheduler(afterClock);
  const afterRecovery = unwrapDecision(
    createMonitor(store, afterClock, afterScheduler).recover(restartAfterRun, 3),
  );
  const afterFinal = unwrapStored(store.load(restartAfterRun)).state;
  scenarios.push({
    id: "restart_after_deadline",
    completed_at: null,
    deadline_at: afterRecovery.deadline_at,
    outcome: afterRecovery.outcome,
    final_status: afterFinal.status,
    final_state_version: afterFinal.state_version,
    event_actions: eventActions(store, restartAfterRun),
  });

  const silentRun = "trace-silent-60";
  createRunningRun(store, silentRun);
  const silentClock = new VirtualClock();
  const silentScheduler = new VirtualScheduler(silentClock);
  silentScheduler.advanceTo("2026-08-08T00:01:00.000Z");
  const silentFinal = unwrapStored(store.load(silentRun)).state;
  scenarios.push({
    id: "silent_60_without_started",
    completed_at: null,
    deadline_at: null,
    outcome: "NOOP",
    final_status: silentFinal.status,
    final_state_version: silentFinal.state_version,
    event_actions: eventActions(store, silentRun),
  });

  const expected = [
    ["completion_29_999", "RECOVERED", "SLICE_RUNNING", 4],
    ["completion_30_000", "RECOVERED", "SLICE_RUNNING", 4],
    ["completion_30_001", "TIMED_OUT", "SOURCE_INTERRUPTING", 4],
    ["restart_before_deadline", "WAITING", "SOURCE_INTERRUPTING", 4],
    ["restart_after_deadline", "TIMED_OUT", "SOURCE_INTERRUPTING", 4],
    ["silent_60_without_started", "NOOP", "SLICE_RUNNING", 2],
  ];
  for (const [id, outcome, status, version] of expected) {
    const scenario = scenarios.find((entry) => entry.id === id);
    if (
      scenario === undefined ||
      scenario.outcome !== outcome ||
      scenario.final_status !== status ||
      scenario.final_state_version !== version
    ) {
      fail(`Virtual clock scenario failed: ${id}.`);
    }
  }
  return {
    schema_version: 1,
    slice_id: "S07",
    timeout_ms: 30_000,
    scenarios,
    result: "PASS",
  };
}

function runWorker(storageRoot, runId, readyPath, startPath, contender) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, storageRoot, runId, readyPath, startPath, contender],
      { cwd: repoRoot, shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Race worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForFiles(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) {
      fail(`Timed out waiting for race workers: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function buildRaceReport(store, storageRoot) {
  const iterationCount = 12;
  for (let iteration = 0; iteration < iterationCount; iteration += 1) {
    const runId = `race-${String(iteration).padStart(2, "0")}`;
    createRunningRun(store, runId);
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler(clock);
    unwrapDecision(createMonitor(store, clock, scheduler).onEvent(runId, started(), 2));

    const barrierDirectory = path.join(storageRoot, "race-barriers", String(iteration));
    mkdirSync(barrierDirectory, { recursive: true });
    const readyCompletion = path.join(barrierDirectory, "ready-completion");
    const readyDeadline = path.join(barrierDirectory, "ready-deadline");
    const startPath = path.join(barrierDirectory, "start");
    const completion = runWorker(
      storageRoot,
      runId,
      readyCompletion,
      startPath,
      "completion",
    );
    const deadline = runWorker(
      storageRoot,
      runId,
      readyDeadline,
      startPath,
      "deadline",
    );
    await waitForFiles([readyCompletion, readyDeadline], 10_000);
    writeFileSync(startPath, "go", "utf8");
    const results = await Promise.all([completion, deadline]);
    if (results.some((entry) => entry.kind !== "decision")) {
      fail(`Race iteration ${String(iteration)} returned an error: ${JSON.stringify(results)}.`);
    }
    const transitionCount = results.filter((entry) => entry.outcome !== "NOOP").length;
    const final = unwrapStored(store.load(runId));
    if (
      transitionCount !== 1 ||
      final.state.state_version !== 4 ||
      final.event_count !== 5 ||
      (final.state.status !== "SLICE_RUNNING" && final.state.status !== "SOURCE_INTERRUPTING")
    ) {
      fail(`Race iteration ${String(iteration)} persisted more than one winner.`);
    }
  }
  return {
    schema_version: 1,
    slice_id: "S07",
    iterations: iterationCount,
    contender_processes_per_iteration: 2,
    one_transition_per_iteration: true,
    one_noop_loser_per_iteration: true,
    final_event_count_per_iteration: 5,
    result: "PASS",
  };
}

function buildObservabilityMatrix(store) {
  const variants = [
    ["stable_compaction_ids", "stable_compaction_id_unavailable"],
    ["structured_phase_events", "structured_phase_unavailable"],
    ["ordered_host_sequence", "ordered_sequence_unavailable"],
  ];
  const scenarios = variants.map(([field, expectedReason]) => {
    const runId = `observability-${field}`;
    createRunningRun(store, runId);
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler(clock);
    const monitor = createMonitor(store, clock, scheduler, {
      ...OBSERVABILITY,
      [field]: false,
    });
    const result = monitor.onEvent(runId, started(), 2);
    const state = unwrapStored(store.load(runId)).state;
    if (
      !(result instanceof CompactionMonitorError) ||
      result.code !== "compaction_observability_unavailable" ||
      result.reason !== expectedReason ||
      scheduler.scheduleCount !== 0 ||
      state.status !== "SLICE_RUNNING" ||
      state.state_version !== 2
    ) {
      fail(`Observability failure did not close safely: ${field}.`);
    }
    return {
      id: field,
      failure_code: result.code,
      reason: result.reason,
      scheduled_timers: scheduler.scheduleCount,
      final_status: state.status,
      final_state_version: state.state_version,
    };
  });
  return {
    schema_version: 1,
    slice_id: "S07",
    scenarios,
    result: "PASS",
  };
}

const storageRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s07-evidence-"));
try {
  const store = openStore(storageRoot);
  const virtualClockEventTrace = buildVirtualClockTrace(store);
  const raceRepeatReport = await buildRaceReport(store, storageRoot);
  const observabilityFailureMatrix = buildObservabilityMatrix(store);
  process.stdout.write(JSON.stringify({
    virtual_clock_event_trace: virtualClockEventTrace,
    race_repeat_report: raceRepeatReport,
    observability_failure_matrix: observabilityFailureMatrix,
  }));
} finally {
  rmSync(storageRoot, { recursive: true, force: true });
}
