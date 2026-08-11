import type { WorkspaceIdentity } from "../../contracts/index.js";

export const RUN_STATE_SCHEMA_VERSION = 1 as const;
export const RUN_STORE_SCHEMA_VERSION = 1 as const;

export const RUN_STATUSES = [
  "IDLE",
  "PREPARING",
  "SLICE_RUNNING",
  "VERIFYING",
  "COMMITTING",
  "CHECKPOINTING",
  "COMPACTION_WAIT",
  "SOURCE_INTERRUPTING",
  "HANDOFF_EXPORTING",
  "CONTINUATION_STARTING",
  "PAUSED",
  "NEEDS_USER",
  "DONE",
  "ABORTED",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type CommitMode = "after_slice" | "none";
export type Sha256Digest = `sha256:${string}`;

export type SliceCommitModeOverrides = Readonly<Record<string, CommitMode>>;

export interface RunCompactionState {
  readonly compaction_id: string;
  readonly observed_started_at: string;
  readonly deadline_at: string;
  readonly handoff_attempted: boolean;
  readonly source_interruption_schema_version?: 2;
}

export interface RunHandoffState {
  readonly compression_task_id: string;
  readonly markdown_path: string;
  readonly evidence_index_path: string;
  readonly artifact_digest: Sha256Digest;
  readonly continuation_task_id?: string;
}

export interface RunFailureState {
  readonly code: string;
  readonly message: string;
  readonly occurred_at: string;
  readonly last_successful_status: RunStatus;
  readonly details?: Readonly<Record<string, string>>;
}

export interface RunState {
  readonly schema_version: typeof RUN_STATE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly state_version: number;
  readonly workspace_identity: WorkspaceIdentity;
  readonly plan_digest: Sha256Digest;
  readonly status: RunStatus;
  readonly commit_mode: CommitMode;
  readonly current_slice_id: string | null;
  readonly protected_baseline_digest: Sha256Digest;
  readonly project_lock_owner: string | null;
  readonly write_epoch: number;
  readonly source_thread_id: string | null;
  readonly compaction?: RunCompactionState;
  readonly handoff?: RunHandoffState;
  readonly last_error?: RunFailureState;
  readonly paused_from_status?: RunStatus;
  readonly slice_commit_mode_overrides?: SliceCommitModeOverrides;
}

export interface InitialRunStateInput {
  readonly run_id: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly plan_digest: Sha256Digest;
  readonly commit_mode: CommitMode;
  readonly current_slice_id?: string | null;
  readonly protected_baseline_digest: Sha256Digest;
}

export interface RunStateUpdates {
  readonly commit_mode?: CommitMode;
  readonly current_slice_id?: string | null;
  readonly protected_baseline_digest?: Sha256Digest;
  readonly project_lock_owner?: string | null;
  readonly write_epoch?: number;
  readonly source_thread_id?: string | null;
  readonly compaction?: RunCompactionState | null;
  readonly handoff?: RunHandoffState | null;
  readonly last_error?: RunFailureState | null;
  readonly paused_from_status?: RunStatus | null;
  readonly slice_commit_mode_overrides?: SliceCommitModeOverrides | null;
}

export interface RunTransition {
  readonly action: string;
  readonly to: RunStatus;
  readonly updates?: RunStateUpdates;
}

export interface RunEventRecord {
  readonly schema_version: typeof RUN_STORE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly event_index: number;
  readonly event_kind: "RUN_CREATED" | "STATE_TRANSITION";
  readonly action: string;
  readonly occurred_at: string;
  readonly previous_event_digest: Sha256Digest | null;
  readonly before_state: RunState | null;
  readonly before_state_digest: Sha256Digest | null;
  readonly after_state: RunState;
  readonly after_state_digest: Sha256Digest;
  readonly event_digest: Sha256Digest;
}

export interface StoredRun {
  readonly state: RunState;
  readonly event_count: number;
  readonly event_head_digest: Sha256Digest;
  readonly snapshot_digest: Sha256Digest;
  readonly recovered_from_event_log: boolean;
}

export interface RunReplayReport {
  readonly run_id: string;
  readonly state: RunState;
  readonly state_digest: Sha256Digest;
  readonly event_count: number;
  readonly event_head_digest: Sha256Digest;
}

export interface EffectIdempotencyKey {
  readonly digest: Sha256Digest;
  readonly run_id: string;
  readonly state_version: number;
  readonly action: string;
  readonly stable_target_id: string;
}

export interface EffectRecord {
  readonly idempotency_key: EffectIdempotencyKey;
  readonly status: "INTENDED" | "COMPLETED";
  readonly payload_digest: Sha256Digest;
  readonly intent_event_digest: Sha256Digest;
  readonly intended_at: string;
  readonly receipt_digest?: Sha256Digest;
  readonly completion_event_digest?: Sha256Digest;
  readonly completed_at?: string;
}

export type StateStoreFailureCode =
  | "run_not_found"
  | "run_already_exists"
  | "invalid_state"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";

export type StateStoreFaultPoint =
  | "after_run_event_persisted"
  | "after_effect_intent_persisted"
  | "after_effect_completion_persisted";

export interface StateStoreFaultContext {
  readonly run_id: string;
  readonly state_version?: number;
  readonly idempotency_key?: Sha256Digest;
}

export interface FileRunStoreOptions {
  readonly now?: () => Date;
  readonly faultInjector?: (
    point: StateStoreFaultPoint,
    context: StateStoreFaultContext,
  ) => void;
}

export interface RunTransitionMatrixEntry {
  readonly from: RunStatus;
  readonly to: RunStatus;
  readonly allowed: boolean;
}
