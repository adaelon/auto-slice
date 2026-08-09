import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson, sha256Json } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
import { ensureStateStoreSchema } from "./schema.js";
import { isRunTransitionAllowed } from "./transitions.js";
import {
  RUN_STATUSES,
  RUN_STORE_SCHEMA_VERSION,
  type EffectIdempotencyKey,
  type EffectRecord,
  type FileRunStoreOptions,
  type RunEventRecord,
  type RunReplayReport,
  type RunState,
  type RunStateUpdates,
  type RunTransition,
  type Sha256Digest,
  type StateStoreFailureCode,
  type StoredRun,
} from "./types.js";
import {
  decodeEffectIdempotencyKey,
  decodeRunState,
  requireExactKeys,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireRecord,
  requireRunId,
  requireSafeInteger,
  requireSha256Digest,
} from "./validation.js";

const EVENT_FILENAME_PATTERN = /^(\d{20})\.json$/u;
const EFFECT_DIRECTORY_PATTERN = /^[0-9a-f]{64}$/u;
const TEMPORARY_FILENAME_PATTERN = /^\..+\.tmp$/u;
const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);

interface RunEventMaterial {
  readonly schema_version: typeof RUN_STORE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly event_index: number;
  readonly event_kind: "RUN_CREATED" | "STATE_TRANSITION";
  readonly action: string;
  readonly occurred_at: string;
  readonly previous_event_digest: Sha256Digest | null;
  readonly before_state: RunState | null;
  readonly before_state_digest: Sha256Digest | null;
  readonly after_state: RunState;
  readonly after_state_digest: Sha256Digest;
}

interface RunSnapshotMaterial {
  readonly schema_version: typeof RUN_STORE_SCHEMA_VERSION;
  readonly run_id: string;
  readonly state: RunState;
  readonly state_digest: Sha256Digest;
  readonly event_count: number;
  readonly event_head_digest: Sha256Digest;
}

interface RunSnapshotRecord extends RunSnapshotMaterial {
  readonly snapshot_digest: Sha256Digest;
}

interface ReplayResult {
  readonly events: readonly RunEventRecord[];
  readonly states: readonly RunState[];
  readonly state: RunState;
  readonly event_head_digest: Sha256Digest;
}

interface EffectIntentMaterial {
  readonly schema_version: typeof RUN_STORE_SCHEMA_VERSION;
  readonly event_kind: "EFFECT_INTENDED";
  readonly idempotency_key: EffectIdempotencyKey;
  readonly payload_digest: Sha256Digest;
  readonly occurred_at: string;
}

interface EffectIntentEvent extends EffectIntentMaterial {
  readonly event_digest: Sha256Digest;
}

interface EffectCompletionMaterial {
  readonly schema_version: typeof RUN_STORE_SCHEMA_VERSION;
  readonly event_kind: "EFFECT_COMPLETED";
  readonly idempotency_key_digest: Sha256Digest;
  readonly receipt_digest: Sha256Digest;
  readonly occurred_at: string;
  readonly previous_event_digest: Sha256Digest;
}

interface EffectCompletionEvent extends EffectCompletionMaterial {
  readonly event_digest: Sha256Digest;
}

type ParsedJson =
  | null
  | boolean
  | number
  | string
  | readonly ParsedJson[]
  | { readonly [key: string]: ParsedJson };

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asStoreError(error: unknown, operation: string): StateStoreError {
  if (error instanceof StateStoreError) {
    return error;
  }
  return new StateStoreError(
    "state_persist_failed",
    `${operation} failed: ${messageFrom(error)}`,
    { cause: error },
  );
}

function encodeRunDirectoryName(runId: string): string {
  requireRunId(runId, "run_id", "invalid_state");
  return Buffer.from(runId, "utf8").toString("base64url");
}

function eventFilename(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99_999_999_999_999_999_999) {
    throw new StateStoreError("invalid_state", `Event index is outside the supported range: ${String(index)}.`);
  }
  return `${String(index).padStart(20, "0")}.json`;
}

function readStrictJson(filePath: string, label: string): ParsedJson {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error: unknown) {
    throw new StateStoreError("state_persist_failed", `${label} cannot be read.`, { cause: error });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new StateStoreError("state_corrupt", `${label} is not valid UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text) as ParsedJson;
  } catch (error: unknown) {
    throw new StateStoreError("state_corrupt", `${label} is not valid JSON.`, { cause: error });
  }
}

function readOptionalJson(filePath: string, label: string): ParsedJson | undefined {
  try {
    return readStrictJson(filePath, label);
  } catch (error: unknown) {
    if (error instanceof StateStoreError && error.code === "state_persist_failed" && isErrno(error.cause, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function writeTemporaryFile(targetPath: string, payload: unknown): string {
  const directory = path.dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${canonicalJson(payload)}\n`, "utf8");
    fsyncSync(descriptor);
    return temporaryPath;
  } catch (error: unknown) {
    throw new StateStoreError("state_persist_failed", `Temporary state file cannot be written: ${targetPath}.`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeTemporaryFile(temporaryPath: string): void {
  try {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  } catch {
    // The canonical immutable file, if published, remains authoritative.
  }
}

function publishImmutableJson(targetPath: string, payload: unknown): boolean {
  const temporaryPath = writeTemporaryFile(targetPath, payload);
  try {
    linkSync(temporaryPath, targetPath);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "EEXIST")) {
      return false;
    }
    throw new StateStoreError("state_persist_failed", `Immutable state file cannot be published: ${targetPath}.`, {
      cause: error,
    });
  } finally {
    removeTemporaryFile(temporaryPath);
  }
}

