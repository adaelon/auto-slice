import { randomUUID } from "node:crypto";

import type { ModelDecision, ModelInvocationDecision } from "../model-policy/index.js";
import { canonicalJson, sha256Json } from "../state/index.js";
import {
  GitChangeGuard,
  WorkspaceGuardError,
  type ProjectLease,
} from "../workspace/index.js";
import { parseSliceContractV1 } from "./contract-parser.js";
import { SliceExecutionError } from "./errors.js";
import { CheckProcessRunner } from "./process-runner.js";
import {
  SLICE_EXECUTION_SCHEMA_VERSION,
  type ExecutionId,
  type ExecutionReceipt,
  type SliceContractV1,
  type WriteLeasePort,
} from "./types.js";

interface ExecutionContext {
  readonly contract: SliceContractV1;
  readonly contractDigest: `sha256:${string}`;
  readonly lease: ProjectLease;
  readonly modelDecision: ModelInvocationDecision;
  readonly protectedBaseline: import("../workspace/index.js").ProtectedBaseline;
  readonly startedAt: string;
  status: "READY" | "COLLECTING" | "COLLECTED";
}

export interface SliceExecutorOptions {
  readonly leaseGuard: WriteLeasePort;
  readonly changeGuard?: GitChangeGuard;
  readonly processRunner?: CheckProcessRunner;
  readonly now?: () => Date;
  readonly executionIdFactory?: () => string;
}

function validDevelopmentDecision(value: unknown): value is ModelInvocationDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const decision = value as Readonly<Record<string, unknown>>;
  return decision.mode === "model" &&
    decision.model === "gpt-5.6-sol" &&
    decision.effort === "max";
}

function validTime(now: () => Date): string | SliceExecutionError {
  try {
    const value = now();
    if (!Number.isFinite(value.getTime())) {
      return new SliceExecutionError("workspace_inspection_failed", "Slice Executor clock returned an invalid Date.");
    }
    return value.toISOString();
  } catch (error: unknown) {
    return new SliceExecutionError(
      "workspace_inspection_failed",
      "Slice Executor clock could not be read.",
      { cause: error },
    );
  }
}

function executionReceiptDigest(
  receipt: Omit<ExecutionReceipt, "receipt_digest">,
): `sha256:${string}` {
  return sha256Json(receipt);
}

export class SliceExecutor {
  private readonly changeGuard: GitChangeGuard;
  private readonly processRunner: CheckProcessRunner;
  private readonly now: () => Date;
  private readonly executionIdFactory: () => string;
  private readonly executions = new Map<string, ExecutionContext>();

  public constructor(private readonly options: SliceExecutorOptions) {
    this.changeGuard = options.changeGuard ?? new GitChangeGuard();
    this.processRunner = options.processRunner ?? new CheckProcessRunner();
    this.now = options.now ?? (() => new Date());
    this.executionIdFactory = options.executionIdFactory ?? randomUUID;
  }

  public start(
    rawContract: unknown,
    lease: ProjectLease,
    modelDecision: ModelDecision,
  ): ExecutionId | SliceExecutionError {
    const contract = parseSliceContractV1(rawContract);
    if (contract instanceof SliceExecutionError) {
      return contract;
    }
    if (!validDevelopmentDecision(modelDecision)) {
      return new SliceExecutionError(
        "model_decision_invalid",
        "Slice development requires the exact DEVELOPMENT model decision.",
      );
    }
    const currentLease = this.options.leaseGuard.assertWritable(lease.lease_id, lease.epoch);
    if (currentLease instanceof WorkspaceGuardError) {
      return new SliceExecutionError(
        "write_capability_unavailable",
        `Project Write Lease is not writable: ${currentLease.code}.`,
        { cause: currentLease },
      );
    }
    if (
      currentLease.run_id !== lease.run_id ||
      currentLease.lease_id !== lease.lease_id ||
      currentLease.epoch !== lease.epoch ||
      canonicalJson(currentLease.workspace_identity) !== canonicalJson(lease.workspace_identity)
    ) {
      return new SliceExecutionError(
        "write_capability_unavailable",
        "Project Write Lease identity changed before Slice start.",
      );
    }
    const protectedBaseline = this.changeGuard.captureBaseline(currentLease.workspace_identity);
    if (protectedBaseline instanceof WorkspaceGuardError) {
      return new SliceExecutionError(
        "workspace_inspection_failed",
        `Protected Change baseline could not be captured: ${protectedBaseline.code}.`,
        { cause: protectedBaseline },
      );
    }
    const startedAt = validTime(this.now);
    if (startedAt instanceof SliceExecutionError) {
      return startedAt;
    }
    let executionId: string;
    try {
      executionId = this.executionIdFactory();
    } catch (error: unknown) {
      return new SliceExecutionError(
        "workspace_inspection_failed",
        "Execution ID factory failed.",
        { cause: error },
      );
    }
    if (executionId.trim().length === 0 || this.executions.has(executionId)) {
      return new SliceExecutionError(
        "workspace_inspection_failed",
        "Execution ID must be non-empty and unique.",
      );
    }
    this.executions.set(executionId, {
      contract,
      contractDigest: sha256Json(contract),
      lease: currentLease,
      modelDecision,
      protectedBaseline,
      startedAt,
      status: "READY",
    });
    return {
      schema_version: SLICE_EXECUTION_SCHEMA_VERSION,
      execution_id: executionId,
      slice_id: contract.slice_id,
    };
  }

