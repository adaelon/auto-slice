import { StateStoreError, type RunState, type StoredRun } from "../state/index.js";

import { CompactionMonitorError } from "./errors.js";
import {
  COMPACTION_TIMEOUT_MS,
  type AutoCompactionStartedEvent,
  type CompactionEvent,
  type CompactionMonitorFailureCode,
  type CompactionMonitorOptions,
  type MonitorDecision,
  type MonitorDiagnostic,
} from "./types.js";

const EVENT_KEYS = [
  "type",
  "thread_id",
  "compaction_id",
  "host_sequence",
  "observed_at",
] as const;

const STATE_ERROR_CODES = new Set<CompactionMonitorFailureCode>([
  "run_not_found",
  "invalid_transition",
  "stale_state",
  "state_persist_failed",
  "state_corrupt",
  "unsupported_state_schema",
]);

interface Timestamp {
  readonly iso: string;
  readonly milliseconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256
  );
}

function timestamp(value: unknown, label: string): Timestamp {
  if (typeof value !== "string") {
    throw new CompactionMonitorError(
      "invalid_compaction_event",
      `${label} must be an ISO timestamp string.`,
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new CompactionMonitorError(
      "invalid_compaction_event",
      `${label} must be a canonical ISO timestamp.`,
    );
  }
  return { iso: value, milliseconds };
}

function schedulerKey(runId: string, compactionId: string): string {
  return `${runId}\u0000${compactionId}`;
}

export class CompactionMonitor {
  private readonly lastHostSequences = new Map<string, number>();

  public constructor(private readonly options: CompactionMonitorOptions) {}

  public onEvent(
    runId: string,
    value: unknown,
    expectedStateVersion: number,
  ): MonitorDecision | CompactionMonitorError {
    try {
      this.requireObservability();
      this.requireRunArguments(runId, expectedStateVersion);
      const event = this.decodeEvent(value);
      const current = this.load(runId);
      if (current.state.source_thread_id !== event.thread_id) {
        return this.decision(current.state, "NOOP", event.compaction_id, "thread_mismatch");
      }
      const sequenceDiagnostic = this.observeSequence(event.thread_id, event.host_sequence);
      if (sequenceDiagnostic !== undefined) {
        return this.decision(current.state, "NOOP", event.compaction_id, sequenceDiagnostic);
      }
      return event.type === "AUTO_COMPACTION_STARTED"
        ? this.onStarted(runId, event, expectedStateVersion, current)
        : this.onCompleted(runId, event, expectedStateVersion, current);
    } catch (error: unknown) {
      return this.asMonitorError(error, "Compaction event processing failed.");
    }
  }

  public onDeadline(
    runId: string,
    compactionId: string,
    firedAt: string,
    expectedStateVersion: number,
  ): MonitorDecision | CompactionMonitorError {
    try {
      this.requireObservability();
      this.requireRunArguments(runId, expectedStateVersion);
      if (!validIdentifier(compactionId)) {
        throw new CompactionMonitorError(
          "invalid_compaction_event",
          "compaction_id must be a stable non-empty identifier.",
        );
      }
      const fired = timestamp(firedAt, "fired_at");
      const current = this.load(runId);
      return this.onDeadlineLoaded(
        runId,
        compactionId,
        fired,
        expectedStateVersion,
        current.state,
      );
    } catch (error: unknown) {
      return this.asMonitorError(error, "Compaction deadline processing failed.");
    }
  }

  public recover(
    runId: string,
    expectedStateVersion: number,
  ): MonitorDecision | CompactionMonitorError {
    try {
      this.requireObservability();
      this.requireRunArguments(runId, expectedStateVersion);
      const current = this.load(runId);
      const active = current.state.compaction;
      if (active === undefined) {
        return this.decision(current.state, "NOOP", null, "no_active_compaction");
      }
      if (current.state.status === "SOURCE_INTERRUPTING") {
        return this.decision(
          current.state,
          "NOOP",
          active.compaction_id,
          "deadline_won",
        );
      }
      if (current.state.status !== "COMPACTION_WAIT") {
        return this.decision(
          current.state,
          "NOOP",
          active.compaction_id,
          "state_not_listening",
        );
      }
      if (current.state.state_version !== expectedStateVersion) {
        throw this.staleState(expectedStateVersion, current.state.state_version);
      }
      const now = this.readClock();
      if (now.milliseconds >= timestamp(active.deadline_at, "deadline_at").milliseconds) {
        return this.onDeadlineLoaded(
          runId,
          active.compaction_id,
          now,
          expectedStateVersion,
          current.state,
        );
      }
      const scheduled = this.scheduleDeadline(current.state);
      if (scheduled instanceof CompactionMonitorError) {
        return scheduled;
      }
      return this.decision(
        current.state,
        "WAITING",
        active.compaction_id,
        "deadline_rearmed",
      );
    } catch (error: unknown) {
      return this.asMonitorError(error, "Compaction recovery failed.");
    }
  }

  private onStarted(
    runId: string,
    event: AutoCompactionStartedEvent,
    expectedStateVersion: number,
    current: StoredRun,
  ): MonitorDecision | CompactionMonitorError {
    const active = current.state.compaction;
    if (
      current.state.status === "COMPACTION_WAIT" &&
      active?.compaction_id === event.compaction_id
    ) {
      return this.decision(
        current.state,
        "NOOP",
        event.compaction_id,
        "duplicate_started",
      );
    }
    if (current.state.state_version !== expectedStateVersion) {
      throw this.staleState(expectedStateVersion, current.state.state_version);
    }
    if (current.state.status !== "SLICE_RUNNING") {
      return this.decision(
        current.state,
        "NOOP",
        event.compaction_id,
        "state_not_listening",
      );
    }
    const observed = timestamp(event.observed_at, "observed_at");
    const deadlineAt = new Date(observed.milliseconds + COMPACTION_TIMEOUT_MS).toISOString();
    const transitioned = this.options.run_store.compareAndSwap(runId, expectedStateVersion, {
      action: "observe_auto_compaction_started",
      to: "COMPACTION_WAIT",
      updates: {
        compaction: {
          compaction_id: event.compaction_id,
          observed_started_at: observed.iso,
          deadline_at: deadlineAt,
          handoff_attempted: false,
        },
      },
    });
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state" || transitioned.code === "state_persist_failed") {
        const latest = this.load(runId);
        if (
          latest.state.status === "COMPACTION_WAIT" &&
          latest.state.compaction?.compaction_id === event.compaction_id
        ) {
          if (transitioned.code === "state_persist_failed") {
            const deadlineDecision = this.armDeadline(latest.state);
            return deadlineDecision ?? this.decision(
              latest.state,
              "WAITING",
              event.compaction_id,
            );
          }
          return this.decision(latest.state, "NOOP", event.compaction_id, "duplicate_started");
        }
      }
      throw this.fromStateError(transitioned);
    }
    const deadlineDecision = this.armDeadline(transitioned.state);
    if (deadlineDecision !== undefined) {
      return deadlineDecision;
    }
    return this.decision(transitioned.state, "WAITING", event.compaction_id);
  }

  private onCompleted(
    runId: string,
    event: Extract<CompactionEvent, { readonly type: "AUTO_COMPACTION_COMPLETED" }>,
    expectedStateVersion: number,
    current: StoredRun,
  ): MonitorDecision | CompactionMonitorError {
    const active = current.state.compaction;
    if (active?.compaction_id !== event.compaction_id) {
      return this.decision(
        current.state,
        "NOOP",
        event.compaction_id,
        "unknown_compaction_id",
      );
    }
    if (current.state.status === "SOURCE_INTERRUPTING") {
      return this.decision(current.state, "NOOP", event.compaction_id, "deadline_won");
    }
    if (current.state.status !== "COMPACTION_WAIT") {
      return this.decision(
        current.state,
        "NOOP",
        event.compaction_id,
        "state_not_listening",
      );
    }
    if (current.state.state_version !== expectedStateVersion) {
      throw this.staleState(expectedStateVersion, current.state.state_version);
    }
    const observed = timestamp(event.observed_at, "observed_at");
    const deadline = timestamp(active.deadline_at, "deadline_at");
    if (observed.milliseconds > deadline.milliseconds) {
      return this.onDeadlineLoaded(
        runId,
        event.compaction_id,
        observed,
        expectedStateVersion,
        current.state,
      );
    }
    const transitioned = this.options.run_store.compareAndSwap(runId, expectedStateVersion, {
      action: "observe_auto_compaction_completed",
      to: "SLICE_RUNNING",
      updates: { compaction: null },
    });
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state") {
        return this.resolveRace(runId, event.compaction_id);
      }
      if (transitioned.code === "state_persist_failed") {
        return this.reconcilePersistedTransition(runId, event.compaction_id, "RECOVERED");
      }
      throw this.fromStateError(transitioned);
    }
    this.cancelDeadline(runId, event.compaction_id);
    return this.decision(transitioned.state, "RECOVERED", event.compaction_id);
  }

  private onDeadlineLoaded(
    runId: string,
    compactionId: string,
    fired: Timestamp,
    expectedStateVersion: number,
    state: RunState,
  ): MonitorDecision | CompactionMonitorError {
    const active = state.compaction;
    if (active === undefined) {
      return this.decision(state, "NOOP", compactionId, "completion_won");
    }
    if (active.compaction_id !== compactionId) {
      return this.decision(
        state,
        "NOOP",
        compactionId,
        "unknown_compaction_id",
      );
    }
    if (state.status === "SOURCE_INTERRUPTING") {
      return this.decision(state, "NOOP", compactionId, "deadline_won");
    }
    if (state.status !== "COMPACTION_WAIT") {
      return this.decision(
        state,
        "NOOP",
        compactionId,
        "state_not_listening",
      );
    }
    if (state.state_version !== expectedStateVersion) {
      throw this.staleState(expectedStateVersion, state.state_version);
    }
    const deadline = timestamp(active.deadline_at, "deadline_at");
    if (fired.milliseconds < deadline.milliseconds) {
      const scheduled = this.scheduleDeadline(state);
      if (scheduled instanceof CompactionMonitorError) {
        return scheduled;
      }
      return this.decision(
        state,
        "NOOP",
        compactionId,
        "deadline_not_reached",
      );
    }
    const transitioned = this.options.run_store.compareAndSwap(runId, expectedStateVersion, {
      action: "observe_auto_compaction_deadline",
      to: "SOURCE_INTERRUPTING",
    });
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state") {
        return this.resolveRace(runId, compactionId);
      }
      if (transitioned.code === "state_persist_failed") {
        return this.reconcilePersistedTransition(runId, compactionId, "TIMED_OUT");
      }
      throw this.fromStateError(transitioned);
    }
    this.cancelDeadline(runId, compactionId);
    return this.decision(transitioned.state, "TIMED_OUT", compactionId);
  }

  private armDeadline(
    state: RunState,
  ): MonitorDecision | CompactionMonitorError | undefined {
    const active = state.compaction;
    if (active === undefined) {
      return undefined;
    }
    const now = this.readClock();
    if (now.milliseconds >= timestamp(active.deadline_at, "deadline_at").milliseconds) {
      return this.onDeadlineLoaded(
        state.run_id,
        active.compaction_id,
        now,
        state.state_version,
        state,
      );
    }
    const scheduled = this.scheduleDeadline(state);
    return scheduled instanceof CompactionMonitorError ? scheduled : undefined;
  }

  private scheduleDeadline(state: RunState): true | CompactionMonitorError {
    const active = state.compaction;
    if (active === undefined) {
      return true;
    }
    try {
      this.options.scheduler.schedule(
        schedulerKey(state.run_id, active.compaction_id),
        new Date(active.deadline_at),
        () => {
          let firedAt: string;
          try {
            firedAt = this.readClock().iso;
          } catch {
            return;
          }
          this.onDeadline(
            state.run_id,
            active.compaction_id,
            firedAt,
            state.state_version,
          );
        },
      );
      return true;
    } catch (error: unknown) {
      return new CompactionMonitorError(
        "scheduler_failed",
        "The compaction deadline could not be scheduled.",
        { cause: error },
      );
    }
  }

  private cancelDeadline(runId: string, compactionId: string): void {
    try {
      this.options.scheduler.cancel(schedulerKey(runId, compactionId));
    } catch {
      // A stale timer is harmless: its persisted-state check becomes a no-op.
    }
  }

  private resolveRace(runId: string, compactionId: string): MonitorDecision {
    const latest = this.load(runId);
    if (
      latest.state.status === "SOURCE_INTERRUPTING" &&
      latest.state.compaction?.compaction_id === compactionId
    ) {
      return this.decision(latest.state, "NOOP", compactionId, "deadline_won");
    }
    if (latest.state.status === "SLICE_RUNNING" && latest.state.compaction === undefined) {
      return this.decision(latest.state, "NOOP", compactionId, "completion_won");
    }
    throw this.staleState(-1, latest.state.state_version);
  }

  private reconcilePersistedTransition(
    runId: string,
    compactionId: string,
    attemptedOutcome: "RECOVERED" | "TIMED_OUT",
  ): MonitorDecision {
    const latest = this.load(runId);
    if (latest.state.status === "SLICE_RUNNING" && latest.state.compaction === undefined) {
      this.cancelDeadline(runId, compactionId);
      return attemptedOutcome === "RECOVERED"
        ? this.decision(latest.state, "RECOVERED", compactionId)
        : this.decision(latest.state, "NOOP", compactionId, "completion_won");
    }
    if (
      latest.state.status === "SOURCE_INTERRUPTING" &&
      latest.state.compaction?.compaction_id === compactionId
    ) {
      this.cancelDeadline(runId, compactionId);
      return attemptedOutcome === "TIMED_OUT"
        ? this.decision(latest.state, "TIMED_OUT", compactionId)
        : this.decision(latest.state, "NOOP", compactionId, "deadline_won");
    }
    throw new CompactionMonitorError(
      "state_persist_failed",
      "The state-store failure could not be reconciled with a committed compaction transition.",
    );
  }

  private decodeEvent(value: unknown): CompactionEvent {
    if (!isRecord(value)) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "Host compaction events must be structured objects.",
        { reason: "structured_phase_unavailable" },
      );
    }
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...EVENT_KEYS].sort())) {
      throw new CompactionMonitorError(
        "invalid_compaction_event",
        "Host compaction events must match the frozen event schema exactly.",
      );
    }
    if (
      value.type !== "AUTO_COMPACTION_STARTED" &&
      value.type !== "AUTO_COMPACTION_COMPLETED"
    ) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "Host compaction events must expose STARTED and COMPLETED phases.",
        { reason: "structured_phase_unavailable" },
      );
    }
    if (!validIdentifier(value.compaction_id)) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "Host compaction events must expose a stable compaction_id.",
        { reason: "stable_compaction_id_unavailable" },
      );
    }
    if (!Number.isSafeInteger(value.host_sequence) || Number(value.host_sequence) < 0) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "Host compaction events must expose an ordered host_sequence.",
        { reason: "ordered_sequence_unavailable" },
      );
    }
    if (!validIdentifier(value.thread_id)) {
      throw new CompactionMonitorError(
        "invalid_compaction_event",
        "thread_id must be a non-empty stable identifier.",
      );
    }
    timestamp(value.observed_at, "observed_at");
    return value as unknown as CompactionEvent;
  }

  private requireObservability(): void {
    if (!this.options.observability.stable_compaction_ids) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "The Host does not guarantee stable compaction IDs.",
        { reason: "stable_compaction_id_unavailable" },
      );
    }
    if (!this.options.observability.structured_phase_events) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "The Host does not expose structured compaction phases.",
        { reason: "structured_phase_unavailable" },
      );
    }
    if (!this.options.observability.ordered_host_sequence) {
      throw new CompactionMonitorError(
        "compaction_observability_unavailable",
        "The Host does not guarantee ordered compaction event sequences.",
        { reason: "ordered_sequence_unavailable" },
      );
    }
  }

  private requireRunArguments(runId: string, expectedStateVersion: number): void {
    if (!validIdentifier(runId)) {
      throw new CompactionMonitorError(
        "invalid_compaction_event",
        "run_id must be a non-empty stable identifier.",
      );
    }
    if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
      throw new CompactionMonitorError(
        "invalid_compaction_event",
        "expected_state_version must be a non-negative safe integer.",
      );
    }
  }

  private observeSequence(
    threadId: string,
    sequence: number,
  ): "duplicate_host_sequence" | "out_of_order_host_event" | undefined {
    const previous = this.lastHostSequences.get(threadId);
    if (previous !== undefined && sequence < previous) {
      return "out_of_order_host_event";
    }
    if (previous !== undefined && sequence === previous) {
      return "duplicate_host_sequence";
    }
    this.lastHostSequences.set(threadId, sequence);
    return undefined;
  }

  private readClock(): Timestamp {
    try {
      const value = this.options.clock.now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error("Clock returned an invalid Date.");
      }
      return { iso: value.toISOString(), milliseconds: value.getTime() };
    } catch (error: unknown) {
      throw new CompactionMonitorError(
        "clock_unavailable",
        "The compaction monitor clock is unavailable.",
        { cause: error },
      );
    }
  }

  private load(runId: string): StoredRun {
    let lastError: StateStoreError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const loaded = this.options.run_store.load(runId);
      if (!(loaded instanceof StateStoreError)) {
        return loaded;
      }
      lastError = loaded;
      if (loaded.code !== "state_persist_failed") {
        throw this.fromStateError(loaded);
      }
    }
    throw this.fromStateError(lastError ?? new StateStoreError(
      "state_persist_failed",
      "The Run could not be loaded.",
    ));
  }

  private fromStateError(error: StateStoreError): CompactionMonitorError {
    const code = STATE_ERROR_CODES.has(error.code as CompactionMonitorFailureCode)
      ? error.code as CompactionMonitorFailureCode
      : "state_persist_failed";
    return new CompactionMonitorError(code, error.message, { cause: error });
  }

  private staleState(expected: number, actual: number): CompactionMonitorError {
    return new CompactionMonitorError(
      "stale_state",
      `Expected state_version ${String(expected)}, found ${String(actual)}.`,
    );
  }

  private decision(
    state: RunState,
    outcome: MonitorDecision["outcome"],
    compactionId: string | null,
    diagnostic?: MonitorDiagnostic,
  ): MonitorDecision {
    const deadlineAt = state.compaction?.deadline_at;
    return {
      outcome,
      run_id: state.run_id,
      compaction_id: compactionId,
      state_version: state.state_version,
      status: state.status,
      ...(deadlineAt === undefined ? {} : { deadline_at: deadlineAt }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  }

  private asMonitorError(error: unknown, message: string): CompactionMonitorError {
    if (error instanceof CompactionMonitorError) {
      return error;
    }
    if (error instanceof StateStoreError) {
      return this.fromStateError(error);
    }
    return new CompactionMonitorError("state_persist_failed", message, { cause: error });
  }
}
