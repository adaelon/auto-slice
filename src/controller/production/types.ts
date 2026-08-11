import type { WorkspaceIdentity } from "../../contracts/index.js";
import type { MonitorDecision } from "../compaction-monitor/index.js";
import type {
  HostModelCapabilitySnapshot,
  ModelInvocationDecision,
} from "../model-policy/index.js";
import type {
  CommitMode,
  RunTransition,
  Sha256Digest,
  StoredRun,
} from "../state/index.js";
import type {
  ExecutionId,
  ExecutionReceipt,
  SliceContractV1,
  VerificationReceipt,
} from "../slices/index.js";
import type {
  ChangeSet,
  OwnedPatch,
  ProjectLease,
  ProtectedBaseline,
  ReleasedLease,
  WorkspaceSnapshot,
} from "../workspace/index.js";
import type {
  GoalCompletionReceipt,
  GoalCompletionRequest,
} from "./goal-completion-guard.js";

export const PRODUCTION_PLAN_VERSION = 1 as const;
export const DEVELOPMENT_TASK_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_RUN_SCHEMA_VERSION = 1 as const;

export interface ProductionSliceV1 {
  readonly contract: SliceContractV1;
  readonly instructions: string;
}

export interface ProductionPlanV1 {
  readonly schema_version: typeof PRODUCTION_PLAN_VERSION;
  readonly run_id: string;
  readonly commit_mode: CommitMode;
  readonly model_capabilities: HostModelCapabilitySnapshot;
  readonly slices: readonly ProductionSliceV1[];
}

export interface ResolvedProductionPlanV1 {
  readonly plan: ProductionPlanV1;
  readonly plan_digest: Sha256Digest;
  readonly development_model: ModelInvocationDecision;
  readonly continuation_model: ModelInvocationDecision;
  readonly compression_model: ModelInvocationDecision;
}

export interface DevelopmentTaskRequest {
  readonly schema_version: typeof DEVELOPMENT_TASK_SCHEMA_VERSION;
  readonly run_id: string;
  readonly slice_id: string;
  readonly idempotency_key: Sha256Digest;
  readonly workspace_identity: WorkspaceIdentity;
  readonly lease_id: string;
  readonly write_epoch: number;
  readonly model_decision: ModelInvocationDecision;
  readonly prompt: string;
}

export interface ProductionHostCapabilities {
  readonly context_compaction_events: "AVAILABLE" | "UNAVAILABLE";
}

export type CompactionProbeFailureReasonCode =
  | "content_read_failed"
  | "probe_timeout"
  | "probe_unavailable"
  | "probe_protocol_error";

export type CompactionProbeResult =
  | { readonly kind: "NO_COMPACTION" }
  | { readonly kind: "COMPACTION_SEEN"; readonly observedAt: string }
  | {
    readonly kind: "PROBE_FAILED";
    readonly reasonCode: CompactionProbeFailureReasonCode;
  };

export interface CompactionContentProbePort {
  probe(
    threadId: string,
    turnId: string,
    elapsedMs: number,
  ): Promise<CompactionProbeResult>;
}

export type ControllerSignal =
  | {
    readonly type: "COMPACTION";
    readonly phase: "STARTED" | "COMPLETED";
    readonly thread_id: string;
    readonly compaction_id: string;
    readonly host_sequence: number;
    readonly observed_at: string;
  }
  | {
    readonly type: "TURN_TERMINAL";
    readonly run_id: string;
    readonly slice_id: string;
    readonly thread_id: string;
    readonly turn_id: string;
    readonly outcome: "COMPLETED" | "INTERRUPTED" | "FAILED";
    readonly started_at: string;
    readonly completed_at: string;
  }
  | {
    readonly type: "THREAD_LIFECYCLE";
    readonly thread_id: string;
    readonly state: "ARCHIVED" | "DELETED" | "UNARCHIVED" | "CLOSED";
  }
  | {
    readonly type: "MODEL_REROUTED";
    readonly thread_id: string;
    readonly turn_id: string;
    readonly from_model: string;
    readonly to_model: string;
    readonly reason_code: "HIGH_RISK_CYBER_ACTIVITY" | "OTHER";
  };

export type DevelopmentTaskEvent =
  | {
    readonly type: "AUTO_COMPACTION_STARTED";
    readonly thread_id: string;
    readonly compaction_id: string;
    readonly observed_at: string;
    readonly host_sequence: number;
  }
  | {
    readonly type: "AUTO_COMPACTION_COMPLETED";
    readonly thread_id: string;
    readonly compaction_id: string;
    readonly observed_at: string;
    readonly host_sequence: number;
  };

export interface DevelopmentTaskReceipt {
  readonly schema_version: typeof DEVELOPMENT_TASK_SCHEMA_VERSION;
  readonly run_id: string;
  readonly slice_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly outcome: "COMPLETED" | "INTERRUPTED" | "FAILED";
  readonly started_at: string;
  readonly completed_at: string;
  readonly receipt_digest: Sha256Digest;
}

export interface DevelopmentTaskHandle {
  readonly thread_id: string;
  readonly turn_id: string;
  readonly events: AsyncIterable<DevelopmentTaskEvent>;
  readonly completion: Promise<DevelopmentTaskReceipt | import("./errors.js").ProductionRuntimeError>;
}

export interface DevelopmentTaskPort {
  start(request: DevelopmentTaskRequest): Promise<DevelopmentTaskHandle | import("./errors.js").ProductionRuntimeError>;
}

export interface ProductionRunStorePort {
  load(runId: string): StoredRun | import("../state/index.js").StateStoreError;
  compareAndSwap(
    runId: string,
    expectedVersion: number,
    transition: RunTransition,
  ): StoredRun | import("../state/index.js").StateStoreError;
}

