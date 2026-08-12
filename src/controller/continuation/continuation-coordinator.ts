import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import type {
  HandoffReceipt,
  HandoffResultReceipt,
  HandoffReceiptV2,
  SynthesizeFirstConsumerContract,
} from "../handoff/index.js";
import {
  parseSliceContractV1,
  SliceExecutionError,
  type SliceContractV1,
} from "../slices/index.js";
import {
  canonicalJson,
  createEffectIdempotencyKey,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type EffectIdempotencyKey,
  type EffectRecord,
  type RunState,
  type Sha256Digest,
  type StoredRun,
} from "../state/index.js";
import { WorkspaceGuardError } from "../workspace/index.js";
import { buildContinuationPrompt } from "../production/prompt-builder.js";

import { ContinuationError } from "./errors.js";
import {
  DEFAULT_CONTINUATION_OPERATION_TIMEOUT_MS,
  type ContinueFromHandoffInput,
  type ContinuationCoordinatorOptions,
  type ContinuationDecision,
  type ContinuationFailureCode,
  type ContinuationFailureReason,
  type LeaseReceipt,
  type ProgressReceipt,
  type ReadyReceipt,
  type ResumeEnvelope,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const LEGACY_HANDOFF_RECEIPT_KEYS = [
  "compression_task_id",
  "source_thread_id",
  "workflow_version",
  "markdown_path",
  "evidence_index_path",
  "source_revision",
  "frame_digest",
  "handoff_digest",
  "evidence_index_digest",
  "artifact_digest",
  "verify_evidence",
  "consumer_contract",
] as const;

const HANDOFF_RECEIPT_V2_KEYS = [
  "receipt_schema_version",
  "compression_task_id",
  "compression_turn_id",
  "source_thread_id",
  "workflow_version",
  "markdown_path",
  "evidence_index_path",
  "source_revision",
  "structural_digest",
  "handoff_digest",
  "evidence_index_digest",
  "verify_evidence",
  "verify_evidence_result_digest",
  "consumer_contract",
  "artifact_digest",
] as const;

const HANDOFF_RESULT_RECEIPT_KEYS = [
  "receipt_schema_version",
  "compression_task_id",
  "compression_turn_id",
  "source_thread_id",
  "workflow_version",
  "markdown_path",
  "artifact_digest",
] as const;

const CONSUMER_CONTRACT_KEYS = [
  "formatVersion",
  "kind",
  "mode",
  "firstDeliverableIds",
  "preDraftEvidenceReads",
  "maxTargetedReads",
  "allowedReadReasons",
  "forbidBroadSearch",
  "forbidFullFileReread",
] as const;

const READY_RECEIPT_KEYS = [
  "task_id",
  "run_id",
  "slice_id",
  "workspace_identity",
  "handoff_artifact_digest",
  "consumer_contract_digest",
  "handoff_read",
  "first_deliverable_ids",
  "first_deliverable_draft_digest",
  "pre_draft_evidence_reads",
  "targeted_evidence_reads",
  "targeted_read_reasons",
  "broad_search_count",
  "full_file_reread_count",
  "rollout_digest",
  "write_access",
  "observed_state_version",
  "observed_at",
] as const;

const LEASE_RECEIPT_KEYS = [
  "task_id",
  "lease_id",
  "write_epoch",
  "workspace_identity",
  "granted",
  "observed_at",
] as const;

const PROGRESS_RECEIPT_BASE_KEYS = [
  "task_id",
  "slice_id",
  "observed_state_version",
] as const;

const STATE_ERROR_CODES = new Set<ContinuationFailureCode>([
  "run_not_found",
  "invalid_transition",
  "stale_state",
  "state_persist_failed",
  "state_corrupt",
  "unsupported_state_schema",
]);

interface WorkflowPosition {
  task_id?: string;
  grant_may_have_occurred: boolean;
}

interface WorkflowReceipts {
  readonly task_id: string;
  readonly ready: ReadyReceipt;
  readonly lease: LeaseReceipt;
  readonly progress: ProgressReceipt;
}

type VerifiedHandoffReceipt = HandoffReceipt | HandoffReceiptV2 | HandoffResultReceipt;

class BoundedCallError extends Error {
  public constructor(
    public readonly reason: "timeout" | "call_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoundedCallError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const expected = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return actual.every((key) => expected.has(key)) &&
    required.every((key) => actual.includes(key));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256;
}

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined;
}

function sha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function identitiesEqual(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function decodeWorkspaceIdentity(
  value: unknown,
  reason: ContinuationFailureReason,
): WorkspaceIdentity {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["canonical_root", "filesystem_identity"]) ||
    !validIdentifier(value.canonical_root) ||
    !validIdentifier(value.filesystem_identity)
  ) {
    throw new ContinuationError(
      "continuation_start_failed",
      "Continuation receipt workspace identity is outside the frozen schema.",
      { reason },
    );
  }
  return value as unknown as WorkspaceIdentity;
}

function decodeConsumerContract(value: unknown): SynthesizeFirstConsumerContract {
  if (!isRecord(value) || !exactKeys(value, CONSUMER_CONTRACT_KEYS)) {
    throw new ContinuationError(
      "handoff_integrity_failed",
      "The Handoff consumer contract is outside the synthesize-first v1 schema.",
      { reason: "handoff_consumer_contract_invalid" },
    );
  }
  if (
    value.formatVersion !== 1 ||
    value.kind !== "codex-handoff-synthesize-first-consumer-contract" ||
    value.mode !== "synthesize_first" ||
    !Array.isArray(value.firstDeliverableIds) ||
    value.firstDeliverableIds.length === 0 ||
    value.firstDeliverableIds.some((entry) => !validIdentifier(entry)) ||
    value.preDraftEvidenceReads !== 0 ||
    !Number.isSafeInteger(value.maxTargetedReads) ||
    (value.maxTargetedReads as number) < 0 ||
    (value.maxTargetedReads as number) > 3 ||
    !Array.isArray(value.allowedReadReasons) ||
    value.allowedReadReasons.some((entry) => (
      entry !== "claim_verification" && entry !== "named_uncertainty"
    )) ||
    value.forbidBroadSearch !== true ||
    value.forbidFullFileReread !== true
  ) {
    throw new ContinuationError(
      "handoff_integrity_failed",
      "The Handoff consumer contract does not preserve the synthesize-first limits.",
      { reason: "handoff_consumer_contract_invalid" },
    );
  }
  return value as unknown as SynthesizeFirstConsumerContract;
}