function rewriteJsonAtomic(targetPath: string, payload: unknown): void {
  const temporaryPath = writeTemporaryFile(targetPath, payload);
  try {
    renameSync(temporaryPath, targetPath);
  } catch (error: unknown) {
    throw new StateStoreError("state_persist_failed", `State snapshot cannot be replaced: ${targetPath}.`, {
      cause: error,
    });
  } finally {
    removeTemporaryFile(temporaryPath);
  }
}

function createRunEvent(material: RunEventMaterial): RunEventRecord {
  return {
    ...material,
    event_digest: sha256Json(material),
  };
}

function decodeNullableDigest(
  value: unknown,
  label: string,
): Sha256Digest | null {
  return value === null ? null : requireSha256Digest(value, label, "state_corrupt");
}

function decodeNullableRunState(value: unknown): RunState | null {
  return value === null ? null : decodeRunState(value);
}

function decodeRunEvent(value: unknown, label: string): RunEventRecord {
  const record = requireRecord(value, label, "state_corrupt");
  requireExactKeys(
    record,
    [
      "schema_version",
      "run_id",
      "event_index",
      "event_kind",
      "action",
      "occurred_at",
      "previous_event_digest",
      "before_state",
      "before_state_digest",
      "after_state",
      "after_state_digest",
      "event_digest",
    ],
    [],
    label,
    "state_corrupt",
  );
  if (record.schema_version !== RUN_STORE_SCHEMA_VERSION) {
    throw new StateStoreError("unsupported_state_schema", `${label} has an unsupported schema version.`);
  }
  const runId = requireRunId(record.run_id, `${label}.run_id`, "state_corrupt");
  const eventIndex = requireSafeInteger(record.event_index, `${label}.event_index`, "state_corrupt");
  if (record.event_kind !== "RUN_CREATED" && record.event_kind !== "STATE_TRANSITION") {
    throw new StateStoreError("state_corrupt", `${label}.event_kind is invalid.`);
  }
  const eventKind = record.event_kind;
  const action = requireNonEmptyString(record.action, `${label}.action`, "state_corrupt");
  const occurredAt = requireIsoTimestamp(record.occurred_at, `${label}.occurred_at`, "state_corrupt");
  const previousEventDigest = decodeNullableDigest(
    record.previous_event_digest,
    `${label}.previous_event_digest`,
  );
  const beforeState = decodeNullableRunState(record.before_state);
  const beforeStateDigest = decodeNullableDigest(record.before_state_digest, `${label}.before_state_digest`);
  const afterState = decodeRunState(record.after_state);
  const afterStateDigest = requireSha256Digest(record.after_state_digest, `${label}.after_state_digest`, "state_corrupt");
  const eventDigest = requireSha256Digest(record.event_digest, `${label}.event_digest`, "state_corrupt");
  const material: RunEventMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    run_id: runId,
    event_index: eventIndex,
    event_kind: eventKind,
    action,
    occurred_at: occurredAt,
    previous_event_digest: previousEventDigest,
    before_state: beforeState,
    before_state_digest: beforeStateDigest,
    after_state: afterState,
    after_state_digest: afterStateDigest,
  };
  if (sha256Json(material) !== eventDigest) {
    throw new StateStoreError("state_corrupt", `${label} checksum does not match its content.`);
  }
  return { ...material, event_digest: eventDigest };
}

function createSnapshot(
  state: RunState,
  eventCount: number,
  eventHeadDigest: Sha256Digest,
): RunSnapshotRecord {
  const material: RunSnapshotMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    run_id: state.run_id,
    state,
    state_digest: sha256Json(state),
    event_count: eventCount,
    event_head_digest: eventHeadDigest,
  };
  return {
    ...material,
    snapshot_digest: sha256Json(material),
  };
}