  public async collect(execution: ExecutionId): Promise<ExecutionReceipt | SliceExecutionError> {
    const context = this.executions.get(execution.execution_id);
    if (
      context === undefined ||
      execution.slice_id !== context.contract.slice_id
    ) {
      return new SliceExecutionError("execution_not_found", "Execution ID is unknown or malformed.");
    }
    if (context.status !== "READY") {
      return new SliceExecutionError(
        "execution_already_collected",
        "Execution collection has already started or completed.",
      );
    }
    context.status = "COLLECTING";
    const checkReceipts = [];
    for (const check of context.contract.checks) {
      const leaseFailure = this.assertLease(context.lease);
      if (leaseFailure !== null) {
        context.status = "COLLECTED";
        return leaseFailure;
      }
      checkReceipts.push(await this.processRunner.run(check, context.lease.workspace_identity));
    }
    const leaseFailure = this.assertLease(context.lease);
    if (leaseFailure !== null) {
      context.status = "COLLECTED";
      return leaseFailure;
    }
    const workspaceSnapshot = this.changeGuard.captureCurrent(context.lease.workspace_identity);
    if (workspaceSnapshot instanceof WorkspaceGuardError) {
      context.status = "COLLECTED";
      return new SliceExecutionError(
        "workspace_inspection_failed",
        `Workspace snapshot could not be captured: ${workspaceSnapshot.code}.`,
        { cause: workspaceSnapshot },
      );
    }
    const completedAt = validTime(this.now);
    if (completedAt instanceof SliceExecutionError) {
      context.status = "COLLECTED";
      return completedAt;
    }
    const material: Omit<ExecutionReceipt, "receipt_digest"> = {
      schema_version: SLICE_EXECUTION_SCHEMA_VERSION,
      execution_id: execution.execution_id,
      slice_id: context.contract.slice_id,
      contract_digest: context.contractDigest,
      run_id: context.lease.run_id,
      lease_id: context.lease.lease_id,
      write_epoch: context.lease.epoch,
      workspace_identity: context.lease.workspace_identity,
      model_decision: context.modelDecision,
      started_at: context.startedAt,
      completed_at: completedAt,
      check_receipts: checkReceipts,
      protected_baseline: context.protectedBaseline,
      workspace_snapshot: workspaceSnapshot,
    };
    context.status = "COLLECTED";
    return {
      ...material,
      receipt_digest: executionReceiptDigest(material),
    };
  }

  private assertLease(lease: ProjectLease): SliceExecutionError | null {
    const current = this.options.leaseGuard.assertWritable(lease.lease_id, lease.epoch);
    if (current instanceof WorkspaceGuardError) {
      return new SliceExecutionError(
        "write_capability_unavailable",
        `Project Write Lease became unavailable: ${current.code}.`,
        { cause: current },
      );
    }
    if (
      current.run_id !== lease.run_id ||
      current.lease_id !== lease.lease_id ||
      current.epoch !== lease.epoch ||
      canonicalJson(current.workspace_identity) !== canonicalJson(lease.workspace_identity)
    ) {
      return new SliceExecutionError(
        "write_capability_unavailable",
        "Project Write Lease changed during Slice execution.",
      );
    }
    return null;
  }
}
