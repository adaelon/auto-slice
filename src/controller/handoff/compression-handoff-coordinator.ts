import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ModelDecision } from "../model-policy/index.js";
import {
  canonicalJson,
  createEffectIdempotencyKey,
  sha256Bytes,
  sha256Json,
  StateStoreError,
  type EffectRecord,
  type RunState,
  type Sha256Digest,
  type StoredRun,
} from "../state/index.js";
import type { InterruptReceipt } from "../thread-control/index.js";

import { CompressionHandoffError } from "./errors.js";
import {
  DEFAULT_HANDOFF_EXPORT_TIMEOUT_MS,
  HANDOFF_WORKFLOW_VERSION,
  type CompressionHandoffCoordinatorOptions,
  type CompressionHandoffDecision,
  type CompressionHandoffFailureCode,
  type CompressionHandoffFailureReason,
  type CompressionRequest,
  type CompressionTaskLaunchReceipt,
  type HandoffReceipt,
  type SynthesizeFirstConsumerContract,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const LAUNCH_RECEIPT_KEYS = [
  "compression_task_id",
  "source_thread_id",
  "workspace_identity",
  "history_empty",
  "project_write_lease",
  "model",
  "reasoning_effort",
  "created_at",
] as const;

const HANDOFF_RECEIPT_KEYS = [
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

const STATE_ERROR_CODES = new Set<CompressionHandoffFailureCode>([
  "run_not_found",
  "invalid_transition",
  "stale_state",
  "state_persist_failed",
  "state_corrupt",
  "unsupported_state_schema",
]);

const INTEGRITY_REASONS = new Set<CompressionHandoffFailureReason>([
  "handoff_receipt_invalid",
  "handoff_workflow_version_mismatch",
  "handoff_source_mismatch",
  "handoff_source_revision_mismatch",
  "handoff_path_invalid",
  "handoff_artifact_missing",
  "handoff_artifact_digest_mismatch",
  "handoff_verify_failed",
  "receipt_replay_mismatch",
]);

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
  const expected = [...required, ...optional].sort();
  const actual = Object.keys(value).sort();
  return actual.every((key) => expected.includes(key)) &&
    required.every((key) => actual.includes(key));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256;
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

function decodeConsumerContract(value: unknown): SynthesizeFirstConsumerContract {
  if (!isRecord(value) || !exactKeys(value, CONSUMER_CONTRACT_KEYS)) {
    throw new CompressionHandoffError(
      "handoff_integrity_failed",
      "The Handoff consumer contract is outside the synthesize-first v1 schema.",
      { reason: "handoff_receipt_invalid" },
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
    throw new CompressionHandoffError(
      "handoff_integrity_failed",
      "The Handoff consumer contract does not preserve the frozen synthesize-first limits.",
      { reason: "handoff_receipt_invalid" },
    );
  }
  return value as unknown as SynthesizeFirstConsumerContract;
}

function artifactDigest(receipt: Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">): Sha256Digest {
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

function diagnostic(error: unknown): {
  readonly code?: string;
  readonly retained_work_dir?: string;
} {
  const candidate = error instanceof BoundedCallError ? error.cause : error;
  if (!isRecord(candidate)) {
    return {};
  }
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const retained = typeof candidate.retained_work_dir === "string"
    ? candidate.retained_work_dir
    : typeof candidate.workDir === "string"
      ? candidate.workDir
      : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    ...(retained === undefined ? {} : { retained_work_dir: retained }),
  };
}

function reasonForDiagnostic(
  code: string | undefined,
  fallback: CompressionHandoffFailureReason,
): CompressionHandoffFailureReason {
  if (code === "MAP_WORKER_UNAVAILABLE" || code === "NO_WORKER_CAPACITY") {
    return "worker_unavailable";
  }
  if (
    code === "LIVE_BUDGET_UNREACHABLE" ||
    code === "OUTPUT_TOO_LARGE" ||
    code === "EVIDENCE_INDEX_TOO_LARGE" ||
    code === "TOKEN_BUDGET_EXHAUSTED"
  ) {
    return "skill_budget_failed";
  }
  if (code === "SOURCE_CHANGED" || code === "SOURCE_REVISION_MISMATCH") {
    return "source_revision_mismatch";
  }
  return fallback;
}

export class CompressionHandoffCoordinator {
  private readonly now: () => Date;
  private readonly exportTimeoutMs: number;
  private readonly inFlight = new Map<
    string,
    Promise<CompressionHandoffDecision | CompressionHandoffError>
  >();

  public constructor(private readonly options: CompressionHandoffCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.exportTimeoutMs = options.export_timeout_ms ?? DEFAULT_HANDOFF_EXPORT_TIMEOUT_MS;
  }

  public async exportHandoff(
    runId: string,
    interruptReceipt: InterruptReceipt,
    modelDecision: ModelDecision,
    expectedStateVersion: number,
  ): Promise<CompressionHandoffDecision | CompressionHandoffError> {
    const inputError = this.validateArguments(
      runId,
      interruptReceipt,
      expectedStateVersion,
    );
    if (inputError !== undefined) {
      return inputError;
    }
    const inFlightKey = `${runId}\u0000${String(expectedStateVersion)}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing !== undefined) {
      const shared = await existing;
      return shared instanceof CompressionHandoffError
        ? shared
        : { ...shared, outcome: "ALREADY_EXPORTED" };
    }
    const pending = this.exportHandoffInner(
      runId,
      interruptReceipt,
      modelDecision,
      expectedStateVersion,
    );
    this.inFlight.set(inFlightKey, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async exportHandoffInner(
    runId: string,
    interruptReceipt: InterruptReceipt,
    modelDecision: ModelDecision,
    expectedStateVersion: number,
  ): Promise<CompressionHandoffDecision | CompressionHandoffError> {
    const loaded = this.options.run_store.load(runId);
    if (loaded instanceof StateStoreError) {
      return this.fromStateError(loaded);
    }
    if (
      loaded.state.status === "CONTINUATION_STARTING" &&
      loaded.state.state_version === expectedStateVersion + 2
    ) {
      return this.replayTerminal(loaded, interruptReceipt, expectedStateVersion);
    }
    if (
      loaded.state.state_version !== expectedStateVersion &&
      !this.isClaimedState(loaded.state, expectedStateVersion)
    ) {
      return new CompressionHandoffError(
        "stale_state",
        `Expected state_version ${String(expectedStateVersion)}, found ${String(loaded.state.state_version)}.`,
      );
    }
    const preparationError = this.validateRunInputs(
      loaded.state,
      interruptReceipt,
      expectedStateVersion,
    );
    if (preparationError !== undefined) {
      return preparationError;
    }
    if (!this.isCompressionDecision(modelDecision)) {
      return this.closeFailure(
        loaded.state,
        "model_policy_invalid",
        "S09 requires the exact COMPRESSION decision gpt-5.6-sol/medium.",
        { failure_code: "model_policy_unavailable" },
      );
    }

    const claimed = this.isClaimedState(loaded.state, expectedStateVersion)
      ? loaded
      : this.claimAttempt(loaded);
    if (claimed instanceof CompressionHandoffError) {
      return claimed;
    }

    const state = claimed.state;
    const request = this.createRequest(state, interruptReceipt);
    const effectKey = createEffectIdempotencyKey(
      runId,
      state.state_version,
      "export_handoff",
      state.compaction?.compaction_id as string,
    );
    const boundRequest: CompressionRequest = {
      ...request,
      idempotency_key: effectKey.digest,
    };
    const payloadDigest = sha256Json(boundRequest);
    const intent = this.options.run_store.appendEffectIntent(effectKey, payloadDigest);
    if (intent instanceof StateStoreError) {
      return this.fromStateError(intent);
    }

    const launched = await this.launch(boundRequest, state);
    if (launched instanceof CompressionHandoffError) {
      return launched;
    }
    const received = await this.receiveHandoff(
      launched,
      boundRequest,
      state,
      effectKey.digest,
    );
    if (received instanceof CompressionHandoffError) {
      return received;
    }
    const receiptDigest = sha256Json(received);
    const completed = this.completeOrReconcileEffect(
      effectKey,
      payloadDigest,
      receiptDigest,
      intent,
    );
    if (completed instanceof CompressionHandoffError) {
      return this.closeFailure(
        state,
        completed.reason ?? "receipt_replay_mismatch",
        completed.message,
        {
          compression_task_id: launched.compression_task_id,
          ...(completed.diagnostic_code === undefined
            ? {}
            : { diagnostic_code: completed.diagnostic_code }),
          ...(received.retained_work_dir === undefined
            ? {}
            : { retained_work_dir: received.retained_work_dir }),
        },
      );
    }

    const transitioned = this.options.run_store.compareAndSwap(
      runId,
      state.state_version,
      {
        action: "complete_handoff_export",
        to: "CONTINUATION_STARTING",
        updates: {
          handoff: {
            compression_task_id: received.compression_task_id,
            markdown_path: received.markdown_path,
            evidence_index_path: received.evidence_index_path,
            artifact_digest: received.artifact_digest,
          },
          last_error: null,
        },
      },
    );
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state" || transitioned.code === "state_persist_failed") {
        const latest = this.options.run_store.load(runId);
        if (
          !(latest instanceof StateStoreError) &&
          this.isTerminalSuccess(latest.state, expectedStateVersion, received)
        ) {
          return this.decision(
            latest.state,
            "ALREADY_EXPORTED",
            effectKey.digest,
            received,
          );
        }
      }
      return this.fromStateError(transitioned);
    }
    return this.decision(
      transitioned.state,
      "EXPORTED",
      effectKey.digest,
      received,
    );
  }

  private claimAttempt(loaded: StoredRun): StoredRun | CompressionHandoffError {
    const compaction = loaded.state.compaction;
    if (compaction === undefined) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "HANDOFF_EXPORTING has no active compaction identity.",
        { reason: "active_compaction_missing" },
      );
    }
    const claimed = this.options.run_store.compareAndSwap(
      loaded.state.run_id,
      loaded.state.state_version,
      {
        action: "mark_handoff_attempted",
        to: "HANDOFF_EXPORTING",
        updates: {
          compaction: {
            ...compaction,
            handoff_attempted: true,
          },
        },
      },
    );
    if (!(claimed instanceof StateStoreError)) {
      return claimed;
    }
    if (claimed.code === "stale_state") {
      const latest = this.options.run_store.load(loaded.state.run_id);
      if (
        !(latest instanceof StateStoreError) &&
        this.isClaimedState(latest.state, loaded.state.state_version)
      ) {
        return latest;
      }
    }
    return this.fromStateError(claimed);
  }

  private async launch(
    request: CompressionRequest,
    state: RunState,
  ): Promise<CompressionTaskLaunchReceipt | CompressionHandoffError> {
    let raw: unknown;
    try {
      raw = await this.bounded(
        "Compression Task creation",
        () => this.options.launcher.start(request),
      );
    } catch (error: unknown) {
      const observed = diagnostic(error);
      const reason = error instanceof BoundedCallError && error.reason === "timeout"
        ? "task_start_timeout"
        : reasonForDiagnostic(observed.code, "task_start_failed");
      return this.closeFailure(
        state,
        reason,
        "The fresh Compression Task could not be created.",
        {
          ...(observed.code === undefined
            ? {}
            : { diagnostic_code: observed.code }),
          ...(observed.retained_work_dir === undefined
            ? {}
            : { retained_work_dir: observed.retained_work_dir }),
        },
      );
    }
    try {
      return this.decodeLaunchReceipt(raw, request);
    } catch (error: unknown) {
      const normalized = this.asCompressionError(
        error,
        "handoff_export_failed",
        "task_launch_receipt_invalid",
      );
      return this.closeFailure(state, normalized.reason as CompressionHandoffFailureReason, normalized.message);
    }
  }

  private async receiveHandoff(
    launch: CompressionTaskLaunchReceipt,
    request: CompressionRequest,
    state: RunState,
    idempotencyKey: Sha256Digest,
  ): Promise<HandoffReceipt | CompressionHandoffError> {
    let raw: unknown;
    try {
      raw = await this.bounded(
        "Compression Task Handoff export",
        () => this.options.launcher.awaitHandoff(
          launch.compression_task_id,
          idempotencyKey,
        ),
      );
    } catch (error: unknown) {
      const observed = diagnostic(error);
      const reason = error instanceof BoundedCallError && error.reason === "timeout"
        ? "export_timeout"
        : reasonForDiagnostic(observed.code, "export_call_failed");
      return this.closeFailure(
        state,
        reason,
        "The Compression Task did not produce a verified Handoff.",
        {
          compression_task_id: launch.compression_task_id,
          ...(observed.code === undefined
            ? {}
            : { diagnostic_code: observed.code }),
          ...(observed.retained_work_dir === undefined
            ? {}
            : { retained_work_dir: observed.retained_work_dir }),
        },
      );
    }
    try {
      return await this.decodeAndVerifyHandoffReceipt(raw, launch, request);
    } catch (error: unknown) {
      const normalized = this.asCompressionError(
        error,
        "handoff_integrity_failed",
        "handoff_receipt_invalid",
      );
      return this.closeFailure(
        state,
        normalized.reason as CompressionHandoffFailureReason,
        normalized.message,
        {
          compression_task_id: launch.compression_task_id,
          ...(normalized.diagnostic_code === undefined
            ? {}
            : { diagnostic_code: normalized.diagnostic_code }),
          ...(normalized.retained_work_dir === undefined
            ? {}
            : { retained_work_dir: normalized.retained_work_dir }),
          failure_code: normalized.code,
        },
      );
    }
  }

  private decodeLaunchReceipt(
    value: unknown,
    request: CompressionRequest,
  ): CompressionTaskLaunchReceipt {
    if (!isRecord(value) || !exactKeys(value, LAUNCH_RECEIPT_KEYS)) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "CompressionLauncher returned a launch receipt outside the frozen schema.",
        { reason: "task_launch_receipt_invalid" },
      );
    }
    if (!validIdentifier(value.compression_task_id)) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task identity is missing or unstable.",
        { reason: "task_launch_receipt_invalid" },
      );
    }
    if (
      value.compression_task_id === request.source_thread_id ||
      value.source_thread_id !== request.source_thread_id
    ) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression and Source task identities are not isolated.",
        { reason: "task_identity_conflict" },
      );
    }
    if (canonicalJson(value.workspace_identity) !== canonicalJson(request.workspace_identity)) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task workspace identity differs from the Source workspace.",
        { reason: "task_workspace_mismatch" },
      );
    }
    if (value.history_empty !== true) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task did not prove an empty history.",
        { reason: "task_history_not_empty" },
      );
    }
    if (value.project_write_lease !== false) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task must never hold a Project Write Lease.",
        { reason: "task_write_lease_present" },
      );
    }
    if (
      value.model !== request.model ||
      value.reasoning_effort !== request.reasoning_effort
    ) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task did not use the exact frozen model policy.",
        { reason: "task_model_mismatch" },
      );
    }
    if (canonicalTimestamp(value.created_at) === undefined) {
      throw new CompressionHandoffError(
        "handoff_export_failed",
        "Compression Task launch time is not a canonical timestamp.",
        { reason: "task_launch_receipt_invalid" },
      );
    }
    return value as unknown as CompressionTaskLaunchReceipt;
  }

  private async decodeAndVerifyHandoffReceipt(
    value: unknown,
    launch: CompressionTaskLaunchReceipt,
    request: CompressionRequest,
  ): Promise<HandoffReceipt> {
    if (!isRecord(value) || !exactKeys(value, HANDOFF_RECEIPT_KEYS, ["retained_work_dir"])) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Compression Task returned a Handoff receipt outside the frozen schema.",
        { reason: "handoff_receipt_invalid" },
      );
    }
    if (value.workflow_version !== HANDOFF_WORKFLOW_VERSION) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Only Handoff workflow v2 can unlock a Continuation Task.",
        { reason: "handoff_workflow_version_mismatch" },
      );
    }
    if (
      value.compression_task_id !== launch.compression_task_id ||
      value.source_thread_id !== request.source_thread_id
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Handoff receipt identities differ from the launched task pair.",
        { reason: "handoff_source_mismatch" },
      );
    }
    if (value.source_revision !== request.source_persisted_revision) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "The exported Source revision differs from the InterruptReceipt.",
        { reason: "handoff_source_revision_mismatch" },
      );
    }
    if (
      !sha256Digest(value.frame_digest) ||
      !sha256Digest(value.handoff_digest) ||
      !sha256Digest(value.evidence_index_digest) ||
      !sha256Digest(value.artifact_digest)
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Handoff receipt digests are missing or non-canonical.",
        { reason: "handoff_receipt_invalid" },
      );
    }
    if (value.verify_evidence !== "PASS") {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "The Compression Task did not prove verify-evidence PASS.",
        { reason: "handoff_verify_failed" },
      );
    }
    if (
      typeof value.markdown_path !== "string" ||
      typeof value.evidence_index_path !== "string" ||
      (value.retained_work_dir !== undefined && typeof value.retained_work_dir !== "string")
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Handoff publication paths are invalid.",
        { reason: "handoff_path_invalid" },
      );
    }
    const consumerContract = decodeConsumerContract(value.consumer_contract);
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
    if (artifactDigest(material) !== value.artifact_digest) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Handoff receipt fields do not match artifact_digest.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    await this.verifyPublishedArtifacts(material, request.workspace_identity.canonical_root);
    return {
      ...material,
      artifact_digest: value.artifact_digest,
      ...(value.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: value.retained_work_dir }),
    };
  }

  private async verifyPublishedArtifacts(
    receipt: Omit<HandoffReceipt, "artifact_digest" | "retained_work_dir">,
    workspaceRoot: string,
  ): Promise<void> {
    if (
      !path.isAbsolute(receipt.markdown_path) ||
      !path.isAbsolute(receipt.evidence_index_path) ||
      path.resolve(receipt.markdown_path) === path.resolve(receipt.evidence_index_path)
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Handoff and Evidence Index require distinct absolute publication paths.",
        { reason: "handoff_path_invalid" },
      );
    }
    let realWorkspace: string;
    let realMarkdown: string;
    let realEvidence: string;
    let markdown: Buffer;
    let evidence: Buffer;
    try {
      [realWorkspace, realMarkdown, realEvidence, markdown, evidence] = await Promise.all([
        realpath(workspaceRoot),
        realpath(receipt.markdown_path),
        realpath(receipt.evidence_index_path),
        readFile(receipt.markdown_path),
        readFile(receipt.evidence_index_path),
      ]);
    } catch (error: unknown) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "The atomically published Handoff pair is not fully readable.",
        { reason: "handoff_artifact_missing", cause: error },
      );
    }
    if (
      !this.isWithin(realWorkspace, realMarkdown) ||
      !this.isWithin(realWorkspace, realEvidence)
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Published Handoff artifacts escaped the Source workspace.",
        { reason: "handoff_path_invalid" },
      );
    }
    if (
      sha256Bytes(markdown) !== receipt.handoff_digest ||
      sha256Bytes(evidence) !== receipt.evidence_index_digest
    ) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Published Handoff bytes differ from the Compression Task receipt.",
        { reason: "handoff_artifact_digest_mismatch" },
      );
    }
    const markdownText = markdown.toString("utf8");
    if (!markdownText.includes("handoff-v2")) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Published Markdown is not the isolated Handoff v2 renderer output.",
        { reason: "handoff_workflow_version_mismatch" },
      );
    }
    let index: unknown;
    try {
      index = JSON.parse(evidence.toString("utf8")) as unknown;
    } catch (error: unknown) {
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Published Evidence Index is not valid JSON.",
        { reason: "handoff_verify_failed", cause: error },
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
      throw new CompressionHandoffError(
        "handoff_integrity_failed",
        "Evidence Index source revision or integrity binding is invalid.",
        { reason: "handoff_verify_failed" },
      );
    }
  }

  private async replayTerminal(
    loaded: StoredRun,
    interruptReceipt: InterruptReceipt,
    expectedStateVersion: number,
  ): Promise<CompressionHandoffDecision | CompressionHandoffError> {
    const state = loaded.state;
    const validation = this.validateRunInputs(
      state,
      interruptReceipt,
      expectedStateVersion,
      true,
    );
    if (validation !== undefined) {
      return validation;
    }
    if (state.handoff === undefined || state.compaction === undefined) {
      return new CompressionHandoffError(
        "state_corrupt",
        "CONTINUATION_STARTING has no persisted Handoff identity.",
      );
    }
    const effectKey = createEffectIdempotencyKey(
      state.run_id,
      expectedStateVersion + 1,
      "export_handoff",
      state.compaction.compaction_id,
    );
    const request = {
      ...this.createRequest(state, interruptReceipt),
      idempotency_key: effectKey.digest,
    } satisfies CompressionRequest;
    const effect = this.options.run_store.appendEffectIntent(
      effectKey,
      sha256Json(request),
    );
    if (effect instanceof StateStoreError) {
      return this.fromStateError(effect);
    }
    if (effect.status !== "COMPLETED" || effect.receipt_digest === undefined) {
      return new CompressionHandoffError(
        "state_corrupt",
        "CONTINUATION_STARTING has no completed Handoff export effect receipt.",
      );
    }
    let raw: unknown;
    try {
      raw = await this.bounded(
        "Completed Compression Task Handoff replay",
        () => this.options.launcher.awaitHandoff(
          state.handoff?.compression_task_id as string,
          effectKey.digest,
        ),
      );
      const syntheticLaunch: CompressionTaskLaunchReceipt = {
        compression_task_id: state.handoff.compression_task_id,
        source_thread_id: state.source_thread_id as string,
        workspace_identity: state.workspace_identity,
        history_empty: true,
        project_write_lease: false,
        model: "gpt-5.6-sol",
        reasoning_effort: "medium",
        created_at: interruptReceipt.observed_at,
      };
      const receipt = await this.decodeAndVerifyHandoffReceipt(
        raw,
        syntheticLaunch,
        request,
      );
      if (
        sha256Json(receipt) !== effect.receipt_digest ||
        receipt.artifact_digest !== state.handoff.artifact_digest
      ) {
        return new CompressionHandoffError(
          "handoff_integrity_failed",
          "Repeated Handoff receipt differs from the persisted terminal receipt.",
          { reason: "receipt_replay_mismatch" },
        );
      }
      return this.decision(
        state,
        "ALREADY_EXPORTED",
        effectKey.digest,
        receipt,
      );
    } catch (error: unknown) {
      return this.asCompressionError(
        error,
        "handoff_integrity_failed",
        "receipt_replay_mismatch",
      );
    }
  }

  private validateArguments(
    runId: string,
    receipt: InterruptReceipt,
    expectedStateVersion: number,
  ): CompressionHandoffError | undefined {
    const runtimeReceipt: unknown = receipt;
    if (
      !validIdentifier(runId) ||
      !Number.isSafeInteger(expectedStateVersion) ||
      expectedStateVersion < 0 ||
      !Number.isSafeInteger(this.exportTimeoutMs) ||
      this.exportTimeoutMs <= 0 ||
      !isRecord(runtimeReceipt) ||
      !validIdentifier(runtimeReceipt.thread_id) ||
      runtimeReceipt.execution_stopped !== true ||
      runtimeReceipt.thread_persisted !== true ||
      !validIdentifier(runtimeReceipt.persisted_revision) ||
      canonicalTimestamp(runtimeReceipt.observed_at) === undefined
    ) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "S09 arguments require stable identities, a trusted InterruptReceipt, and a positive timeout.",
        { reason: "invalid_request" },
      );
    }
    return undefined;
  }

  private validateRunInputs(
    state: RunState,
    receipt: InterruptReceipt,
    expectedStateVersion: number,
    terminal = false,
  ): CompressionHandoffError | undefined {
    const expectedStatus = terminal ? "CONTINUATION_STARTING" : "HANDOFF_EXPORTING";
    if (state.status !== expectedStatus) {
      return new CompressionHandoffError(
        "invalid_transition",
        `Run ${state.run_id} is ${state.status}, not ${expectedStatus}.`,
        { reason: "run_not_handoff_exporting" },
      );
    }
    if (state.source_thread_id === null) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "Handoff export has no Source Thread identity.",
        { reason: "source_thread_missing" },
      );
    }
    if (state.source_thread_id !== receipt.thread_id) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "InterruptReceipt does not identify the current Source Thread.",
        { reason: "source_thread_mismatch" },
      );
    }
    if (state.compaction === undefined) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "Handoff export has no active compaction identity.",
        { reason: "active_compaction_missing" },
      );
    }
    if (
      !terminal &&
      state.state_version === expectedStateVersion &&
      state.compaction.handoff_attempted
    ) {
      return new CompressionHandoffError(
        "handoff_export_failed",
        "The active compaction_id was already attempted and requires explicit recovery.",
        { reason: "handoff_already_attempted" },
      );
    }
    return undefined;
  }

  private createRequest(
    state: RunState,
    receipt: InterruptReceipt,
  ): Omit<CompressionRequest, "idempotency_key"> {
    return {
      source_thread_id: state.source_thread_id as string,
      source_persisted_revision: receipt.persisted_revision,
      workspace_identity: state.workspace_identity,
      compaction_id: state.compaction?.compaction_id as string,
      model: "gpt-5.6-sol",
      reasoning_effort: "medium",
    };
  }

  private isCompressionDecision(value: unknown): boolean {
    return isRecord(value) &&
      value.mode === "model" &&
      value.model === "gpt-5.6-sol" &&
      value.effort === "medium";
  }

  private isClaimedState(state: RunState, expectedStateVersion: number): boolean {
    return state.status === "HANDOFF_EXPORTING" &&
      state.state_version === expectedStateVersion + 1 &&
      state.compaction?.handoff_attempted === true;
  }

  private completeOrReconcileEffect(
    key: ReturnType<typeof createEffectIdempotencyKey>,
    payloadDigest: Sha256Digest,
    receiptDigest: Sha256Digest,
    intent: EffectRecord,
  ): EffectRecord | CompressionHandoffError {
    if (intent.status === "COMPLETED") {
      if (
        intent.payload_digest !== payloadDigest ||
        intent.receipt_digest !== receiptDigest
      ) {
        return new CompressionHandoffError(
          "handoff_integrity_failed",
          "The idempotent Handoff effect replay returned different bytes.",
          { reason: "receipt_replay_mismatch" },
        );
      }
      return intent;
    }
    const completed = this.options.run_store.completeEffect(key, receiptDigest);
    if (completed instanceof StateStoreError) {
      return this.fromStateError(completed);
    }
    if (completed.receipt_digest !== receiptDigest) {
      return new CompressionHandoffError(
        "handoff_integrity_failed",
        "The persisted Handoff effect receipt digest differs from the verified receipt.",
        { reason: "receipt_replay_mismatch" },
      );
    }
    return completed;
  }

  private closeFailure(
    state: RunState,
    reason: CompressionHandoffFailureReason,
    message: string,
    details: {
      readonly failure_code?: CompressionHandoffFailureCode;
      readonly compression_task_id?: string;
      readonly diagnostic_code?: string;
      readonly retained_work_dir?: string;
    } = {},
  ): CompressionHandoffError {
    const failureCode = details.failure_code ?? (
      INTEGRITY_REASONS.has(reason)
        ? "handoff_integrity_failed"
        : "handoff_export_failed"
    );
    let occurredAt: string;
    try {
      occurredAt = this.now().toISOString();
    } catch (error: unknown) {
      return new CompressionHandoffError(
        failureCode,
        message,
        { reason, cause: error },
      );
    }
    const transitioned = this.options.run_store.compareAndSwap(
      state.run_id,
      state.state_version,
      {
        action: "close_handoff_export_failure",
        to: "NEEDS_USER",
        updates: {
          last_error: {
            code: failureCode,
            message,
            occurred_at: occurredAt,
            last_successful_status: "HANDOFF_EXPORTING",
            details: {
              reason,
              ...(state.compaction === undefined
                ? {}
                : { compaction_id: state.compaction.compaction_id }),
              ...(details.compression_task_id === undefined
                ? {}
                : { compression_task_id: details.compression_task_id }),
              ...(details.diagnostic_code === undefined
                ? {}
                : { diagnostic_code: details.diagnostic_code }),
              ...(details.retained_work_dir === undefined
                ? {}
                : { retained_work_dir: details.retained_work_dir }),
            },
          },
        },
      },
    );
    if (transitioned instanceof StateStoreError) {
      return this.fromStateError(transitioned);
    }
    return new CompressionHandoffError(failureCode, message, {
      reason,
      ...(details.diagnostic_code === undefined
        ? {}
        : { diagnostic_code: details.diagnostic_code }),
      ...(details.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: details.retained_work_dir }),
    });
  }

  private isTerminalSuccess(
    state: RunState,
    expectedStateVersion: number,
    receipt: HandoffReceipt,
  ): boolean {
    return state.status === "CONTINUATION_STARTING" &&
      state.state_version === expectedStateVersion + 2 &&
      state.handoff?.compression_task_id === receipt.compression_task_id &&
      state.handoff.artifact_digest === receipt.artifact_digest;
  }

  private decision(
    state: RunState,
    outcome: CompressionHandoffDecision["outcome"],
    effectIdempotencyKey: Sha256Digest,
    receipt: HandoffReceipt,
  ): CompressionHandoffDecision {
    if (
      state.status !== "CONTINUATION_STARTING" ||
      state.source_thread_id === null ||
      state.compaction === undefined
    ) {
      throw new CompressionHandoffError(
        "state_corrupt",
        "A Handoff decision requires CONTINUATION_STARTING with Source and compaction identities.",
      );
    }
    return {
      outcome,
      run_id: state.run_id,
      source_thread_id: state.source_thread_id,
      compaction_id: state.compaction.compaction_id,
      state_version: state.state_version,
      status: "CONTINUATION_STARTING",
      effect_idempotency_key: effectIdempotencyKey,
      receipt,
    };
  }

  private async bounded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new BoundedCallError("timeout", `${label} timed out.`));
        }, this.exportTimeoutMs);
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

  private isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  private asCompressionError(
    error: unknown,
    fallbackCode: CompressionHandoffFailureCode,
    fallbackReason: CompressionHandoffFailureReason,
  ): CompressionHandoffError {
    if (error instanceof CompressionHandoffError) {
      return error;
    }
    return new CompressionHandoffError(
      fallbackCode,
      error instanceof Error ? error.message : String(error),
      { reason: fallbackReason, cause: error },
    );
  }

  private fromStateError(error: StateStoreError): CompressionHandoffError {
    const code = STATE_ERROR_CODES.has(error.code as CompressionHandoffFailureCode)
      ? error.code as CompressionHandoffFailureCode
      : "state_persist_failed";
    return new CompressionHandoffError(code, error.message, { cause: error });
  }
}
