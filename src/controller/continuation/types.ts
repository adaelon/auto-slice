import type { WorkspaceIdentity } from "../../contracts/index.js";
import type {
  HandoffReceipt,
  HandoffReceiptV2,
  SynthesizeFirstConsumerContract,
} from "../handoff/index.js";
import type { ModelDecision } from "../model-policy/index.js";
import type { SliceContractV1 } from "../slices/index.js";
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
  ProjectLease,
  WorkspaceGuardError,
} from "../workspace/index.js";

export const DEFAULT_CONTINUATION_OPERATION_TIMEOUT_MS = 120_000 as const;

export type ContinuationTaskId = string;

export interface ResumeEnvelope {
  readonly run_id: string;
  readonly current_slice_id: string;
  readonly goal_prompt: string;
  readonly handoff_markdown_path: string;
  readonly evidence_index_path: string;
  readonly consumer_contract: SynthesizeFirstConsumerContract;
  readonly expected_workspace_identity: WorkspaceIdentity;
  /** Legacy envelope decode compatibility only; new envelopes omit this field. */
  readonly expected_owned_diff_digest?: Sha256Digest;
}

export interface ReadyReceipt {
  readonly task_id: ContinuationTaskId;
  readonly run_id: string;
  readonly slice_id: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly handoff_artifact_digest: Sha256Digest;
  readonly consumer_contract_digest: Sha256Digest;
  readonly handoff_read: true;
  readonly first_deliverable_ids: readonly string[];
  readonly first_deliverable_draft_digest: Sha256Digest;
  readonly pre_draft_evidence_reads: 0;
  readonly targeted_evidence_reads: number;
  readonly targeted_read_reasons: readonly (
    | "claim_verification"
    | "named_uncertainty"
  )[];
  readonly broad_search_count: 0;
  readonly full_file_reread_count: 0;
  readonly rollout_digest: Sha256Digest;
  readonly write_access: false;
  readonly observed_state_version: number;
  readonly observed_at: string;
}

export interface LeaseReceipt {
  readonly task_id: ContinuationTaskId;
  readonly lease_id: string;
  readonly write_epoch: number;
  readonly workspace_identity: WorkspaceIdentity;
  readonly granted: true;
  readonly observed_at: string;
}

interface ProgressReceiptBase {
  readonly task_id: ContinuationTaskId;
  readonly slice_id: string;
  readonly observed_state_version: number;
}

export type ProgressReceipt = ProgressReceiptBase & (
  | {
    readonly durable_artifact_digest: Sha256Digest;
    readonly verification_receipt_digest?: never;
  }
  | {
    readonly durable_artifact_digest?: never;
    readonly verification_receipt_digest: Sha256Digest;
  }
);

export interface ContinuationLauncher {
  start(
    envelope: ResumeEnvelope,
    modelDecision: ModelDecision,
  ): Promise<unknown>;
  awaitReady(taskId: ContinuationTaskId): Promise<unknown>;
  grantWrite(taskId: ContinuationTaskId, newWriteEpoch: number): Promise<unknown>;
  awaitProgress(taskId: ContinuationTaskId): Promise<unknown>;
}

export interface ContinuationRunStorePort {
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

export interface ContinuationWorkspaceGuardPort {
  assertWritable(
    leaseId: string,
    expectedEpoch: number,
  ): ProjectLease | WorkspaceGuardError;
  freezeWrites(
    leaseId: string,
    expectedEpoch: number,
  ): FrozenLease | WorkspaceGuardError;
}

export interface ContinuationCoordinatorOptions {
  readonly run_store: ContinuationRunStorePort;
  readonly workspace_guard: ContinuationWorkspaceGuardPort;
  readonly launcher: ContinuationLauncher;
  readonly now?: () => Date;
  readonly operation_timeout_ms?: number;
}

export interface ContinueFromHandoffInput {
  readonly run_id: string;
  readonly lease_id: string;
  /** S21 will make V2 the only production decode path; legacy is retained for replay tests. */
  readonly handoff_receipt: HandoffReceipt | HandoffReceiptV2;
  readonly slice_contract: SliceContractV1;
  readonly model_decision: ModelDecision;
  /** Accepted only for legacy callers and ignored by runtime decisions. */
  readonly expected_owned_diff_digest?: Sha256Digest;
  readonly expected_state_version: number;
}

export type ContinuationOutcome = "CONTINUED" | "ALREADY_CONTINUED";

export interface ContinuationDecision {
  readonly outcome: ContinuationOutcome;
  readonly run_id: string;
  readonly old_source_thread_id: string;
  readonly continuation_task_id: ContinuationTaskId;
  readonly current_slice_id: string;
  readonly state_version: number;
  readonly status: Extract<RunStatus, "SLICE_RUNNING">;
  readonly write_epoch: number;
  readonly envelope: ResumeEnvelope;
  readonly ready_receipt: ReadyReceipt;
  readonly lease_receipt: LeaseReceipt;
  readonly progress_receipt: ProgressReceipt;
}

export type ContinuationFailureReason =
  | "invalid_request"
  | "run_not_continuation_starting"
  | "source_thread_missing"
  | "active_compaction_missing"
  | "handoff_state_missing"
  | "handoff_binding_mismatch"
  | "handoff_path_invalid"
  | "handoff_artifact_missing"
  | "handoff_artifact_digest_mismatch"
  | "handoff_consumer_contract_invalid"
  | "current_slice_missing"
  | "slice_contract_invalid"
  | "owned_diff_digest_invalid"
  | "project_write_lease_missing"
  | "write_epoch_mismatch"
  | "model_policy_invalid"
  | "write_capability_unavailable"
  | "task_start_timeout"
  | "task_start_failed"
  | "task_id_invalid"
  | "task_identity_conflict"
  | "ready_timeout"
  | "ready_call_failed"
  | "ready_receipt_invalid"
  | "ready_identity_mismatch"
  | "ready_workspace_mismatch"
  | "consumer_contract_violated"
  | "grant_timeout"
  | "grant_call_failed"
  | "lease_receipt_invalid"
  | "lease_receipt_mismatch"
  | "progress_timeout"
  | "progress_call_failed"
  | "progress_receipt_invalid"
  | "progress_identity_mismatch"
  | "progress_not_durable"
  | "receipt_replay_mismatch"
  | "failure_freeze_failed";

export type ContinuationFailureCode =
  | "continuation_start_failed"
  | "handoff_integrity_failed"
  | "model_policy_unavailable"
  | "run_not_found"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";
