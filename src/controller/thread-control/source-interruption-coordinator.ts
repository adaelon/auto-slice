import {
  createEffectIdempotencyKey,
  sha256Json,
  StateStoreError,
  type EffectRecord,
  type RunState,
  type Sha256Digest,
  type StoredRun,
} from "../state/index.js";
import {
  WorkspaceGuardError,
  type FrozenLease,
  type LeaseState,
  type ProjectLease,
} from "../workspace/index.js";

import { SourceInterruptionError } from "./errors.js";
import {
  DEFAULT_SOURCE_INTERRUPT_TIMEOUT_MS,
  isOpaqueStableRevision,
  type InterruptReceipt,
  type SourceInterruptionCoordinatorOptions,
  type SourceInterruptionDecision,
  type SourceInterruptionFailureCode,
  type SourceInterruptionFailureReason,
  type ThreadInspection,
} from "./types.js";

const INTERRUPT_RECEIPT_KEYS = [
  "thread_id",
  "execution_stopped",
  "thread_persisted",
  "persisted_revision",
  "observed_at",
] as const;

const THREAD_INSPECTION_KEYS = [
  "thread_id",
  "persisted_revision",
  "readable",
  "archived",
  "deleted",
  "observed_at",
] as const;

const STATE_ERROR_CODES = new Set<SourceInterruptionFailureCode>([
  "run_not_found",
  "invalid_transition",
  "stale_state",
  "state_persist_failed",
  "state_corrupt",
  "unsupported_state_schema",
]);

type LeasePosition =
  | { readonly kind: "FROZEN"; readonly lease: FrozenLease }
  | { readonly kind: "ROTATED"; readonly lease: ProjectLease };

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

function revisionFailure(error: unknown): SourceInterruptionError | undefined {
  if (
    error instanceof SourceInterruptionError &&
    (error.reason === "thread_revision_unavailable" ||
      error.reason === "thread_revision_invalid")
  ) {
    return error;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256
  );
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
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

function decodeInterruptReceipt(value: unknown, expectedThreadId: string): InterruptReceipt {
  if (!isRecord(value) || !exactKeys(value, INTERRUPT_RECEIPT_KEYS)) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "ThreadControl returned a receipt outside the frozen InterruptReceipt schema.",
      { reason: "interrupt_receipt_invalid" },
    );
  }
  if (value.thread_id !== expectedThreadId) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "InterruptReceipt.thread_id does not identify the active Source Thread.",
      { reason: "interrupt_receipt_identity_mismatch" },
    );
  }
  if (
    value.execution_stopped !== true ||
    value.thread_persisted !== true ||
    canonicalTimestamp(value.observed_at) === undefined
  ) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "InterruptReceipt does not prove that execution stopped while the Source Thread persisted.",
      { reason: "interrupt_receipt_invalid" },
    );
  }
  if (!isOpaqueStableRevision(value.persisted_revision)) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "InterruptReceipt.persisted_revision is not a valid opaque stable revision.",
      { reason: "thread_revision_invalid" },
    );
  }
  return value as unknown as InterruptReceipt;
}

function decodeThreadInspection(
  value: unknown,
  receipt: InterruptReceipt,
): ThreadInspection {
  if (!isRecord(value) || !exactKeys(value, THREAD_INSPECTION_KEYS)) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "ThreadControl inspection did not match the frozen readable-thread schema.",
      { reason: "thread_inspection_failed" },
    );
  }
  if (value.thread_id !== receipt.thread_id) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "The inspected thread identity differs from the InterruptReceipt.",
      { reason: "interrupt_receipt_identity_mismatch" },
    );
  }
  if (
    value.readable !== true ||
    value.archived !== false ||
    value.deleted !== false
  ) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "The Source Thread is not persisted, readable, unarchived, and undeleted.",
      { reason: "thread_not_persisted" },
    );
  }
  if (!isOpaqueStableRevision(value.persisted_revision)) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "ThreadInspection.persisted_revision is not a valid opaque stable revision.",
      { reason: "thread_revision_invalid" },
    );
  }
  if (value.persisted_revision !== receipt.persisted_revision) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "The readable Source Thread revision differs from the InterruptReceipt.",
      { reason: "thread_revision_mismatch" },
    );
  }
  const inspectedAt = canonicalTimestamp(value.observed_at);
  if (
    inspectedAt === undefined ||
    Date.parse(inspectedAt) < Date.parse(receipt.observed_at)
  ) {
    throw new SourceInterruptionError(
      "source_interrupt_failed",
      "The Source Thread inspection is not a canonical observation after interruption.",
      { reason: "thread_inspection_failed" },
    );
  }
  return value as unknown as ThreadInspection;
}