export interface ProductionWorkspaceGuardPort {
  assertWritable(
    leaseId: string,
    expectedEpoch: number,
  ): ProjectLease | import("../workspace/index.js").WorkspaceGuardError;
  release(
    leaseId: string,
    expectedEpoch: number,
  ): ReleasedLease | import("../workspace/index.js").WorkspaceGuardError;
}

export interface ProductionSliceExecutorPort {
  start(
    rawContract: unknown,
    lease: ProjectLease,
    modelDecision: ModelInvocationDecision,
  ): ExecutionId | import("../slices/index.js").SliceExecutionError;
  collect(
    execution: ExecutionId,
  ): Promise<ExecutionReceipt | import("../slices/index.js").SliceExecutionError>;
}

export interface ProductionSliceVerifierPort {
  verify(
    rawContract: unknown,
    execution: ExecutionReceipt,
    workspace: WorkspaceIdentity,
    completion: GoalCompletionReceipt,
  ): VerificationReceipt;
}

export interface ProductionGoalCompletionPort {
  observe(
    request: GoalCompletionRequest,
  ): GoalCompletionReceipt | import("./errors.js").ProductionRuntimeError;
}

export interface ProductionChangeGuardPort {
  captureBaseline(
    workspace: WorkspaceIdentity,
  ): ProtectedBaseline | import("../workspace/index.js").WorkspaceGuardError;
  captureCurrent(
    workspace: WorkspaceIdentity,
  ): WorkspaceSnapshot | import("../workspace/index.js").WorkspaceGuardError;
  classify(
    baseline: ProtectedBaseline,
    current: WorkspaceSnapshot,
    ownedPaths: readonly string[],
  ): ChangeSet | import("../workspace/index.js").WorkspaceGuardError;
  assertCommittable(
    changeSet: ChangeSet,
  ): OwnedPatch | import("../workspace/index.js").WorkspaceGuardError;
}

export interface ProductionCompactionMonitorPort {
  onEvent(
    runId: string,
    value: unknown,
    expectedStateVersion: number,
  ): MonitorDecision | import("../compaction-monitor/index.js").CompactionMonitorError;
}

export interface ProductionSourceInterruptionPort {
  interruptSource(
    runId: string,
    leaseId: string,
    expectedWriteEpoch: number,
    expectedStateVersion: number,
  ): Promise<
    | import("../thread-control/index.js").SourceInterruptionDecision
    | import("../thread-control/index.js").SourceInterruptionError
  >;
}

export interface ProductionHandoffPort {
  exportHandoff(
    runId: string,
    interruptReceipt: import("../thread-control/index.js").InterruptReceipt,
    modelDecision: ModelInvocationDecision,
    expectedStateVersion: number,
  ): Promise<
    | import("../handoff/index.js").CompressionHandoffDecision
    | import("../handoff/index.js").CompressionHandoffError
  >;
}

export interface ProductionContinuationPort {
  continueFromHandoff(
    input: import("../continuation/index.js").ContinueFromHandoffInput,
  ): Promise<
    | import("../continuation/index.js").ContinuationDecision
    | import("../continuation/index.js").ContinuationError
  >;
}

export interface ProductionOrchestratorOptions {
  readonly run_store: ProductionRunStorePort;
  readonly workspace_guard: ProductionWorkspaceGuardPort;
  readonly development_tasks: DevelopmentTaskPort;
  /** @deprecated Retained only so existing composition/tests can prove trusted completion never call it. */
  readonly slice_executor?: ProductionSliceExecutorPort;
  /** @deprecated Retained only so existing composition/tests can prove trusted completion never call it. */
  readonly slice_verifier?: ProductionSliceVerifierPort;
  /** @deprecated Retained only so existing composition/tests can prove trusted completion never call it. */
  readonly goal_completion?: ProductionGoalCompletionPort;
  /** @deprecated Decode/injection compatibility only; trusted paths never inspect workspace changes. */
  readonly change_guard?: ProductionChangeGuardPort;
  readonly compaction_monitor: ProductionCompactionMonitorPort;
  readonly source_interruption: ProductionSourceInterruptionPort;
  readonly handoff: ProductionHandoffPort;
  readonly continuation: ProductionContinuationPort;
  readonly now?: () => Date;
  readonly poll_interval_ms?: number;
}

export interface ProductionSliceReceipt {
  readonly slice_id: string;
  readonly source_thread_id: string;
  readonly development_receipt_digest: Sha256Digest;
  readonly state_version: number;
}

export interface ProductionRunReceipt {
  readonly schema_version: typeof PRODUCTION_RUN_SCHEMA_VERSION;
  readonly outcome: "DONE";
  readonly run_id: string;
  readonly plan_digest: Sha256Digest;
  readonly completed_slices: readonly ProductionSliceReceipt[];
  readonly final_state_version: number;
  readonly completed_at: string;
  readonly receipt_digest: Sha256Digest;
}

export interface ProductionContinuationReceipt {
  readonly schema_version: typeof PRODUCTION_RUN_SCHEMA_VERSION;
  readonly outcome: "CONTINUATION_STARTED";
  readonly run_id: string;
  readonly plan_digest: Sha256Digest;
  readonly slice_id: string;
  readonly source_thread_id: string;
  readonly compression_task_id: string;
  readonly continuation_task_id: string;
  /** @deprecated Legacy receipt decode compatibility only; new receipts omit this field. */
  readonly expected_owned_diff_digest?: Sha256Digest;
  readonly state_version: number;
  readonly receipt_digest: Sha256Digest;
}

export type ProductionRunDecision = ProductionRunReceipt | ProductionContinuationReceipt;
