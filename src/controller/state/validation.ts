import { RUN_STATUSES, RUN_STATE_SCHEMA_VERSION } from "./types.js";
import { StateStoreError } from "./errors.js";
import type {
  EffectIdempotencyKey,
  RunFailureState,
  RunHandoffState,
  RunCompactionState,
  RunState,
  Sha256Digest,
  StateStoreFailureCode,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);

function fail(code: StateStoreFailureCode, message: string): never {
  throw new StateStoreError(code, message);
}

function asRecord(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(code, `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  code: StateStoreFailureCode,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!(key in record)) {
      fail(code, `${label} is missing '${key}'.`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(code, `${label} contains unsupported field '${key}'.`);
    }
  }
}

function requireString(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail(code, `${label} must be a non-empty string.`);
  }
  return value;
}

function requireNullableString(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, label, code);
}

function requireNonNegativeInteger(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(code, `${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireTimestamp(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string {
  const timestamp = requireString(value, label, code);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    return fail(code, `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return timestamp;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function requireSha256Digest(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): Sha256Digest {
  if (!isSha256Digest(value)) {
    return fail(code, `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function requireRunId(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string {
  const runId = requireString(value, label, code);
  if (Buffer.byteLength(runId, "utf8") > 256) {
    return fail(code, `${label} cannot exceed 256 UTF-8 bytes.`);
  }
  return runId;
}

function decodeCompaction(
  value: unknown,
  code: StateStoreFailureCode,
): RunCompactionState {
  const record = asRecord(value, "RunState.compaction", code);
  assertExactKeys(
    record,
    ["compaction_id", "observed_started_at", "deadline_at", "handoff_attempted"],
    [],
    "RunState.compaction",
    code,
  );
  requireString(record.compaction_id, "RunState.compaction.compaction_id", code);
  requireTimestamp(record.observed_started_at, "RunState.compaction.observed_started_at", code);
  requireTimestamp(record.deadline_at, "RunState.compaction.deadline_at", code);
  if (typeof record.handoff_attempted !== "boolean") {
    fail(code, "RunState.compaction.handoff_attempted must be boolean.");
  }
  return record as unknown as RunCompactionState;
}

function decodeHandoff(value: unknown, code: StateStoreFailureCode): RunHandoffState {
  const record = asRecord(value, "RunState.handoff", code);
  assertExactKeys(
    record,
    ["compression_task_id", "markdown_path", "evidence_index_path", "artifact_digest"],
    ["continuation_task_id"],
    "RunState.handoff",
    code,
  );
  requireString(record.compression_task_id, "RunState.handoff.compression_task_id", code);
  requireString(record.markdown_path, "RunState.handoff.markdown_path", code);
  requireString(record.evidence_index_path, "RunState.handoff.evidence_index_path", code);
  requireSha256Digest(record.artifact_digest, "RunState.handoff.artifact_digest", code);
  if (record.continuation_task_id !== undefined) {
    requireString(record.continuation_task_id, "RunState.handoff.continuation_task_id", code);
  }
  return record as unknown as RunHandoffState;
}

function decodeFailure(value: unknown, code: StateStoreFailureCode): RunFailureState {
  const record = asRecord(value, "RunState.last_error", code);
  assertExactKeys(
    record,
    ["code", "message", "occurred_at", "last_successful_status"],
    ["details"],
    "RunState.last_error",
    code,
  );
  requireString(record.code, "RunState.last_error.code", code);
  requireString(record.message, "RunState.last_error.message", code);
  requireTimestamp(record.occurred_at, "RunState.last_error.occurred_at", code);
  if (typeof record.last_successful_status !== "string" || !RUN_STATUS_SET.has(record.last_successful_status)) {
    fail(code, "RunState.last_error.last_successful_status is invalid.");
  }
  if (record.details !== undefined) {
    const details = asRecord(record.details, "RunState.last_error.details", code);
    for (const [key, detail] of Object.entries(details)) {
      requireString(key, "RunState.last_error.details key", code);
      requireString(detail, `RunState.last_error.details.${key}`, code);
    }
  }
  return record as unknown as RunFailureState;
}

function decodeSliceCommitModeOverrides(
  value: unknown,
  code: StateStoreFailureCode,
): Readonly<Record<string, "after_slice" | "none">> {
  const record = asRecord(value, "RunState.slice_commit_mode_overrides", code);
  for (const [sliceId, mode] of Object.entries(record)) {
    requireString(sliceId, "RunState.slice_commit_mode_overrides key", code);
    if (mode !== "after_slice" && mode !== "none") {
      fail(code, `RunState.slice_commit_mode_overrides.${sliceId} has an invalid mode.`);
    }
  }
  return record as Readonly<Record<string, "after_slice" | "none">>;
}

export function decodeRunState(
  value: unknown,
  code: StateStoreFailureCode = "state_corrupt",
): RunState {
  const record = asRecord(value, "RunState", code);
  assertExactKeys(
    record,
    [
      "schema_version",
      "run_id",
      "state_version",
      "workspace_identity",
      "plan_digest",
      "status",
      "commit_mode",
      "current_slice_id",
      "protected_baseline_digest",
      "project_lock_owner",
      "write_epoch",
      "source_thread_id",
    ],
    [
      "compaction",
      "handoff",
      "last_error",
      "paused_from_status",
      "slice_commit_mode_overrides",
    ],
    "RunState",
    code,
  );
  if (record.schema_version !== RUN_STATE_SCHEMA_VERSION) {
    fail(code, `Unsupported RunState schema version: ${String(record.schema_version)}.`);
  }
  requireRunId(record.run_id, "RunState.run_id", code);
  requireNonNegativeInteger(record.state_version, "RunState.state_version", code);
  const workspace = asRecord(record.workspace_identity, "RunState.workspace_identity", code);
  assertExactKeys(
    workspace,
    ["canonical_root", "filesystem_identity"],
    [],
    "RunState.workspace_identity",
    code,
  );
  requireString(workspace.canonical_root, "RunState.workspace_identity.canonical_root", code);
  requireString(workspace.filesystem_identity, "RunState.workspace_identity.filesystem_identity", code);
  requireSha256Digest(record.plan_digest, "RunState.plan_digest", code);
  if (typeof record.status !== "string" || !RUN_STATUS_SET.has(record.status)) {
    fail(code, `Unsupported RunState status: ${String(record.status)}.`);
  }
  if (record.commit_mode !== "after_slice" && record.commit_mode !== "none") {
    fail(code, `Unsupported RunState commit mode: ${String(record.commit_mode)}.`);
  }
  requireNullableString(record.current_slice_id, "RunState.current_slice_id", code);
  requireSha256Digest(record.protected_baseline_digest, "RunState.protected_baseline_digest", code);
  requireNullableString(record.project_lock_owner, "RunState.project_lock_owner", code);
  requireNonNegativeInteger(record.write_epoch, "RunState.write_epoch", code);
  requireNullableString(record.source_thread_id, "RunState.source_thread_id", code);
  if (record.compaction !== undefined) {
    decodeCompaction(record.compaction, code);
  }
  if (record.handoff !== undefined) {
    decodeHandoff(record.handoff, code);
  }
  if (record.last_error !== undefined) {
    decodeFailure(record.last_error, code);
  }
  if (
    record.paused_from_status !== undefined &&
    (typeof record.paused_from_status !== "string" ||
      !RUN_STATUS_SET.has(record.paused_from_status) ||
      record.paused_from_status === "PAUSED" ||
      record.paused_from_status === "NEEDS_USER" ||
      record.paused_from_status === "DONE" ||
      record.paused_from_status === "ABORTED")
  ) {
    fail(code, "RunState.paused_from_status is not a resumable Run status.");
  }
  if (record.slice_commit_mode_overrides !== undefined) {
    decodeSliceCommitModeOverrides(record.slice_commit_mode_overrides, code);
  }
  return record as unknown as RunState;
}

export function decodeEffectIdempotencyKey(
  value: unknown,
  code: StateStoreFailureCode = "state_corrupt",
): EffectIdempotencyKey {
  const record = asRecord(value, "EffectIdempotencyKey", code);
  assertExactKeys(
    record,
    ["digest", "run_id", "state_version", "action", "stable_target_id"],
    [],
    "EffectIdempotencyKey",
    code,
  );
  requireSha256Digest(record.digest, "EffectIdempotencyKey.digest", code);
  requireRunId(record.run_id, "EffectIdempotencyKey.run_id", code);
  requireNonNegativeInteger(record.state_version, "EffectIdempotencyKey.state_version", code);
  requireString(record.action, "EffectIdempotencyKey.action", code);
  requireString(record.stable_target_id, "EffectIdempotencyKey.stable_target_id", code);
  return record as unknown as EffectIdempotencyKey;
}

export function requireIsoTimestamp(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string {
  return requireTimestamp(value, label, code);
}

export function requireSafeInteger(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): number {
  return requireNonNegativeInteger(value, label, code);
}

export function requireNonEmptyString(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): string {
  return requireString(value, label, code);
}

export function requireRecord(
  value: unknown,
  label: string,
  code: StateStoreFailureCode,
): Record<string, unknown> {
  return asRecord(value, label, code);
}

export function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  code: StateStoreFailureCode,
): void {
  assertExactKeys(record, required, optional, label, code);
}
