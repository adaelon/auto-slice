import { readFileSync } from "node:fs";
import path from "node:path";

import {
  FileRunStore,
  isLegacyAcceptanceStatus,
  sha256Bytes,
  StateStoreError,
  type RunState,
} from "../state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
  type LeaseState,
} from "../workspace/index.js";
import { ControlPlane } from "./control-plane.js";
import { ControlPlaneError } from "./errors.js";
import { FileCommandJournal } from "./file-command-journal.js";
import type {
  ControlLifecyclePort,
  ControlPlaneOptions,
  ControlPortReceipt,
  ExplicitRecoveryPort,
  RecoveryEvidence,
  RecoveryPortReceipt,
  RecoveryResolution,
  SlicePhase,
  SlicePhasePort,
} from "./types.js";

function workspaceFailure(error: WorkspaceGuardError, code: "pause_safe_point_failed" | "abort_cleanup_failed" | "recovery_failed"): ControlPlaneError {
  return new ControlPlaneError(code, error.message, { cause: error });
}

function latestLeaseState(
  guard: FileWorkspaceGuard,
  leaseId: string,
): LeaseState | WorkspaceGuardError {
  const events = guard.inspectLeaseEvents(leaseId);
  if (events instanceof WorkspaceGuardError) {
    return events;
  }
  const state = events.at(-1)?.after_state;
  return state ?? new WorkspaceGuardError("workspace_guard_corrupt", "Lease history is empty.");
}

export class FileControlLifecycle implements ControlLifecyclePort {
  public constructor(private readonly guard: FileWorkspaceGuard) {}

  public pauseAtSafePoint(run: RunState): ControlPortReceipt | ControlPlaneError {
    if (run.project_lock_owner === null) {
      return { applied: true, receipt_digest: sha256Bytes(`pause:${run.run_id}:no-lease`) };
    }
    const frozen = this.guard.freezeWrites(run.project_lock_owner, run.write_epoch);
    return frozen instanceof WorkspaceGuardError
      ? workspaceFailure(frozen, "pause_safe_point_failed")
      : { applied: true, receipt_digest: sha256Bytes(JSON.stringify(frozen)) };
  }

  public resumeFromSafePoint(run: RunState): ControlPortReceipt | ControlPlaneError {
    if (run.project_lock_owner !== null) {
      const current = latestLeaseState(this.guard, run.project_lock_owner);
      if (!(current instanceof WorkspaceGuardError) && current.status === "FROZEN") {
        const rotated = this.guard.rotateEpoch(current);
        return rotated instanceof WorkspaceGuardError
          ? workspaceFailure(rotated, "pause_safe_point_failed")
          : {
            applied: true,
            receipt_digest: sha256Bytes(JSON.stringify(rotated)),
            updates: { write_epoch: rotated.epoch },
          };
      }
      if (!(current instanceof WorkspaceGuardError) && current.status === "ACTIVE") {
        return {
          applied: true,
          receipt_digest: sha256Bytes(JSON.stringify(current)),
          updates: { write_epoch: current.epoch },
        };
      }
    }
    const acquired = this.guard.acquire(run.workspace_identity, run.run_id);
    return acquired instanceof WorkspaceGuardError
      ? workspaceFailure(acquired, "pause_safe_point_failed")
      : {
        applied: true,
        receipt_digest: sha256Bytes(JSON.stringify(acquired)),
        updates: {
          project_lock_owner: acquired.lease_id,
          write_epoch: acquired.epoch,
        },
      };
  }

  public revokeWrites(run: RunState): ControlPortReceipt | ControlPlaneError {
    if (run.project_lock_owner === null) {
      return { applied: true, receipt_digest: sha256Bytes(`abort:${run.run_id}:no-lease`) };
    }
    const released = this.guard.release(run.project_lock_owner, run.write_epoch);
    return released instanceof WorkspaceGuardError
      ? workspaceFailure(released, "abort_cleanup_failed")
      : { applied: true, receipt_digest: sha256Bytes(JSON.stringify(released)) };
  }
}

export class EvidenceBoundRecovery implements ExplicitRecoveryPort {
  public constructor(private readonly guard: FileWorkspaceGuard) {}

