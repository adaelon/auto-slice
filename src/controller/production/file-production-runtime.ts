import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import {
  canonicalizeWorkspaceRoot,
  createWorkspaceIdentity,
  isWithinWorkspace,
} from "../../contracts/workspace-identity.js";
import {
  CompactionMonitor,
  SystemClock,
  TimeoutDeadlineScheduler,
} from "../compaction-monitor/index.js";
import {
  ControlPlaneError,
  openFileControlPlane,
} from "../control-plane/index.js";
import { ContinuationCoordinator, type ContinuationLauncher } from "../continuation/index.js";
import {
  CompressionHandoffCoordinator,
  type CompressionTaskLauncher,
} from "../handoff/index.js";
import { FileRunStore, sha256Json, StateStoreError } from "../state/index.js";
import {
  SourceInterruptionCoordinator,
  type ThreadControlPort,
} from "../thread-control/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
} from "../workspace/index.js";
import { ProductionPlanError, ProductionRuntimeError } from "./errors.js";
import { parseProductionPlanV1 } from "./plan-parser.js";
import {
  ProductionOrchestrator,
  productionSliceBindingDigest,
} from "./production-orchestrator.js";
import type {
  DevelopmentTaskPort,
  ProductionRunDecision,
} from "./types.js";

const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 10_000;

const LEASE_ACTIVE_STATUSES = new Set([
  "PREPARING",
  "SLICE_RUNNING",
  "COMPACTION_WAIT",
  "SOURCE_INTERRUPTING",
  "HANDOFF_EXPORTING",
  "CONTINUATION_STARTING",
  "VERIFYING",
  "COMMITTING",
  "CHECKPOINTING",
]);

export interface ProductionTaskHostPorts {
  readonly development_tasks: DevelopmentTaskPort;
  readonly thread_control: ThreadControlPort;
  readonly compression_launcher: CompressionTaskLauncher;
  readonly continuation_launcher: ContinuationLauncher;
  dispose(): Promise<void>;
}

export interface RunProductionPlanFileOptions {
  readonly plan_path: string;
  readonly workspace_root: string;
  readonly storage_root?: string;
  readonly task_host: ProductionTaskHostPorts;
  readonly now?: () => Date;
  readonly lease_duration_ms?: number;
  readonly lease_renew_interval_ms?: number;
}

export interface ProductionFileRunReceipt {
  readonly workspace_identity: WorkspaceIdentity;
  readonly storage_root: string;
  readonly decision: ProductionRunDecision;
}

type ProductionFileRunResult =
  | ProductionFileRunReceipt
  | ProductionPlanError
  | ProductionRuntimeError;

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

function readProductionPlan(planPath: string): unknown {
  try {
    const bytes = readFileSync(path.resolve(planPath));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return new ProductionPlanError(
      "production_plan_invalid",
      `Production Plan cannot be read as strict UTF-8 JSON: ${path.resolve(planPath)}.`,
      { cause: error },
    );
  }
}

function workspaceDigest(identity: WorkspaceIdentity): string {
  const digest = identity.filesystem_identity.split(":").at(-1);
  return digest !== undefined && /^[a-f0-9]{64}$/u.test(digest)
    ? digest
    : sha256Json(identity).slice("sha256:".length);
}

export function defaultProductionStorageRoot(identity: WorkspaceIdentity): string {
  return path.join(
    os.homedir(),
    ".codex",
    "auto-slice",
    "workspaces",
    workspaceDigest(identity),
  );
}

function validateTiming(
  leaseDurationMs: number,
  renewIntervalMs: number,
): ProductionRuntimeError | null {
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    !Number.isSafeInteger(renewIntervalMs) ||
    leaseDurationMs <= 0 ||
    renewIntervalMs <= 0 ||
    renewIntervalMs * 2 >= leaseDurationMs
  ) {
    return runtimeError(
      "production_run_invalid",
      "Lease timing requires positive safe integers with at least two renewal intervals per lease.",
    );
  }
  return null;
}

class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failure: ProductionRuntimeError | null = null;

  public constructor(
    private readonly runId: string,
    private readonly runStore: FileRunStore,
    private readonly workspaceGuard: FileWorkspaceGuard,
    private readonly taskHost: ProductionTaskHostPorts,
    private readonly intervalMs: number,
  ) {}

  public start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  public stop(): ProductionRuntimeError | null {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.failure;
  }

  private tick(): void {
    if (this.failure !== null) {
      return;
    }
    const stored = this.runStore.load(this.runId);
    if (stored instanceof StateStoreError) {
      this.fail(runtimeError(
        "production_state_failed",
        `Project Write Lease heartbeat cannot load Run ${this.runId}: ${stored.code}.`,
        stored,
      ));
      return;
    }
    const owner = stored.state.project_lock_owner;
    if (owner === null || !LEASE_ACTIVE_STATUSES.has(stored.state.status)) {
      return;
    }
    const renewed = this.workspaceGuard.renew(owner, stored.state.write_epoch);
    if (renewed instanceof WorkspaceGuardError) {
      this.fail(runtimeError(
        "workspace_guard_failed",
        `Project Write Lease renewal failed: ${renewed.code}.`,
        renewed,
      ));
    }
  }

  private fail(error: ProductionRuntimeError): void {
    this.failure = error;
    void this.taskHost.dispose();
  }
}

function mapControlFailure(error: ControlPlaneError): ProductionRuntimeError {
  const code = error.code === "project_lock_unavailable"
    ? "workspace_guard_failed"
    : "production_state_failed";
  return runtimeError(code, `Production Run start was rejected: ${error.code}.`, error);
}

