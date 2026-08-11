import { CompactionMonitorError } from "../compaction-monitor/index.js";
import { ContinuationError } from "../continuation/index.js";
import { CompressionHandoffError } from "../handoff/index.js";
import {
  canonicalJson,
  sha256Json,
  StateStoreError,
  type RunState,
  type Sha256Digest,
  type StoredRun,
} from "../state/index.js";
import { SourceInterruptionError } from "../thread-control/index.js";
import { WorkspaceGuardError } from "../workspace/index.js";
import { ProductionRuntimeError } from "./errors.js";
import {
  buildDevelopmentPrompt,
  effectiveCommitMode,
} from "./prompt-builder.js";
import {
  DEVELOPMENT_TASK_SCHEMA_VERSION,
  PRODUCTION_RUN_SCHEMA_VERSION,
  type DevelopmentTaskHandle,
  type DevelopmentTaskReceipt,
  type ProductionContinuationReceipt,
  type ProductionOrchestratorOptions,
  type ProductionRunDecision,
  type ProductionRunReceipt,
  type ProductionSliceReceipt,
  type ProductionSliceV1,
  type ResolvedProductionPlanV1,
} from "./types.js";

interface CompletedSlice {
  readonly stored: StoredRun;
  readonly receipt: ProductionSliceReceipt;
}

