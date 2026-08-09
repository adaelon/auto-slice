import type {
  RunStatus,
  RunTransition,
  StateStoreError,
  StoredRun,
} from "../state/index.js";

export const COMPACTION_TIMEOUT_MS = 30_000 as const;

export interface HostCompactionObservability {
  readonly stable_compaction_ids: boolean;
  readonly structured_phase_events: boolean;
  readonly ordered_host_sequence: boolean;
}

export interface AutoCompactionStartedEvent {
  readonly type: "AUTO_COMPACTION_STARTED";
  readonly thread_id: string;
  readonly compaction_id: string;
  readonly host_sequence: number;
  readonly observed_at: string;
}

export interface AutoCompactionCompletedEvent {
  readonly type: "AUTO_COMPACTION_COMPLETED";
  readonly thread_id: string;
  readonly compaction_id: string;
  readonly host_sequence: number;
  readonly observed_at: string;
}

export type CompactionEvent =
  | AutoCompactionStartedEvent
  | AutoCompactionCompletedEvent;

export interface Clock {
  now(): Date;
}

export interface DeadlineScheduler {
  schedule(key: string, deadline: Date, callback: () => void): void;
  cancel(key: string): void;
}

export interface RunStorePort {
  load(runId: string): StoredRun | StateStoreError;
  compareAndSwap(
    runId: string,
    expectedVersion: number,
    transition: RunTransition,
  ): StoredRun | StateStoreError;
}

export type MonitorOutcome = "WAITING" | "RECOVERED" | "TIMED_OUT" | "NOOP";

export type MonitorDiagnostic =
  | "thread_mismatch"
  | "duplicate_host_sequence"
  | "out_of_order_host_event"
  | "duplicate_started"
  | "unknown_compaction_id"
  | "state_not_listening"
  | "deadline_not_reached"
  | "deadline_rearmed"
  | "completion_won"
  | "deadline_won"
  | "no_active_compaction";

export interface MonitorDecision {
  readonly outcome: MonitorOutcome;
  readonly run_id: string;
  readonly compaction_id: string | null;
  readonly state_version: number;
  readonly status: RunStatus;
  readonly deadline_at?: string;
  readonly diagnostic?: MonitorDiagnostic;
}

export type CompactionMonitorFailureCode =
  | "compaction_observability_unavailable"
  | "invalid_compaction_event"
  | "clock_unavailable"
  | "scheduler_failed"
  | "run_not_found"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";

export type CompactionMonitorFailureReason =
  | "stable_compaction_id_unavailable"
  | "structured_phase_unavailable"
  | "ordered_sequence_unavailable";

export interface CompactionMonitorOptions {
  readonly run_store: RunStorePort;
  readonly clock: Clock;
  readonly scheduler: DeadlineScheduler;
  readonly observability: HostCompactionObservability;
}
