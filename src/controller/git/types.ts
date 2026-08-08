import type { RunState, Sha256Digest } from "../state/index.js";
import type { SliceContractV1, VerificationReceipt } from "../slices/index.js";
import type { OwnedPatch, ProtectedBaseline } from "../workspace/index.js";

export const COMMIT_COORDINATOR_SCHEMA_VERSION = 1 as const;

export type CommitCoordinatorFailureCode =
  | "verification_failed"
  | "verification_receipt_invalid"
  | "finish_input_invalid"
  | "workspace_not_git_worktree"
  | "git_inspection_failed"
  | "head_drift"
  | "protected_change_overlap"
  | "owned_patch_invalid"
  | "stage_scope_mismatch"
  | "commit_failed"
  | "checkpoint_invalid"
  | "checkpoint_refresh_failed";

export interface GitCommandOptions {
  readonly extra_environment?: Readonly<Record<string, string>>;
}

export interface GitCommandResult {
  readonly exit_code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly failure_message: string | null;
}

export interface GitCommandPort {
  run(
    workspaceRoot: string,
    args: readonly string[],
    options?: GitCommandOptions,
  ): GitCommandResult;
}

export interface CheckpointPlan {
  readonly updated_at: string;
  readonly next_slice_id: string | null;
  readonly current_summary: string;
  readonly next_steps: readonly string[];
  readonly unfinished: readonly string[];
  readonly cold_start_reading_sequence: readonly string[];
}

export interface CheckpointDocument extends CheckpointPlan {
  readonly schema_version: typeof COMMIT_COORDINATOR_SCHEMA_VERSION;
  readonly run_id: string;
  readonly completed_slice_id: string;
  readonly head: string;
  readonly commit_mode: "after_slice" | "none";
  readonly owned_diff_digest: Sha256Digest;
  readonly verification_receipt_digest: Sha256Digest;
}

export interface CheckpointWriteReceipt {
  readonly path: "SESSION_CHECKPOINT.md";
  readonly digest: Sha256Digest;
  readonly bytes: number;
}

export interface FinishSliceInput {
  readonly run: RunState;
  readonly slice: SliceContractV1;
  readonly verification: VerificationReceipt;
  readonly protected_baseline: ProtectedBaseline;
  readonly owned_patch: OwnedPatch;
  readonly commit_message: string;
  readonly checkpoint: CheckpointPlan;
}

export interface FinishReceipt {
  readonly schema_version: typeof COMMIT_COORDINATOR_SCHEMA_VERSION;
  readonly run_id: string;
  readonly slice_id: string;
  readonly commit_mode: "after_slice" | "none";
  readonly commit_created: boolean;
  readonly start_head: string;
  readonly end_head: string;
  readonly owned_diff_digest: Sha256Digest;
  readonly verification_receipt_digest: Sha256Digest;
  readonly checkpoint_path: "SESSION_CHECKPOINT.md";
  readonly checkpoint_digest: Sha256Digest;
  readonly completed_at: string;
  readonly receipt_digest: Sha256Digest;
}

export type CommitCoordinatorFaultPoint = "after_stage";

export interface CommitCoordinatorOptions {
  readonly git?: GitCommandPort;
  readonly checkpointWriter?: import("./checkpoint-writer.js").CheckpointWriter;
  readonly now?: () => Date;
  readonly indexNameFactory?: () => string;
  readonly faultInjector?: (point: CommitCoordinatorFaultPoint) => void;
  readonly changeGuard?: import("../workspace/index.js").GitChangeGuard;
}
