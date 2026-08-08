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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import { canonicalJson, sha256Bytes, sha256Json, type Sha256Digest } from "../state/index.js";
import { WorkspaceGuardError } from "./errors.js";
import {
  WORKSPACE_GUARD_SCHEMA_VERSION,
  type FileWorkspaceGuardOptions,
  type FrozenLease,
  type LeaseEventAction,
  type LeaseEventRecord,
  type LeaseState,
  type ProjectLease,
  type ReleasedLease,
} from "./types.js";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_CAS_ATTEMPTS = 16;

interface LeaseLocator {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly workspace_key: string;
  readonly initial_event: LeaseEventRecord;
}

interface LoadedLeaseHistory {
  readonly locator: LeaseLocator;
  readonly events: readonly LeaseEventRecord[];
  readonly state: LeaseState;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new WorkspaceGuardError(
      "workspace_guard_corrupt",
      `${label} must be a safe integer greater than or equal to ${String(minimum)}.`,
    );
  }
  return value as number;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  const digest = requireString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be a SHA-256 digest.`);
  }
  return digest as Sha256Digest;
}

function parseWorkspaceIdentity(value: unknown, label: string): WorkspaceIdentity {
  if (!isRecord(value)) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be an object.`);
  }
  return {
    canonical_root: requireString(value.canonical_root, `${label}.canonical_root`),
    filesystem_identity: requireString(value.filesystem_identity, `${label}.filesystem_identity`),
  };
}

function parseLeaseState(value: unknown, label: string): LeaseState {
  if (!isRecord(value)) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be an object.`);
  }
  if (value.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} has an unsupported schema version.`);
  }
  const base = {
    schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
    lease_id: requireString(value.lease_id, `${label}.lease_id`),
    workspace_identity: parseWorkspaceIdentity(value.workspace_identity, `${label}.workspace_identity`),
    run_id: requireString(value.run_id, `${label}.run_id`),
    epoch: requireInteger(value.epoch, `${label}.epoch`, 1),
    revision: requireInteger(value.revision, `${label}.revision`, 0),
    acquired_at: requireTimestamp(value.acquired_at, `${label}.acquired_at`),
    renewed_at: requireTimestamp(value.renewed_at, `${label}.renewed_at`),
    expires_at: requireTimestamp(value.expires_at, `${label}.expires_at`),
  };
  if (value.status === "ACTIVE") {
    return { ...base, status: "ACTIVE" };
  }
  if (value.status === "FROZEN") {
    return {
      ...base,
      status: "FROZEN",
      frozen_at: requireTimestamp(value.frozen_at, `${label}.frozen_at`),
    };
  }
  if (value.status === "RELEASED") {
    return {
      ...base,
      status: "RELEASED",
      released_at: requireTimestamp(value.released_at, `${label}.released_at`),
    };
  }
  throw new WorkspaceGuardError("workspace_guard_corrupt", `${label}.status is invalid.`);
}

function parseEventAction(value: unknown, label: string): LeaseEventAction {
  if (
    value === "ACQUIRED" ||
    value === "RENEWED" ||
    value === "FROZEN" ||
    value === "EPOCH_ROTATED" ||
    value === "RELEASED"
  ) {
    return value;
  }
  throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} is invalid.`);
}

function createLeaseEvent(
  action: LeaseEventAction,
  occurredAt: string,
  beforeState: LeaseState | null,
  previousEventDigest: Sha256Digest | null,
  afterState: LeaseState,
): LeaseEventRecord {
  const material = {
    schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
    lease_id: afterState.lease_id,
    event_index: afterState.revision,
    action,
    occurred_at: occurredAt,
    previous_event_digest: previousEventDigest,
    before_state: beforeState,
    before_state_digest: beforeState === null ? null : sha256Json(beforeState),
    after_state: afterState,
    after_state_digest: sha256Json(afterState),
  };
  return {
    ...material,
    event_digest: sha256Json(material),
  };
}

function parseLeaseEvent(value: unknown, label: string): LeaseEventRecord {
  if (!isRecord(value)) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} must be an object.`);
  }
  if (value.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} has an unsupported schema version.`);
  }
  const beforeState = value.before_state === null ? null : parseLeaseState(value.before_state, `${label}.before_state`);
  const previousEventDigest = value.previous_event_digest === null
    ? null
    : requireDigest(value.previous_event_digest, `${label}.previous_event_digest`);
  const beforeStateDigest = value.before_state_digest === null
    ? null
    : requireDigest(value.before_state_digest, `${label}.before_state_digest`);
  const afterState = parseLeaseState(value.after_state, `${label}.after_state`);
  const material = {
    schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
    lease_id: requireString(value.lease_id, `${label}.lease_id`),
    event_index: requireInteger(value.event_index, `${label}.event_index`, 0),
    action: parseEventAction(value.action, `${label}.action`),
    occurred_at: requireTimestamp(value.occurred_at, `${label}.occurred_at`),
    previous_event_digest: previousEventDigest,
    before_state: beforeState,
    before_state_digest: beforeStateDigest,
    after_state: afterState,
    after_state_digest: requireDigest(value.after_state_digest, `${label}.after_state_digest`),
  };
  const event: LeaseEventRecord = {
    ...material,
    event_digest: requireDigest(value.event_digest, `${label}.event_digest`),
  };
  if (
    event.lease_id !== event.after_state.lease_id ||
    event.event_index !== event.after_state.revision ||
    event.after_state_digest !== sha256Json(event.after_state) ||
    event.before_state_digest !== (event.before_state === null ? null : sha256Json(event.before_state)) ||
    event.event_digest !== sha256Json(material)
  ) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} failed digest or identity validation.`);
  }
  return event;
}