function decodeSnapshot(value: unknown, label: string): RunSnapshotRecord {
  const record = requireRecord(value, label, "state_corrupt");
  requireExactKeys(
    record,
    [
      "schema_version",
      "run_id",
      "state",
      "state_digest",
      "event_count",
      "event_head_digest",
      "snapshot_digest",
    ],
    [],
    label,
    "state_corrupt",
  );
  if (record.schema_version !== RUN_STORE_SCHEMA_VERSION) {
    throw new StateStoreError("unsupported_state_schema", `${label} has an unsupported schema version.`);
  }
  const runId = requireRunId(record.run_id, `${label}.run_id`, "state_corrupt");
  const state = decodeRunState(record.state);
  const stateDigest = requireSha256Digest(record.state_digest, `${label}.state_digest`, "state_corrupt");
  const eventCount = requireSafeInteger(record.event_count, `${label}.event_count`, "state_corrupt");
  const eventHeadDigest = requireSha256Digest(record.event_head_digest, `${label}.event_head_digest`, "state_corrupt");
  const snapshotDigest = requireSha256Digest(record.snapshot_digest, `${label}.snapshot_digest`, "state_corrupt");
  const material: RunSnapshotMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    run_id: runId,
    state,
    state_digest: stateDigest,
    event_count: eventCount,
    event_head_digest: eventHeadDigest,
  };
  if (sha256Json(material) !== snapshotDigest || sha256Json(state) !== stateDigest) {
    throw new StateStoreError("state_corrupt", `${label} checksum does not match its content.`);
  }
  return { ...material, snapshot_digest: snapshotDigest };
}

function assertImmutableRunFields(before: RunState, after: RunState): void {
  if (
    before.run_id !== after.run_id ||
    canonicalJson(before.workspace_identity) !== canonicalJson(after.workspace_identity) ||
    before.plan_digest !== after.plan_digest ||
    before.protected_baseline_digest !== after.protected_baseline_digest
  ) {
    throw new StateStoreError("state_corrupt", "A state event changed immutable RunState fields.");
  }
}

function cloneRunState(value: RunState): RunState {
  return decodeRunState(JSON.parse(canonicalJson(value)) as unknown, "invalid_state");
}

function assertMetadataTransition(
  before: RunState,
  after: RunState,
  action: string,
  code: "invalid_transition" | "state_corrupt",
): void {
  if (before.status !== after.status) {
    return;
  }
  if (
    action !== "mark_handoff_attempted" ||
    before.status !== "HANDOFF_EXPORTING" ||
    before.compaction === undefined ||
    before.compaction.handoff_attempted ||
    after.compaction === undefined
  ) {
    throw new StateStoreError(code, "The same-state Run transition is not a valid Handoff attempt claim.");
  }
  const expected = {
    ...before,
    state_version: before.state_version + 1,
    compaction: {
      ...before.compaction,
      handoff_attempted: true,
    },
  } satisfies RunState;
  if (canonicalJson(after) !== canonicalJson(expected)) {
    throw new StateStoreError(
      code,
      "mark_handoff_attempted may only change compaction.handoff_attempted from false to true.",
    );
  }
}

function applyStateUpdates(state: RunState, transition: RunTransition): RunState {
  if (typeof transition.action !== "string" || transition.action.length === 0) {
    throw new StateStoreError("invalid_transition", "Run transition action must be a non-empty string.");
  }
  if (typeof transition.to !== "string" || !RUN_STATUS_SET.has(transition.to)) {
    throw new StateStoreError("invalid_transition", `Unknown Run status: ${transition.to}.`);
  }
  if (!isRunTransitionAllowed(state.status, transition.to, transition.action)) {
    throw new StateStoreError(
      "invalid_transition",
      `Run transition ${state.status} -> ${transition.to} is not allowed.`,
    );
  }

  const next = JSON.parse(canonicalJson(state)) as Record<string, unknown>;
  next.state_version = state.state_version + 1;
  next.status = transition.to;
  const updates: RunStateUpdates | undefined = transition.updates;
  if (updates !== undefined) {
    const allowedUpdateKeys = new Set([
      "commit_mode",
      "current_slice_id",
      "project_lock_owner",
      "write_epoch",
      "source_thread_id",
      "compaction",
      "handoff",
      "last_error",
    ]);
    for (const key of Object.keys(updates)) {
      if (!allowedUpdateKeys.has(key)) {
        throw new StateStoreError("invalid_transition", `Unsupported RunState update field: ${key}.`);
      }
    }
    for (const key of allowedUpdateKeys) {
      const value = updates[key as keyof RunStateUpdates];
      if (value === undefined) {
        continue;
      }
      if ((key === "compaction" || key === "handoff" || key === "last_error") && value === null) {
        Reflect.deleteProperty(next, key);
      } else {
        next[key] = value;
      }
    }
  }
  const decoded = decodeRunState(next, "invalid_state");
  assertMetadataTransition(state, decoded, transition.action, "invalid_transition");
  return decoded;
}

function createEffectIntentEvent(
  key: EffectIdempotencyKey,
  payloadDigest: Sha256Digest,
  occurredAt: string,
): EffectIntentEvent {
  const material: EffectIntentMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    event_kind: "EFFECT_INTENDED",
    idempotency_key: key,
    payload_digest: payloadDigest,
    occurred_at: occurredAt,
  };
  return { ...material, event_digest: sha256Json(material) };
}

