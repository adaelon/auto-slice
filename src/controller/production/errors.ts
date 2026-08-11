import type { ModelPolicyFailureReason } from "../model-policy/index.js";

export type ProductionPlanFailureCode =
  | "production_plan_invalid"
  | "path_outside_workspace"
  | "development_prompt_invalid"
  | "model_policy_unavailable";

export type ProductionRuntimeFailureCode =
  | "development_task_invalid"
  | "development_task_busy"
  | "app_server_spawn_failed"
  | "app_server_process_exited"
  | "app_server_protocol_error"
  | "app_server_request_failed"
  | "app_server_timeout"
  | "model_policy_unavailable"
  | "production_run_invalid"
  | "production_state_failed"
  | "workspace_guard_failed"
  | "slice_execution_failed"
  | "slice_verification_failed"
  | "slice_commit_failed"
  | "compaction_monitor_failed"
  | "compaction_probe_failed"
  | "source_interrupt_failed"
  | "handoff_export_failed"
  | "handoff_integrity_failed"
  | "continuation_start_failed";

export interface ProductionPlanErrorOptions extends ErrorOptions {
  readonly reason?: ModelPolicyFailureReason;
}

export class ProductionPlanError extends Error {
  public readonly code: ProductionPlanFailureCode;
  public readonly reason: ModelPolicyFailureReason | undefined;

  public constructor(
    code: ProductionPlanFailureCode,
    message: string,
    options: ProductionPlanErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ProductionPlanError";
    this.code = code;
    this.reason = options.reason;
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      code: this.code,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      message: this.message,
    };
  }
}

export class ProductionRuntimeError extends Error {
  public readonly code: ProductionRuntimeFailureCode;

  public constructor(
    code: ProductionRuntimeFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProductionRuntimeError";
    this.code = code;
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return { code: this.code, message: this.message };
  }
}