function legacyHandoffArtifactDigest(
  receipt: Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">,
): Sha256Digest {
  return sha256Json({
    compression_task_id: receipt.compression_task_id,
    consumer_contract: receipt.consumer_contract,
    evidence_index_digest: receipt.evidence_index_digest,
    evidence_index_path: receipt.evidence_index_path,
    frame_digest: receipt.frame_digest,
    handoff_digest: receipt.handoff_digest,
    markdown_path: receipt.markdown_path,
    source_revision: receipt.source_revision,
    source_thread_id: receipt.source_thread_id,
    verify_evidence: receipt.verify_evidence,
    workflow_version: receipt.workflow_version,
  });
}

function isHandoffReceiptV2(
  receipt: VerifiedHandoffReceipt,
): receipt is HandoffReceiptV2 {
  return "receipt_schema_version" in receipt && receipt.receipt_schema_version === 2;
}

function isHandoffResultReceipt(
  receipt: VerifiedHandoffReceipt,
): receipt is HandoffResultReceipt {
  return "receipt_schema_version" in receipt && receipt.receipt_schema_version === 3;
}

function resultConsumerContract(sliceId: string): SynthesizeFirstConsumerContract {
  return {
    formatVersion: 1,
    kind: "codex-handoff-synthesize-first-consumer-contract",
    mode: "synthesize_first",
    firstDeliverableIds: [sliceId],
    preDraftEvidenceReads: 0,
    maxTargetedReads: 3,
    allowedReadReasons: ["claim_verification", "named_uncertainty"],
    forbidBroadSearch: true,
    forbidFullFileReread: true,
  };
}

function consumerContractFor(
  receipt: VerifiedHandoffReceipt,
  sliceId: string,
): SynthesizeFirstConsumerContract {
  return isHandoffResultReceipt(receipt)
    ? resultConsumerContract(sliceId)
    : receipt.consumer_contract;
}

function diagnosticCode(error: unknown): string | undefined {
  const candidate = error instanceof BoundedCallError ? error.cause : error;
  return isRecord(candidate) && typeof candidate.code === "string"
    ? candidate.code
    : undefined;
}

function launcherFailureReason(code: string | undefined): ContinuationFailureReason | undefined {
  switch (code) {
    case "INVALID_CONTINUATION_REQUEST":
      return "invalid_request";
    case "CONTINUATION_TASK_START_FAILED":
      return "task_start_failed";
    case "READY_EVIDENCE_INVALID":
      return "consumer_contract_violated";
    case "WRITE_EPOCH_MISMATCH":
      return "write_epoch_mismatch";
    case "CONTINUATION_WRITE_TURN_START_FAILED":
      return "grant_call_failed";
    case "CONTINUATION_WRITE_TURN_FAILED":
      return "progress_call_failed";
    case "RECEIPT_REPLAY_MISMATCH":
      return "receipt_replay_mismatch";
    default:
      return undefined;
  }
}

export class ContinuationCoordinator {
  private readonly now: () => Date;
  private readonly operationTimeoutMs: number;
  private readonly inFlight = new Map<
    string,
    Promise<ContinuationDecision | ContinuationError>
  >();

  public constructor(private readonly options: ContinuationCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.operationTimeoutMs = options.operation_timeout_ms ??
      DEFAULT_CONTINUATION_OPERATION_TIMEOUT_MS;
  }