async function executeProductionPlanFile(
  options: RunProductionPlanFileOptions,
): Promise<ProductionFileRunResult> {
  let workspaceIdentity: WorkspaceIdentity;
  try {
    workspaceIdentity = createWorkspaceIdentity(
      canonicalizeWorkspaceRoot(options.workspace_root),
    );
  } catch (error: unknown) {
    return runtimeError(
      "production_run_invalid",
      `Production workspace cannot be addressed: ${options.workspace_root}.`,
      error,
    );
  }

  const storageRoot = path.resolve(
    options.storage_root ?? defaultProductionStorageRoot(workspaceIdentity),
  );
  if (isWithinWorkspace(workspaceIdentity.canonical_root, storageRoot)) {
    return runtimeError(
      "production_run_invalid",
      "Production state storage must be outside the verified workspace.",
    );
  }

  const leaseDurationMs = options.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS;
  const renewIntervalMs = options.lease_renew_interval_ms ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
  const timingFailure = validateTiming(leaseDurationMs, renewIntervalMs);
  if (timingFailure !== null) {
    return timingFailure;
  }

  const rawPlan = readProductionPlan(options.plan_path);
  if (rawPlan instanceof ProductionPlanError) {
    return rawPlan;
  }
  const now = options.now ?? (() => new Date());
  const resolved = parseProductionPlanV1(rawPlan, now);
  if (resolved instanceof ProductionPlanError) {
    return resolved;
  }

  const runStore = FileRunStore.open(storageRoot, { now });
  if (runStore instanceof StateStoreError) {
    return runtimeError(
      "production_state_failed",
      `Production state storage cannot be opened: ${runStore.code}.`,
      runStore,
    );
  }
  const workspaceGuard = FileWorkspaceGuard.open(storageRoot, {
    now,
    leaseDurationMs,
  });
  if (workspaceGuard instanceof WorkspaceGuardError) {
    return runtimeError(
      "workspace_guard_failed",
      `Production workspace guard cannot be opened: ${workspaceGuard.code}.`,
      workspaceGuard,
    );
  }
  const controlPlane = openFileControlPlane(storageRoot, now);
  if (controlPlane instanceof ControlPlaneError) {
    return mapControlFailure(controlPlane);
  }
  const firstSlice = resolved.plan.slices[0];
  if (firstSlice === undefined) {
    return runtimeError("production_run_invalid", "Production Plan has no first Slice.");
  }
  const startCommandId = `run-plan-${sha256Json({
    plan_digest: resolved.plan_digest,
    workspace_identity: workspaceIdentity,
  }).slice("sha256:".length)}`;
  const started = controlPlane.execute("start", {
    command_id: startCommandId,
    payload: {
      run_id: resolved.plan.run_id,
      workspace_identity: workspaceIdentity,
      plan_digest: resolved.plan_digest,
      protected_baseline_digest: productionSliceBindingDigest(
        resolved.plan_digest,
        firstSlice.contract.slice_id,
      ),
      commit_mode: resolved.plan.commit_mode,
      first_slice_id: firstSlice.contract.slice_id,
    },
  });
  if (started instanceof ControlPlaneError) {
    return mapControlFailure(started);
  }
  if (started.outcome !== "OK" || started.snapshot?.status !== "PREPARING") {
    return runtimeError(
      started.error?.code === "project_lock_unavailable"
        ? "workspace_guard_failed"
        : "production_state_failed",
      `Production Run start did not enter PREPARING (${started.error?.code ?? started.outcome}).`,
    );
  }

  const clock = new SystemClock();
  const monitor = new CompactionMonitor({
    run_store: runStore,
    clock,
    scheduler: new TimeoutDeadlineScheduler(clock),
    observability: {
      stable_compaction_ids: true,
      structured_phase_events: true,
      ordered_host_sequence: true,
    },
  });
  const sourceInterruption = new SourceInterruptionCoordinator({
    run_store: runStore,
    workspace_guard: workspaceGuard,
    thread_control: options.task_host.thread_control,
    now,
  });
  const handoff = new CompressionHandoffCoordinator({
    run_store: runStore,
    launcher: options.task_host.compression_launcher,
    now,
  });
  const continuation = new ContinuationCoordinator({
    run_store: runStore,
    workspace_guard: workspaceGuard,
    launcher: options.task_host.continuation_launcher,
    now,
  });
  const orchestrator = new ProductionOrchestrator({
    run_store: runStore,
    workspace_guard: workspaceGuard,
    development_tasks: options.task_host.development_tasks,
    compaction_monitor: monitor,
    source_interruption: sourceInterruption,
    handoff,
    continuation,
    now,
  });
  const heartbeat = new LeaseHeartbeat(
    resolved.plan.run_id,
    runStore,
    workspaceGuard,
    options.task_host,
    renewIntervalMs,
  );
  heartbeat.start();
  const decision = await orchestrator.run(resolved);
  const heartbeatFailure = heartbeat.stop();
  if (decision instanceof ProductionRuntimeError) {
    return decision;
  }
  if (heartbeatFailure !== null) {
    return heartbeatFailure;
  }
  return {
    workspace_identity: workspaceIdentity,
    storage_root: storageRoot,
    decision,
  };
}

export async function runProductionPlanFile(
  options: RunProductionPlanFileOptions,
): Promise<ProductionFileRunResult> {
  let result: ProductionFileRunResult;
  try {
    result = await executeProductionPlanFile(options);
  } catch (error: unknown) {
    result = runtimeError(
      "production_run_invalid",
      "Production runtime failed outside its deterministic error boundary.",
      error,
    );
  }
  try {
    await options.task_host.dispose();
  } catch (error: unknown) {
    if (!(result instanceof ProductionPlanError) && !(result instanceof ProductionRuntimeError)) {
      return runtimeError(
        "app_server_process_exited",
        "Production task host disposal failed.",
        error,
      );
    }
  }
  return result;
}