  public resolve(
    run: RunState,
    resolution: Exclude<RecoveryResolution, "abort_run">,
    evidence: RecoveryEvidence,
  ): RecoveryPortReceipt | ControlPlaneError {
    const verified = this.verifyEvidence(run, evidence);
    if (verified instanceof ControlPlaneError) {
      return verified;
    }
    if (resolution !== "release_stale_project_lock") {
      return { applied: true, receipt_digest: verified };
    }
    if (run.project_lock_owner !== null) {
      const released = this.guard.release(run.project_lock_owner, run.write_epoch);
      if (released instanceof WorkspaceGuardError && released.code !== "lease_lost") {
        return workspaceFailure(released, "recovery_failed");
      }
    }
    const acquired = this.guard.acquire(run.workspace_identity, run.run_id);
    return acquired instanceof WorkspaceGuardError
      ? workspaceFailure(acquired, "recovery_failed")
      : {
        applied: true,
        receipt_digest: sha256Bytes(`${verified}:${JSON.stringify(acquired)}`),
        updates: {
          project_lock_owner: acquired.lease_id,
          write_epoch: acquired.epoch,
        },
      };
  }

  private verifyEvidence(
    run: RunState,
    evidence: RecoveryEvidence,
  ): ReturnType<typeof sha256Bytes> | ControlPlaneError {
    try {
      if (path.isAbsolute(evidence.evidence_path)) {
        return new ControlPlaneError("recovery_failed", "Recovery evidence path must be workspace-relative.");
      }
      const root = path.resolve(run.workspace_identity.canonical_root);
      const candidate = path.resolve(root, evidence.evidence_path);
      const relative = path.relative(root, candidate);
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return new ControlPlaneError("recovery_failed", "Recovery evidence path escapes the workspace.");
      }
      const digest = sha256Bytes(readFileSync(candidate));
      return digest === evidence.evidence_digest
        ? digest
        : new ControlPlaneError("recovery_failed", "Recovery evidence digest does not match the file.");
    } catch (error: unknown) {
      return new ControlPlaneError("recovery_failed", "Recovery evidence cannot be verified.", { cause: error });
    }
  }
}

export class CurrentSlicePhase implements SlicePhasePort {
  public getPhase(run: RunState, sliceId: string): SlicePhase {
    if (sliceId !== run.current_slice_id) {
      return "UNKNOWN";
    }
    const effectiveStatus = run.status === "PAUSED"
      ? run.paused_from_status
      : run.status === "NEEDS_USER"
        ? run.last_error?.last_successful_status
        : run.status;
    if (effectiveStatus === "DONE" || effectiveStatus === "ABORTED") {
      return "COMPLETED";
    }
    if (effectiveStatus !== undefined && isLegacyAcceptanceStatus(effectiveStatus)) {
      return "VERIFYING";
    }
    if (effectiveStatus === "IDLE") {
      return "PENDING";
    }
    if (effectiveStatus === "PREPARING") {
      return run.source_thread_id === null ? "PENDING" : "COMPLETED";
    }
    return effectiveStatus === undefined ? "UNKNOWN" : "RUNNING";
  }
}

export function openFileControlPlane(
  storageRoot: string,
  now: () => Date = () => new Date(),
): ControlPlane | ControlPlaneError {
  const runStore = FileRunStore.open(storageRoot, { now });
  if (runStore instanceof StateStoreError) {
    return new ControlPlaneError(
      runStore.code === "state_corrupt" ? "state_corrupt" : "state_persist_failed",
      runStore.message,
      { cause: runStore },
    );
  }
  const guard = FileWorkspaceGuard.open(storageRoot, { now });
  if (guard instanceof WorkspaceGuardError) {
    return new ControlPlaneError(
      guard.code === "workspace_guard_corrupt" ? "state_corrupt" : "state_persist_failed",
      guard.message,
      { cause: guard },
    );
  }
  const journal = FileCommandJournal.open(storageRoot);
  if (journal instanceof ControlPlaneError) {
    return journal;
  }
  const options = {
    run_store: runStore,
    command_journal: journal,
    workspace_guard: guard,
    lifecycle: new FileControlLifecycle(guard),
    recovery: new EvidenceBoundRecovery(guard),
    slice_phase: new CurrentSlicePhase(),
    now,
  } satisfies ControlPlaneOptions;
  return new ControlPlane(options);
}
