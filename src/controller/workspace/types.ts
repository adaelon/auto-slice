import type { WorkspaceIdentity } from "../../contracts/index.js";
import type { Sha256Digest } from "../state/index.js";

export const WORKSPACE_GUARD_SCHEMA_VERSION = 1 as const;

export type WorkspaceGuardFailureCode =
  | "project_lock_unavailable"
  | "lease_lost"
  | "stale_write_epoch"
  | "protected_change_overlap"
  | "workspace_guard_persist_failed"
  | "workspace_guard_corrupt"
  | "workspace_not_git_worktree"
  | "git_inspection_failed"
  | "invalid_owned_path";

interface LeaseBase {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly lease_id: string;
  readonly workspace_identity: WorkspaceIdentity;
  readonly run_id: string;
  readonly epoch: number;
  readonly revision: number;
  readonly acquired_at: string;
  readonly renewed_at: string;
  readonly expires_at: string;
}

export interface ProjectLease extends LeaseBase {
  readonly status: "ACTIVE";
}

export interface FrozenLease extends LeaseBase {
  readonly status: "FROZEN";
  readonly frozen_at: string;
}

export interface ReleasedLease extends LeaseBase {
  readonly status: "RELEASED";
  readonly released_at: string;
}

export type LeaseState = ProjectLease | FrozenLease | ReleasedLease;
export type LeaseEventAction = "ACQUIRED" | "RENEWED" | "FROZEN" | "EPOCH_ROTATED" | "RELEASED";

export interface LeaseEventRecord {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly lease_id: string;
  readonly event_index: number;
  readonly action: LeaseEventAction;
  readonly occurred_at: string;
  readonly previous_event_digest: Sha256Digest | null;
  readonly before_state: LeaseState | null;
  readonly before_state_digest: Sha256Digest | null;
  readonly after_state: LeaseState;
  readonly after_state_digest: Sha256Digest;
  readonly event_digest: Sha256Digest;
}

export interface FileWorkspaceGuardOptions {
  readonly now?: () => Date;
  readonly leaseIdFactory?: () => string;
  readonly leaseDurationMs?: number;
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly object_type: string;
  readonly object_id: string;
}

export interface GitIndexEntry {
  readonly mode: string;
  readonly object_id: string;
  readonly stage: number;
}

export interface WorktreeEntry {
  readonly kind: "file" | "symlink" | "directory" | "other";
  readonly mode: string;
  readonly digest: Sha256Digest;
}

export interface GitPathState {
  readonly path: string;
  readonly head: GitTreeEntry | null;
  readonly index: readonly GitIndexEntry[];
  readonly worktree: WorktreeEntry | null;
  readonly combined_patch_digest: Sha256Digest;
}

interface GitSnapshotBase {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly workspace_identity: WorkspaceIdentity;
  readonly head_oid: string;
  readonly entries: readonly GitPathState[];
  readonly captured_at: string;
}

export interface ProtectedBaseline extends GitSnapshotBase {
  readonly kind: "PROTECTED_BASELINE";
  readonly baseline_digest: Sha256Digest;
}

export interface WorkspaceSnapshot extends GitSnapshotBase {
  readonly kind: "CURRENT_WORKSPACE";
  readonly snapshot_digest: Sha256Digest;
}

export interface ChangeSet {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly workspace_identity: WorkspaceIdentity;
  readonly head_oid: string;
  readonly baseline_digest: Sha256Digest;
  readonly current_digest: Sha256Digest;
  readonly declared_owned_paths: readonly string[];
  readonly protected_paths: readonly string[];
  readonly owned_paths: readonly string[];
  readonly overlap_paths: readonly string[];
  readonly unowned_paths: readonly string[];
  readonly head_changed: boolean;
  readonly owned_entries: readonly GitPathState[];
  readonly change_set_digest: Sha256Digest;
}

export interface OwnedPatch {
  readonly schema_version: typeof WORKSPACE_GUARD_SCHEMA_VERSION;
  readonly workspace_identity: WorkspaceIdentity;
  readonly head_oid: string;
  readonly baseline_digest: Sha256Digest;
  readonly current_digest: Sha256Digest;
  readonly paths: readonly string[];
  readonly entries: readonly GitPathState[];
  readonly patch_digest: Sha256Digest;
}