function decodeEffectIntent(value: unknown, label: string): EffectIntentEvent {
  const record = requireRecord(value, label, "state_corrupt");
  requireExactKeys(
    record,
    ["schema_version", "event_kind", "idempotency_key", "payload_digest", "occurred_at", "event_digest"],
    [],
    label,
    "state_corrupt",
  );
  if (record.schema_version !== RUN_STORE_SCHEMA_VERSION || record.event_kind !== "EFFECT_INTENDED") {
    throw new StateStoreError("state_corrupt", `${label} has invalid effect intent metadata.`);
  }
  const key = validateEffectIdempotencyKey(decodeEffectIdempotencyKey(record.idempotency_key));
  const payloadDigest = requireSha256Digest(record.payload_digest, `${label}.payload_digest`, "state_corrupt");
  const occurredAt = requireIsoTimestamp(record.occurred_at, `${label}.occurred_at`, "state_corrupt");
  const eventDigest = requireSha256Digest(record.event_digest, `${label}.event_digest`, "state_corrupt");
  const material: EffectIntentMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    event_kind: "EFFECT_INTENDED",
    idempotency_key: key,
    payload_digest: payloadDigest,
    occurred_at: occurredAt,
  };
  if (sha256Json(material) !== eventDigest) {
    throw new StateStoreError("state_corrupt", `${label} checksum does not match its content.`);
  }
  return { ...material, event_digest: eventDigest };
}

function createEffectCompletionEvent(
  intent: EffectIntentEvent,
  receiptDigest: Sha256Digest,
  occurredAt: string,
): EffectCompletionEvent {
  const material: EffectCompletionMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    event_kind: "EFFECT_COMPLETED",
    idempotency_key_digest: intent.idempotency_key.digest,
    receipt_digest: receiptDigest,
    occurred_at: occurredAt,
    previous_event_digest: intent.event_digest,
  };
  return { ...material, event_digest: sha256Json(material) };
}

function decodeEffectCompletion(value: unknown, label: string): EffectCompletionEvent {
  const record = requireRecord(value, label, "state_corrupt");
  requireExactKeys(
    record,
    [
      "schema_version",
      "event_kind",
      "idempotency_key_digest",
      "receipt_digest",
      "occurred_at",
      "previous_event_digest",
      "event_digest",
    ],
    [],
    label,
    "state_corrupt",
  );
  if (record.schema_version !== RUN_STORE_SCHEMA_VERSION || record.event_kind !== "EFFECT_COMPLETED") {
    throw new StateStoreError("state_corrupt", `${label} has invalid effect completion metadata.`);
  }
  const idempotencyKeyDigest = requireSha256Digest(
    record.idempotency_key_digest,
    `${label}.idempotency_key_digest`,
    "state_corrupt",
  );
  const receiptDigest = requireSha256Digest(record.receipt_digest, `${label}.receipt_digest`, "state_corrupt");
  const occurredAt = requireIsoTimestamp(record.occurred_at, `${label}.occurred_at`, "state_corrupt");
  const previousEventDigest = requireSha256Digest(
    record.previous_event_digest,
    `${label}.previous_event_digest`,
    "state_corrupt",
  );
  const eventDigest = requireSha256Digest(record.event_digest, `${label}.event_digest`, "state_corrupt");
  const material: EffectCompletionMaterial = {
    schema_version: RUN_STORE_SCHEMA_VERSION,
    event_kind: "EFFECT_COMPLETED",
    idempotency_key_digest: idempotencyKeyDigest,
    receipt_digest: receiptDigest,
    occurred_at: occurredAt,
    previous_event_digest: previousEventDigest,
  };
  if (sha256Json(material) !== eventDigest) {
    throw new StateStoreError("state_corrupt", `${label} checksum does not match its content.`);
  }
  return { ...material, event_digest: eventDigest };
}

function effectRecord(intent: EffectIntentEvent, completion?: EffectCompletionEvent): EffectRecord {
  if (completion === undefined) {
    return {
      idempotency_key: intent.idempotency_key,
      status: "INTENDED",
      payload_digest: intent.payload_digest,
      intent_event_digest: intent.event_digest,
      intended_at: intent.occurred_at,
    };
  }
  if (
    completion.idempotency_key_digest !== intent.idempotency_key.digest ||
    completion.previous_event_digest !== intent.event_digest
  ) {
    throw new StateStoreError("state_corrupt", "Effect completion does not follow its intent.");
  }
  return {
    idempotency_key: intent.idempotency_key,
    status: "COMPLETED",
    payload_digest: intent.payload_digest,
    intent_event_digest: intent.event_digest,
    intended_at: intent.occurred_at,
    receipt_digest: completion.receipt_digest,
    completion_event_digest: completion.event_digest,
    completed_at: completion.occurred_at,
  };
}

function validateEffectIdempotencyKey(
  key: EffectIdempotencyKey,
  code: StateStoreFailureCode = "state_corrupt",
): EffectIdempotencyKey {
  const decoded = decodeEffectIdempotencyKey(key, code);
  const material = {
    run_id: decoded.run_id,
    state_version: decoded.state_version,
    action: decoded.action,
    stable_target_id: decoded.stable_target_id,
  };
  if (sha256Json(material) !== decoded.digest) {
    throw new StateStoreError(code, "Effect idempotency key digest does not match its fields.");
  }
  return decoded;
}

