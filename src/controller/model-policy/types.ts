export const MODEL_POLICY_SCHEMA_VERSION = 1 as const;

export type WorkRole =
  | "DEVELOPMENT"
  | "CONTINUATION"
  | "COMPRESSION"
  | "DETERMINISTIC";

export type ModelPolicyEffort = "max" | "medium";

export interface ModelInvocationDecision {
  readonly mode: "model";
  readonly model: "gpt-5.6-sol";
  readonly effort: ModelPolicyEffort;
}

export interface NoModelDecision {
  readonly mode: "none";
}

export type ModelDecision = ModelInvocationDecision | NoModelDecision;

export interface HostModelCapability {
  readonly model: string;
  readonly reasoning_efforts: readonly string[];
}

export interface HostModelCapabilitySnapshot {
  readonly schema_version: typeof MODEL_POLICY_SCHEMA_VERSION;
  readonly source: string;
  readonly captured_at: string;
  readonly expires_at: string;
  readonly models: readonly HostModelCapability[];
}

export type ModelPolicyFailureCode = "model_policy_unavailable";

export type ModelPolicyFailureReason =
  | "unknown_role"
  | "invalid_capability_snapshot"
  | "future_capability_snapshot"
  | "expired_capability_snapshot"
  | "model_unavailable"
  | "reasoning_effort_unavailable"
  | "clock_unavailable";

export interface ModelPolicyFailure {
  readonly code: ModelPolicyFailureCode;
  readonly reason: ModelPolicyFailureReason;
}

export interface HostModelCapabilityAdapter {
  snapshot(): HostModelCapabilitySnapshot | ModelPolicyFailure;
}
