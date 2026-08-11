import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type CommitMode,
  type Sha256Digest,
} from "../state/index.js";
import {
  GitChangeGuard,
  WorkspaceGuardError,
  type GitPathState,
  type ProtectedBaseline,
  type WorkspaceSnapshot,
} from "../workspace/index.js";
import { ProductionRuntimeError } from "./errors.js";

export const GOAL_COMPLETION_SCHEMA_VERSION = 1 as const;
export const GOAL_CHECKPOINT_PATH = "SESSION_CHECKPOINT.md" as const;

const MAXIMUM_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CHECKPOINT_BYTES = 1024 * 1024;

export interface GoalCompletionRequest {
  readonly workspace_identity: WorkspaceIdentity;
  readonly protected_baseline: ProtectedBaseline;
  readonly workspace_snapshot: WorkspaceSnapshot;
  readonly owned_paths: readonly string[];
  readonly commit_mode: CommitMode;
}

export interface GoalCompletionReceipt {
  readonly schema_version: typeof GOAL_COMPLETION_SCHEMA_VERSION;
  readonly workspace_identity: WorkspaceIdentity;
  readonly commit_mode: CommitMode;
  readonly commit_created: boolean;
  readonly start_head: string;
  readonly end_head: string;
  readonly owned_paths: readonly string[];
  readonly owned_diff_digest: Sha256Digest;
  readonly checkpoint_path: typeof GOAL_CHECKPOINT_PATH;
  readonly checkpoint_digest: Sha256Digest;
  readonly observed_at: string;
  readonly receipt_digest: Sha256Digest;
}

function runtimeError(message: string, cause?: unknown): ProductionRuntimeError {
  return new ProductionRuntimeError(
    "slice_verification_failed",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function snapshotDigest(
  snapshot: Pick<ProtectedBaseline, "workspace_identity" | "head_oid" | "entries">,
): Sha256Digest {
  return sha256Json({
    workspace_identity: snapshot.workspace_identity,
    head_oid: snapshot.head_oid,
    entries: snapshot.entries,
  });
}

function normalizeOwnedPath(value: string): string | null {
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
    return null;
  }
  return recursive ? `${base}/**` : base;
}

function foldPath(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function isOwned(candidatePath: string, patterns: readonly string[]): boolean {
  const candidate = foldPath(candidatePath);
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const base = foldPath(pattern.slice(0, -3));
      return candidate === base || candidate.startsWith(`${base}/`);
    }
    return candidate === foldPath(pattern);
  });
}

function withoutCheckpoint(entries: readonly GitPathState[]): readonly GitPathState[] {
  return entries.filter((entry) => foldPath(entry.path) !== foldPath(GOAL_CHECKPOINT_PATH));
}

function checkpointState(entries: readonly GitPathState[]): GitPathState | undefined {
  return entries.find((entry) => foldPath(entry.path) === foldPath(GOAL_CHECKPOINT_PATH));
}

function parseNullSeparated(value: Buffer): readonly string[] {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  return decoded
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replaceAll("\\", "/"));
}

function receipt(material: Omit<GoalCompletionReceipt, "receipt_digest">): GoalCompletionReceipt {
  return { ...material, receipt_digest: sha256Json(material) };
}

export class GitGoalCompletionGuard {
  private readonly changeGuard: GitChangeGuard;

  public constructor(private readonly now: () => Date = () => new Date()) {
    this.changeGuard = new GitChangeGuard(now);
  }

  public observe(
    request: GoalCompletionRequest,
  ): GoalCompletionReceipt | ProductionRuntimeError {
    try {
      const inputFailure = this.validateInput(request);
      if (inputFailure !== null) {
        return inputFailure;
      }
      const checkpointDigest = this.checkpointDigest(request);
      if (checkpointDigest instanceof ProductionRuntimeError) {
        return checkpointDigest;
      }
      return request.commit_mode === "none"
        ? this.observeWithoutCommit(request, checkpointDigest)
        : this.observeCommitted(request, checkpointDigest);
    } catch (error: unknown) {
      return runtimeError("Goal task completion could not be inspected deterministically.", error);
    }
  }

