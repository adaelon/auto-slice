import {
  canonicalJson,
  createInitialRunState,
  isLegacyAcceptanceStatus,
  isRunTransitionAllowed,
  sha256Json,
  StateStoreError,
  type CommitMode,
  type RunState,
  type RunStatus,
  type Sha256Digest,
  type StoredRun,
} from "../state/index.js";
import { WorkspaceGuardError } from "../workspace/index.js";
import { ControlPlaneError } from "./errors.js";
import { recoveryOptionsFor } from "./recovery-catalog.js";
import { projectRunSnapshot } from "./status-projector.js";
import {
  CONTROL_COMMANDS,
  CONTROL_PLANE_SCHEMA_VERSION,
  RECOVERY_RESOLUTIONS,
  type CommandEnvelope,
  type ControlCommand,
  type ControlCommandReceipt,
  type ControlCommandReceiptMaterial,
  type ControlPlaneFailureCode,
  type ControlPlaneOptions,
  type OverrideSliceCommitModePayload,
  type RecoveryEvidence,
  type RecoveryResolution,
  type ResumePayload,
  type RunSnapshot,
  type StartRunPayload,
} from "./types.js";

const COMMAND_SET = new Set<string>(CONTROL_COMMANDS);
const RESOLUTION_SET = new Set<string>(RECOVERY_RESOLUTIONS);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TERMINAL_STATUSES = new Set<RunStatus>(["DONE", "ABORTED"]);

interface ExecutedCommand {
  readonly snapshot?: RunSnapshot;
  readonly error?: ControlPlaneError;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidEnvelope(message: string): ControlPlaneError {
  return new ControlPlaneError("invalid_command_envelope", message);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw invalidEnvelope(`${label} must be a non-empty string of at most 512 UTF-8 bytes.`);
  }
  return value;
}

function requireStateVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidEnvelope(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw invalidEnvelope(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value as Sha256Digest;
}

function requireCommitMode(value: unknown, label: string): CommitMode {
  if (value !== "after_slice" && value !== "none") {
    throw invalidEnvelope(`${label} must be after_slice or none.`);
  }
  return value;
}

function parseEnvelope(value: unknown): CommandEnvelope {
  if (!isRecord(value) || !("payload" in value)) {
    throw invalidEnvelope("CommandEnvelope must be an object containing payload.");
  }
  const commandId = requireNonEmptyString(value.command_id, "command_id");
  const runId = value.run_id === undefined
    ? undefined
    : requireNonEmptyString(value.run_id, "run_id");
  const expected = value.expected_state_version === undefined
    ? undefined
    : requireStateVersion(value.expected_state_version, "expected_state_version");
  return {
    command_id: commandId,
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(expected === undefined ? {} : { expected_state_version: expected }),
    payload: value.payload,
  };
}

function parseStartPayload(value: unknown): StartRunPayload {
  if (!isRecord(value) || !isRecord(value.workspace_identity)) {
    throw invalidEnvelope("start payload must contain workspace_identity.");
  }
  return {
    run_id: requireNonEmptyString(value.run_id, "payload.run_id"),
    workspace_identity: {
      canonical_root: requireNonEmptyString(
        value.workspace_identity.canonical_root,
        "payload.workspace_identity.canonical_root",
      ),
      filesystem_identity: requireNonEmptyString(
        value.workspace_identity.filesystem_identity,
        "payload.workspace_identity.filesystem_identity",
      ),
    },
    plan_digest: requireDigest(value.plan_digest, "payload.plan_digest"),
    protected_baseline_digest: requireDigest(
      value.protected_baseline_digest,
      "payload.protected_baseline_digest",
    ),
    commit_mode: requireCommitMode(value.commit_mode, "payload.commit_mode"),
    first_slice_id: requireNonEmptyString(value.first_slice_id, "payload.first_slice_id"),
  };
}

function parseResumePayload(value: unknown): ResumePayload {
  if (!isRecord(value)) {
    throw invalidEnvelope("resume payload must be an object.");
  }
  const resolution = value.resolution === undefined
    ? undefined
    : (
      typeof value.resolution === "string" && RESOLUTION_SET.has(value.resolution)
        ? value.resolution as RecoveryResolution
        : (() => { throw invalidEnvelope("payload.resolution is invalid."); })()
    );
  let evidence: RecoveryEvidence | undefined;
  if (value.evidence !== undefined) {
    if (!isRecord(value.evidence)) {
      throw invalidEnvelope("payload.evidence must be an object.");
    }
    evidence = {
      evidence_path: requireNonEmptyString(value.evidence.evidence_path, "payload.evidence.evidence_path"),
      evidence_digest: requireDigest(value.evidence.evidence_digest, "payload.evidence.evidence_digest"),
    };
  }
  return {
    ...(resolution === undefined ? {} : { resolution }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function parseOverridePayload(value: unknown): OverrideSliceCommitModePayload {
  if (!isRecord(value)) {
    throw invalidEnvelope("override payload must be an object.");
  }
  return {
    slice_id: requireNonEmptyString(value.slice_id, "payload.slice_id"),
    mode: requireCommitMode(value.mode, "payload.mode"),
  };
}

function mapStateStoreError(error: StateStoreError): ControlPlaneError {
  const mapped: ControlPlaneFailureCode = error.code === "invalid_state"
    ? "invalid_command_envelope"
    : error.code;
  return new ControlPlaneError(mapped, error.message, { cause: error });
}

function mapWorkspaceError(error: WorkspaceGuardError): ControlPlaneError {
  const code: ControlPlaneFailureCode = error.code === "project_lock_unavailable"
    ? "project_lock_unavailable"
    : error.code === "workspace_guard_corrupt"
      ? "state_corrupt"
      : "state_persist_failed";
  return new ControlPlaneError(code, error.message, { cause: error });
}

function makeReceipt(material: ControlCommandReceiptMaterial): ControlCommandReceipt {
  return {
    ...material,
    receipt_digest: sha256Json(material),
  };
}

export class ControlPlane {
  private readonly now: () => Date;

  public constructor(private readonly options: ControlPlaneOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public execute(commandValue: unknown, envelopeValue: unknown): ControlCommandReceipt | ControlPlaneError {
    let command: ControlCommand;
    let envelope: CommandEnvelope;
    let startedAt: string;
    let envelopeDigest: Sha256Digest;
    try {
      if (typeof commandValue !== "string" || !COMMAND_SET.has(commandValue)) {
        return new ControlPlaneError("invalid_command", "Unknown control command.");
      }
      command = commandValue as ControlCommand;
      envelope = parseEnvelope(envelopeValue);
      startedAt = this.timestamp();
      envelopeDigest = sha256Json({ command, envelope: JSON.parse(canonicalJson(envelope)) as unknown });
    } catch (error: unknown) {
      return error instanceof ControlPlaneError
        ? error
        : invalidEnvelope(error instanceof Error ? error.message : String(error));
    }

    const begin = this.options.command_journal.begin(
      command,
      envelope.command_id,
      envelopeDigest,
      startedAt,
    );
    if (begin instanceof ControlPlaneError) {
      return begin;
    }
    if (begin.outcome === "REPLAY") {
      return begin.receipt;
    }
    if (begin.outcome === "IN_PROGRESS") {
      return new ControlPlaneError("command_in_progress", "The command is already executing without a terminal receipt.");
    }

    const executed = this.executeClaimed(command, envelope);
    const completedAt = this.timestampResult();
    if (completedAt instanceof ControlPlaneError) {
      return completedAt;
    }
    const material = {
      schema_version: CONTROL_PLANE_SCHEMA_VERSION,
      command_id: envelope.command_id,
      command,
      outcome: executed.error === undefined
        ? (executed.snapshot?.status === "NEEDS_USER" ? "NEEDS_USER" : "OK")
        : "REJECTED",
      completed_at: completedAt,
      ...(executed.snapshot === undefined ? {} : { snapshot: executed.snapshot }),
      ...(executed.error === undefined ? {} : { error: { code: executed.error.code } }),
    } satisfies ControlCommandReceiptMaterial;
    return this.options.command_journal.complete(begin.intent, makeReceipt(material));
  }

  private executeClaimed(command: ControlCommand, envelope: CommandEnvelope): ExecutedCommand {
    try {
      switch (command) {
        case "start":
          return this.start(envelope);
        case "status":
          return this.status(envelope);
        case "pause":
          return this.pause(envelope);
        case "resume":
          return this.resume(envelope);
        case "abort":
          return this.abort(envelope);
        case "override":
          return this.override(envelope);
      }
    } catch (error: unknown) {
      return {
        error: error instanceof ControlPlaneError
          ? error
          : new ControlPlaneError("invalid_command_envelope", String(error)),
      };
    }
  }

  private start(envelope: CommandEnvelope): ExecutedCommand {
    if (envelope.run_id !== undefined || envelope.expected_state_version !== undefined) {
      throw invalidEnvelope("start envelope must not contain run_id or expected_state_version.");
    }
    const payload = parseStartPayload(envelope.payload);
    const existing = this.options.run_store.load(payload.run_id);
    if (!(existing instanceof StateStoreError)) {
      return { error: new ControlPlaneError("run_already_exists", `Run ${payload.run_id} already exists.`) };
    }
    if (existing.code !== "run_not_found") {
      return { error: mapStateStoreError(existing) };
    }
    const lease = this.options.workspace_guard.acquire(payload.workspace_identity, payload.run_id);
    if (lease instanceof WorkspaceGuardError) {
      return { error: mapWorkspaceError(lease) };
    }
    const initial: RunState = {
      ...createInitialRunState({
        run_id: payload.run_id,
        workspace_identity: payload.workspace_identity,
        plan_digest: payload.plan_digest,
        commit_mode: payload.commit_mode,
        current_slice_id: payload.first_slice_id,
        protected_baseline_digest: payload.protected_baseline_digest,
      }),
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
    };
    const created = this.options.run_store.create(initial);
    if (created instanceof StateStoreError) {
      this.options.workspace_guard.release(lease.lease_id, lease.epoch);
      return { error: mapStateStoreError(created) };
    }
    const prepared = this.options.run_store.compareAndSwap(payload.run_id, 0, {
      action: `control_start:${envelope.command_id}`,
      to: "PREPARING",
    });
    return prepared instanceof StateStoreError
      ? { error: mapStateStoreError(prepared), snapshot: projectRunSnapshot(created.state) }
      : { snapshot: projectRunSnapshot(prepared.state) };
  }

  private status(envelope: CommandEnvelope): ExecutedCommand {
    if (envelope.expected_state_version !== undefined) {
      throw invalidEnvelope("status is a pure read and must not contain expected_state_version.");
    }
    const loaded = this.loadRun(envelope);
    return loaded instanceof ControlPlaneError
      ? { error: loaded }
      : { snapshot: projectRunSnapshot(loaded.state) };
  }

  private pause(envelope: CommandEnvelope): ExecutedCommand {
    const loaded = this.loadExpectedRun(envelope);
    if (loaded instanceof ControlPlaneError) {
      return { error: loaded };
    }
    if (
      loaded.state.status === "NEEDS_USER" ||
      loaded.state.status === "PAUSED" ||
      TERMINAL_STATUSES.has(loaded.state.status) ||
      isLegacyAcceptanceStatus(loaded.state.status)
    ) {
      return { error: new ControlPlaneError("command_not_allowed", `pause is not allowed from ${loaded.state.status}.`) };
    }
    const safePoint = this.options.lifecycle.pauseAtSafePoint(loaded.state, envelope.command_id);
    if (safePoint instanceof ControlPlaneError) {
      return { error: safePoint };
    }
    const paused = this.options.run_store.compareAndSwap(
      loaded.state.run_id,
      loaded.state.state_version,
      {
        action: `control_pause:${envelope.command_id}`,
        to: "PAUSED",
        updates: {
          ...safePoint.updates,
          paused_from_status: loaded.state.status,
        },
      },
    );
    return paused instanceof StateStoreError
      ? { error: mapStateStoreError(paused) }
      : { snapshot: projectRunSnapshot(paused.state) };
  }

  private resume(envelope: CommandEnvelope): ExecutedCommand {
    const payload = parseResumePayload(envelope.payload);
    const loaded = this.loadExpectedRun(envelope);
    if (loaded instanceof ControlPlaneError) {
      return { error: loaded };
    }
    if (loaded.state.status === "PAUSED") {
      if (payload.resolution !== undefined || payload.evidence !== undefined) {
        return { error: new ControlPlaneError("invalid_recovery_resolution", "PAUSED resume does not accept a recovery resolution.") };
      }
      const target = loaded.state.paused_from_status;
      if (target === undefined || !isRunTransitionAllowed("PAUSED", target)) {
        return { error: new ControlPlaneError("invalid_transition", "PAUSED Run has no valid persisted resume target.") };
      }
      const resumed = this.options.lifecycle.resumeFromSafePoint(loaded.state, envelope.command_id);
      if (resumed instanceof ControlPlaneError) {
        return { error: resumed };
      }
      const stored = this.options.run_store.compareAndSwap(
        loaded.state.run_id,
        loaded.state.state_version,
        {
          action: `control_resume:${envelope.command_id}`,
          to: target,
          updates: {
            ...resumed.updates,
            paused_from_status: null,
          },
        },
      );
      return stored instanceof StateStoreError
        ? { error: mapStateStoreError(stored) }
        : { snapshot: projectRunSnapshot(stored.state) };
    }
    if (loaded.state.status !== "NEEDS_USER" || loaded.state.last_error === undefined) {
      return { error: new ControlPlaneError("command_not_allowed", `resume is not allowed from ${loaded.state.status}.`) };
    }
    if (payload.resolution === undefined) {
      return { error: new ControlPlaneError("invalid_recovery_resolution", "NEEDS_USER resume requires an explicit resolution.") };
    }
    const allowed = recoveryOptionsFor(loaded.state.last_error.code);
    if (!allowed.includes(payload.resolution)) {
      return { error: new ControlPlaneError("invalid_recovery_resolution", "Resolution does not match the persisted error code.") };
    }
    if (payload.resolution === "abort_run") {
      return this.abortLoaded(loaded, envelope.command_id);
    }
    if (payload.evidence === undefined) {
      return { error: new ControlPlaneError("invalid_recovery_resolution", "Recovery requires digest-bound evidence.") };
    }
    const target = loaded.state.last_error.last_successful_status;
    if (!isRunTransitionAllowed("NEEDS_USER", target)) {
      return { error: new ControlPlaneError("invalid_recovery_resolution", "Persisted last-successful state is not resumable.") };
    }
    const recovery = this.options.recovery.resolve(
      loaded.state,
      payload.resolution,
      payload.evidence,
      envelope.command_id,
    );
    if (recovery instanceof ControlPlaneError) {
      return { error: recovery };
    }
    const stored = this.options.run_store.compareAndSwap(
      loaded.state.run_id,
      loaded.state.state_version,
      {
        action: `control_recover:${payload.resolution}:${envelope.command_id}`,
        to: target,
        updates: { ...recovery.updates, last_error: null },
      },
    );
    return stored instanceof StateStoreError
      ? { error: mapStateStoreError(stored) }
      : { snapshot: projectRunSnapshot(stored.state) };
  }

  private abort(envelope: CommandEnvelope): ExecutedCommand {
    const loaded = this.loadExpectedRun(envelope);
    return loaded instanceof ControlPlaneError
      ? { error: loaded }
      : this.abortLoaded(loaded, envelope.command_id);
  }

  private abortLoaded(loaded: StoredRun, commandId: string): ExecutedCommand {
    if (TERMINAL_STATUSES.has(loaded.state.status)) {
      return { error: new ControlPlaneError("command_not_allowed", `abort is not allowed from ${loaded.state.status}.`) };
    }
    const revoked = this.options.lifecycle.revokeWrites(loaded.state, commandId);
    if (revoked instanceof ControlPlaneError) {
      return { error: revoked };
    }
    const stored = this.options.run_store.compareAndSwap(
      loaded.state.run_id,
      loaded.state.state_version,
      {
        action: `control_abort:${commandId}`,
        to: "ABORTED",
        updates: {
          ...revoked.updates,
          project_lock_owner: null,
          paused_from_status: null,
        },
      },
    );
    return stored instanceof StateStoreError
      ? { error: mapStateStoreError(stored) }
      : { snapshot: projectRunSnapshot(stored.state) };
  }

  private override(envelope: CommandEnvelope): ExecutedCommand {
    const payload = parseOverridePayload(envelope.payload);
    const loaded = this.loadExpectedRun(envelope);
    if (loaded instanceof ControlPlaneError) {
      return { error: loaded };
    }
    if (
      TERMINAL_STATUSES.has(loaded.state.status) ||
      isLegacyAcceptanceStatus(loaded.state.status)
    ) {
      return { error: new ControlPlaneError("command_not_allowed", `override is not allowed from ${loaded.state.status}.`) };
    }
    const phase = this.options.slice_phase.getPhase(loaded.state, payload.slice_id);
    if (phase === "UNKNOWN") {
      return { error: new ControlPlaneError("slice_not_found", `Slice ${payload.slice_id} is unknown.`) };
    }
    if (phase !== "PENDING") {
      return { error: new ControlPlaneError("slice_already_verifying", `Slice ${payload.slice_id} was already dispatched.`) };
    }
    const current = loaded.state.slice_commit_mode_overrides?.[payload.slice_id];
    if (current === payload.mode) {
      return { snapshot: projectRunSnapshot(loaded.state) };
    }
    const overrides = {
      ...(loaded.state.slice_commit_mode_overrides ?? {}),
      [payload.slice_id]: payload.mode,
    };
    const stored = this.options.run_store.compareAndSwap(
      loaded.state.run_id,
      loaded.state.state_version,
      {
        action: "override_slice_commit_mode",
        to: loaded.state.status,
        updates: { slice_commit_mode_overrides: overrides },
      },
    );
    return stored instanceof StateStoreError
      ? { error: mapStateStoreError(stored) }
      : { snapshot: projectRunSnapshot(stored.state) };
  }

  private loadRun(envelope: CommandEnvelope): StoredRun | ControlPlaneError {
    if (envelope.run_id === undefined) {
      return invalidEnvelope("CommandEnvelope.run_id is required.");
    }
    const loaded = this.options.run_store.load(envelope.run_id);
    return loaded instanceof StateStoreError ? mapStateStoreError(loaded) : loaded;
  }

  private loadExpectedRun(envelope: CommandEnvelope): StoredRun | ControlPlaneError {
    if (envelope.expected_state_version === undefined) {
      return invalidEnvelope("Mutating commands require expected_state_version.");
    }
    const loaded = this.loadRun(envelope);
    if (loaded instanceof ControlPlaneError) {
      return loaded;
    }
    return loaded.state.state_version === envelope.expected_state_version
      ? loaded
      : new ControlPlaneError(
        "stale_state",
        `Expected state_version ${String(envelope.expected_state_version)}, found ${String(loaded.state.state_version)}.`,
      );
  }

  private timestampResult(): string | ControlPlaneError {
    try {
      return this.timestamp();
    } catch (error: unknown) {
      return new ControlPlaneError("state_persist_failed", "Control plane clock returned an invalid value.", { cause: error });
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("Control plane clock returned an invalid Date.");
    }
    return value.toISOString();
  }
}
