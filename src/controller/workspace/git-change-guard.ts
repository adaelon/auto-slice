import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  type WorkspaceIdentity,
} from "../../contracts/index.js";
import { createWorkspaceIdentity } from "../../contracts/workspace-identity.js";
import { canonicalJson, sha256Bytes, sha256Json } from "../state/index.js";
import { WorkspaceGuardError } from "./errors.js";
import {
  WORKSPACE_GUARD_SCHEMA_VERSION,
  type ChangeSet,
  type GitIndexEntry,
  type GitPathState,
  type GitTreeEntry,
  type OwnedPatch,
  type ProtectedBaseline,
  type WorkspaceSnapshot,
  type WorktreeEntry,
} from "./types.js";

const MAXIMUM_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

interface SnapshotMaterial {
  readonly workspace_identity: WorkspaceIdentity;
  readonly head_oid: string;
  readonly entries: readonly GitPathState[];
  readonly captured_at: string;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function repoPath(value: string): string {
  return value.split(path.sep).join("/");
}

function decodeGitOutput(buffer: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    throw new WorkspaceGuardError("git_inspection_failed", `${label} is not valid UTF-8.`, { cause: error });
  }
}

function parseNullSeparated(buffer: Buffer, label: string): readonly string[] {
  return decodeGitOutput(buffer, label).split("\0").filter((entry) => entry.length > 0).map(repoPath);
}

function snapshotDigest(material: Pick<SnapshotMaterial, "workspace_identity" | "head_oid" | "entries">): `sha256:${string}` {
  return sha256Json({
    workspace_identity: material.workspace_identity,
    head_oid: material.head_oid,
    entries: material.entries,
  });
}

function normalizedOwnedPath(value: string): string | WorkspaceGuardError {
  const normalized = value.replaceAll("\\", "/");
  const recursive = normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  const segments = base.split("/");
  if (
    base.length === 0 ||
    path.posix.isAbsolute(base) ||
    path.win32.isAbsolute(base) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /[*?[\]]/u.test(base)
  ) {
    return new WorkspaceGuardError("invalid_owned_path", `Owned path is not a safe repository-relative path: ${value}.`);
  }
  return recursive ? `${base}/**` : base;
}

function foldPath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isOwned(relativePath: string, patterns: readonly string[]): boolean {
  const candidate = foldPath(relativePath);
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const base = foldPath(pattern.slice(0, -3));
      return candidate === base || candidate.startsWith(`${base}/`);
    }
    return candidate === foldPath(pattern);
  });
}

function stateMap(entries: readonly GitPathState[]): ReadonlyMap<string, GitPathState> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

export class GitChangeGuard {
  public constructor(private readonly now: () => Date = () => new Date()) {}

  public captureBaseline(workspace: WorkspaceIdentity): ProtectedBaseline | WorkspaceGuardError {
    const material = this.captureSnapshot(workspace);
    if (material instanceof WorkspaceGuardError) {
      return material;
    }
    return {
      schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
      kind: "PROTECTED_BASELINE",
      ...material,
      baseline_digest: snapshotDigest(material),
    };
  }

  public captureCurrent(workspace: WorkspaceIdentity): WorkspaceSnapshot | WorkspaceGuardError {
    const material = this.captureSnapshot(workspace);
    if (material instanceof WorkspaceGuardError) {
      return material;
    }
    return {
      schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
      kind: "CURRENT_WORKSPACE",
      ...material,
      snapshot_digest: snapshotDigest(material),
    };
  }

  public classify(
    baseline: ProtectedBaseline,
    current: WorkspaceSnapshot,
    ownedPaths: readonly string[],
  ): ChangeSet | WorkspaceGuardError {
    const normalizedPatterns: string[] = [];
    for (const ownedPath of ownedPaths) {
      const normalized = normalizedOwnedPath(ownedPath);
      if (normalized instanceof WorkspaceGuardError) {
        return normalized;
      }
      normalizedPatterns.push(normalized);
    }
    const declaredOwnedPaths = [...new Set(normalizedPatterns)].sort();
    if (canonicalJson(baseline.workspace_identity) !== canonicalJson(current.workspace_identity)) {
      return new WorkspaceGuardError("workspace_guard_corrupt", "Baseline and current snapshots do not identify one workspace.");
    }
    if (
      baseline.baseline_digest !== snapshotDigest(baseline) ||
      current.snapshot_digest !== snapshotDigest(current)
    ) {
      return new WorkspaceGuardError("workspace_guard_corrupt", "A Git snapshot digest is invalid.");
    }

    const baselineByPath = stateMap(baseline.entries);
    const currentByPath = stateMap(current.entries);
    const allPaths = [...new Set([...baselineByPath.keys(), ...currentByPath.keys()])].sort();
    const protectedPaths: string[] = [];
    const owned: string[] = [];
    const overlaps: string[] = [];
    const unowned: string[] = [];
    const ownedEntries: GitPathState[] = [];

    for (const relativePath of allPaths) {
      const before = baselineByPath.get(relativePath);
      const after = currentByPath.get(relativePath);
      if (before !== undefined) {
        if (after !== undefined && canonicalJson(before) === canonicalJson(after)) {
          protectedPaths.push(relativePath);
        } else {
          overlaps.push(relativePath);
        }
        continue;
      }
      if (after !== undefined) {
        if (isOwned(relativePath, declaredOwnedPaths)) {
          owned.push(relativePath);
          ownedEntries.push(after);
        } else {
          unowned.push(relativePath);
        }
      }
    }

    const headChanged = baseline.head_oid !== current.head_oid;
    if (headChanged) {
      overlaps.unshift("<HEAD>");
    }
    const material = {
      schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
      workspace_identity: current.workspace_identity,
      head_oid: current.head_oid,
      baseline_digest: baseline.baseline_digest,
      current_digest: current.snapshot_digest,
      declared_owned_paths: declaredOwnedPaths,
      protected_paths: protectedPaths,
      owned_paths: owned,
      overlap_paths: overlaps,
      unowned_paths: unowned,
      head_changed: headChanged,
      owned_entries: ownedEntries,
    };
    return {
      ...material,
      change_set_digest: sha256Json(material),
    };
  }