export function createEffectIdempotencyKey(
  runId: string,
  stateVersion: number,
  action: string,
  stableTargetId: string,
): EffectIdempotencyKey {
  requireRunId(runId, "run_id", "invalid_state");
  requireSafeInteger(stateVersion, "state_version", "invalid_state");
  requireNonEmptyString(action, "action", "invalid_state");
  requireNonEmptyString(stableTargetId, "stable_target_id", "invalid_state");
  const material = {
    run_id: runId,
    state_version: stateVersion,
    action,
    stable_target_id: stableTargetId,
  };
  return {
    digest: sha256Json(material),
    ...material,
  };
}

export class FileRunStore {
  private readonly now: () => Date;
  private readonly faultInjector: FileRunStoreOptions["faultInjector"];
  private readonly corruptRuns = new Set<string>();

  private constructor(
    private readonly storageRoot: string,
    options: FileRunStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
  }

  public static open(
    requestedStorageRoot: string,
    options: FileRunStoreOptions = {},
  ): FileRunStore | StateStoreError {
    try {
      const storageRoot = path.resolve(requestedStorageRoot);
      ensureStateStoreSchema(storageRoot);
      return new FileRunStore(storageRoot, options);
    } catch (error: unknown) {
      return asStoreError(error, "Opening the state store");
    }
  }

  public create(initialState: RunState): StoredRun | StateStoreError {
    const runId = typeof initialState.run_id === "string" ? initialState.run_id : "<invalid>";
    return this.captureForRun(runId, true, () => this.createOrThrow(initialState));
  }

  public load(runId: string): StoredRun | StateStoreError {
    return this.captureForRun(runId, false, () => this.loadOrThrow(runId));
  }

  public compareAndSwap(
    runId: string,
    expectedVersion: number,
    transition: RunTransition,
  ): StoredRun | StateStoreError {
    return this.captureForRun(runId, true, () => {
      requireSafeInteger(expectedVersion, "expected_version", "invalid_transition");
      const current = this.loadOrThrow(runId, false);
      if (current.state.state_version !== expectedVersion) {
        throw new StateStoreError(
          "stale_state",
          `Expected state_version ${String(expectedVersion)}, found ${String(current.state.state_version)}.`,
        );
      }
      const nextState = applyStateUpdates(current.state, transition);
      const event = createRunEvent({
        schema_version: RUN_STORE_SCHEMA_VERSION,
        run_id: runId,
        event_index: nextState.state_version,
        event_kind: "STATE_TRANSITION",
        action: transition.action,
        occurred_at: this.timestamp(),
        previous_event_digest: current.event_head_digest,
        before_state: current.state,
        before_state_digest: sha256Json(current.state),
        after_state: nextState,
        after_state_digest: sha256Json(nextState),
      });
      const eventPath = path.join(this.eventsDirectory(runId), eventFilename(event.event_index));
      if (!publishImmutableJson(eventPath, event)) {
        throw new StateStoreError("stale_state", "Another writer committed the requested state_version first.");
      }
      this.triggerFault("after_run_event_persisted", {
        run_id: runId,
        state_version: nextState.state_version,
      });
      const snapshot = createSnapshot(nextState, current.event_count + 1, event.event_digest);
      rewriteJsonAtomic(this.snapshotPath(runId), snapshot);
      return this.toStoredRun(snapshot, false);
    });
  }

  public appendEffectIntent(
    requestedKey: EffectIdempotencyKey,
    requestedPayloadDigest: Sha256Digest,
  ): EffectRecord | StateStoreError {
    const runId = typeof requestedKey.run_id === "string" ? requestedKey.run_id : "<invalid>";
    return this.captureForRun(runId, true, () => {
      const key = validateEffectIdempotencyKey(requestedKey, "invalid_state");
      const payloadDigest = requireSha256Digest(
        requestedPayloadDigest,
        "payload_digest",
        "invalid_state",
      );
      const existing = this.readEffectRecord(key);
      if (existing !== undefined) {
        if (existing.payload_digest !== payloadDigest) {
          throw new StateStoreError("state_corrupt", "An idempotency key was reused with a different payload.");
        }
        return existing;
      }
      const run = this.loadOrThrow(key.run_id, false);
      if (run.state.state_version !== key.state_version) {
        throw new StateStoreError(
          "stale_state",
          `Effect intent targets state_version ${String(key.state_version)}, found ${String(run.state.state_version)}.`,
        );
      }
      const intent = createEffectIntentEvent(key, payloadDigest, this.timestamp());
      const intentPath = path.join(this.effectDirectory(key), "intent.json");
      if (!publishImmutableJson(intentPath, intent)) {
        const winner = this.readEffectRecord(key);
        if (winner === undefined || winner.payload_digest !== payloadDigest) {
          throw new StateStoreError("state_corrupt", "Concurrent effect intents disagree for one idempotency key.");
        }
        return winner;
      }
      this.triggerFault("after_effect_intent_persisted", {
        run_id: key.run_id,
        state_version: key.state_version,
        idempotency_key: key.digest,
      });
      return effectRecord(intent);
    });
  }

