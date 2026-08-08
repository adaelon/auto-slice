import type { WorkspaceIdentity } from "../../contracts/index.js";
import type { ModelInvocationDecision } from "../model-policy/index.js";
import type { Sha256Digest } from "../state/index.js";
import type {
  ProjectLease,
  ProtectedBaseline,
  WorkspaceSnapshot,
} from "../workspace/index.js";

export const SLICE_CONTRACT_VERSION = 1 as const;
export const SLICE_EXECUTION_SCHEMA_VERSION = 1 as const;

export type SliceFailureCode =
  | "slice_contract_invalid"
  | "path_outside_workspace"
  | "write_capability_unavailable"
  | "model_decision_invalid"
  | "execution_not_found"
  | "execution_already_collected"
  | "check_spawn_failed"
  | "check_timeout"
  | "check_nonzero_exit"
  | "check_output_limit_exceeded"
  | "artifact_missing"
  | "artifact_digest_mismatch"
  | "unowned_change_detected"
  | "protected_change_overlap"
  | "workspace_inspection_failed"
  | "verification_receipt_invalid";

export interface CheckSpec {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeout_ms: number;
  readonly env_allowlist: readonly string[];
  readonly expected_exit_code: number;
  readonly expected_artifacts: readonly string[];
}

export interface ArtifactExpectation {
  readonly path: string;
  readonly kind: string;
  readonly digest?: Sha256Digest;
}

export interface SliceContractV1 {
  readonly slice_id: string;
  readonly contract_version: typeof SLICE_CONTRACT_VERSION;
  readonly objective: string;
  readonly exclusions: readonly string[];
  readonly owned_paths: readonly string[];
  readonly checks: readonly CheckSpec[];
  readonly expected_artifacts: readonly ArtifactExpectation[];
  readonly commit_mode_override?: "after_slice" | "none";
}

export type CheckProcessOutcome =
  | "PASS"
  | "CHECK_SPAWN_FAILED"
  | "CHECK_PATH_OUTSIDE_WORKSPACE"
  | "CHECK_TIMEOUT"
  | "CHECK_NONZERO_EXIT"
  | "CHECK_OUTPUT_LIMIT_EXCEEDED";

export interface CheckExecutionReceipt {
  readonly check_id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly expected_exit_code: number;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly outcome: CheckProcessOutcome;
  readonly stdout_digest: Sha256Digest;
  readonly stderr_digest: Sha256Digest;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly output_limit_exceeded: boolean;
  readonly process_tree_terminated: boolean;
  readonly failure_detail: string | null;
}

export interface ExecutionId {
  readonly schema_version: typeof SLICE_EXECUTION_SCHEMA_VERSION;
  readonly execution_id: string;
  readonly slice_id: string;
}

export interface ExecutionReceipt {
  readonly schema_version: typeof SLICE_EXECUTION_SCHEMA_VERSION;
  readonly execution_id: string;
  readonly slice_id: string;
  readonly contract_digest: Sha256Digest;
  readonly run_id: string;
  readonly lease_id: string;
  readonly write_epoch: number;
  readonly workspace_identity: WorkspaceIdentity;
  readonly model_decision: ModelInvocationDecision;
  readonly started_at: string;
  readonly completed_at: string;
  readonly check_receipts: readonly CheckExecutionReceipt[];
  readonly protected_baseline: ProtectedBaseline;
  readonly workspace_snapshot: WorkspaceSnapshot;
  readonly receipt_digest: Sha256Digest;
}

export interface ArtifactDigest {
  readonly path: string;
  readonly digest: Sha256Digest;
}

export interface VerificationReceipt {
  readonly schema_version: typeof SLICE_EXECUTION_SCHEMA_VERSION;
  readonly slice_id: string;
  readonly execution_id: string;
  readonly contract_digest: Sha256Digest;
  readonly result: "PASS" | "FAIL";
  readonly check_receipts: readonly CheckExecutionReceipt[];
  readonly artifact_digests: readonly ArtifactDigest[];
  readonly owned_diff_digest: Sha256Digest | null;
  readonly overlap_paths: readonly string[];
  readonly unowned_paths: readonly string[];
  readonly failure_code?: SliceFailureCode;
  readonly receipt_digest: Sha256Digest;
}

export interface WriteLeasePort {
  assertWritable(
    leaseId: string,
    expectedEpoch: number,
  ): ProjectLease | import("../workspace/index.js").WorkspaceGuardError;
}