function parseLocator(value: unknown, label: string): LeaseLocator {
  if (!isRecord(value) || value.schema_version !== WORKSPACE_GUARD_SCHEMA_VERSION) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} is not a WorkspaceGuard v1 locator.`);
  }
  const locator = {
    schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
    workspace_key: requireString(value.workspace_key, `${label}.workspace_key`),
    initial_event: parseLeaseEvent(value.initial_event, `${label}.initial_event`),
  } satisfies LeaseLocator;
  if (
    locator.initial_event.event_index !== 0 ||
    locator.initial_event.action !== "ACQUIRED" ||
    locator.initial_event.before_state !== null ||
    locator.initial_event.previous_event_digest !== null ||
    locator.initial_event.after_state.status !== "ACTIVE"
  ) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} contains an invalid acquisition event.`);
  }
  return locator;
}

function readStrictJson(filePath: string, label: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error: unknown) {
    throw new WorkspaceGuardError("workspace_guard_persist_failed", `${label} cannot be read.`, { cause: error });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} is not valid UTF-8.`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `${label} is not valid JSON.`, { cause: error });
  }
}

function writeTemporaryFile(targetPath: string, payload: unknown): string {
  const directory = path.dirname(targetPath);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error: unknown) {
    throw new WorkspaceGuardError("workspace_guard_persist_failed", `Lease directory cannot be created: ${directory}.`, {
      cause: error,
    });
  }
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
    throw new WorkspaceGuardError("workspace_guard_persist_failed", `Lease state cannot be written: ${targetPath}.`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeFileQuietly(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // An immutable published file remains safe even if temporary cleanup fails.
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
    throw new WorkspaceGuardError("workspace_guard_persist_failed", `Lease state cannot be published: ${targetPath}.`, {
      cause: error,
    });
  } finally {
    removeFileQuietly(temporaryPath);
  }
}

function workspaceKey(workspace: WorkspaceIdentity): string {
  return sha256Json(workspace).slice("sha256:".length);
}

function leaseKey(leaseId: string): string {
  return sha256Bytes(leaseId).slice("sha256:".length);
}

function identitiesEqual(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateEventTransition(previous: LeaseEventRecord, current: LeaseEventRecord): void {
  if (
    current.event_index !== previous.event_index + 1 ||
    current.previous_event_digest !== previous.event_digest ||
    current.before_state === null ||
    canonicalJson(current.before_state) !== canonicalJson(previous.after_state) ||
    current.lease_id !== previous.lease_id ||
    current.after_state.run_id !== previous.after_state.run_id ||
    current.after_state.acquired_at !== previous.after_state.acquired_at ||
    !identitiesEqual(current.after_state.workspace_identity, previous.after_state.workspace_identity)
  ) {
    throw new WorkspaceGuardError("workspace_guard_corrupt", `Lease event ${String(current.event_index)} breaks its event chain.`);
  }
  const before = previous.after_state;
  const after = current.after_state;
  const valid =
    (current.action === "RENEWED" && before.status === "ACTIVE" && after.status === "ACTIVE" && after.epoch === before.epoch) ||
    (current.action === "FROZEN" && before.status === "ACTIVE" && after.status === "FROZEN" && after.epoch === before.epoch) ||
    (current.action === "EPOCH_ROTATED" && before.status === "FROZEN" && after.status === "ACTIVE" && after.epoch === before.epoch + 1) ||
    (current.action === "RELEASED" && before.status !== "RELEASED" && after.status === "RELEASED" && after.epoch === before.epoch);
  if (!valid) {
    throw new WorkspaceGuardError(
      "workspace_guard_corrupt",
      `Lease event ${String(current.event_index)} contains an invalid ${current.action} transition.`,
    );
  }
}

function caught(error: unknown, fallbackCode: "workspace_guard_persist_failed" | "workspace_guard_corrupt", message: string): WorkspaceGuardError {
  return error instanceof WorkspaceGuardError
    ? error
    : new WorkspaceGuardError(fallbackCode, message, { cause: error });
}

export class FileWorkspaceGuard {
  private constructor(
    private readonly storageRoot: string,
    private readonly now: () => Date,
    private readonly leaseIdFactory: () => string,
    private readonly leaseDurationMs: number,
  ) {}

  public static open(
    storageRoot: string,
    options: FileWorkspaceGuardOptions = {},
  ): FileWorkspaceGuard | WorkspaceGuardError {
    const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      return new WorkspaceGuardError("workspace_guard_persist_failed", "leaseDurationMs must be a positive safe integer.");
    }
    try {
      const resolved = path.resolve(storageRoot);
      mkdirSync(path.join(resolved, "workspaces"), { recursive: true });
      mkdirSync(path.join(resolved, "leases"), { recursive: true });
      return new FileWorkspaceGuard(
        resolved,
        options.now ?? (() => new Date()),
        options.leaseIdFactory ?? randomUUID,
        leaseDurationMs,
      );
    } catch (error: unknown) {
      return caught(error, "workspace_guard_persist_failed", `WorkspaceGuard storage cannot be opened: ${storageRoot}.`);
    }
  }

  public acquire(workspace: WorkspaceIdentity, runId: string): ProjectLease | WorkspaceGuardError {
    try {
      if (workspace.canonical_root.length === 0 || workspace.filesystem_identity.length === 0 || runId.length === 0) {
        return new WorkspaceGuardError("project_lock_unavailable", "Workspace identity and run_id must be non-empty.");
      }
      const leaseId = this.leaseIdFactory();
      if (leaseId.length === 0) {
        return new WorkspaceGuardError("project_lock_unavailable", "The lease identity factory returned an empty value.");
      }
      const occurredAt = this.timestamp();
      const state: ProjectLease = {
        schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
        lease_id: leaseId,
        workspace_identity: workspace,
        run_id: runId,
        epoch: 1,
        revision: 0,
        acquired_at: occurredAt,
        renewed_at: occurredAt,
        expires_at: this.expiryFrom(occurredAt),
        status: "ACTIVE",
      };
      const locator: LeaseLocator = {
        schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
        workspace_key: workspaceKey(workspace),
        initial_event: createLeaseEvent("ACQUIRED", occurredAt, null, null, state),
      };
      const locatorPath = this.locatorPath(leaseId);
      if (!publishImmutableJson(locatorPath, locator)) {
        return new WorkspaceGuardError("project_lock_unavailable", "The generated lease identity is already in use.");
      }
      const activePath = this.activePath(locator.workspace_key);
      try {
        mkdirSync(path.dirname(activePath), { recursive: true });
        linkSync(locatorPath, activePath);
      } catch (error: unknown) {
        if (isErrno(error, "EEXIST")) {
          removeFileQuietly(locatorPath);
          return new WorkspaceGuardError(
            "project_lock_unavailable",
            `Workspace ${workspace.canonical_root} already has an active Project Write Lease.`,
          );
        }
        throw error;
      }
      return state;
    } catch (error: unknown) {
      return caught(error, "workspace_guard_persist_failed", "Project Write Lease acquisition failed closed.");
    }
  }

  public renew(leaseId: string, expectedEpoch: number): ProjectLease | WorkspaceGuardError {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = this.loadActiveHistory(leaseId);
      if (loaded instanceof WorkspaceGuardError) {
        return loaded;
      }
      const occurredAt = this.timestampResult();
      if (occurredAt instanceof WorkspaceGuardError) {
        return occurredAt;
      }
      const credentialError = this.validateWritableState(loaded.state, leaseId, expectedEpoch, occurredAt);
      if (credentialError !== undefined) {
        return credentialError;
      }
      const next: ProjectLease = {
        ...loaded.state,
        revision: loaded.state.revision + 1,
        renewed_at: occurredAt,
        expires_at: this.expiryFrom(occurredAt),
        status: "ACTIVE",
      };
      const published = this.appendEvent(loaded, "RENEWED", occurredAt, next);
      if (published instanceof WorkspaceGuardError) {
        return published;
      }
      if (published) {
        return next;
      }
    }
    return new WorkspaceGuardError("workspace_guard_persist_failed", "Lease renewal exceeded its CAS retry bound.");
  }

  public assertWritable(leaseId: string, expectedEpoch: number): ProjectLease | WorkspaceGuardError {
    const loaded = this.loadActiveHistory(leaseId);
    if (loaded instanceof WorkspaceGuardError) {
      return loaded;
    }
    const credentialError = this.validateWritableState(loaded.state, leaseId, expectedEpoch);
    if (credentialError !== undefined) {
      return credentialError;
    }
    return loaded.state.status === "ACTIVE"
      ? loaded.state
      : new WorkspaceGuardError("lease_lost", `Lease ${leaseId} cannot authorize writes.`);
  }

  public freezeWrites(leaseId: string, expectedEpoch: number): FrozenLease | WorkspaceGuardError {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = this.loadActiveHistory(leaseId);
      if (loaded instanceof WorkspaceGuardError) {
        return loaded;
      }
      const occurredAt = this.timestampResult();
      if (occurredAt instanceof WorkspaceGuardError) {
        return occurredAt;
      }
      const commonError = this.validateCredentialAndExpiry(loaded.state, leaseId, expectedEpoch, occurredAt);
      if (commonError !== undefined) {
        return commonError;
      }
      if (loaded.state.status === "FROZEN") {
        return loaded.state;
      }
      if (loaded.state.status !== "ACTIVE") {
        return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} is no longer active.`);
      }
      const next: FrozenLease = {
        ...loaded.state,
        revision: loaded.state.revision + 1,
        status: "FROZEN",
        frozen_at: occurredAt,
      };
      const published = this.appendEvent(loaded, "FROZEN", occurredAt, next);
      if (published instanceof WorkspaceGuardError) {
        return published;
      }
      if (published) {
        return next;
      }
    }
    return new WorkspaceGuardError("workspace_guard_persist_failed", "Lease freeze exceeded its CAS retry bound.");
  }

  public rotateEpoch(frozenLease: FrozenLease): ProjectLease | WorkspaceGuardError {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = this.loadActiveHistory(frozenLease.lease_id);
      if (loaded instanceof WorkspaceGuardError) {
        return loaded;
      }
      const occurredAt = this.timestampResult();
      if (occurredAt instanceof WorkspaceGuardError) {
        return occurredAt;
      }
      const commonError = this.validateCredentialAndExpiry(
        loaded.state,
        frozenLease.lease_id,
        frozenLease.epoch,
        occurredAt,
      );
      if (commonError !== undefined) {
        return commonError;
      }
      if (loaded.state.status !== "FROZEN") {
        return new WorkspaceGuardError("lease_lost", `Lease ${frozenLease.lease_id} is not frozen.`);
      }
      if (canonicalJson(loaded.state) !== canonicalJson(frozenLease)) {
        return new WorkspaceGuardError("lease_lost", "The supplied FrozenLease is not the current frozen capability.");
      }
      const next: ProjectLease = {
        schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
        lease_id: loaded.state.lease_id,
        workspace_identity: loaded.state.workspace_identity,
        run_id: loaded.state.run_id,
        epoch: loaded.state.epoch + 1,
        revision: loaded.state.revision + 1,
        acquired_at: loaded.state.acquired_at,
        renewed_at: occurredAt,
        expires_at: this.expiryFrom(occurredAt),
        status: "ACTIVE",
      };
      const published = this.appendEvent(loaded, "EPOCH_ROTATED", occurredAt, next);
      if (published instanceof WorkspaceGuardError) {
        return published;
      }
      if (published) {
        return next;
      }
    }
    return new WorkspaceGuardError("workspace_guard_persist_failed", "Epoch rotation exceeded its CAS retry bound.");
  }

  public release(leaseId: string, expectedEpoch: number): ReleasedLease | WorkspaceGuardError {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = this.loadHistory(leaseId);
      if (loaded instanceof WorkspaceGuardError) {
        return loaded;
      }
      if (loaded.state.epoch !== expectedEpoch) {
        return new WorkspaceGuardError(
          "stale_write_epoch",
          `Lease ${leaseId} is at epoch ${String(loaded.state.epoch)}, not ${String(expectedEpoch)}.`,
        );
      }
      if (loaded.state.status === "RELEASED") {
        const removal = this.removeActiveLocator(loaded.locator, leaseId);
        return removal ?? loaded.state;
      }
      const activeError = this.assertLocatorIsActive(loaded.locator, leaseId);
      if (activeError !== undefined) {
        return activeError;
      }
      const occurredAt = this.timestampResult();
      if (occurredAt instanceof WorkspaceGuardError) {
        return occurredAt;
      }
      const expiryError = this.assertNotExpired(loaded.state, occurredAt);
      if (expiryError !== undefined) {
        return expiryError;
      }
      const next: ReleasedLease = {
        schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
        lease_id: loaded.state.lease_id,
        workspace_identity: loaded.state.workspace_identity,
        run_id: loaded.state.run_id,
        epoch: loaded.state.epoch,
        revision: loaded.state.revision + 1,
        acquired_at: loaded.state.acquired_at,
        renewed_at: loaded.state.renewed_at,
        expires_at: loaded.state.expires_at,
        status: "RELEASED",
        released_at: occurredAt,
      };
      const published = this.appendEvent(loaded, "RELEASED", occurredAt, next);
      if (published instanceof WorkspaceGuardError) {
        return published;
      }
      if (published) {
        const removal = this.removeActiveLocator(loaded.locator, leaseId);
        return removal ?? next;
      }
    }
    return new WorkspaceGuardError("workspace_guard_persist_failed", "Lease release exceeded its CAS retry bound.");
  }

  public inspectLeaseEvents(leaseId: string): readonly LeaseEventRecord[] | WorkspaceGuardError {
    const loaded = this.loadHistory(leaseId);
    return loaded instanceof WorkspaceGuardError ? loaded : loaded.events;
  }

  private timestampResult(): string | WorkspaceGuardError {
    try {
      return this.timestamp();
    } catch (error: unknown) {
      return caught(error, "workspace_guard_persist_failed", "WorkspaceGuard clock returned an invalid timestamp.");
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new WorkspaceGuardError("workspace_guard_persist_failed", "WorkspaceGuard clock returned an invalid Date.");
    }
    return value.toISOString();
  }

  private expiryFrom(timestamp: string): string {
    return new Date(Date.parse(timestamp) + this.leaseDurationMs).toISOString();
  }

  private locatorPath(leaseId: string): string {
    return path.join(this.storageRoot, "leases", leaseKey(leaseId), "locator.json");
  }

  private eventsPath(leaseId: string): string {
    return path.join(this.storageRoot, "leases", leaseKey(leaseId), "events");
  }

  private activePath(key: string): string {
    return path.join(this.storageRoot, "workspaces", key, "active.json");
  }

  private loadHistory(leaseId: string): LoadedLeaseHistory | WorkspaceGuardError {
    try {
      const locatorPath = this.locatorPath(leaseId);
      if (!existsSync(locatorPath)) {
        return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} does not exist.`);
      }
      const locator = parseLocator(readStrictJson(locatorPath, `Lease locator ${leaseId}`), `Lease locator ${leaseId}`);
      if (locator.initial_event.lease_id !== leaseId) {
        return new WorkspaceGuardError("workspace_guard_corrupt", `Lease locator ${leaseId} has a mismatched identity.`);
      }
      const events: LeaseEventRecord[] = [locator.initial_event];
      const directory = this.eventsPath(leaseId);
      const names = existsSync(directory)
        ? readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()
        : [];
      let previous = locator.initial_event;
      for (const name of names) {
        if (!/^\d{20}\.json$/u.test(name)) {
          return new WorkspaceGuardError("workspace_guard_corrupt", `Lease ${leaseId} has an invalid event filename: ${name}.`);
        }
        const event = parseLeaseEvent(
          readStrictJson(path.join(directory, name), `Lease event ${name}`),
          `Lease event ${name}`,
        );
        validateEventTransition(previous, event);
        events.push(event);
        previous = event;
      }
      return { locator, events, state: previous.after_state };
    } catch (error: unknown) {
      return caught(error, "workspace_guard_corrupt", `Lease ${leaseId} cannot be replayed.`);
    }
  }

  private loadActiveHistory(leaseId: string): LoadedLeaseHistory | WorkspaceGuardError {
    const loaded = this.loadHistory(leaseId);
    if (loaded instanceof WorkspaceGuardError) {
      return loaded;
    }
    const activeError = this.assertLocatorIsActive(loaded.locator, leaseId);
    return activeError ?? loaded;
  }

  private assertLocatorIsActive(locator: LeaseLocator, leaseId: string): WorkspaceGuardError | undefined {
    try {
      const activePath = this.activePath(locator.workspace_key);
      if (!existsSync(activePath)) {
        return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} is no longer active.`);
      }
      const active = parseLocator(readStrictJson(activePath, "Active lease locator"), "Active lease locator");
      if (active.initial_event.lease_id !== leaseId || active.workspace_key !== locator.workspace_key) {
        return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} no longer owns its workspace.`);
      }
      return undefined;
    } catch (error: unknown) {
      return caught(error, "workspace_guard_corrupt", `Active locator for lease ${leaseId} cannot be validated.`);
    }
  }

  private validateCredentialAndExpiry(
    state: LeaseState,
    leaseId: string,
    expectedEpoch: number,
    observedAt?: string,
  ): WorkspaceGuardError | undefined {
    if (state.lease_id !== leaseId || state.status === "RELEASED") {
      return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} is no longer available.`);
    }
    if (state.epoch !== expectedEpoch) {
      return new WorkspaceGuardError(
        "stale_write_epoch",
        `Lease ${leaseId} is at epoch ${String(state.epoch)}, not ${String(expectedEpoch)}.`,
      );
    }
    return this.assertNotExpired(state, observedAt);
  }

  private validateWritableState(
    state: LeaseState,
    leaseId: string,
    expectedEpoch: number,
    observedAt?: string,
  ): WorkspaceGuardError | undefined {
    const commonError = this.validateCredentialAndExpiry(state, leaseId, expectedEpoch, observedAt);
    if (commonError !== undefined) {
      return commonError;
    }
    return state.status === "ACTIVE"
      ? undefined
      : new WorkspaceGuardError("lease_lost", `Lease ${leaseId} is frozen and cannot authorize writes.`);
  }

  private assertNotExpired(state: LeaseState, observedAt?: string): WorkspaceGuardError | undefined {
    const timestamp = observedAt ?? this.timestampResult();
    if (timestamp instanceof WorkspaceGuardError) {
      return timestamp;
    }
    return Date.parse(timestamp) < Date.parse(state.expires_at)
      ? undefined
      : new WorkspaceGuardError("lease_lost", `Lease ${state.lease_id} has expired.`);
  }

  private appendEvent(
    loaded: LoadedLeaseHistory,
    action: Exclude<LeaseEventAction, "ACQUIRED">,
    occurredAt: string,
    afterState: LeaseState,
  ): boolean | WorkspaceGuardError {
    try {
      const previous = loaded.events.at(-1);
      if (previous === undefined) {
        return new WorkspaceGuardError("workspace_guard_corrupt", "A lease history cannot be empty.");
      }
      const event = createLeaseEvent(action, occurredAt, loaded.state, previous.event_digest, afterState);
      const eventPath = path.join(
        this.eventsPath(afterState.lease_id),
        `${String(event.event_index).padStart(20, "0")}.json`,
      );
      return publishImmutableJson(eventPath, event);
    } catch (error: unknown) {
      return caught(error, "workspace_guard_persist_failed", `Lease ${afterState.lease_id} event could not be persisted.`);
    }
  }

  private removeActiveLocator(locator: LeaseLocator, leaseId: string): WorkspaceGuardError | undefined {
    try {
      const activePath = this.activePath(locator.workspace_key);
      if (!existsSync(activePath)) {
        return undefined;
      }
      const active = parseLocator(readStrictJson(activePath, "Active lease locator"), "Active lease locator");
      if (active.initial_event.lease_id !== leaseId) {
        return new WorkspaceGuardError("lease_lost", `Lease ${leaseId} does not own the active locator.`);
      }
      unlinkSync(activePath);
      return undefined;
    } catch (error: unknown) {
      return caught(error, "workspace_guard_persist_failed", `Lease ${leaseId} could not release its active locator.`);
    }
  }
}