  public completeEffect(
    requestedKey: EffectIdempotencyKey,
    requestedReceiptDigest: Sha256Digest,
  ): EffectRecord | StateStoreError {
    const runId = typeof requestedKey.run_id === "string" ? requestedKey.run_id : "<invalid>";
    return this.captureForRun(runId, true, () => {
      const key = validateEffectIdempotencyKey(requestedKey, "invalid_state");
      const receiptDigest = requireSha256Digest(
        requestedReceiptDigest,
        "receipt_digest",
        "invalid_state",
      );
      this.loadOrThrow(key.run_id, false);
      const intentValue = readOptionalJson(
        path.join(this.effectDirectory(key), "intent.json"),
        "Effect intent",
      );
      if (intentValue === undefined) {
        throw new StateStoreError("state_corrupt", "An effect cannot complete without a persisted intent.");
      }
      const intent = decodeEffectIntent(intentValue, "Effect intent");
      if (canonicalJson(intent.idempotency_key) !== canonicalJson(key)) {
        throw new StateStoreError("state_corrupt", "Persisted effect intent key does not match its path.");
      }
      const existingValue = readOptionalJson(
        path.join(this.effectDirectory(key), "completion.json"),
        "Effect completion",
      );
      if (existingValue !== undefined) {
        const existing = decodeEffectCompletion(existingValue, "Effect completion");
        const record = effectRecord(intent, existing);
        if (record.receipt_digest !== receiptDigest) {
          throw new StateStoreError("state_corrupt", "An effect completion was replayed with a different receipt.");
        }
        return record;
      }
      const completion = createEffectCompletionEvent(intent, receiptDigest, this.timestamp());
      const completionPath = path.join(this.effectDirectory(key), "completion.json");
      if (!publishImmutableJson(completionPath, completion)) {
        const winnerValue = readStrictJson(completionPath, "Effect completion");
        const winner = effectRecord(intent, decodeEffectCompletion(winnerValue, "Effect completion"));
        if (winner.receipt_digest !== receiptDigest) {
          throw new StateStoreError("state_corrupt", "Concurrent effect completions disagree for one idempotency key.");
        }
        return winner;
      }
      this.triggerFault("after_effect_completion_persisted", {
        run_id: key.run_id,
        state_version: key.state_version,
        idempotency_key: key.digest,
      });
      return effectRecord(intent, completion);
    });
  }

