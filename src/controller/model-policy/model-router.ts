import { ModelPolicyError } from "./errors.js";
import {
  MODEL_POLICY_SCHEMA_VERSION,
  type ModelDecision,
  type ModelInvocationDecision,
  type WorkRole,
} from "./types.js";

const DEVELOPMENT_DECISION = Object.freeze({
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
} as const satisfies ModelInvocationDecision);

const COMPRESSION_DECISION = Object.freeze({
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "medium",
} as const satisfies ModelInvocationDecision);

const NO_MODEL_DECISION = Object.freeze({
  mode: "none",
} as const satisfies ModelDecision);

export const MODEL_POLICY_TABLE: Readonly<Record<WorkRole, ModelDecision>> = Object.freeze({
  DEVELOPMENT: DEVELOPMENT_DECISION,
  CONTINUATION: DEVELOPMENT_DECISION,
  COMPRESSION: COMPRESSION_DECISION,
  DETERMINISTIC: NO_MODEL_DECISION,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkRole(value: unknown): value is WorkRole {
  return value === "DEVELOPMENT" ||
    value === "CONTINUATION" ||
    value === "COMPRESSION" ||
    value === "DETERMINISTIC";
}

function invalidSnapshot(message: string): ModelPolicyError {
  return new ModelPolicyError("invalid_capability_snapshot", message);
}

function parseCapabilitySnapshot(
  value: unknown,
  nowMilliseconds: number,
): ReadonlyMap<string, ReadonlySet<string>> | ModelPolicyError {
  if (!isRecord(value) || value.schema_version !== MODEL_POLICY_SCHEMA_VERSION) {
    return invalidSnapshot("Host model capabilities must be a schema v1 snapshot.");
  }
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    return invalidSnapshot("Host model capabilities must identify their source.");
  }
  if (typeof value.captured_at !== "string" || typeof value.expires_at !== "string") {
    return invalidSnapshot("Host model capabilities must contain captured_at and expires_at timestamps.");
  }
  const capturedAt = Date.parse(value.captured_at);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(expiresAt) || expiresAt <= capturedAt) {
    return invalidSnapshot("Host model capability timestamps are invalid or non-increasing.");
  }
  if (capturedAt > nowMilliseconds) {
    return new ModelPolicyError(
      "future_capability_snapshot",
      "Host model capabilities were captured in the future relative to the Router clock.",
    );
  }
  if (nowMilliseconds >= expiresAt) {
    return new ModelPolicyError(
      "expired_capability_snapshot",
      "Host model capabilities have expired.",
    );
  }
  if (!Array.isArray(value.models)) {
    return invalidSnapshot("Host model capabilities must contain a models array.");
  }

  const capabilities = new Map<string, ReadonlySet<string>>();
  for (const entry of value.models) {
    if (
      !isRecord(entry) ||
      typeof entry.model !== "string" ||
      entry.model.length === 0 ||
      !Array.isArray(entry.reasoning_efforts) ||
      entry.reasoning_efforts.length === 0 ||
      entry.reasoning_efforts.some((effort) => typeof effort !== "string" || effort.length === 0)
    ) {
      return invalidSnapshot("Every model capability must identify a model and at least one reasoning effort.");
    }
    if (capabilities.has(entry.model)) {
      return invalidSnapshot(`Host model capabilities contain duplicate model ${entry.model}.`);
    }
    const efforts = new Set(entry.reasoning_efforts);
    if (efforts.size !== entry.reasoning_efforts.length) {
      return invalidSnapshot(`Host model ${entry.model} contains duplicate reasoning efforts.`);
    }
    capabilities.set(entry.model, efforts);
  }
  return capabilities;
}

export class ModelRouter {
  public constructor(private readonly now: () => Date = () => new Date()) {}

  public resolve(role: unknown, capabilities: unknown): ModelDecision | ModelPolicyError {
    if (!isWorkRole(role)) {
      return new ModelPolicyError("unknown_role", "The work role has no frozen model policy.");
    }
    const decision = MODEL_POLICY_TABLE[role];
    if (decision.mode === "none") {
      return decision;
    }

    let observedAt: Date;
    try {
      observedAt = this.now();
    } catch (error: unknown) {
      return new ModelPolicyError("clock_unavailable", "The Router clock could not be read.", { cause: error });
    }
    const nowMilliseconds = observedAt.getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      return new ModelPolicyError("clock_unavailable", "The Router clock returned an invalid Date.");
    }

    const available = parseCapabilitySnapshot(capabilities, nowMilliseconds);
    if (available instanceof ModelPolicyError) {
      return available;
    }
    const efforts = available.get(decision.model);
    if (efforts === undefined) {
      return new ModelPolicyError(
        "model_unavailable",
        `The exact required model ${decision.model} is unavailable.`,
      );
    }
    if (!efforts.has(decision.effort)) {
      return new ModelPolicyError(
        "reasoning_effort_unavailable",
        `The exact required reasoning effort ${decision.effort} is unavailable for ${decision.model}.`,
      );
    }
    return decision;
  }
}
