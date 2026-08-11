import type { WorkspaceIdentity } from "../../contracts/index.js";
import type { ModelDecision } from "../model-policy/index.js";
import type {
  EffectIdempotencyKey,
  EffectRecord,
  RunStatus,
  RunTransition,
  Sha256Digest,
  StateStoreError,
  StoredRun,
} from "../state/index.js";
import type { InterruptReceipt } from "../thread-control/index.js";

export const HANDOFF_WORKFLOW_VERSION = "v2" as const;
export const DEFAULT_HANDOFF_EXPORT_TIMEOUT_MS = 600_000 as const;

export interface CompressionRequest {
  readonly source_thread_id: string;
  readonly prompt: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly compaction_id: string;
  readonly model: "gpt-5.6-sol";
  readonly reasoning_effort: "medium";
  readonly idempotency_key: Sha256Digest;
}

export interface CompressionTaskLaunchReceipt {
  readonly compression_task_id: string;
  readonly source_thread_id: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly history_empty: true;
  readonly project_write_lease: false;
  readonly model: "gpt-5.6-sol";
  readonly reasoning_effort: "medium";
  readonly created_at: string;
}

export interface SynthesizeFirstConsumerContract {
  readonly formatVersion: 1;
  readonly kind: "codex-handoff-synthesize-first-consumer-contract";
  readonly mode: "synthesize_first";
  readonly firstDeliverableIds: readonly string[];
  readonly preDraftEvidenceReads: 0;
  readonly maxTargetedReads: number;
  readonly allowedReadReasons: readonly (
    | "claim_verification"
    | "named_uncertainty"
  )[];
  readonly forbidBroadSearch: true;
  readonly forbidFullFileReread: true;
}

export interface HandoffReceipt {
  readonly compression_task_id: string;
  readonly source_thread_id: string;
  readonly workflow_version: typeof HANDOFF_WORKFLOW_VERSION;
  readonly markdown_path: string;
  readonly evidence_index_path: string;
  readonly source_revision: string;
  readonly frame_digest: Sha256Digest;
  readonly handoff_digest: Sha256Digest;
  readonly evidence_index_digest: Sha256Digest;
  readonly artifact_digest: Sha256Digest;
  readonly verify_evidence: "PASS";
  readonly consumer_contract: SynthesizeFirstConsumerContract;
  readonly retained_work_dir?: string;
}

export interface CompressionTaskLauncher {
  start(request: CompressionRequest): Promise<unknown>;
  awaitHandoff(
    compressionTaskId: string,
    idempotencyKey: Sha256Digest,
  ): Promise<unknown>;
}

export interface CompressionHandoffRunStorePort {
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

export interface CompressionHandoffCoordinatorOptions {
  readonly run_store: CompressionHandoffRunStorePort;
  readonly launcher: CompressionTaskLauncher;
  readonly now?: () => Date;
  readonly export_timeout_ms?: number;
}

export type CompressionHandoffOutcome = "EXPORTED" | "ALREADY_EXPORTED";

export interface CompressionHandoffDecision {
  readonly outcome: CompressionHandoffOutcome;
  readonly run_id: string;
  readonly source_thread_id: string;
  readonly compaction_id: string;
  readonly state_version: number;
  readonly status: Extract<RunStatus, "CONTINUATION_STARTING">;
  readonly effect_idempotency_key: Sha256Digest;
  readonly receipt: HandoffReceipt;
}

export type CompressionHandoffFailureReason =
  | "invalid_request"
  | "run_not_handoff_exporting"
  | "active_compaction_missing"
  | "source_thread_missing"
  | "source_thread_mismatch"
  | "source_revision_mismatch"
  | "model_policy_invalid"
  | "handoff_already_attempted"
  | "task_start_timeout"
  | "task_start_failed"
  | "worker_unavailable"
  | "skill_budget_failed"
  | "task_launch_receipt_invalid"
  | "task_identity_conflict"
  | "task_workspace_mismatch"
  | "task_history_not_empty"
  | "task_write_lease_present"
  | "task_model_mismatch"
  | "export_timeout"
  | "export_call_failed"
  | "handoff_receipt_invalid"
  | "handoff_workflow_version_mismatch"
  | "handoff_source_mismatch"
  | "handoff_path_invalid"
  | "handoff_artifact_missing"
  | "handoff_artifact_digest_mismatch"
  | "handoff_verify_failed"
  | "receipt_replay_mismatch";

export type CompressionHandoffFailureCode =
  | "handoff_export_failed"
  | "handoff_integrity_failed"
  | "model_policy_unavailable"
  | "run_not_found"
  | "invalid_transition"
  | "stale_state"
  | "state_persist_failed"
  | "state_corrupt"
  | "unsupported_state_schema";

export interface ExportHandoffInput {
  readonly run_id: string;
  readonly interrupt_receipt: InterruptReceipt;
  readonly model_decision: ModelDecision;
  readonly expected_state_version: number;
}