  public assertCommittable(changeSet: ChangeSet): OwnedPatch | WorkspaceGuardError {
    const material = {
      schema_version: changeSet.schema_version,
      workspace_identity: changeSet.workspace_identity,
      head_oid: changeSet.head_oid,
      baseline_digest: changeSet.baseline_digest,
      current_digest: changeSet.current_digest,
      declared_owned_paths: changeSet.declared_owned_paths,
      protected_paths: changeSet.protected_paths,
      owned_paths: changeSet.owned_paths,
      overlap_paths: changeSet.overlap_paths,
      unowned_paths: changeSet.unowned_paths,
      head_changed: changeSet.head_changed,
      owned_entries: changeSet.owned_entries,
    };
    if (changeSet.change_set_digest !== sha256Json(material)) {
      return new WorkspaceGuardError("workspace_guard_corrupt", "ChangeSet digest is invalid.");
    }
    if (changeSet.head_changed || changeSet.overlap_paths.length > 0 || changeSet.unowned_paths.length > 0) {
      const conflicts = [...changeSet.overlap_paths, ...changeSet.unowned_paths];
      return new WorkspaceGuardError(
        "protected_change_overlap",
        `Changes cannot be proven Slice-owned: ${conflicts.join(", ")}.`,
      );
    }
    const patchMaterial = {
      schema_version: WORKSPACE_GUARD_SCHEMA_VERSION,
      workspace_identity: changeSet.workspace_identity,
      head_oid: changeSet.head_oid,
      baseline_digest: changeSet.baseline_digest,
      current_digest: changeSet.current_digest,
      paths: changeSet.owned_paths,
      entries: changeSet.owned_entries,
    };
    return {
      ...patchMaterial,
      patch_digest: sha256Json(patchMaterial),
    };
  }

