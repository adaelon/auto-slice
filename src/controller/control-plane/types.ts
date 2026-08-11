import type { WorkspaceIdentity } from "../../contracts/index.js";
import type {
  CommitMode,
  RunState,
  RunStateUpdates,
  RunStatus,
  RunTransition,
  Sha256Digest,
  StateStoreError,
  StoredRun,
} from "../state/index.js";
import type {
  ProjectLease,
  ReleasedLease,
  WorkspaceGuardError,
} from "../workspace/index.js";

export const CONTROL_PLANE_SCHEMA_VERSION = 1 as const;

export const CONTROL_COMMANDS = [
  "start",
  "status",
  "pause",
  "resume",
  "abort",
  "override",
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

export const RECOVERY_RESOLUTIONS = [
  "retry_continuation_start",
  "supply_model_policy",
  "resolve_protected_changes",
  "release_stale_project_lock",
  "abort_run",
] as const;

export type RecoveryResolution = (typeof RECOVERY_RESOLUTIONS)[number];

export interface CommandEnvelope {
  readonly command_id: string;
  readonly run_id?: string;
  readonly expected_state_version?: number;
  readonly payload: unknown;
}

export interface ControlCommandRequest {
  readonly command: ControlCommand;
  readonly envelope: CommandEnvelope;
}

export interface StartRunPayload {
  readonly run_id: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly plan_digest: Sha256Digest;
  readonly protected_baseline_digest: Sha256Digest;
  readonly commit_mode: CommitMode;
  readonly first_slice_id: string;
}

export interface RecoveryEvidence {
  readonly evidence_path: string;
  readonly evidence_digest: Sha256Digest;
}

export interface ResumePayload {
  readonly resolution?: RecoveryResolution;
  readonly evidence?: RecoveryEvidence;
}

export interface OverrideSliceCommitModePayload {
  readonly slice_id: string;
  readonly mode: CommitMode;
}

export interface ProjectedTaskIds {
  readonly source_thread_id: string | null;
  readonly compression_task_id: string | null;
  readonly continuation_task_id: string | null;
}

export interface ProjectedRunError {
  readonly code: string;
  readonly occurred_at: string;
  readonly last_successful_status: RunStatus;
  readonly evidence_paths: readonly string[];
  readonly recovery_options: readonly RecoveryResolution[];
}

export interface RunSnapshot {
  readonly schema_version: typeof CONTROL_PLANE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly state_version: number;
  readonly status: RunStatus;
  readonly current_slice_id: string | null;
  readonly commit_mode: CommitMode;
  readonly effective_commit_mode: CommitMode;
  readonly slice_commit_mode_overrides: Readonly<Record<string, CommitMode>>;
  readonly write_epoch: number;
  readonly task_ids: ProjectedTaskIds;
  readonly last_successful_status: RunStatus;
  readonly error?: ProjectedRunError;
}

export type ControlPlaneFailureCode =
  | "invalid_command"
  | "invalid_command_envelope"
  | "command_replay_conflict"
  | "command_in_progress"
  | "command_journal_failed"
  | "command_journal_corrupt"
  | "command_not_allowed"
  | "invalid_recovery_resolution"
  | "recovery_failed"
  | "pause_safe_point_failed"
  | "abort_cleanup_failed"
  | "slice_not_found"
  | "slice_already_verifying"
  | "project_lock_unavailable"
  | "run_not_found"
  | "run_already_exists"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";

export interface ProjectedControlError {
  readonly code: ControlPlaneFailureCode;
}

export type ControlCommandOutcome = "OK" | "NEEDS_USER" | "REJECTED";

export interface ControlCommandReceiptMaterial {
  readonly schema_version: typeof CONTROL_PLANE_SCHEMA_VERSION;
  readonly command_id: string;
  readonly command: ControlCommand;
  readonly outcome: ControlCommandOutcome;
  readonly completed_at: string;
  readonly snapshot?: RunSnapshot;
  readonly error?: ProjectedControlError;
}

export interface ControlCommandReceipt extends ControlCommandReceiptMaterial {
  readonly receipt_digest: Sha256Digest;
}

export interface CommandIntentRecord {
  readonly schema_version: typeof CONTROL_PLANE_SCHEMA_VERSION;
  readonly command_id: string;
  readonly command: ControlCommand;
  readonly envelope_digest: Sha256Digest;
  readonly started_at: string;
  readonly intent_digest: Sha256Digest;
}

export type CommandJournalBegin =
  | { readonly outcome: "CLAIMED"; readonly intent: CommandIntentRecord }
  | { readonly outcome: "IN_PROGRESS"; readonly intent: CommandIntentRecord }
  | { readonly outcome: "REPLAY"; readonly receipt: ControlCommandReceipt };

export interface CommandJournalPort {
  begin(
    command: ControlCommand,
    commandId: string,
    envelopeDigest: Sha256Digest,
    startedAt: string,
  ): CommandJournalBegin | import("./errors.js").ControlPlaneError;
  complete(
    intent: CommandIntentRecord,
    receipt: ControlCommandReceipt,
  ): ControlCommandReceipt | import("./errors.js").ControlPlaneError;
}

export interface ControlPlaneRunStorePort {
  create(initialState: RunState): StoredRun | StateStoreError;
  load(runId: string): StoredRun | StateStoreError;
  compareAndSwap(
    runId: string,
    expectedVersion: number,
    transition: RunTransition,
  ): StoredRun | StateStoreError;
}

export interface ProjectWriteLeasePort {
  acquire(workspace: WorkspaceIdentity, runId: string): ProjectLease | WorkspaceGuardError;
  release(leaseId: string, expectedEpoch: number): ReleasedLease | WorkspaceGuardError;
}

export interface ControlPortReceipt {
  readonly applied: true;
  readonly receipt_digest: Sha256Digest;
  readonly updates?: RunStateUpdates;
}

export type RecoveryPortReceipt = ControlPortReceipt;

export interface ControlLifecyclePort {
  pauseAtSafePoint(run: RunState, commandId: string): ControlPortReceipt | import("./errors.js").ControlPlaneError;
  resumeFromSafePoint(run: RunState, commandId: string): ControlPortReceipt | import("./errors.js").ControlPlaneError;
  revokeWrites(run: RunState, commandId: string): ControlPortReceipt | import("./errors.js").ControlPlaneError;
}

export interface ExplicitRecoveryPort {
  resolve(
    run: RunState,
    resolution: Exclude<RecoveryResolution, "abort_run">,
    evidence: RecoveryEvidence,
    commandId: string,
  ): RecoveryPortReceipt | import("./errors.js").ControlPlaneError;
}

export type SlicePhase = "PENDING" | "RUNNING" | "VERIFYING" | "COMPLETED" | "UNKNOWN";

export interface SlicePhasePort {
  getPhase(run: RunState, sliceId: string): SlicePhase;
}

export interface ControlPlaneOptions {
  readonly run_store: ControlPlaneRunStorePort;
  readonly command_journal: CommandJournalPort;
  readonly workspace_guard: ProjectWriteLeasePort;
  readonly lifecycle: ControlLifecyclePort;
  readonly recovery: ExplicitRecoveryPort;
  readonly slice_phase: SlicePhasePort;
  readonly now?: () => Date;
}