export class SourceInterruptionCoordinator {
  private readonly now: () => Date;
  private readonly interruptTimeoutMs: number;

  public constructor(private readonly options: SourceInterruptionCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.interruptTimeoutMs =
      options.interrupt_timeout_ms ?? DEFAULT_SOURCE_INTERRUPT_TIMEOUT_MS;
  }

  public async interruptSource(
    runId: string,
    leaseId: string,
    expectedWriteEpoch: number,
    expectedStateVersion: number,
  ): Promise<SourceInterruptionDecision | SourceInterruptionError> {
    const argumentError = this.validateArguments(
      runId,
      leaseId,
      expectedWriteEpoch,
      expectedStateVersion,
    );
    if (argumentError !== undefined) {
      return argumentError;
    }

    const loaded = this.options.run_store.load(runId);
    if (loaded instanceof StateStoreError) {
      return this.fromStateError(loaded);
    }
    if (
      loaded.state.status === "HANDOFF_EXPORTING" &&
      loaded.state.state_version === expectedStateVersion + 1
    ) {
      return this.replayTerminal(
        loaded,
        leaseId,
        expectedWriteEpoch,
        expectedStateVersion,
      );
    }
    if (loaded.state.state_version !== expectedStateVersion) {
      return new SourceInterruptionError(
        "stale_state",
        `Expected state_version ${String(expectedStateVersion)}, found ${String(loaded.state.state_version)}.`,
      );
    }
    if (loaded.state.status !== "SOURCE_INTERRUPTING") {
      return new SourceInterruptionError(
        "invalid_transition",
        `Run ${runId} is ${loaded.state.status}, not SOURCE_INTERRUPTING.`,
        { reason: "run_not_source_interrupting" },
      );
    }
    const preparationError = this.validateRunInputs(
      loaded.state,
      leaseId,
      expectedWriteEpoch,
    );
    if (preparationError !== undefined) {
      return this.closeFailure(loaded.state, preparationError.reason ?? "invalid_request", preparationError.message);
    }

    const sourceThreadId = loaded.state.source_thread_id as string;
    const compactionId = loaded.state.compaction?.compaction_id as string;
    const effectKey = createEffectIdempotencyKey(
      runId,
      expectedStateVersion,
      "interrupt_source_thread",
      sourceThreadId,
    );
    const payloadDigest = sha256Json({
      compaction_id: compactionId,
      lease_id: leaseId,
      source_thread_id: sourceThreadId,
      write_epoch: expectedWriteEpoch,
    });

    const leasePosition = this.freezeOrRecover(
      loaded.state,
      leaseId,
      expectedWriteEpoch,
    );
    if (leasePosition instanceof WorkspaceGuardError) {
      return this.closeFailure(
        loaded.state,
        "lease_freeze_failed",
        `Project Write Lease could not be frozen: ${leasePosition.code}.`,
      );
    }

    const intent = this.options.run_store.appendEffectIntent(effectKey, payloadDigest);
    if (intent instanceof StateStoreError) {
      return this.fromStateError(intent);
    }
    if (leasePosition.kind === "ROTATED" && intent.status !== "COMPLETED") {
      return this.closeFailure(
        loaded.state,
        "write_epoch_rotation_failed",
        "The write epoch advanced without a completed interrupt effect receipt.",
        leasePosition.lease.epoch,
      );
    }

    const receipt = await this.obtainVerifiedReceipt(
      loaded.state,
      sourceThreadId,
      effectKey.digest,
    );
    if (receipt instanceof SourceInterruptionError) {
      return this.closeFailure(
        loaded.state,
        receipt.reason ?? "interrupt_call_failed",
        receipt.message,
        leasePosition.kind === "ROTATED" ? leasePosition.lease.epoch : undefined,
      );
    }
    const receiptDigest = sha256Json(receipt);
    const completedEffect = this.completeOrReconcileEffect(
      effectKey,
      payloadDigest,
      receiptDigest,
      intent,
    );
    if (completedEffect instanceof SourceInterruptionError) {
      return this.closeFailure(
        loaded.state,
        completedEffect.reason ?? "receipt_replay_mismatch",
        completedEffect.message,
        leasePosition.kind === "ROTATED" ? leasePosition.lease.epoch : undefined,
      );
    }

    const rotated = leasePosition.kind === "ROTATED"
      ? leasePosition.lease
      : this.rotateOrRecover(leasePosition.lease, expectedWriteEpoch);
    if (rotated instanceof WorkspaceGuardError) {
      return this.closeFailure(
        loaded.state,
        "write_epoch_rotation_failed",
        `The frozen Project Write Lease could not rotate epoch: ${rotated.code}.`,
      );
    }

    const transitioned = this.options.run_store.compareAndSwap(runId, expectedStateVersion, {
      action: "complete_source_interruption",
      to: "HANDOFF_EXPORTING",
      updates: {
        write_epoch: rotated.epoch,
        last_error: null,
      },
    });
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state" || transitioned.code === "state_persist_failed") {
        const latest = this.options.run_store.load(runId);
        if (
          !(latest instanceof StateStoreError) &&
          this.isTerminalSuccess(latest.state, expectedStateVersion, rotated.epoch)
        ) {
          return this.decision(
            latest.state,
            "ALREADY_INTERRUPTED",
            effectKey.digest,
            receipt,
          );
        }
      }
      return this.fromStateError(transitioned);
    }
    return this.decision(
      transitioned.state,
      "INTERRUPTED",
      effectKey.digest,
      receipt,
    );
  }

  private async replayTerminal(
    loaded: StoredRun,
    leaseId: string,
    expectedWriteEpoch: number,
    expectedStateVersion: number,
  ): Promise<SourceInterruptionDecision | SourceInterruptionError> {
    const state = loaded.state;
    if (
      state.source_thread_id === null ||
      state.compaction === undefined ||
      state.project_lock_owner !== leaseId ||
      state.write_epoch !== expectedWriteEpoch + 1
    ) {
      return new SourceInterruptionError(
        "state_corrupt",
        "HANDOFF_EXPORTING does not preserve the completed S08 identities and rotated epoch.",
      );
    }
    const effectKey = createEffectIdempotencyKey(
      state.run_id,
      expectedStateVersion,
      "interrupt_source_thread",
      state.source_thread_id,
    );
    const payloadDigest = sha256Json({
      compaction_id: state.compaction.compaction_id,
      lease_id: leaseId,
      source_thread_id: state.source_thread_id,
      write_epoch: expectedWriteEpoch,
    });
    const effect = this.options.run_store.appendEffectIntent(effectKey, payloadDigest);
    if (effect instanceof StateStoreError) {
      return this.fromStateError(effect);
    }
    if (effect.status !== "COMPLETED" || effect.receipt_digest === undefined) {
      return new SourceInterruptionError(
        "state_corrupt",
        "HANDOFF_EXPORTING has no completed source interruption effect.",
      );
    }
    const receipt = await this.obtainVerifiedReceipt(
      state,
      state.source_thread_id,
      effectKey.digest,
    );
    if (receipt instanceof SourceInterruptionError) {
      return receipt;
    }
    if (sha256Json(receipt) !== effect.receipt_digest) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "Repeated ThreadControl interruption returned a different terminal receipt.",
        { reason: "receipt_replay_mismatch" },
      );
    }
    return this.decision(
      state,
      "ALREADY_INTERRUPTED",
      effectKey.digest,
      receipt,
    );
  }

  private validateArguments(
    runId: string,
    leaseId: string,
    expectedWriteEpoch: number,
    expectedStateVersion: number,
  ): SourceInterruptionError | undefined {
    if (
      !validIdentifier(runId) ||
      !validIdentifier(leaseId) ||
      !Number.isSafeInteger(expectedWriteEpoch) ||
      expectedWriteEpoch < 1 ||
      !Number.isSafeInteger(expectedStateVersion) ||
      expectedStateVersion < 0 ||
      !Number.isSafeInteger(this.interruptTimeoutMs) ||
      this.interruptTimeoutMs <= 0
    ) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "Source interruption arguments and timeout must be stable non-empty identifiers and positive safe integers.",
        { reason: "invalid_request" },
      );
    }
    return undefined;
  }

  private validateRunInputs(
    state: RunState,
    leaseId: string,
    expectedWriteEpoch: number,
  ): SourceInterruptionError | undefined {
    if (state.source_thread_id === null) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "SOURCE_INTERRUPTING has no Source Thread identity.",
        { reason: "source_thread_missing" },
      );
    }
    if (state.compaction === undefined) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "SOURCE_INTERRUPTING has no active Compaction Timeout identity.",
        { reason: "active_compaction_missing" },
      );
    }
    if (state.project_lock_owner === null || state.project_lock_owner !== leaseId) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "The supplied Project Write Lease does not own this Run.",
        { reason: "project_write_lease_missing" },
      );
    }
    if (state.write_epoch !== expectedWriteEpoch) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        `Run write_epoch ${String(state.write_epoch)} differs from ${String(expectedWriteEpoch)}.`,
        { reason: "write_epoch_mismatch" },
      );
    }
    return undefined;
  }

  private freezeOrRecover(
    state: RunState,
    leaseId: string,
    expectedWriteEpoch: number,
  ): LeasePosition | WorkspaceGuardError {
    const frozen = this.options.workspace_guard.freezeWrites(
      leaseId,
      expectedWriteEpoch,
    );
    if (!(frozen instanceof WorkspaceGuardError)) {
      return { kind: "FROZEN", lease: frozen };
    }
    const persisted = this.persistedLeasePosition(
      state,
      leaseId,
      expectedWriteEpoch,
    );
    return persisted ?? frozen;
  }

  private rotateOrRecover(
    frozen: FrozenLease,
    expectedWriteEpoch: number,
  ): ProjectLease | WorkspaceGuardError {
    const rotated = this.options.workspace_guard.rotateEpoch(frozen);
    if (!(rotated instanceof WorkspaceGuardError)) {
      return rotated;
    }
    const events = this.options.workspace_guard.inspectLeaseEvents(frozen.lease_id);
    if (events instanceof WorkspaceGuardError) {
      return rotated;
    }
    const latest = events.at(-1);
    if (
      latest?.action === "EPOCH_ROTATED" &&
      latest.after_state.status === "ACTIVE" &&
      latest.after_state.epoch === expectedWriteEpoch + 1 &&
      latest.after_state.lease_id === frozen.lease_id &&
      latest.after_state.run_id === frozen.run_id
    ) {
      return latest.after_state;
    }
    return rotated;
  }

  private persistedLeasePosition(
    state: RunState,
    leaseId: string,
    expectedWriteEpoch: number,
  ): LeasePosition | undefined {
    const events = this.options.workspace_guard.inspectLeaseEvents(leaseId);
    if (events instanceof WorkspaceGuardError) {
      return undefined;
    }
    const latest = events.at(-1);
    const lease: LeaseState | undefined = latest?.after_state;
    if (lease === undefined || lease.lease_id !== leaseId || lease.run_id !== state.run_id) {
      return undefined;
    }
    if (lease.status === "FROZEN" && lease.epoch === expectedWriteEpoch) {
      return { kind: "FROZEN", lease };
    }
    if (
      latest?.action === "EPOCH_ROTATED" &&
      lease.status === "ACTIVE" &&
      lease.epoch === expectedWriteEpoch + 1
    ) {
      return { kind: "ROTATED", lease };
    }
    return undefined;
  }

  private async obtainVerifiedReceipt(
    state: RunState,
    sourceThreadId: string,
    idempotencyKey: Sha256Digest,
  ): Promise<InterruptReceipt | SourceInterruptionError> {
    let rawReceipt: unknown;
    try {
      rawReceipt = await this.boundedCall(
        () => this.options.thread_control.interrupt(sourceThreadId, idempotencyKey),
        "interrupt",
      );
    } catch (error: unknown) {
      const revisionError = revisionFailure(error);
      if (revisionError !== undefined) {
        return revisionError;
      }
      const timedOut = error instanceof BoundedCallError && error.reason === "timeout";
      return new SourceInterruptionError(
        "source_interrupt_failed",
        timedOut
          ? `Source Thread interruption exceeded ${String(this.interruptTimeoutMs)}ms.`
          : "ThreadControl.interrupt failed before a trustworthy receipt was returned.",
        {
          reason: timedOut ? "interrupt_timeout" : "interrupt_call_failed",
          cause: error,
        },
      );
    }

    let receipt: InterruptReceipt;
    try {
      receipt = decodeInterruptReceipt(rawReceipt, sourceThreadId);
    } catch (error: unknown) {
      return error instanceof SourceInterruptionError
        ? error
        : new SourceInterruptionError(
          "source_interrupt_failed",
          "InterruptReceipt validation failed.",
          { reason: "interrupt_receipt_invalid", cause: error },
        );
    }

    let rawInspection: unknown;
    try {
      rawInspection = await this.boundedCall(
        () => this.options.thread_control.inspect(sourceThreadId),
        "inspect",
      );
    } catch (error: unknown) {
      const revisionError = revisionFailure(error);
      if (revisionError !== undefined) {
        return revisionError;
      }
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "The interrupted Source Thread could not be inspected as readable and persisted.",
        { reason: "thread_inspection_failed", cause: error },
      );
    }
    try {
      decodeThreadInspection(rawInspection, receipt);
      return receipt;
    } catch (error: unknown) {
      return error instanceof SourceInterruptionError
        ? error
        : new SourceInterruptionError(
          "source_interrupt_failed",
          `Source Thread ${state.source_thread_id ?? "<missing>"} inspection failed.`,
          { reason: "thread_inspection_failed", cause: error },
        );
    }
  }

  private completeOrReconcileEffect(
    key: ReturnType<typeof createEffectIdempotencyKey>,
    payloadDigest: Sha256Digest,
    receiptDigest: Sha256Digest,
    existing: EffectRecord,
  ): EffectRecord | SourceInterruptionError {
    if (existing.status === "COMPLETED") {
      return existing.receipt_digest === receiptDigest
        ? existing
        : new SourceInterruptionError(
          "source_interrupt_failed",
          "Repeated ThreadControl interruption returned a different terminal receipt.",
          { reason: "receipt_replay_mismatch" },
        );
    }
    const completed = this.options.run_store.completeEffect(key, receiptDigest);
    if (!(completed instanceof StateStoreError)) {
      return completed;
    }
    if (completed.code === "state_persist_failed") {
      const reconciled = this.options.run_store.appendEffectIntent(key, payloadDigest);
      if (
        !(reconciled instanceof StateStoreError) &&
        reconciled.status === "COMPLETED" &&
        reconciled.receipt_digest === receiptDigest
      ) {
        return reconciled;
      }
    }
    return this.fromStateError(completed);
  }

  private closeFailure(
    state: RunState,
    reason: SourceInterruptionFailureReason,
    message: string,
    observedWriteEpoch?: number,
  ): SourceInterruptionError {
    const occurredAt = this.timestamp();
    if (occurredAt instanceof SourceInterruptionError) {
      return occurredAt;
    }
    const transitioned = this.options.run_store.compareAndSwap(
      state.run_id,
      state.state_version,
      {
        action: "fail_source_interruption",
        to: "NEEDS_USER",
        updates: {
          ...(observedWriteEpoch === undefined ? {} : { write_epoch: observedWriteEpoch }),
          last_error: {
            code: "source_interrupt_failed",
            message,
            occurred_at: occurredAt,
            last_successful_status: "SOURCE_INTERRUPTING",
            details: {
              reason,
              source_thread_id: state.source_thread_id ?? "<missing>",
              compaction_id: state.compaction?.compaction_id ?? "<missing>",
              project_lock_owner: state.project_lock_owner ?? "<missing>",
              write_epoch: String(observedWriteEpoch ?? state.write_epoch),
            },
          },
        },
      },
    );
    if (transitioned instanceof StateStoreError) {
      if (transitioned.code === "stale_state") {
        const latest = this.options.run_store.load(state.run_id);
        if (
          !(latest instanceof StateStoreError) &&
          latest.state.status === "NEEDS_USER" &&
          latest.state.last_error?.code === "source_interrupt_failed"
        ) {
          return new SourceInterruptionError(
            "source_interrupt_failed",
            latest.state.last_error.message,
            { reason },
          );
        }
      }
      return this.fromStateError(transitioned);
    }
    return new SourceInterruptionError(
      "source_interrupt_failed",
      message,
      { reason },
    );
  }

  private timestamp(): string | SourceInterruptionError {
    try {
      const value = this.now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error("Clock returned an invalid Date.");
      }
      return value.toISOString();
    } catch (error: unknown) {
      return new SourceInterruptionError(
        "source_interrupt_failed",
        "Source interruption failure could not be timestamped.",
        { reason: "invalid_request", cause: error },
      );
    }
  }

  private async boundedCall<T>(
    operation: () => T | Promise<T>,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new BoundedCallError("timeout", `${label} timed out.`));
        }, this.interruptTimeoutMs);
      });
      const operationPromise = Promise.resolve().then(operation).catch((error: unknown) => {
        const revisionError = revisionFailure(error);
        if (revisionError !== undefined) {
          throw revisionError;
        }
        throw new BoundedCallError("call_failed", `${label} failed.`, { cause: error });
      });
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private isTerminalSuccess(
    state: RunState,
    expectedStateVersion: number,
    writeEpoch: number,
  ): boolean {
    return (
      state.status === "HANDOFF_EXPORTING" &&
      state.state_version === expectedStateVersion + 1 &&
      state.write_epoch === writeEpoch
    );
  }

  private decision(
    state: RunState,
    outcome: SourceInterruptionDecision["outcome"],
    effectIdempotencyKey: Sha256Digest,
    receipt: InterruptReceipt,
  ): SourceInterruptionDecision {
    if (
      state.status !== "HANDOFF_EXPORTING" ||
      state.source_thread_id === null ||
      state.compaction === undefined
    ) {
      throw new SourceInterruptionError(
        "state_corrupt",
        "A source interruption decision requires HANDOFF_EXPORTING with source and compaction identities.",
      );
    }
    return {
      outcome,
      run_id: state.run_id,
      source_thread_id: state.source_thread_id,
      compaction_id: state.compaction.compaction_id,
      state_version: state.state_version,
      status: "HANDOFF_EXPORTING",
      write_epoch: state.write_epoch,
      effect_idempotency_key: effectIdempotencyKey,
      receipt,
    };
  }

  private fromStateError(error: StateStoreError): SourceInterruptionError {
    const code = STATE_ERROR_CODES.has(error.code as SourceInterruptionFailureCode)
      ? error.code as SourceInterruptionFailureCode
      : "state_persist_failed";
    return new SourceInterruptionError(code, error.message, { cause: error });
  }
}