function runtimeError(
  code: ConstructorParameters<typeof ProductionRuntimeError>[0],
  message: string,
  cause?: unknown,
): ProductionRuntimeError {
  return new ProductionRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sameWorkspace(left: RunState["workspace_identity"], right: RunState["workspace_identity"]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function runReceiptMaterial(
  receipt: Omit<ProductionRunReceipt, "receipt_digest">,
): ProductionRunReceipt {
  return { ...receipt, receipt_digest: sha256Json(receipt) };
}

function continuationReceiptMaterial(
  receipt: Omit<ProductionContinuationReceipt, "receipt_digest">,
): ProductionContinuationReceipt {
  return { ...receipt, receipt_digest: sha256Json(receipt) };
}

function developmentReceiptMaterial(
  receipt: DevelopmentTaskReceipt,
): Omit<DevelopmentTaskReceipt, "receipt_digest"> {
  return {
    schema_version: receipt.schema_version,
    run_id: receipt.run_id,
    slice_id: receipt.slice_id,
    thread_id: receipt.thread_id,
    turn_id: receipt.turn_id,
    outcome: receipt.outcome,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
  };
}

export function productionSliceBindingDigest(
  planDigest: Sha256Digest,
  sliceId: string,
): Sha256Digest {
  return sha256Json({
    kind: "PRODUCTION_SLICE_STATE",
    plan_digest: planDigest,
    slice_id: sliceId,
  });
}

export class ProductionOrchestrator {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;

  public constructor(private readonly options: ProductionOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.poll_interval_ms ?? 100;
  }

  public async run(
    resolved: ResolvedProductionPlanV1,
  ): Promise<ProductionRunDecision | ProductionRuntimeError> {
    const initial = this.load(resolved.plan.run_id);
    if (initial instanceof ProductionRuntimeError) {
      return initial;
    }
    const invalid = this.validateRunStart(resolved, initial.state);
    if (invalid !== null) {
      return this.closeFailure(resolved.plan.run_id, invalid);
    }

    let current = initial;
    const completedSlices: ProductionSliceReceipt[] = [];
    for (let index = 0; index < resolved.plan.slices.length; index += 1) {
      const slice = resolved.plan.slices[index];
      if (slice === undefined) {
        return this.closeFailure(
          resolved.plan.run_id,
          runtimeError("production_run_invalid", "Production Plan Slice ordering is sparse."),
        );
      }
      const completed = await this.runSlice(resolved, slice, index, current);
      if (completed instanceof ProductionRuntimeError) {
        return this.closeFailure(resolved.plan.run_id, completed);
      }
      if ("outcome" in completed) {
        return completed;
      }
      current = completed.stored;
      completedSlices.push(completed.receipt);
    }

    const owner = current.state.project_lock_owner;
    if (owner === null) {
      return this.closeFailure(
        resolved.plan.run_id,
        runtimeError("production_run_invalid", "A completed production Run lost its Project Write Lease identity."),
      );
    }
    const released = this.options.workspace_guard.release(owner, current.state.write_epoch);
    if (released instanceof WorkspaceGuardError) {
      return this.closeFailure(
        resolved.plan.run_id,
        runtimeError(
          "workspace_guard_failed",
          `Project Write Lease release failed: ${released.code}.`,
          released,
        ),
      );
    }
    const done = this.transition(current, {
      action: "complete_production_run",
      to: "DONE",
      updates: { project_lock_owner: null },
    });
    if (done instanceof ProductionRuntimeError) {
      return done;
    }
    const completedAt = this.timestamp();
    if (completedAt instanceof ProductionRuntimeError) {
      return completedAt;
    }
    return runReceiptMaterial({
      schema_version: PRODUCTION_RUN_SCHEMA_VERSION,
      outcome: "DONE",
      run_id: resolved.plan.run_id,
      plan_digest: resolved.plan_digest,
      completed_slices: completedSlices,
      final_state_version: done.state.state_version,
      completed_at: completedAt,
    });
  }

  private async runSlice(
    resolved: ResolvedProductionPlanV1,
    slice: ProductionSliceV1,
    index: number,
    stored: StoredRun,
  ): Promise<CompletedSlice | ProductionContinuationReceipt | ProductionRuntimeError> {
    const expectedStatus = "PREPARING";
    if (stored.state.status !== expectedStatus) {
      return runtimeError(
        "production_run_invalid",
        `Slice ${slice.contract.slice_id} requires ${expectedStatus}, found ${stored.state.status}.`,
      );
    }
    const owner = stored.state.project_lock_owner;
    if (owner === null) {
      return runtimeError(
        "production_run_invalid",
        `Slice ${slice.contract.slice_id} has no Project Write Lease identity.`,
      );
    }
    const lease = this.options.workspace_guard.assertWritable(owner, stored.state.write_epoch);
    if (lease instanceof WorkspaceGuardError) {
      return runtimeError(
        "workspace_guard_failed",
        `Slice ${slice.contract.slice_id} cannot obtain write capability: ${lease.code}.`,
        lease,
      );
    }
    if (
      lease.run_id !== stored.state.run_id ||
      lease.lease_id !== owner ||
      lease.epoch !== stored.state.write_epoch ||
      !sameWorkspace(lease.workspace_identity, stored.state.workspace_identity)
    ) {
      return runtimeError(
        "workspace_guard_failed",
        `Slice ${slice.contract.slice_id} received a mismatched Project Write Lease.`,
      );
    }
    const runtimeCommitOverride = stored.state.slice_commit_mode_overrides?.[
      slice.contract.slice_id
    ];
    const commitMode = effectiveCommitMode(
      slice,
      stored.state.commit_mode,
      runtimeCommitOverride,
    );
    const prompt = buildDevelopmentPrompt(slice, commitMode);
    if (typeof prompt !== "string") {
      return runtimeError("production_run_invalid", prompt.message, prompt);
    }
    const handle = await this.options.development_tasks.start({
      schema_version: DEVELOPMENT_TASK_SCHEMA_VERSION,
      run_id: stored.state.run_id,
      slice_id: slice.contract.slice_id,
      idempotency_key: sha256Json({
        action: "start_development_task",
        run_id: stored.state.run_id,
        slice_id: slice.contract.slice_id,
        state_version: stored.state.state_version,
      }),
      workspace_identity: stored.state.workspace_identity,
      lease_id: lease.lease_id,
      write_epoch: lease.epoch,
      model_decision: resolved.development_model,
      prompt,
    });
    if (handle instanceof ProductionRuntimeError) {
      return handle;
    }
    const running = this.startSlice(
      stored,
      slice,
      productionSliceBindingDigest(resolved.plan_digest, slice.contract.slice_id),
      handle,
    );
    if (running instanceof ProductionRuntimeError) {
      return running;
    }

    const eventObservation = this.observeDevelopmentEvents(
      resolved.plan.run_id,
      handle,
    );
    const timeoutObservation = this.watchForTimedOutCompaction(
      resolved,
      slice,
      handle,
    );
    const completion = await handle.completion;
    const [eventFailure, timeoutOutcome] = await Promise.all([
      eventObservation,
      timeoutObservation,
    ]);
    if (timeoutOutcome !== null) {
      return timeoutOutcome;
    }
    if (eventFailure !== null) {
      return eventFailure;
    }
    if (completion instanceof ProductionRuntimeError) {
      return completion;
    }
    const completionFailure = this.validateDevelopmentCompletion(
      stored.state.run_id,
      slice,
      handle,
      completion,
    );
    if (completionFailure !== null) {
      return completionFailure;
    }
    const afterDevelopment = this.load(stored.state.run_id);
    if (afterDevelopment instanceof ProductionRuntimeError) {
      return afterDevelopment;
    }
    if (
      afterDevelopment.state.status !== "SLICE_RUNNING" ||
      afterDevelopment.state.current_slice_id !== slice.contract.slice_id ||
      afterDevelopment.state.source_thread_id !== handle.thread_id
    ) {
      return runtimeError(
        "production_run_invalid",
        `Slice ${slice.contract.slice_id} Development Task ended outside SLICE_RUNNING.`,
      );
    }
    const isFinalSlice = index === resolved.plan.slices.length - 1;
    const completedState = isFinalSlice
      ? afterDevelopment
      : this.transition(afterDevelopment, {
        action: `prepare_next_slice:${slice.contract.slice_id}`,
        to: "PREPARING",
      });
    if (completedState instanceof ProductionRuntimeError) {
      return completedState;
    }
    return {
      stored: completedState,
      receipt: {
        slice_id: slice.contract.slice_id,
        source_thread_id: completion.thread_id,
        development_receipt_digest: completion.receipt_digest,
        state_version: completedState.state.state_version,
      },
    };
  }

  private startSlice(
    stored: StoredRun,
    slice: ProductionSliceV1,
    sliceBindingDigest: Sha256Digest,
    handle: DevelopmentTaskHandle,
  ): StoredRun | ProductionRuntimeError {
    const sliceChanged = stored.state.current_slice_id !== slice.contract.slice_id;
    const bindingChanged = stored.state.protected_baseline_digest !== sliceBindingDigest;
    if (sliceChanged !== bindingChanged) {
      return runtimeError(
        "production_run_invalid",
        "A Slice identity and its persisted Slice binding must rotate together.",
      );
    }
    return this.transition(stored, {
      action: `start_slice:${slice.contract.slice_id}`,
      to: "SLICE_RUNNING",
      updates: {
        ...(sliceChanged
          ? {
            current_slice_id: slice.contract.slice_id,
            protected_baseline_digest: sliceBindingDigest,
          }
          : {}),
        source_thread_id: handle.thread_id,
      },
    });
  }

  private async observeDevelopmentEvents(
    runId: string,
    handle: DevelopmentTaskHandle,
  ): Promise<ProductionRuntimeError | null> {
    try {
      for await (const event of handle.events) {
        const loaded = this.load(runId);
        if (loaded instanceof ProductionRuntimeError) {
          return loaded;
        }
        const decision = this.options.compaction_monitor.onEvent(
          runId,
          event,
          loaded.state.state_version,
        );
        if (decision instanceof CompactionMonitorError) {
          return runtimeError(
            "compaction_monitor_failed",
            `Compaction event processing failed: ${decision.code}.`,
            decision,
          );
        }
      }
      return null;
    } catch (error: unknown) {
      return runtimeError(
        "compaction_monitor_failed",
        "Development Task event streaming failed closed.",
        error,
      );
    }
  }

  private async watchForTimedOutCompaction(
    resolved: ResolvedProductionPlanV1,
    slice: ProductionSliceV1,
    handle: DevelopmentTaskHandle,
  ): Promise<ProductionContinuationReceipt | ProductionRuntimeError | null> {
    const completionSignal = handle.completion.then(
      () => "COMPLETED" as const,
      () => "COMPLETED" as const,
    );
    for (;;) {
      const loaded = this.load(resolved.plan.run_id);
      if (loaded instanceof ProductionRuntimeError) {
        return loaded;
      }
      if (loaded.state.status === "SOURCE_INTERRUPTING") {
        return await this.recoverTimedOutCompaction(
          resolved,
          slice,
        );
      }
      const signal = await Promise.race([
        completionSignal,
        this.delayPoll().then(() => "POLL" as const),
      ]);
      if (signal === "COMPLETED") {
        const afterCompletion = this.load(resolved.plan.run_id);
        if (afterCompletion instanceof ProductionRuntimeError) {
          return afterCompletion;
        }
        return afterCompletion.state.status === "SOURCE_INTERRUPTING"
          ? await this.recoverTimedOutCompaction(
            resolved,
            slice,
          )
          : null;
      }
    }
  }

  private async recoverTimedOutCompaction(
    resolved: ResolvedProductionPlanV1,
    slice: ProductionSliceV1,
  ): Promise<ProductionContinuationReceipt | ProductionRuntimeError> {
    const timedOut = this.load(resolved.plan.run_id);
    if (timedOut instanceof ProductionRuntimeError) {
      return timedOut;
    }
    const owner = timedOut.state.project_lock_owner;
    if (
      timedOut.state.status !== "SOURCE_INTERRUPTING" ||
      owner === null ||
      timedOut.state.current_slice_id !== slice.contract.slice_id ||
      timedOut.state.source_thread_id === null ||
      timedOut.state.compaction === undefined
    ) {
      return runtimeError(
        "production_run_invalid",
        "Timed-out compaction recovery requires the bound current Slice in SOURCE_INTERRUPTING.",
      );
    }
    const interrupted = await this.options.source_interruption.interruptSource(
      timedOut.state.run_id,
      owner,
      timedOut.state.write_epoch,
      timedOut.state.state_version,
    );
    if (interrupted instanceof SourceInterruptionError) {
      return runtimeError("source_interrupt_failed", interrupted.message, interrupted);
    }
    if (
      interrupted.run_id !== timedOut.state.run_id ||
      interrupted.source_thread_id !== timedOut.state.source_thread_id ||
      interrupted.compaction_id !== timedOut.state.compaction.compaction_id
    ) {
      return runtimeError(
        "source_interrupt_failed",
        "Source interruption returned a receipt for another Run, Thread, or compaction.",
      );
    }
    const exported = await this.options.handoff.exportHandoff(
      timedOut.state.run_id,
      interrupted.receipt,
      resolved.compression_model,
      interrupted.state_version,
    );
    if (exported instanceof CompressionHandoffError) {
      const code = exported.code === "handoff_integrity_failed"
        ? "handoff_integrity_failed"
        : exported.code === "model_policy_unavailable"
          ? "model_policy_unavailable"
          : "handoff_export_failed";
      return runtimeError(code, exported.message, exported);
    }
    if (
      exported.run_id !== timedOut.state.run_id ||
      exported.source_thread_id !== interrupted.source_thread_id ||
      exported.compaction_id !== interrupted.compaction_id ||
      exported.receipt.source_thread_id !== interrupted.source_thread_id ||
      exported.receipt.compression_task_id === interrupted.source_thread_id
    ) {
      return runtimeError(
        "handoff_integrity_failed",
        "Compression Handoff returned a receipt for another Run, Thread, or compaction.",
      );
    }
    const continued = await this.options.continuation.continueFromHandoff({
      run_id: timedOut.state.run_id,
      lease_id: owner,
      handoff_receipt: exported.receipt,
      slice_contract: slice.contract,
      model_decision: resolved.continuation_model,
      expected_state_version: exported.state_version,
    });
    if (continued instanceof ContinuationError) {
      return runtimeError("continuation_start_failed", continued.message, continued);
    }
    if (
      continued.run_id !== timedOut.state.run_id ||
      continued.old_source_thread_id !== interrupted.source_thread_id ||
      continued.current_slice_id !== slice.contract.slice_id ||
      continued.continuation_task_id === interrupted.source_thread_id ||
      continued.continuation_task_id === exported.receipt.compression_task_id
    ) {
      return runtimeError(
        "continuation_start_failed",
        "Continuation returned a conflicting task identity or Slice binding.",
      );
    }
    const resumed = this.load(timedOut.state.run_id);
    if (resumed instanceof ProductionRuntimeError) {
      return resumed;
    }
    if (
      resumed.state.state_version !== continued.state_version ||
      resumed.state.status !== "SLICE_RUNNING" ||
      resumed.state.current_slice_id !== slice.contract.slice_id ||
      resumed.state.source_thread_id !== continued.continuation_task_id ||
      resumed.state.write_epoch !== continued.write_epoch ||
      resumed.state.handoff?.compression_task_id !== exported.receipt.compression_task_id ||
      resumed.state.handoff.continuation_task_id !== continued.continuation_task_id
    ) {
      return runtimeError(
        "continuation_start_failed",
        "Continuation receipt does not match the persisted resumed Run state.",
      );
    }
    return continuationReceiptMaterial({
      schema_version: PRODUCTION_RUN_SCHEMA_VERSION,
      outcome: "CONTINUATION_STARTED",
      run_id: timedOut.state.run_id,
      plan_digest: resolved.plan_digest,
      slice_id: slice.contract.slice_id,
      source_thread_id: interrupted.source_thread_id,
      compression_task_id: exported.receipt.compression_task_id,
      continuation_task_id: continued.continuation_task_id,
      state_version: continued.state_version,
    });
  }

  private validateDevelopmentCompletion(
    runId: string,
    slice: ProductionSliceV1,
    handle: DevelopmentTaskHandle,
    receipt: DevelopmentTaskReceipt,
  ): ProductionRuntimeError | null {
    if (
      receipt.outcome !== "COMPLETED" ||
      receipt.run_id !== runId ||
      receipt.slice_id !== slice.contract.slice_id ||
      receipt.thread_id !== handle.thread_id ||
      receipt.turn_id !== handle.turn_id ||
      receipt.receipt_digest !== sha256Json(developmentReceiptMaterial(receipt))
    ) {
      return runtimeError(
        "slice_execution_failed",
        `Slice ${slice.contract.slice_id} Development Task did not complete with matching identities.`,
      );
    }
    return null;
  }

  private validateRunStart(
    resolved: ResolvedProductionPlanV1,
    state: RunState,
  ): ProductionRuntimeError | null {
    const first = resolved.plan.slices[0];
    if (
      resolved.plan.slices.length === 0 ||
      first === undefined ||
      state.status !== "PREPARING" ||
      state.run_id !== resolved.plan.run_id ||
      resolved.plan_digest !== sha256Json(resolved.plan) ||
      state.plan_digest !== resolved.plan_digest ||
      state.commit_mode !== resolved.plan.commit_mode ||
      state.current_slice_id !== first.contract.slice_id ||
      state.protected_baseline_digest !== productionSliceBindingDigest(
        resolved.plan_digest,
        first.contract.slice_id,
      ) ||
      !Number.isSafeInteger(this.pollIntervalMs) ||
      this.pollIntervalMs <= 0
    ) {
      return runtimeError(
        "production_run_invalid",
        "Production Orchestrator requires one matching PREPARING Run and an ordered non-empty plan.",
      );
    }
    return null;
  }

  private transition(
    stored: StoredRun,
    transition: Parameters<ProductionOrchestratorOptions["run_store"]["compareAndSwap"]>[2],
  ): StoredRun | ProductionRuntimeError {
    const result = this.options.run_store.compareAndSwap(
      stored.state.run_id,
      stored.state.state_version,
      transition,
    );
    return result instanceof StateStoreError
      ? runtimeError(
        "production_state_failed",
        `Run transition ${transition.action} failed: ${result.code}.`,
        result,
      )
      : result;
  }

  private load(runId: string): StoredRun | ProductionRuntimeError {
    const loaded = this.options.run_store.load(runId);
    return loaded instanceof StateStoreError
      ? runtimeError("production_state_failed", `Run ${runId} cannot be loaded: ${loaded.code}.`, loaded)
      : loaded;
  }

  private closeFailure(runId: string, error: ProductionRuntimeError): ProductionRuntimeError {
    const loaded = this.options.run_store.load(runId);
    if (
      loaded instanceof StateStoreError ||
      loaded.state.status === "NEEDS_USER" ||
      loaded.state.status === "DONE" ||
      loaded.state.status === "ABORTED"
    ) {
      return error;
    }
    const occurredAt = this.timestamp();
    if (occurredAt instanceof ProductionRuntimeError) {
      return error;
    }
    const closed = this.options.run_store.compareAndSwap(runId, loaded.state.state_version, {
      action: "close_production_failure",
      to: "NEEDS_USER",
      updates: {
        last_error: {
          code: error.code,
          message: error.message,
          occurred_at: occurredAt,
          last_successful_status: loaded.state.status,
        },
      },
    });
    return closed instanceof StateStoreError
      ? runtimeError(
        "production_state_failed",
        `Production failure closure could not be persisted: ${closed.code}.`,
        closed,
      )
      : error;
  }

  private timestamp(): string | ProductionRuntimeError {
    try {
      const value = this.now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new TypeError("clock returned an invalid Date");
      }
      return value.toISOString();
    } catch (error: unknown) {
      return runtimeError("production_run_invalid", "Production Orchestrator clock is invalid.", error);
    }
  }

  private delayPoll(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, this.pollIntervalMs);
    });
  }
}