  private captureSnapshot(workspace: WorkspaceIdentity): SnapshotMaterial | WorkspaceGuardError {
    try {
      const root = realpathSync.native(workspace.canonical_root);
      const actualIdentity = createWorkspaceIdentity(root);
      if (canonicalJson(actualIdentity) !== canonicalJson(workspace)) {
        return new WorkspaceGuardError("git_inspection_failed", "Workspace identity changed before Git inspection.");
      }
      const gitRootOutput = this.runGit(
        root,
        ["rev-parse", "--show-toplevel"],
        "Git worktree root",
        "workspace_not_git_worktree",
      );
      const gitRoot = realpathSync.native(decodeGitOutput(gitRootOutput, "Git worktree root").trim());
      if (comparablePath(gitRoot) !== comparablePath(root)) {
        return new WorkspaceGuardError(
          "workspace_not_git_worktree",
          `V1 requires the workspace root to equal its Git worktree root: ${root}.`,
        );
      }
      const headOid = decodeGitOutput(
        this.runGit(root, ["rev-parse", "--verify", "HEAD"], "Git HEAD"),
        "Git HEAD",
      ).trim();
      if (!/^[0-9a-f]{40,64}$/u.test(headOid)) {
        return new WorkspaceGuardError("git_inspection_failed", "Git HEAD is not a full object ID.");
      }
      const tracked = parseNullSeparated(
        this.runGit(
          root,
          ["--literal-pathspecs", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
          "Git tracked changes",
        ),
        "Git tracked paths",
      );
      const untracked = parseNullSeparated(
        this.runGit(
          root,
          ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--"],
          "Git untracked changes",
        ),
        "Git untracked paths",
      );
      const paths = [...new Set([...tracked, ...untracked])].sort();
      const entries = paths.map((relativePath) => this.capturePathState(root, relativePath));
      const capturedAt = this.now();
      if (!Number.isFinite(capturedAt.getTime())) {
        return new WorkspaceGuardError("git_inspection_failed", "ChangeGuard clock returned an invalid Date.");
      }
      return {
        workspace_identity: workspace,
        head_oid: headOid,
        entries,
        captured_at: capturedAt.toISOString(),
      };
    } catch (error: unknown) {
      if (error instanceof WorkspaceGuardError) {
        return error;
      }
      return new WorkspaceGuardError("git_inspection_failed", "Git workspace inspection failed closed.", { cause: error });
    }
  }

  private capturePathState(root: string, relativePath: string): GitPathState {
    if (
      relativePath.length === 0 ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((segment) => segment === "..")
    ) {
      throw new WorkspaceGuardError("git_inspection_failed", `Git returned an unsafe path: ${relativePath}.`);
    }
    const head = this.captureHeadEntry(root, relativePath);
    const index = this.captureIndexEntries(root, relativePath);
    const worktree = this.captureWorktreeEntry(root, relativePath);
    const patch = this.runGit(
      root,
      [
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        relativePath,
      ],
      `Git patch for ${relativePath}`,
    );
    return {
      path: relativePath,
      head,
      index,
      worktree,
      combined_patch_digest: sha256Bytes(patch),
    };
  }

  private captureHeadEntry(root: string, relativePath: string): GitTreeEntry | null {
    const output = parseNullSeparated(
      this.runGit(root, ["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", relativePath], `Git HEAD entry for ${relativePath}`),
      `Git HEAD entry for ${relativePath}`,
    );
    if (output.length === 0) {
      return null;
    }
    if (output.length !== 1) {
      throw new WorkspaceGuardError("git_inspection_failed", `Git returned multiple HEAD entries for ${relativePath}.`);
    }
    const record = output[0];
    if (record === undefined) {
      return null;
    }
    const tab = record.indexOf("\t");
    const header = tab < 0 ? record : record.slice(0, tab);
    const [mode, objectType, objectId, ...extra] = header.split(" ");
    if (
      mode === undefined ||
      objectType === undefined ||
      objectId === undefined ||
      extra.length > 0 ||
      !/^[0-7]{6}$/u.test(mode) ||
      !/^[0-9a-f]{40,64}$/u.test(objectId)
    ) {
      throw new WorkspaceGuardError("git_inspection_failed", `Git returned an invalid HEAD entry for ${relativePath}.`);
    }
    return { mode, object_type: objectType, object_id: objectId };
  }

  private captureIndexEntries(root: string, relativePath: string): readonly GitIndexEntry[] {
    const records = parseNullSeparated(
      this.runGit(
        root,
        ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", relativePath],
        `Git index entry for ${relativePath}`,
      ),
      `Git index entry for ${relativePath}`,
    );
    return records.map((record) => {
      const tab = record.indexOf("\t");
      const header = tab < 0 ? record : record.slice(0, tab);
      const [mode, objectId, stageText, ...extra] = header.split(" ");
      const stage = Number(stageText);
      if (
        mode === undefined ||
        objectId === undefined ||
        stageText === undefined ||
        extra.length > 0 ||
        !/^[0-7]{6}$/u.test(mode) ||
        !/^[0-9a-f]{40,64}$/u.test(objectId) ||
        !Number.isInteger(stage) ||
        stage < 0 ||
        stage > 3
      ) {
        throw new WorkspaceGuardError("git_inspection_failed", `Git returned an invalid index entry for ${relativePath}.`);
      }
      return { mode, object_id: objectId, stage };
    }).sort((left, right) => left.stage - right.stage);
  }

  private captureWorktreeEntry(root: string, relativePath: string): WorktreeEntry | null {
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    const relativeToRoot = path.relative(root, absolutePath);
    if (
      relativeToRoot === ".." ||
      relativeToRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new WorkspaceGuardError("git_inspection_failed", `Git path escapes the workspace: ${relativePath}.`);
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absolutePath);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
    if (stats.isFile()) {
      const executable = process.platform !== "win32" && (stats.mode & 0o111) !== 0;
      return {
        kind: "file",
        mode: executable ? "100755" : "100644",
        digest: sha256Bytes(readFileSync(absolutePath)),
      };
    }
    if (stats.isSymbolicLink()) {
      return {
        kind: "symlink",
        mode: "120000",
        digest: sha256Bytes(`symlink\0${readlinkSync(absolutePath)}`),
      };
    }
    if (stats.isDirectory()) {
      return {
        kind: "directory",
        mode: "040000",
        digest: sha256Bytes(`directory\0${relativePath}`),
      };
    }
    return {
      kind: "other",
      mode: "000000",
      digest: sha256Bytes(`other\0${String(stats.mode)}`),
    };
  }

  private runGit(
    root: string,
    args: readonly string[],
    label: string,
    failureCode: "git_inspection_failed" | "workspace_not_git_worktree" = "git_inspection_failed",
  ): Buffer {
    const result = spawnSync("git", ["-C", root, ...args], {
      cwd: root,
      env: process.env,
      maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
    const stderr = Buffer.isBuffer(result.stderr) ? decodeGitOutput(result.stderr, `${label} stderr`) : "";
    if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      const detail = result.error?.message ?? (stderr.trim() || `exit ${String(result.status)}`);
      throw new WorkspaceGuardError(failureCode, `${label} failed: ${detail}.`, { cause: result.error });
    }
    return result.stdout;
  }
}