  public async continueFromHandoff(
    input: ContinueFromHandoffInput,
  ): Promise<ContinuationDecision | ContinuationError> {
    const argumentError = this.validateArguments(input);
    if (argumentError !== undefined) {
      return argumentError;
    }
    const inFlightKey = `${input.run_id}\u0000${String(input.expected_state_version)}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing !== undefined) {
      const shared = await existing;
      return shared instanceof ContinuationError
        ? shared
        : { ...shared, outcome: "ALREADY_CONTINUED" };
    }
    const pending = this.continueFromHandoffInner(input);
    this.inFlight.set(inFlightKey, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async continueFromHandoffInner(
    input: ContinueFromHandoffInput,
  ): Promise<ContinuationDecision | ContinuationError> {
    const loaded = this.options.run_store.load(input.run_id);
    if (loaded instanceof StateStoreError) {
      return this.fromStateError(loaded);
    }
    if (
      loaded.state.status === "SLICE_RUNNING" &&
      loaded.state.state_version === input.expected_state_version + 1 &&
      loaded.state.handoff?.continuation_task_id !== undefined
    ) {
      return this.replayTerminal(loaded, input);
    }
    if (loaded.state.state_version !== input.expected_state_version) {
      return new ContinuationError(
        "stale_state",
        `Expected state_version ${String(input.expected_state_version)}, found ${String(loaded.state.state_version)}.`,
      );
    }

    const state = loaded.state;
    const preparationError = this.validateRunState(state, input, false);
    if (preparationError !== undefined) {
      return this.closeFailure(state, input, preparationError);
    }
    const sliceContract = this.decodeSliceContract(input.slice_contract, state);
    if (sliceContract instanceof ContinuationError) {
      return this.closeFailure(state, input, sliceContract);
    }
    if (!this.isContinuationDecision(input.model_decision)) {
      return this.closeFailure(
        state,
        input,
        new ContinuationError(
          "model_policy_unavailable",
          "S10 requires the exact CONTINUATION decision gpt-5.6-sol/max.",
          { reason: "model_policy_invalid" },
        ),
      );
    }

    let handoff: VerifiedHandoffReceipt;
    try {
      handoff = await this.decodeAndVerifyHandoffReceipt(
        input.handoff_receipt,
        state,
        false,
      );
    } catch (error: unknown) {
      return this.closeFailure(state, input, this.asContinuationError(error));
    }

    const leaseError = this.assertLease(state, input.lease_id);
    if (leaseError !== undefined) {
      return this.closeFailure(state, input, leaseError);
    }

    const envelope = this.createEnvelope(
      state,
      sliceContract,
      handoff,
      input.lease_id,
      input.expected_state_version,
      input.expected_owned_diff_digest,
    );
    if (envelope instanceof ContinuationError) {
      return this.closeFailure(state, input, envelope);
    }
    const position: WorkflowPosition = { grant_may_have_occurred: false };
    let workflow: WorkflowReceipts;
    try {
      workflow = await this.performWorkflow(
        state,
        input,
        sliceContract,
        handoff,
        envelope,
        input.expected_state_version,
        position,
      );
    } catch (error: unknown) {
      return this.closeFailure(
        state,
        input,
        this.asContinuationError(error),
        position,
      );
    }

    const transitioned = this.options.run_store.compareAndSwap(
      state.run_id,
      input.expected_state_version,
      {
        action: "complete_continuation_start",
        to: "SLICE_RUNNING",
        updates: {
          source_thread_id: workflow.task_id,
          compaction: null,
          handoff: {
            ...(state.handoff as NonNullable<RunState["handoff"]>),
            continuation_task_id: workflow.task_id,
          },
          last_error: null,
        },
      },
    );
    if (transitioned instanceof StateStoreError) {
      if (
        transitioned.code === "stale_state" ||
        transitioned.code === "state_persist_failed"
      ) {
        const latest = this.options.run_store.load(state.run_id);
        if (
          !(latest instanceof StateStoreError) &&
          this.isTerminalSuccess(
            latest.state,
            input.expected_state_version,
            workflow.task_id,
          )
        ) {
          return this.decision(
            latest.state,
            input,
            envelope,
            workflow,
            "ALREADY_CONTINUED",
          );
        }
      }
      return this.closeFailure(
        state,
        input,
        this.fromStateError(transitioned),
        { ...position, grant_may_have_occurred: true },
      );
    }

    return this.decision(
      transitioned.state,
      input,
      envelope,
      workflow,
      "CONTINUED",
    );
  }

  private async replayTerminal(
    loaded: StoredRun,
    input: ContinueFromHandoffInput,
  ): Promise<ContinuationDecision | ContinuationError> {
    const stateError = this.validateRunState(loaded.state, input, true);
    if (stateError !== undefined) {
      return stateError;
    }
    const sliceContract = this.decodeSliceContract(input.slice_contract, loaded.state);
    if (sliceContract instanceof ContinuationError) {
      return sliceContract;
    }
    if (!this.isContinuationDecision(input.model_decision)) {
      return new ContinuationError(
        "model_policy_unavailable",
        "S10 terminal replay requires the exact CONTINUATION model decision.",
        { reason: "model_policy_invalid" },
      );
    }
    let handoff: VerifiedHandoffReceipt;
    try {
      handoff = await this.decodeAndVerifyHandoffReceipt(
        input.handoff_receipt,
        loaded.state,
        true,
      );
    } catch (error: unknown) {
      return this.asContinuationError(error);
    }
    const leaseError = this.assertLease(loaded.state, input.lease_id);
    if (leaseError !== undefined) {
      return leaseError;
    }
    const envelope = this.createEnvelope(
      loaded.state,
      sliceContract,
      handoff,
      input.lease_id,
      input.expected_state_version,
      input.expected_owned_diff_digest,
    );
    if (envelope instanceof ContinuationError) {
      return envelope;
    }
    const position: WorkflowPosition = { grant_may_have_occurred: false };
    try {
      const workflow = await this.performWorkflow(
        loaded.state,
        input,
        sliceContract,
        handoff,
        envelope,
        input.expected_state_version,
        position,
        loaded.state.handoff?.continuation_task_id,
      );
      return this.decision(
        loaded.state,
        input,
        envelope,
        workflow,
        "ALREADY_CONTINUED",
      );
    } catch (error: unknown) {
      return this.asContinuationError(error);
    }
  }

  private async performWorkflow(
    state: RunState,
    input: ContinueFromHandoffInput,
    sliceContract: SliceContractV1,
    handoff: VerifiedHandoffReceipt,
    envelope: ResumeEnvelope,
    effectStateVersion: number,
    position: WorkflowPosition,
    expectedTaskId?: string,
  ): Promise<WorkflowReceipts> {
    const startKey = createEffectIdempotencyKey(
      state.run_id,
      effectStateVersion,
      "start_continuation_task",
      handoff.artifact_digest,
    );
    const startPayloadDigest = sha256Json({
      envelope,
      model_decision: input.model_decision,
    });
    const startIntent = this.appendEffect(startKey, startPayloadDigest);
    const rawTaskId = await this.callBounded(
      "Continuation Task start",
      "task_start_timeout",
      "task_start_failed",
      () => this.options.launcher.start(envelope, input.model_decision),
    );
    const taskId = this.decodeTaskId(rawTaskId, state, handoff, expectedTaskId);
    position.task_id = taskId;

    const rawReady = await this.callBounded(
      "Continuation Task readiness",
      "ready_timeout",
      "ready_call_failed",
      () => this.options.launcher.awaitReady(taskId),
    );
    const ready = this.decodeReadyReceipt(
      rawReady,
      taskId,
      state,
      handoff,
      effectStateVersion,
    );
    this.completeEffect(
      startKey,
      startPayloadDigest,
      sha256Json({ task_id: taskId, ready_receipt: ready }),
      startIntent,
    );

    await this.decodeAndVerifyHandoffReceipt(handoff, state, state.status === "SLICE_RUNNING");
    const leaseBeforeGrant = this.assertLease(state, input.lease_id);
    if (leaseBeforeGrant !== undefined) {
      throw leaseBeforeGrant;
    }

    const grantKey = createEffectIdempotencyKey(
      state.run_id,
      effectStateVersion,
      "grant_continuation_write",
      taskId,
    );
    const grantPayloadDigest = sha256Json({
      handoff_artifact_digest: handoff.artifact_digest,
      lease_id: input.lease_id,
      task_id: taskId,
      write_epoch: state.write_epoch,
    });
    const grantIntent = this.appendEffect(grantKey, grantPayloadDigest);
    position.grant_may_have_occurred = true;
    const rawLease = await this.callBounded(
      "Continuation write grant",
      "grant_timeout",
      "grant_call_failed",
      () => this.options.launcher.grantWrite(taskId, state.write_epoch),
    );
    const lease = this.decodeLeaseReceipt(
      rawLease,
      taskId,
      input.lease_id,
      state,
    );
    this.completeEffect(
      grantKey,
      grantPayloadDigest,
      sha256Json(lease),
      grantIntent,
    );
    const leaseAfterGrant = this.assertLease(state, input.lease_id);
    if (leaseAfterGrant !== undefined) {
      throw leaseAfterGrant;
    }

    const progressKey = createEffectIdempotencyKey(
      state.run_id,
      effectStateVersion,
      "observe_continuation_progress",
      taskId,
    );
    const progressPayloadDigest = sha256Json({
      ...(input.expected_owned_diff_digest === undefined
        ? {}
        : { expected_owned_diff_digest: input.expected_owned_diff_digest }),
      slice_contract_digest: sha256Json(sliceContract),
      task_id: taskId,
    });
    const progressIntent = this.appendEffect(progressKey, progressPayloadDigest);
    const rawProgress = await this.callBounded(
      "Continuation durable progress",
      "progress_timeout",
      "progress_call_failed",
      () => this.options.launcher.awaitProgress(taskId),
    );
    const progress = this.decodeProgressReceipt(
      rawProgress,
      taskId,
      state,
      effectStateVersion,
    );
    this.completeEffect(
      progressKey,
      progressPayloadDigest,
      sha256Json(progress),
      progressIntent,
    );
    return { task_id: taskId, ready, lease, progress };
  }

  private validateArguments(
    input: ContinueFromHandoffInput,
  ): ContinuationError | undefined {
    const runtime: unknown = input;
    if (
      !isRecord(runtime) ||
      !validIdentifier(runtime.run_id) ||
      !validIdentifier(runtime.lease_id) ||
      !Number.isSafeInteger(runtime.expected_state_version) ||
      (runtime.expected_state_version as number) < 0 ||
      (runtime.expected_owned_diff_digest !== undefined &&
        !sha256Digest(runtime.expected_owned_diff_digest)) ||
      !isRecord(runtime.handoff_receipt) ||
      !isRecord(runtime.slice_contract) ||
      !isRecord(runtime.model_decision) ||
      !Number.isSafeInteger(this.operationTimeoutMs) ||
      this.operationTimeoutMs <= 0
    ) {
      return new ContinuationError(
        "continuation_start_failed",
        "S10 arguments require stable identities, frozen inputs, and a positive timeout.",
        { reason: "invalid_request" },
      );
    }
    return undefined;
  }

  private validateRunState(
    state: RunState,
    input: ContinueFromHandoffInput,
    terminal: boolean,
  ): ContinuationError | undefined {
    const expectedStatus = terminal ? "SLICE_RUNNING" : "CONTINUATION_STARTING";
    if (state.status !== expectedStatus) {
      return new ContinuationError(
        "invalid_transition",
        `Run ${state.run_id} is ${state.status}, not ${expectedStatus}.`,
        { reason: "run_not_continuation_starting" },
      );
    }
    if (state.source_thread_id === null) {
      return new ContinuationError(
        "continuation_start_failed",
        "Continuation startup has no Source Thread identity.",
        { reason: "source_thread_missing" },
      );
    }
    if (!terminal && state.compaction === undefined) {
      return new ContinuationError(
        "continuation_start_failed",
        "Continuation startup has no active compaction identity.",
        { reason: "active_compaction_missing" },
      );
    }
    if (terminal && state.compaction !== undefined) {
      return new ContinuationError(
        "state_corrupt",
        "A completed Continuation still exposes the consumed compaction gate.",
        { reason: "active_compaction_missing" },
      );
    }
    if (state.handoff === undefined) {
      return new ContinuationError(
        "continuation_start_failed",
        "Continuation startup has no verified Handoff identity.",
        { reason: "handoff_state_missing" },
      );
    }
    if (
      terminal
        ? state.handoff.continuation_task_id === undefined ||
          state.source_thread_id !== state.handoff.continuation_task_id
        : state.handoff.continuation_task_id !== undefined
    ) {
      return new ContinuationError(
        "state_corrupt",
        "Run Handoff continuation identity is inconsistent with its lifecycle status.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    if (state.current_slice_id === null) {
      return new ContinuationError(
        "continuation_start_failed",
        "Continuation startup has no current Slice identity.",
        { reason: "current_slice_missing" },
      );
    }
    if (
      state.project_lock_owner === null ||
      state.project_lock_owner !== input.lease_id
    ) {
      return new ContinuationError(
        "continuation_start_failed",
        "The supplied Project Write Lease does not own this Run.",
        { reason: "project_write_lease_missing" },
      );
    }
    if (!Number.isSafeInteger(state.write_epoch) || state.write_epoch < 1) {
      return new ContinuationError(
        "state_corrupt",
        "Run write_epoch is not a valid rotated capability.",
        { reason: "write_epoch_mismatch" },
      );
    }
    return undefined;
  }

  private decodeSliceContract(
    value: SliceContractV1,
    state: RunState,
  ): SliceContractV1 | ContinuationError {
    const parsed = parseSliceContractV1(value);
    if (parsed instanceof SliceExecutionError) {
      return new ContinuationError(
        "continuation_start_failed",
        `Current SliceContract is invalid: ${parsed.message}`,
        { reason: "slice_contract_invalid", cause: parsed },
      );
    }
    if (parsed.slice_id !== state.current_slice_id) {
      return new ContinuationError(
        "continuation_start_failed",
        `SliceContract ${parsed.slice_id} does not match current Slice ${String(state.current_slice_id)}.`,
        { reason: "slice_contract_invalid" },
      );
    }
    return parsed;
  }

  private async decodeAndVerifyHandoffReceipt(
    value: unknown,
    state: RunState,
    terminal: boolean,
  ): Promise<VerifiedHandoffReceipt> {
    if (!isRecord(value)) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Continuation received a Handoff receipt outside the frozen schema.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    if (exactKeys(value, HANDOFF_RESULT_RECEIPT_KEYS)) {
      return this.decodeHandoffResultReceipt(value, state, terminal);
    }
    if (exactKeys(value, HANDOFF_RECEIPT_V2_KEYS, ["retained_work_dir"])) {
      return this.decodeAndVerifyHandoffReceiptV2(value, state, terminal);
    }
    if (!exactKeys(value, LEGACY_HANDOFF_RECEIPT_KEYS, ["retained_work_dir"])) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Continuation Handoff receipt matches neither machine V2 nor legacy replay schema.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    const consumerContract = decodeConsumerContract(value.consumer_contract);
    if (
      value.workflow_version !== "v2" ||
      value.verify_evidence !== "PASS" ||
      !validTaskId(value.source_thread_id) ||
      !validTaskId(value.compression_task_id) ||
      value.source_thread_id === value.compression_task_id ||
      !validIdentifier(value.source_revision) ||
      !sha256Digest(value.frame_digest) ||
      !sha256Digest(value.handoff_digest) ||
      !sha256Digest(value.evidence_index_digest) ||
      !sha256Digest(value.artifact_digest) ||
      typeof value.markdown_path !== "string" ||
      typeof value.evidence_index_path !== "string" ||
      (value.retained_work_dir !== undefined &&
        typeof value.retained_work_dir !== "string")
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Legacy Handoff receipt does not prove a distinct verified task pair.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    if (
      state.handoff === undefined ||
      state.handoff.compression_task_id !== value.compression_task_id ||
      state.handoff.markdown_path !== value.markdown_path ||
      state.handoff.evidence_index_path !== value.evidence_index_path ||
      state.handoff.artifact_digest !== value.artifact_digest ||
      (!terminal && state.source_thread_id !== value.source_thread_id) ||
      (terminal && state.source_thread_id === value.source_thread_id)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Caller Handoff identity differs from the persisted Run Handoff binding.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    const material = {
      compression_task_id: value.compression_task_id,
      source_thread_id: value.source_thread_id,
      workflow_version: value.workflow_version,
      markdown_path: value.markdown_path,
      evidence_index_path: value.evidence_index_path,
      source_revision: value.source_revision,
      frame_digest: value.frame_digest,
      handoff_digest: value.handoff_digest,
      evidence_index_digest: value.evidence_index_digest,
      verify_evidence: value.verify_evidence,
      consumer_contract: consumerContract,
    } satisfies Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">;
    if (legacyHandoffArtifactDigest(material) !== value.artifact_digest) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Handoff receipt fields no longer match artifact_digest.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    await this.verifyPublishedArtifacts(material);
    return {
      ...material,
      artifact_digest: value.artifact_digest,
      ...(value.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: value.retained_work_dir }),
    };
  }

  private decodeHandoffResultReceipt(
    value: Readonly<Record<string, unknown>>,
    state: RunState,
    terminal: boolean,
  ): HandoffResultReceipt {
    if (
      value.receipt_schema_version !== 3 ||
      value.workflow_version !== 3 ||
      !validTaskId(value.source_thread_id) ||
      !validTaskId(value.compression_task_id) ||
      !validTaskId(value.compression_turn_id) ||
      value.source_thread_id === value.compression_task_id ||
      typeof value.markdown_path !== "string" ||
      !path.isAbsolute(value.markdown_path) ||
      !sha256Digest(value.artifact_digest)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Continuation final-result receipt is outside the path-only schema.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    if (
      state.handoff === undefined ||
      state.handoff.compression_task_id !== value.compression_task_id ||
      path.normalize(state.handoff.markdown_path) !== path.normalize(value.markdown_path) ||
      state.handoff.artifact_digest !== value.artifact_digest ||
      (!terminal && state.source_thread_id !== value.source_thread_id) ||
      (terminal && state.source_thread_id === value.source_thread_id)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Continuation final-result receipt differs from the persisted Run binding.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    const material = {
      receipt_schema_version: value.receipt_schema_version,
      compression_task_id: value.compression_task_id,
      compression_turn_id: value.compression_turn_id,
      source_thread_id: value.source_thread_id,
      workflow_version: value.workflow_version,
      markdown_path: path.normalize(value.markdown_path),
    } satisfies Omit<HandoffResultReceipt, "artifact_digest">;
    if (sha256Json(material) !== value.artifact_digest) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Continuation final-result receipt fields no longer match artifact_digest.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    return { ...material, artifact_digest: value.artifact_digest };
  }

  private async decodeAndVerifyHandoffReceiptV2(
    value: Readonly<Record<string, unknown>>,
    state: RunState,
    terminal: boolean,
  ): Promise<HandoffReceiptV2> {
    const consumerContract = decodeConsumerContract(value.consumer_contract);
    if (
      value.receipt_schema_version !== 2 ||
      value.workflow_version !== 2 ||
      value.verify_evidence !== "PASS" ||
      !validTaskId(value.source_thread_id) ||
      !validTaskId(value.compression_task_id) ||
      !validTaskId(value.compression_turn_id) ||
      value.source_thread_id === value.compression_task_id ||
      !sha256Digest(value.source_revision) ||
      !sha256Digest(value.structural_digest) ||
      !sha256Digest(value.handoff_digest) ||
      !sha256Digest(value.evidence_index_digest) ||
      !sha256Digest(value.verify_evidence_result_digest) ||
      !sha256Digest(value.artifact_digest) ||
      typeof value.markdown_path !== "string" ||
      typeof value.evidence_index_path !== "string" ||
      (value.retained_work_dir !== undefined && (
        typeof value.retained_work_dir !== "string" ||
        !path.isAbsolute(value.retained_work_dir)
      ))
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "HandoffReceiptV2 does not prove one machine-verified Compression task and Turn.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    if (
      state.handoff === undefined ||
      state.handoff.compression_task_id !== value.compression_task_id ||
      state.handoff.markdown_path !== value.markdown_path ||
      state.handoff.evidence_index_path !== value.evidence_index_path ||
      state.handoff.artifact_digest !== value.artifact_digest ||
      (!terminal && state.source_thread_id !== value.source_thread_id) ||
      (terminal && state.source_thread_id === value.source_thread_id)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "HandoffReceiptV2 identity differs from the persisted Run Handoff binding.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    const material = {
      receipt_schema_version: value.receipt_schema_version,
      compression_task_id: value.compression_task_id,
      compression_turn_id: value.compression_turn_id,
      source_thread_id: value.source_thread_id,
      workflow_version: value.workflow_version,
      markdown_path: value.markdown_path,
      evidence_index_path: value.evidence_index_path,
      source_revision: value.source_revision,
      structural_digest: value.structural_digest,
      handoff_digest: value.handoff_digest,
      evidence_index_digest: value.evidence_index_digest,
      verify_evidence: value.verify_evidence,
      verify_evidence_result_digest: value.verify_evidence_result_digest,
      consumer_contract: consumerContract,
      ...(value.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: value.retained_work_dir }),
    } satisfies Omit<HandoffReceiptV2, "artifact_digest">;
    if (sha256Json(material) !== value.artifact_digest) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "HandoffReceiptV2 fields no longer match artifact_digest.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    await this.verifyPublishedArtifacts(material);
    return { ...material, artifact_digest: value.artifact_digest };
  }

  private async verifyPublishedArtifacts(
    receipt: Readonly<{
      markdown_path: string;
      evidence_index_path: string;
      source_revision: string;
      handoff_digest: Sha256Digest;
      evidence_index_digest: Sha256Digest;
    }>,
  ): Promise<void> {
    if (
      !path.isAbsolute(receipt.markdown_path) ||
      !path.isAbsolute(receipt.evidence_index_path) ||
      path.resolve(receipt.markdown_path) === path.resolve(receipt.evidence_index_path)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Handoff and Evidence Index require distinct absolute paths.",
        { reason: "handoff_path_invalid" },
      );
    }
    let realMarkdown: string;
    let realEvidence: string;
    let markdown: Buffer;
    let evidence: Buffer;
    try {
      const [markdownBefore, evidenceBefore] = await Promise.all([
        lstat(receipt.markdown_path),
        lstat(receipt.evidence_index_path),
      ]);
      if (
        !markdownBefore.isFile() ||
        markdownBefore.isSymbolicLink() ||
        !evidenceBefore.isFile() ||
        evidenceBefore.isSymbolicLink() ||
        (markdownBefore.dev === evidenceBefore.dev &&
          markdownBefore.ino !== 0 &&
          markdownBefore.ino === evidenceBefore.ino)
      ) {
        throw new Error("Handoff pair is not two independent regular files");
      }
      [realMarkdown, realEvidence, markdown, evidence] = await Promise.all([
        realpath(receipt.markdown_path),
        realpath(receipt.evidence_index_path),
        readFile(receipt.markdown_path),
        readFile(receipt.evidence_index_path),
      ]);
    } catch (error: unknown) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "The verified Handoff pair is no longer fully readable.",
        { reason: "handoff_artifact_missing", cause: error },
      );
    }
    if (
      path.relative(path.resolve(receipt.markdown_path), realMarkdown) !== "" ||
      path.relative(path.resolve(receipt.evidence_index_path), realEvidence) !== ""
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Handoff artifacts changed their verified publication paths.",
        { reason: "handoff_path_invalid" },
      );
    }
    if (
      sha256Bytes(markdown) !== receipt.handoff_digest ||
      sha256Bytes(evidence) !== receipt.evidence_index_digest
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Published Handoff bytes changed before write grant.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    let markdownText: string;
    let evidenceText: string;
    try {
      markdownText = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
      evidenceText = new TextDecoder("utf-8", { fatal: true }).decode(evidence);
    } catch (error: unknown) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Published Handoff pair is not strict UTF-8.",
        { reason: "handoff_artifact_digest_mismatch", cause: error },
      );
    }
    if (!markdownText.includes("handoff-v2")) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Published Markdown is not a Handoff v2 artifact.",
        { reason: "handoff_binding_mismatch" },
      );
    }
    let index: unknown;
    try {
      index = JSON.parse(evidenceText) as unknown;
    } catch (error: unknown) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Published Evidence Index is not valid JSON.",
        { reason: "handoff_artifact_digest_mismatch", cause: error },
      );
    }
    if (
      !isRecord(index) ||
      !isRecord(index.source) ||
      index.source.sourceRevision !== receipt.source_revision ||
      !isRecord(index.integrity) ||
      typeof index.integrity.indexDigest !== "string" ||
      !RAW_SHA256_PATTERN.test(index.integrity.indexDigest)
    ) {
      throw new ContinuationError(
        "handoff_integrity_failed",
        "Evidence Index source revision or integrity binding is invalid.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
  }

  private createEnvelope(
    state: RunState,
    sliceContract: SliceContractV1,
    handoff: VerifiedHandoffReceipt,
    leaseId: string,
    observedStateVersion: number,
    legacyExpectedOwnedDiffDigest?: Sha256Digest,
  ): ResumeEnvelope | ContinuationError {
    const runtimeOverride = state.slice_commit_mode_overrides?.[sliceContract.slice_id];
    const commitMode = sliceContract.commit_mode_override ?? runtimeOverride ?? state.commit_mode;
    const goalPrompt = buildContinuationPrompt(
      sliceContract.slice_id,
      handoff.markdown_path,
      commitMode,
    );
    if (typeof goalPrompt !== "string") {
      return new ContinuationError(
        "continuation_start_failed",
        goalPrompt.message,
        { reason: "invalid_request", cause: goalPrompt },
      );
    }
    const consumerContract = consumerContractFor(
      handoff,
      state.current_slice_id as string,
    );
    return {
      run_id: state.run_id,
      current_slice_id: state.current_slice_id as string,
      goal_prompt: goalPrompt,
      source_thread_id: handoff.source_thread_id,
      compression_task_id: handoff.compression_task_id,
      ...(isHandoffReceiptV2(handoff) || isHandoffResultReceipt(handoff)
        ? {
          compression_turn_id: handoff.compression_turn_id,
          handoff_receipt_schema_version: handoff.receipt_schema_version,
        }
        : {}),
      handoff_markdown_path: handoff.markdown_path,
      ...("evidence_index_path" in handoff
        ? { evidence_index_path: handoff.evidence_index_path }
        : {}),
      handoff_artifact_digest: handoff.artifact_digest,
      ...("handoff_digest" in handoff
        ? { handoff_digest: handoff.handoff_digest }
        : {}),
      consumer_contract: consumerContract,
      expected_workspace_identity: state.workspace_identity,
      lease_id: leaseId,
      write_epoch: state.write_epoch,
      observed_state_version: observedStateVersion,
      commit_mode: commitMode,
      ...(legacyExpectedOwnedDiffDigest === undefined
        ? {}
        : { expected_owned_diff_digest: legacyExpectedOwnedDiffDigest }),
    };
  }

  private decodeTaskId(
    value: unknown,
    state: RunState,
    handoff: VerifiedHandoffReceipt,
    expectedTaskId?: string,
  ): string {
    if (!validTaskId(value)) {
      throw new ContinuationError(
        "continuation_start_failed",
        "ContinuationLauncher.start did not return a canonical task UUID.",
        { reason: "task_id_invalid" },
      );
    }
    if (
      value === handoff.source_thread_id ||
      value === handoff.compression_task_id ||
      value === state.source_thread_id && state.status !== "SLICE_RUNNING"
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Source, Compression, and Continuation Task UUIDs must be pairwise distinct.",
        { reason: "task_identity_conflict" },
      );
    }
    if (expectedTaskId !== undefined && value !== expectedTaskId) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Repeated Continuation launch returned a different task UUID.",
        { reason: "receipt_replay_mismatch" },
      );
    }
    return value;
  }

  private decodeReadyReceipt(
    value: unknown,
    taskId: string,
    state: RunState,
    handoff: VerifiedHandoffReceipt,
    observedStateVersion: number,
  ): ReadyReceipt {
    if (!isRecord(value) || !exactKeys(value, READY_RECEIPT_KEYS)) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation readiness receipt is outside the frozen schema.",
        { reason: "ready_receipt_invalid" },
      );
    }
    const consumerContract = consumerContractFor(
      handoff,
      state.current_slice_id as string,
    );
    const workspace = decodeWorkspaceIdentity(value.workspace_identity, "ready_workspace_mismatch");
    if (
      value.task_id !== taskId ||
      value.run_id !== state.run_id ||
      value.slice_id !== state.current_slice_id ||
      value.handoff_artifact_digest !== handoff.artifact_digest ||
      value.consumer_contract_digest !== sha256Json(consumerContract) ||
      value.observed_state_version !== observedStateVersion
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation readiness identities differ from the ResumeEnvelope.",
        { reason: "ready_identity_mismatch" },
      );
    }
    if (!identitiesEqual(workspace, state.workspace_identity)) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation readiness was observed in a different workspace.",
        { reason: "ready_workspace_mismatch" },
      );
    }
    if (
      value.handoff_read !== true ||
      value.write_access !== false ||
      !Array.isArray(value.first_deliverable_ids) ||
      canonicalJson(value.first_deliverable_ids) !==
        canonicalJson(consumerContract.firstDeliverableIds) ||
      !sha256Digest(value.first_deliverable_draft_digest) ||
      value.pre_draft_evidence_reads !== 0 ||
      !Number.isSafeInteger(value.targeted_evidence_reads) ||
      (value.targeted_evidence_reads as number) < 0 ||
      (value.targeted_evidence_reads as number) >
        consumerContract.maxTargetedReads ||
      !Array.isArray(value.targeted_read_reasons) ||
      value.targeted_read_reasons.length !== value.targeted_evidence_reads ||
      value.targeted_read_reasons.some((reason) =>
        !consumerContract.allowedReadReasons.includes(
          reason as "claim_verification" | "named_uncertainty",
        )
      ) ||
      value.broad_search_count !== 0 ||
      value.full_file_reread_count !== 0 ||
      !sha256Digest(value.rollout_digest) ||
      canonicalTimestamp(value.observed_at) === undefined
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation readiness does not prove synthesize-first consumer-contract compliance.",
        { reason: "consumer_contract_violated" },
      );
    }
    return value as unknown as ReadyReceipt;
  }

  private decodeLeaseReceipt(
    value: unknown,
    taskId: string,
    leaseId: string,
    state: RunState,
  ): LeaseReceipt {
    if (!isRecord(value) || !exactKeys(value, LEASE_RECEIPT_KEYS)) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation write grant returned a receipt outside the frozen schema.",
        { reason: "lease_receipt_invalid" },
      );
    }
    const workspace = decodeWorkspaceIdentity(value.workspace_identity, "lease_receipt_mismatch");
    if (
      value.task_id !== taskId ||
      value.lease_id !== leaseId ||
      value.write_epoch !== state.write_epoch ||
      value.granted !== true ||
      canonicalTimestamp(value.observed_at) === undefined ||
      !identitiesEqual(workspace, state.workspace_identity)
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Continuation write grant does not bind the current lease, epoch, task, and workspace.",
        { reason: "lease_receipt_mismatch" },
      );
    }
    return value as unknown as LeaseReceipt;
  }

  private decodeProgressReceipt(
    value: unknown,
    taskId: string,
    state: RunState,
    observedStateVersion: number,
  ): ProgressReceipt {
    const durableKeys = [...PROGRESS_RECEIPT_BASE_KEYS, "durable_artifact_digest"];
    const verificationKeys = [
      ...PROGRESS_RECEIPT_BASE_KEYS,
      "verification_receipt_digest",
    ];
    if (
      !isRecord(value) ||
      (!exactKeys(value, durableKeys) && !exactKeys(value, verificationKeys))
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "ProgressReceipt must contain exactly one durable progress digest.",
        { reason: "progress_receipt_invalid" },
      );
    }
    if (
      value.task_id !== taskId ||
      value.slice_id !== state.current_slice_id ||
      value.observed_state_version !== observedStateVersion
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "ProgressReceipt identities differ from the resumed Run and Slice.",
        { reason: "progress_identity_mismatch" },
      );
    }
    const durable = value.durable_artifact_digest;
    const verification = value.verification_receipt_digest;
    if (
      (durable !== undefined && !sha256Digest(durable)) ||
      (verification !== undefined && !sha256Digest(verification))
    ) {
      throw new ContinuationError(
        "continuation_start_failed",
        "ProgressReceipt does not contain a canonical durable or verification digest.",
        { reason: "progress_not_durable" },
      );
    }
    return value as unknown as ProgressReceipt;
  }

  private assertLease(
    state: RunState,
    leaseId: string,
  ): ContinuationError | undefined {
    const lease = this.options.workspace_guard.assertWritable(
      leaseId,
      state.write_epoch,
    );
    if (lease instanceof WorkspaceGuardError) {
      return new ContinuationError(
        "continuation_start_failed",
        `Rotated Project Write Lease is unavailable: ${lease.code}.`,
        { reason: "write_capability_unavailable", diagnostic_code: lease.code, cause: lease },
      );
    }
    if (
      lease.lease_id !== leaseId ||
      lease.run_id !== state.run_id ||
      lease.epoch !== state.write_epoch ||
      !identitiesEqual(lease.workspace_identity, state.workspace_identity)
    ) {
      return new ContinuationError(
        "continuation_start_failed",
        "Rotated Project Write Lease does not bind this Run, epoch, and workspace.",
        { reason: "write_epoch_mismatch" },
      );
    }
    return undefined;
  }

  private appendEffect(
    key: EffectIdempotencyKey,
    payloadDigest: Sha256Digest,
  ): EffectRecord {
    const result = this.options.run_store.appendEffectIntent(key, payloadDigest);
    if (result instanceof StateStoreError) {
      throw this.fromStateError(result);
    }
    return result;
  }

  private completeEffect(
    key: EffectIdempotencyKey,
    payloadDigest: Sha256Digest,
    receiptDigest: Sha256Digest,
    intent: EffectRecord,
  ): EffectRecord {
    if (intent.status === "COMPLETED") {
      if (
        intent.payload_digest !== payloadDigest ||
        intent.receipt_digest !== receiptDigest
      ) {
        throw new ContinuationError(
          "continuation_start_failed",
          "Repeated Continuation effect returned a different receipt.",
          { reason: "receipt_replay_mismatch" },
        );
      }
      return intent;
    }
    const completed = this.options.run_store.completeEffect(key, receiptDigest);
    if (completed instanceof StateStoreError) {
      throw this.fromStateError(completed);
    }
    if (completed.receipt_digest !== receiptDigest) {
      throw new ContinuationError(
        "continuation_start_failed",
        "Persisted Continuation effect receipt differs from the verified receipt.",
        { reason: "receipt_replay_mismatch" },
      );
    }
    return completed;
  }

  private closeFailure(
    originalState: RunState,
    input: ContinueFromHandoffInput,
    error: ContinuationError,
    position: WorkflowPosition = { grant_may_have_occurred: false },
  ): ContinuationError {
    const current = this.options.run_store.load(originalState.run_id);
    if (current instanceof StateStoreError) {
      return this.fromStateError(current);
    }
    if (
      current.state.status !== "CONTINUATION_STARTING" ||
      current.state.state_version !== input.expected_state_version
    ) {
      return error;
    }

    let freezeError: WorkspaceGuardError | undefined;
    if (position.grant_may_have_occurred) {
      const frozen = this.options.workspace_guard.freezeWrites(
        input.lease_id,
        current.state.write_epoch,
      );
      if (frozen instanceof WorkspaceGuardError) {
        freezeError = frozen;
      }
    }

    let occurredAt: string;
    try {
      occurredAt = this.now().toISOString();
    } catch (clockError: unknown) {
      return new ContinuationError(error.code, error.message, {
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        diagnostic_code: "clock_unavailable",
        cause: clockError,
      });
    }
    const transitioned = this.options.run_store.compareAndSwap(
      current.state.run_id,
      input.expected_state_version,
      {
        action: "close_continuation_start_failure",
        to: "NEEDS_USER",
        updates: {
          last_error: {
            code: error.code,
            message: error.message,
            occurred_at: occurredAt,
            last_successful_status: "CONTINUATION_STARTING",
            details: {
              reason: error.reason ?? "invalid_request",
              write_epoch: String(current.state.write_epoch),
              ...(current.state.source_thread_id === null
                ? {}
                : { source_thread_id: current.state.source_thread_id }),
              ...(current.state.handoff === undefined
                ? {}
                 : {
                   compression_task_id: current.state.handoff.compression_task_id,
                   handoff_markdown_path: current.state.handoff.markdown_path,
                   ...(current.state.handoff.evidence_index_path === undefined
                     ? {}
                     : { evidence_index_path: current.state.handoff.evidence_index_path }),
                 }),
              ...(position.task_id === undefined
                ? {}
                : { continuation_task_id: position.task_id }),
              ...(freezeError === undefined
                ? {}
                : { failure_freeze_error: freezeError.code }),
              ...(error.diagnostic_code === undefined
                ? {}
                : { diagnostic_code: error.diagnostic_code }),
            },
          },
        },
      },
    );
    if (transitioned instanceof StateStoreError) {
      const latest = this.options.run_store.load(current.state.run_id);
      if (
        !(latest instanceof StateStoreError) &&
        latest.state.status === "NEEDS_USER"
      ) {
        return error;
      }
      return this.fromStateError(transitioned);
    }
    if (freezeError !== undefined) {
      return new ContinuationError(error.code, error.message, {
        reason: "failure_freeze_failed",
        diagnostic_code: freezeError.code,
        cause: freezeError,
      });
    }
    return error;
  }

  private isTerminalSuccess(
    state: RunState,
    expectedStateVersion: number,
    taskId: string,
  ): boolean {
    return state.status === "SLICE_RUNNING" &&
      state.state_version === expectedStateVersion + 1 &&
      state.source_thread_id === taskId &&
      state.handoff?.continuation_task_id === taskId &&
      state.compaction === undefined;
  }

  private decision(
    state: RunState,
    input: ContinueFromHandoffInput,
    envelope: ResumeEnvelope,
    workflow: WorkflowReceipts,
    outcome: ContinuationDecision["outcome"],
  ): ContinuationDecision {
    if (
      state.status !== "SLICE_RUNNING" ||
      state.source_thread_id !== workflow.task_id ||
      state.current_slice_id === null
    ) {
      throw new ContinuationError(
        "state_corrupt",
        "Continuation decision requires SLICE_RUNNING with the new Source identity.",
      );
    }
    return {
      outcome,
      run_id: state.run_id,
      old_source_thread_id: input.handoff_receipt.source_thread_id,
      continuation_task_id: workflow.task_id,
      current_slice_id: state.current_slice_id,
      state_version: state.state_version,
      status: "SLICE_RUNNING",
      write_epoch: state.write_epoch,
      envelope,
      ready_receipt: workflow.ready,
      lease_receipt: workflow.lease,
      progress_receipt: workflow.progress,
    };
  }

  private async callBounded<T>(
    label: string,
    timeoutReason: ContinuationFailureReason,
    callReason: ContinuationFailureReason,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.bounded(label, operation);
    } catch (error: unknown) {
      const bounded = error instanceof BoundedCallError ? error : undefined;
      const code = diagnosticCode(error);
      if (code === "HANDOFF_INTEGRITY_FAILED") {
        throw new ContinuationError(
          "handoff_integrity_failed",
          "Continuation launcher rejected changed Handoff bytes before task input.",
          {
            reason: "handoff_artifact_digest_mismatch",
            diagnostic_code: code,
            cause: bounded?.cause,
          },
        );
      }
      throw new ContinuationError(
        "continuation_start_failed",
        `${label} ${bounded?.reason === "timeout" ? "timed out" : "failed"}.`,
        {
          reason: bounded?.reason === "timeout"
            ? timeoutReason
            : launcherFailureReason(code) ?? callReason,
          ...(code === undefined
            ? {}
            : { diagnostic_code: code }),
          cause: error,
        },
      );
    }
  }

  private async bounded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new BoundedCallError("timeout", `${label} timed out.`));
        }, this.operationTimeoutMs);
      });
      const operationPromise = Promise.resolve().then(operation).catch((error: unknown) => {
        throw new BoundedCallError("call_failed", `${label} failed.`, { cause: error });
      });
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private isContinuationDecision(value: unknown): boolean {
    return isRecord(value) &&
      value.mode === "model" &&
      value.model === "gpt-5.6-sol" &&
      value.effort === "max";
  }

  private asContinuationError(error: unknown): ContinuationError {
    if (error instanceof ContinuationError) {
      return error;
    }
    if (error instanceof StateStoreError) {
      return this.fromStateError(error);
    }
    return new ContinuationError(
      "continuation_start_failed",
      error instanceof Error ? error.message : String(error),
      { reason: "task_start_failed", cause: error },
    );
  }

  private fromStateError(error: StateStoreError): ContinuationError {
    const code = STATE_ERROR_CODES.has(error.code as ContinuationFailureCode)
      ? error.code as ContinuationFailureCode
      : "state_persist_failed";
    return new ContinuationError(code, error.message, { cause: error });
  }
}
