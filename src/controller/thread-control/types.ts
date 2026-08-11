import type {
  EffectIdempotencyKey,
  EffectRecord,
  RunStatus,
  RunTransition,
  Sha256Digest,
  StateStoreError,
  StoredRun,
} from "../state/index.js";
import type {
  FrozenLease,
  LeaseEventRecord,
  ProjectLease,
  WorkspaceGuardError,
} from "../workspace/index.js";

export const DEFAULT_SOURCE_INTERRUPT_TIMEOUT_MS = 30_000 as const;

export interface ThreadSummary {
  readonly thread_id: string;
  readonly readable: true;
  readonly persistent: true;
  readonly observed_at: string;
}

export interface ThreadMetadataPort {
  inspect(threadId: string, includeTurns?: false): Promise<unknown>;
}

export interface InterruptReceipt {
  readonly thread_id: string;
  readonly turn_id: string;
  readonly terminal_status: "interrupted";
  readonly execution_stopped: true;
  readonly thread_persisted: true;
  readonly observed_at: string;
}

export interface ThreadInspection {
  readonly thread_id: string;
  readonly readable: true;
  readonly persistent: true;
  readonly observed_at: string;
}

export interface ThreadControlPort extends ThreadMetadataPort {
  interrupt(threadId: string, idempotencyKey: Sha256Digest): Promise<unknown>;
}

export interface SourceInterruptionRunStorePort {
  load(runId: string): StoredRun | StateStoreError;
  compareAndSwap(
    runId: string,
    expectedVersion: number,
    transition: RunTransition,
  ): StoredRun | StateStoreError;
  appendEffectIntent(
    key: EffectIdempotencyKey,
    payloadDigest: Sha256Digest,
  ): EffectRecord | StateStoreError;
  completeEffect(
    key: EffectIdempotencyKey,
    receiptDigest: Sha256Digest,
  ): EffectRecord | StateStoreError;
}

export interface SourceInterruptionWorkspaceGuardPort {
  freezeWrites(
    leaseId: string,
    expectedEpoch: number,
  ): FrozenLease | WorkspaceGuardError;
  rotateEpoch(frozenLease: FrozenLease): ProjectLease | WorkspaceGuardError;
  inspectLeaseEvents(
    leaseId: string,
  ): readonly LeaseEventRecord[] | WorkspaceGuardError;
}

export interface SourceInterruptionCoordinatorOptions {
  readonly run_store: SourceInterruptionRunStorePort;
  readonly workspace_guard: SourceInterruptionWorkspaceGuardPort;
  readonly thread_control: ThreadControlPort;
  readonly now?: () => Date;
  readonly interrupt_timeout_ms?: number;
}

export type SourceInterruptionOutcome = "INTERRUPTED" | "ALREADY_INTERRUPTED";

export interface SourceInterruptionDecision {
  readonly outcome: SourceInterruptionOutcome;
  readonly run_id: string;
  readonly source_thread_id: string;
  readonly compaction_id: string;
  readonly state_version: number;
  readonly status: Extract<RunStatus, "HANDOFF_EXPORTING">;
  readonly write_epoch: number;
  readonly effect_idempotency_key: Sha256Digest;
  readonly receipt: InterruptReceipt;
}

export type SourceInterruptionFailureReason =
  | "invalid_request"
  | "run_not_source_interrupting"
  | "source_thread_missing"
  | "active_compaction_missing"
  | "project_write_lease_missing"
  | "write_epoch_mismatch"
  | "lease_freeze_failed"
  | "interrupt_timeout"
  | "interrupt_call_failed"
  | "interrupt_receipt_invalid"
  | "interrupt_receipt_identity_mismatch"
  | "thread_inspection_failed"
  | "thread_not_persisted"
  | "source_interruption_migration_required"
  | "receipt_replay_mismatch"
  | "write_epoch_rotation_failed";

export type SourceInterruptionFailureCode =
  | "source_interrupt_failed"
  | "run_not_found"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";
