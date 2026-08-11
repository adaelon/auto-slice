import {
  ModelPolicyError,
  ModelRouter,
  type HostModelCapability,
  type HostModelCapabilitySnapshot,
  type ModelInvocationDecision,
} from "../model-policy/index.js";
import { sha256Json } from "../state/index.js";
import {
  parseSliceContractV1,
  SliceExecutionError,
  type SliceContractV1,
} from "../slices/index.js";
import { ProductionPlanError } from "./errors.js";
import { buildDevelopmentPrompt, effectiveCommitMode } from "./prompt-builder.js";
import {
  PRODUCTION_PLAN_VERSION,
  type ProductionPlanV1,
  type ProductionSliceV1,
  type ResolvedProductionPlanV1,
} from "./types.js";

const MAXIMUM_SLICES = 128;
const MAXIMUM_INSTRUCTIONS_BYTES = 16 * 1024;
const MAXIMUM_OBJECTIVE_BYTES = 8 * 1024;
const MAXIMUM_EXCLUSION_BYTES = 4 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): ProductionPlanError {
  return new ProductionPlanError("production_plan_invalid", message);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in value)) {
      throw invalid(`${label} is missing '${key}'.`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`${label} contains unsupported field '${key}'.`);
    }
  }
}

function requireBoundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw invalid(`${label} must be a bounded UTF-8 string without NUL bytes.`);
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw invalid(`${label} must contain 1 through ${String(maximumBytes)} UTF-8 bytes.`);
  }
  return normalized;
}

function validateContractShape(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw invalid(`${label} must be a SliceContractV1 object.`);
  }
  assertExactKeys(
    value,
    ["contract_version", "objective", "exclusions", "owned_paths", "checks", "expected_artifacts"],
    ["slice_id", "id", "commit_mode_override"],
    label,
  );
  if (value.slice_id === undefined && value.id === undefined) {
    throw invalid(`${label} must contain slice_id or id.`);
  }
  if (Array.isArray(value.checks)) {
    for (const [index, check] of value.checks.entries()) {
      if (!isRecord(check)) {
        throw invalid(`${label}.checks[${String(index)}] must be an object.`);
      }
      assertExactKeys(
        check,
        ["id", "argv", "cwd", "timeout_ms", "env_allowlist", "expected_exit_code", "expected_artifacts"],
        [],
        `${label}.checks[${String(index)}]`,
      );
    }
  }
  if (Array.isArray(value.expected_artifacts)) {
    for (const [index, artifact] of value.expected_artifacts.entries()) {
      if (isRecord(artifact)) {
        assertExactKeys(
          artifact,
          ["path"],
          ["kind", "digest"],
          `${label}.expected_artifacts[${String(index)}]`,
        );
      }
    }
  }
  return value;
}

function parseContract(value: unknown, label: string): SliceContractV1 {
  const raw = validateContractShape(value, label);
  const parsed = parseSliceContractV1(raw);
  if (parsed instanceof SliceExecutionError) {
    const code = parsed.code === "path_outside_workspace"
      ? "path_outside_workspace"
      : "production_plan_invalid";
    throw new ProductionPlanError(code, `${label}: ${parsed.message}`, { cause: parsed });
  }
  requireBoundedText(parsed.objective, `${label}.objective`, MAXIMUM_OBJECTIVE_BYTES);
  for (const [index, exclusion] of parsed.exclusions.entries()) {
    requireBoundedText(
      exclusion,
      `${label}.exclusions[${String(index)}]`,
      MAXIMUM_EXCLUSION_BYTES,
    );
  }
  return parsed;
}

function parseCapability(value: unknown, index: number): HostModelCapability {
  const label = `model_capabilities.models[${String(index)}]`;
  if (!isRecord(value)) {
    throw invalid(`${label} must be an object.`);
  }
  assertExactKeys(value, ["model", "reasoning_efforts"], [], label);
  if (
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !Array.isArray(value.reasoning_efforts) ||
    value.reasoning_efforts.some((effort) => typeof effort !== "string")
  ) {
    throw invalid(`${label} has invalid model capability fields.`);
  }
  const reasoningEfforts: string[] = [];
  for (const effort of value.reasoning_efforts as readonly unknown[]) {
    if (typeof effort !== "string") {
      throw invalid(`${label}.reasoning_efforts must contain only strings.`);
    }
    reasoningEfforts.push(effort);
  }
  return {
    model: value.model,
    reasoning_efforts: reasoningEfforts,
  };
}

