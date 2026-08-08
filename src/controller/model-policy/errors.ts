import type {
  ModelPolicyFailure,
  ModelPolicyFailureCode,
  ModelPolicyFailureReason,
} from "./types.js";

export class ModelPolicyError extends Error implements ModelPolicyFailure {
  public readonly code: ModelPolicyFailureCode = "model_policy_unavailable";

  public constructor(
    public readonly reason: ModelPolicyFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelPolicyError";
  }
}
