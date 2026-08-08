export { WorkspaceGuardError } from "./errors.js";
export { FileWorkspaceGuard } from "./file-workspace-guard.js";
export { GitChangeGuard } from "./git-change-guard.js";
export {
  WORKSPACE_GUARD_SCHEMA_VERSION,
  type ChangeSet,
  type FileWorkspaceGuardOptions,
  type FrozenLease,
  type GitIndexEntry,
  type GitPathState,
  type GitTreeEntry,
  type LeaseEventAction,
  type LeaseEventRecord,
  type LeaseState,
  type OwnedPatch,
  type ProjectLease,
  type ProtectedBaseline,
  type ReleasedLease,
  type WorkspaceGuardFailureCode,
  type WorkspaceSnapshot,
  type WorktreeEntry,
} from "./types.js";