function parseCapabilities(value: unknown): HostModelCapabilitySnapshot {
  if (!isRecord(value)) {
    throw invalid("model_capabilities must be a HostModelCapabilitySnapshot object.");
  }
  assertExactKeys(
    value,
    ["schema_version", "source", "captured_at", "expires_at", "models"],
    [],
    "model_capabilities",
  );
  if (
    value.schema_version !== 1 ||
    typeof value.source !== "string" ||
    value.source.trim().length === 0 ||
    typeof value.captured_at !== "string" ||
    typeof value.expires_at !== "string" ||
    !Array.isArray(value.models)
  ) {
    throw invalid("model_capabilities is not a schema v1 capability snapshot.");
  }
  const capturedAt = new Date(value.captured_at);
  const expiresAt = new Date(value.expires_at);
  if (
    !Number.isFinite(capturedAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    capturedAt.toISOString() !== value.captured_at ||
    expiresAt.toISOString() !== value.expires_at
  ) {
    throw invalid("model_capabilities timestamps must use canonical ISO-8601 UTC form.");
  }
  return {
    schema_version: 1,
    source: value.source,
    captured_at: value.captured_at,
    expires_at: value.expires_at,
    models: value.models.map(parseCapability),
  };
}

function requireModelDecision(
  router: ModelRouter,
  role: "DEVELOPMENT" | "CONTINUATION" | "COMPRESSION",
  capabilities: HostModelCapabilitySnapshot,
): ModelInvocationDecision {
  const decision = router.resolve(role, capabilities);
  if (decision instanceof ModelPolicyError) {
    throw new ProductionPlanError(
      "model_policy_unavailable",
      `${role} model policy is unavailable: ${decision.reason}.`,
      { cause: decision, reason: decision.reason },
    );
  }
  if (decision.mode !== "model") {
    throw new ProductionPlanError(
      "model_policy_unavailable",
      `${role} unexpectedly resolved without a model.`,
    );
  }
  return decision;
}

function parseSlice(value: unknown, index: number): ProductionSliceV1 {
  const label = `slices[${String(index)}]`;
  if (!isRecord(value)) {
    throw invalid(`${label} must be a ProductionSliceV1 object.`);
  }
  assertExactKeys(value, ["contract", "instructions"], [], label);
  return {
    contract: parseContract(value.contract, `${label}.contract`),
    instructions: requireBoundedText(
      value.instructions,
      `${label}.instructions`,
      MAXIMUM_INSTRUCTIONS_BYTES,
    ),
  } satisfies ProductionSliceV1;
}

export function parseProductionPlanV1(
  value: unknown,
  now: () => Date = () => new Date(),
): ResolvedProductionPlanV1 | ProductionPlanError {
  try {
    if (!isRecord(value)) {
      throw invalid("ProductionPlanV1 must be an object.");
    }
    assertExactKeys(
      value,
      ["schema_version", "run_id", "commit_mode", "model_capabilities", "slices"],
      [],
      "ProductionPlanV1",
    );
    if (value.schema_version !== PRODUCTION_PLAN_VERSION) {
      throw invalid("ProductionPlanV1 must use schema_version 1.");
    }
    if (
      typeof value.run_id !== "string" ||
      !RUN_ID_PATTERN.test(value.run_id) ||
      Buffer.byteLength(value.run_id, "utf8") > 256
    ) {
      throw invalid("run_id must be a stable identifier of at most 256 UTF-8 bytes.");
    }
    if (value.commit_mode !== "after_slice" && value.commit_mode !== "none") {
      throw invalid("commit_mode must be after_slice or none.");
    }
    if (!Array.isArray(value.slices) || value.slices.length === 0 || value.slices.length > MAXIMUM_SLICES) {
      throw invalid(`slices must contain 1 through ${String(MAXIMUM_SLICES)} ordered entries.`);
    }
    const capabilities = parseCapabilities(value.model_capabilities);
    const slices = value.slices.map(parseSlice);
    if (new Set(slices.map((slice) => slice.contract.slice_id)).size !== slices.length) {
      throw invalid("ProductionPlanV1 Slice ids must be unique.");
    }
    const plan = {
      schema_version: PRODUCTION_PLAN_VERSION,
      run_id: value.run_id,
      commit_mode: value.commit_mode,
      model_capabilities: capabilities,
      slices,
    } satisfies ProductionPlanV1;
    for (const slice of slices) {
      const prompt = buildDevelopmentPrompt(
        slice,
        effectiveCommitMode(slice, plan.commit_mode),
      );
      if (prompt instanceof ProductionPlanError) {
        throw prompt;
      }
    }
    const router = new ModelRouter(now);
    return {
      plan,
      plan_digest: sha256Json(plan),
      development_model: requireModelDecision(router, "DEVELOPMENT", capabilities),
      continuation_model: requireModelDecision(router, "CONTINUATION", capabilities),
      compression_model: requireModelDecision(router, "COMPRESSION", capabilities),
    };
  } catch (error: unknown) {
    return error instanceof ProductionPlanError
      ? error
      : invalid(error instanceof Error ? error.message : String(error));
  }
}