  private validateInput(request: GoalCompletionRequest): ProductionRuntimeError | null {
    if (
      canonicalJson(request.workspace_identity) !==
        canonicalJson(request.protected_baseline.workspace_identity) ||
      canonicalJson(request.workspace_identity) !==
        canonicalJson(request.workspace_snapshot.workspace_identity) ||
      request.protected_baseline.baseline_digest !== snapshotDigest(request.protected_baseline) ||
      request.workspace_snapshot.snapshot_digest !== snapshotDigest(request.workspace_snapshot)
    ) {
      return runtimeError("Goal completion inputs do not bind one valid workspace snapshot pair.");
    }
    const normalized = request.owned_paths.map(normalizeOwnedPath);
    if (normalized.some((entry) => entry === null)) {
      return runtimeError("Goal completion contains an invalid Slice-owned path.");
    }
    return null;
  }

  private checkpointDigest(
    request: GoalCompletionRequest,
  ): Sha256Digest | ProductionRuntimeError {
    const before = checkpointState(request.protected_baseline.entries);
    const after = checkpointState(request.workspace_snapshot.entries);
    const unchanged = before === undefined
      ? after === undefined
      : after !== undefined && canonicalJson(before) === canonicalJson(after);
    if (after === undefined || unchanged) {
      return runtimeError(
        "Development Task did not refresh SESSION_CHECKPOINT.md after completing the Slice.",
      );
    }
    const checkpoint = path.join(
      request.workspace_identity.canonical_root,
      GOAL_CHECKPOINT_PATH,
    );
    const stat = lstatSync(checkpoint);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAXIMUM_CHECKPOINT_BYTES) {
      return runtimeError("SESSION_CHECKPOINT.md must be one non-empty bounded regular file.");
    }
    return sha256Bytes(readFileSync(checkpoint));
  }

  private observeWithoutCommit(
    request: GoalCompletionRequest,
    checkpointDigest: Sha256Digest,
  ): GoalCompletionReceipt | ProductionRuntimeError {
    if (request.protected_baseline.head_oid !== request.workspace_snapshot.head_oid) {
      return runtimeError("commit_mode=none forbids Development Task commits.");
    }
    const baselineEntries = withoutCheckpoint(request.protected_baseline.entries);
    const currentEntries = withoutCheckpoint(request.workspace_snapshot.entries);
    const filteredBaseline: ProtectedBaseline = {
      ...request.protected_baseline,
      entries: baselineEntries,
      baseline_digest: snapshotDigest({
        ...request.protected_baseline,
        entries: baselineEntries,
      }),
    };
    const filteredCurrent: WorkspaceSnapshot = {
      ...request.workspace_snapshot,
      entries: currentEntries,
      snapshot_digest: snapshotDigest({
        ...request.workspace_snapshot,
        entries: currentEntries,
      }),
    };
    const changeSet = this.changeGuard.classify(
      filteredBaseline,
      filteredCurrent,
      request.owned_paths,
    );
    if (changeSet instanceof WorkspaceGuardError) {
      return runtimeError(`Goal completion ownership inspection failed: ${changeSet.code}.`, changeSet);
    }
    const ownedPatch = this.changeGuard.assertCommittable(changeSet);
    if (ownedPatch instanceof WorkspaceGuardError) {
      return runtimeError(
        `Goal task changed protected or unowned paths: ${[
          ...changeSet.overlap_paths,
          ...changeSet.unowned_paths,
        ].join(", ")}.`,
        ownedPatch,
      );
    }
    const observedAt = this.timestamp();
    if (observedAt instanceof ProductionRuntimeError) {
      return observedAt;
    }
    return receipt({
      schema_version: GOAL_COMPLETION_SCHEMA_VERSION,
      workspace_identity: request.workspace_identity,
      commit_mode: "none",
      commit_created: false,
      start_head: request.protected_baseline.head_oid,
      end_head: request.workspace_snapshot.head_oid,
      owned_paths: ownedPatch.paths,
      owned_diff_digest: ownedPatch.patch_digest,
      checkpoint_path: GOAL_CHECKPOINT_PATH,
      checkpoint_digest: checkpointDigest,
      observed_at: observedAt,
    });
  }

  private observeCommitted(
    request: GoalCompletionRequest,
    checkpointDigest: Sha256Digest,
  ): GoalCompletionReceipt | ProductionRuntimeError {
    const startHead = request.protected_baseline.head_oid;
    const endHead = request.workspace_snapshot.head_oid;
    if (startHead === endHead) {
      return runtimeError("commit_mode=after_slice requires the Development Task to create a commit.");
    }
    const parentLine = this.decodeGitText(this.runGit(
      request.workspace_identity.canonical_root,
      ["rev-list", "--parents", "-n", "1", endHead],
    )).trim();
    const parents = parentLine.split(/\s+/u);
    if (parents.length !== 2 || parents[0] !== endHead || parents[1] !== startHead) {
      return runtimeError(
        "commit_mode=after_slice requires exactly one non-merge commit whose parent is the Slice baseline.",
      );
    }

    const changedPaths = [...new Set(parseNullSeparated(this.runGit(
      request.workspace_identity.canonical_root,
      [
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        startHead,
        endHead,
        "--",
      ],
    )))].sort();
    if (changedPaths.length === 0) {
      return runtimeError("The Development Task commit contains no Slice changes.");
    }
    const normalizedPatterns = request.owned_paths.map((entry) => normalizeOwnedPath(entry) as string);
    const protectedPaths = new Set(
      request.protected_baseline.entries.map((entry) => foldPath(entry.path)),
    );
    const overlapPaths = changedPaths.filter((entry) => protectedPaths.has(foldPath(entry)));
    const unownedPaths = changedPaths.filter((entry) => (
      foldPath(entry) === foldPath(GOAL_CHECKPOINT_PATH) ||
      !isOwned(entry, normalizedPatterns)
    ));
    if (overlapPaths.length > 0 || unownedPaths.length > 0) {
      return runtimeError(
        `Development Task commit is not Slice-owned: ${[
          ...new Set([...overlapPaths, ...unownedPaths]),
        ].sort().join(", ")}.`,
      );
    }

    const baselineRemainder = withoutCheckpoint(request.protected_baseline.entries);
    const currentRemainder = withoutCheckpoint(request.workspace_snapshot.entries);
    if (canonicalJson(baselineRemainder) !== canonicalJson(currentRemainder)) {
      return runtimeError(
        "Development Task left uncommitted changes outside the checkpoint or altered a Protected Change.",
      );
    }
    const patch = this.runGit(
      request.workspace_identity.canonical_root,
      [
        "--literal-pathspecs",
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        startHead,
        endHead,
        "--",
      ],
    );
    const observedAt = this.timestamp();
    if (observedAt instanceof ProductionRuntimeError) {
      return observedAt;
    }
    return receipt({
      schema_version: GOAL_COMPLETION_SCHEMA_VERSION,
      workspace_identity: request.workspace_identity,
      commit_mode: "after_slice",
      commit_created: true,
      start_head: startHead,
      end_head: endHead,
      owned_paths: changedPaths,
      owned_diff_digest: sha256Json({
        start_head: startHead,
        end_head: endHead,
        paths: changedPaths,
        patch_digest: sha256Bytes(patch),
      }),
      checkpoint_path: GOAL_CHECKPOINT_PATH,
      checkpoint_digest: checkpointDigest,
      observed_at: observedAt,
    });
  }

  private runGit(root: string, args: readonly string[]): Buffer {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw result.error ?? new Error(`git exited ${String(result.status)}`);
    }
    return result.stdout;
  }

  private decodeGitText(value: Buffer): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  }

  private timestamp(): string | ProductionRuntimeError {
    try {
      const value = this.now();
      if (!Number.isFinite(value.getTime())) {
        return runtimeError("Goal completion clock returned an invalid Date.");
      }
      return value.toISOString();
    } catch (error: unknown) {
      return runtimeError("Goal completion clock could not be read.", error);
    }
  }
}