  public recoverIncompleteEffects(runId: string): readonly EffectRecord[] | StateStoreError {
    return this.captureForRun(runId, false, () => {
      this.loadOrThrow(runId);
      const effectsDirectory = this.effectsDirectory(runId);
      if (!existsSync(effectsDirectory)) {
        return [];
      }
      const records: EffectRecord[] = [];
      const entries = readdirSync(effectsDirectory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      for (const entry of entries) {
        if (!entry.isDirectory() || !EFFECT_DIRECTORY_PATTERN.test(entry.name)) {
          throw new StateStoreError("state_corrupt", `Unexpected entry in effect ledger: ${entry.name}.`);
        }
        const record = this.readEffectRecordFromDirectory(path.join(effectsDirectory, entry.name), entry.name);
        if (record !== undefined && record.status === "INTENDED") {
          records.push(record);
        }
      }
      return records.sort((left, right) =>
        left.idempotency_key.digest.localeCompare(right.idempotency_key.digest),
      );
    });
  }

  public replayRunEvents(runId: string): RunReplayReport | StateStoreError {
    return this.captureForRun(runId, false, () => {
      const replay = this.replayOrThrow(runId);
      return {
        run_id: runId,
        state: replay.state,
        state_digest: sha256Json(replay.state),
        event_count: replay.events.length,
        event_head_digest: replay.event_head_digest,
      };
    });
  }

  public inspectRunEvents(runId: string): readonly RunEventRecord[] | StateStoreError {
    return this.captureForRun(runId, false, () => this.replayOrThrow(runId).events);
  }

  private captureForRun<T>(
    runId: string,
    mutation: boolean,
    operation: () => T,
  ): T | StateStoreError {
    if (mutation && this.corruptRuns.has(runId)) {
      return new StateStoreError(
        "state_corrupt",
        `Run '${runId}' is in read-only diagnostic mode.`,
      );
    }
    try {
      return operation();
    } catch (error: unknown) {
      const storeError = asStoreError(error, "State store operation");
      if (storeError.code === "state_corrupt") {
        this.corruptRuns.add(runId);
      }
      return storeError;
    }
  }

  private createOrThrow(initialState: RunState): StoredRun {
    const state = cloneRunState(initialState);
    if (
      state.state_version !== 0 ||
      state.status !== "IDLE"
    ) {
      throw new StateStoreError(
        "invalid_state",
        "A new RunState must use schema_version 1, state_version 0, and status IDLE.",
      );
    }
    const event = createRunEvent({
      schema_version: RUN_STORE_SCHEMA_VERSION,
      run_id: state.run_id,
      event_index: 0,
      event_kind: "RUN_CREATED",
      action: "create_run",
      occurred_at: this.timestamp(),
      previous_event_digest: null,
      before_state: null,
      before_state_digest: null,
      after_state: state,
      after_state_digest: sha256Json(state),
    });
    const eventPath = path.join(this.eventsDirectory(state.run_id), eventFilename(0));
    if (!publishImmutableJson(eventPath, event)) {
      throw new StateStoreError("run_already_exists", `Run '${state.run_id}' already exists.`);
    }
    this.triggerFault("after_run_event_persisted", {
      run_id: state.run_id,
      state_version: 0,
    });
    const snapshot = createSnapshot(state, 1, event.event_digest);
    rewriteJsonAtomic(this.snapshotPath(state.run_id), snapshot);
    return this.toStoredRun(snapshot, false);
  }

  private loadOrThrow(runId: string, repairSnapshot = true): StoredRun {
    const replay = this.replayOrThrow(runId);
    const snapshotValue = readOptionalJson(this.snapshotPath(runId), "Run snapshot");
    if (snapshotValue === undefined) {
      const recovered = createSnapshot(replay.state, replay.events.length, replay.event_head_digest);
      if (repairSnapshot) {
        rewriteJsonAtomic(this.snapshotPath(runId), recovered);
      }
      return this.toStoredRun(recovered, true);
    }
    const snapshot = decodeSnapshot(snapshotValue, "Run snapshot");
    if (snapshot.run_id !== runId || snapshot.state.run_id !== runId) {
      throw new StateStoreError("state_corrupt", "Run snapshot identity does not match its directory.");
    }
    const snapshotVersion = snapshot.state.state_version;
    const historicalState = replay.states[snapshotVersion];
    const historicalEvent = replay.events[snapshotVersion];
    if (historicalState === undefined || historicalEvent === undefined) {
      throw new StateStoreError("state_corrupt", "Run snapshot is ahead of the append-only event log.");
    }
    if (
      snapshot.event_count !== snapshotVersion + 1 ||
      snapshot.state_digest !== sha256Json(historicalState) ||
      snapshot.event_head_digest !== historicalEvent.event_digest ||
      canonicalJson(snapshot.state) !== canonicalJson(historicalState)
    ) {
      throw new StateStoreError("state_corrupt", "Run snapshot is not a valid event-log prefix.");
    }
    if (snapshotVersion === replay.state.state_version) {
      return this.toStoredRun(snapshot, false);
    }
    const recovered = createSnapshot(replay.state, replay.events.length, replay.event_head_digest);
    if (repairSnapshot) {
      rewriteJsonAtomic(this.snapshotPath(runId), recovered);
    }
    return this.toStoredRun(recovered, true);
  }

  private replayOrThrow(runId: string): ReplayResult {
    requireRunId(runId, "run_id", "invalid_state");
    const runDirectory = this.runDirectory(runId);
    if (!existsSync(runDirectory)) {
      throw new StateStoreError("run_not_found", `Run '${runId}' does not exist.`);
    }
    const eventsDirectory = this.eventsDirectory(runId);
    if (!existsSync(eventsDirectory) || !statSync(eventsDirectory).isDirectory()) {
      throw new StateStoreError("state_corrupt", `Run '${runId}' has no event directory.`);
    }
    const filenames = readdirSync(eventsDirectory).filter((entry) => {
      if (TEMPORARY_FILENAME_PATTERN.test(entry)) {
        return false;
      }
      if (!EVENT_FILENAME_PATTERN.test(entry)) {
        throw new StateStoreError("state_corrupt", `Unexpected event-log entry: ${entry}.`);
      }
      return true;
    }).sort();
    if (filenames.length === 0) {
      throw new StateStoreError("state_corrupt", `Run '${runId}' has an empty event log.`);
    }

    const events: RunEventRecord[] = [];
    const states: RunState[] = [];
    let previousState: RunState | null = null;
    let previousEventDigest: Sha256Digest | null = null;
    for (const [index, filename] of filenames.entries()) {
      if (filename !== eventFilename(index)) {
        throw new StateStoreError("state_corrupt", `Run event sequence is broken at index ${String(index)}.`);
      }
      const event = decodeRunEvent(
        readStrictJson(path.join(eventsDirectory, filename), `Run event ${filename}`),
        `Run event ${filename}`,
      );
      if (event.run_id !== runId || event.event_index !== index) {
        throw new StateStoreError("state_corrupt", `Run event ${filename} has the wrong identity or index.`);
      }
      if (index === 0) {
        if (
          event.event_kind !== "RUN_CREATED" ||
          event.action !== "create_run" ||
          event.previous_event_digest !== null ||
          event.before_state !== null ||
          event.before_state_digest !== null ||
          event.after_state.state_version !== 0 ||
          event.after_state.status !== "IDLE"
        ) {
          throw new StateStoreError("state_corrupt", "The first Run event is not a valid creation event.");
        }
      } else {
        if (
          previousState === null ||
          previousEventDigest === null ||
          event.event_kind !== "STATE_TRANSITION" ||
          event.previous_event_digest !== previousEventDigest ||
          event.before_state === null ||
          event.before_state_digest !== sha256Json(previousState) ||
          canonicalJson(event.before_state) !== canonicalJson(previousState) ||
          event.after_state.state_version !== previousState.state_version + 1 ||
          !isRunTransitionAllowed(
            previousState.status,
            event.after_state.status,
            event.action,
          )
        ) {
          throw new StateStoreError("state_corrupt", `Run event ${filename} breaks the event chain.`);
        }
        assertMetadataTransition(
          previousState,
          event.after_state,
          event.action,
          "state_corrupt",
        );
        assertImmutableRunFields(previousState, event.after_state);
      }
      if (
        event.after_state.run_id !== runId ||
        event.after_state_digest !== sha256Json(event.after_state)
      ) {
        throw new StateStoreError("state_corrupt", `Run event ${filename} has an invalid after-state digest.`);
      }
      events.push(event);
      states.push(event.after_state);
      previousState = event.after_state;
      previousEventDigest = event.event_digest;
    }
    if (previousState === null || previousEventDigest === null) {
      throw new StateStoreError("state_corrupt", `Run '${runId}' could not be replayed.`);
    }
    return {
      events,
      states,
      state: previousState,
      event_head_digest: previousEventDigest,
    };
  }

  private readEffectRecord(key: EffectIdempotencyKey): EffectRecord | undefined {
    return this.readEffectRecordFromDirectory(
      this.effectDirectory(key),
      key.digest.slice("sha256:".length),
      key,
    );
  }

  private readEffectRecordFromDirectory(
    effectDirectory: string,
    expectedDirectoryName: string,
    expectedKey?: EffectIdempotencyKey,
  ): EffectRecord | undefined {
    if (!existsSync(effectDirectory)) {
      return undefined;
    }
    const entries = readdirSync(effectDirectory).filter((entry) => !TEMPORARY_FILENAME_PATTERN.test(entry));
    for (const entry of entries) {
      if (entry !== "intent.json" && entry !== "completion.json") {
        throw new StateStoreError("state_corrupt", `Unexpected effect-ledger entry: ${entry}.`);
      }
    }
    const intentValue = readOptionalJson(path.join(effectDirectory, "intent.json"), "Effect intent");
    if (intentValue === undefined) {
      if (entries.length === 0) {
        return undefined;
      }
      throw new StateStoreError("state_corrupt", "Effect ledger contains a completion without an intent.");
    }
    const intent = decodeEffectIntent(intentValue, "Effect intent");
    if (intent.idempotency_key.digest.slice("sha256:".length) !== expectedDirectoryName) {
      throw new StateStoreError("state_corrupt", "Effect directory does not match its idempotency key.");
    }
    if (
      expectedKey !== undefined &&
      canonicalJson(intent.idempotency_key) !== canonicalJson(expectedKey)
    ) {
      throw new StateStoreError("state_corrupt", "Effect intent does not match the requested idempotency key.");
    }
    const completionValue = readOptionalJson(
      path.join(effectDirectory, "completion.json"),
      "Effect completion",
    );
    return effectRecord(
      intent,
      completionValue === undefined
        ? undefined
        : decodeEffectCompletion(completionValue, "Effect completion"),
    );
  }

  private runDirectory(runId: string): string {
    return path.join(this.storageRoot, "runs", encodeRunDirectoryName(runId));
  }

  private eventsDirectory(runId: string): string {
    return path.join(this.runDirectory(runId), "events");
  }

  private snapshotPath(runId: string): string {
    return path.join(this.runDirectory(runId), "snapshot.json");
  }

  private effectsDirectory(runId: string): string {
    return path.join(this.runDirectory(runId), "effects");
  }

  private effectDirectory(key: EffectIdempotencyKey): string {
    return path.join(this.effectsDirectory(key.run_id), key.digest.slice("sha256:".length));
  }

  private timestamp(): string {
    const timestamp = this.now().toISOString();
    requireIsoTimestamp(timestamp, "clock", "state_persist_failed");
    return timestamp;
  }

  private triggerFault(
    point: Parameters<NonNullable<FileRunStoreOptions["faultInjector"]>>[0],
    context: Parameters<NonNullable<FileRunStoreOptions["faultInjector"]>>[1],
  ): void {
    this.faultInjector?.(point, context);
  }

  private toStoredRun(snapshot: RunSnapshotRecord, recovered: boolean): StoredRun {
    return {
      state: snapshot.state,
      event_count: snapshot.event_count,
      event_head_digest: snapshot.event_head_digest,
      snapshot_digest: snapshot.snapshot_digest,
      recovered_from_event_log: recovered,
    };
  }
}
