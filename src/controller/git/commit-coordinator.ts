import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Bytes, sha256Json } from "../state/index.js";
import type { VerificationReceipt } from "../slices/index.js";
import {
  GitChangeGuard,
  WorkspaceGuardError,
  type OwnedPatch,
} from "../workspace/index.js";
import { CheckpointWriter } from "./checkpoint-writer.js";
import { CommitCoordinatorError, CheckpointWriteError } from "./errors.js";
import { GitProcessRunner } from "./git-process-runner.js";
import {
  COMMIT_COORDINATOR_SCHEMA_VERSION,
  type CheckpointDocument,
  type CommitCoordinatorFailureCode,
  type CommitCoordinatorOptions,
  type FinishReceipt,
  type FinishSliceInput,
  type GitCommandOptions,
  type GitCommandPort,
} from "./types.js";

const CHECKPOINT_PATH = "SESSION_CHECKPOINT.md" as const;

class GitInvocationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitInvocationError";
  }
}

function verificationMaterial(
  receipt: VerificationReceipt,
): Omit<VerificationReceipt, "receipt_digest"> {
  const base = {
    schema_version: receipt.schema_version,
    slice_id: receipt.slice_id,
    execution_id: receipt.execution_id,
    contract_digest: receipt.contract_digest,
    result: receipt.result,
    check_receipts: receipt.check_receipts,
    artifact_digests: receipt.artifact_digests,
    owned_diff_digest: receipt.owned_diff_digest,
    overlap_paths: receipt.overlap_paths,
    unowned_paths: receipt.unowned_paths,
  };
  return receipt.failure_code === undefined
    ? base
    : { ...base, failure_code: receipt.failure_code };
}

function finishMaterial(receipt: Omit<FinishReceipt, "receipt_digest">): FinishReceipt {
  return {
    ...receipt,
    receipt_digest: sha256Json(receipt),
  };
}

function normalizeRepoPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseNullSeparated(buffer: Buffer): readonly string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error: unknown) {
    throw new GitInvocationError(
      `Git returned a non-UTF-8 path list: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return decoded.split("\0").filter((entry) => entry.length > 0).map(normalizeRepoPath);
}

function isSafeSingleLine(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/u.test(value);
}

export class CommitCoordinator {
  private readonly git: GitCommandPort;
  private readonly checkpointWriter: CheckpointWriter;
  private readonly now: () => Date;
  private readonly indexNameFactory: () => string;
  private readonly faultInjector: CommitCoordinatorOptions["faultInjector"];
  private readonly changeGuard: GitChangeGuard;

  public constructor(options: CommitCoordinatorOptions = {}) {
    this.git = options.git ?? new GitProcessRunner();
    this.checkpointWriter = options.checkpointWriter ?? new CheckpointWriter();
    this.now = options.now ?? (() => new Date());
    this.indexNameFactory = options.indexNameFactory ??
      (() => `auto-slice-index-${String(process.pid)}-${randomUUID()}.tmp`);
    this.faultInjector = options.faultInjector;
    this.changeGuard = options.changeGuard ?? new GitChangeGuard();
  }

  public finishSlice(input: FinishSliceInput): FinishReceipt | CommitCoordinatorError {
    const declaredStartHead = input.owned_patch.head_oid;
    try {
      const validated = this.validateInput(input);
      if (validated instanceof CommitCoordinatorError) {
        return validated;
      }
      const mode = input.slice.commit_mode_override ?? input.run.commit_mode;
      if (mode === "none") {
        return this.finishWithoutCommit(input, validated);
      }
      return this.finishWithCommit(input, validated);
    } catch (error: unknown) {
      return this.failure(
        "git_inspection_failed",
        "Commit coordination failed closed on an unexpected local error.",
        declaredStartHead,
        this.tryReadHead(input.run.workspace_identity.canonical_root),
        false,
        error,
      );
    }
  }

  private validateInput(input: FinishSliceInput): OwnedPatch | CommitCoordinatorError {
    const startHead = input.owned_patch.head_oid;
    const mode = input.slice.commit_mode_override ?? input.run.commit_mode;
    const runtimeMode: unknown = mode;
    if (
      (runtimeMode !== "after_slice" && runtimeMode !== "none") ||
      input.run.current_slice_id !== input.slice.slice_id ||
      !isSafeSingleLine(input.commit_message) ||
      input.commit_message.length > 200
    ) {
      return this.failure(
        "finish_input_invalid",
        "Finish input must identify the current Slice, a frozen commit mode, and one safe commit message.",
        startHead,
        startHead,
        false,
      );
    }
    if (input.verification.result !== "PASS") {
      return this.failure(
        "verification_failed",
        "A Slice cannot finish unless its VerificationReceipt is PASS.",
        startHead,
        startHead,
        false,
      );
    }
    if (
      input.verification.receipt_digest !== sha256Json(verificationMaterial(input.verification)) ||
      input.verification.slice_id !== input.slice.slice_id ||
      input.verification.contract_digest !== sha256Json(input.slice) ||
      input.verification.failure_code !== undefined ||
      input.verification.overlap_paths.length > 0 ||
      input.verification.unowned_paths.length > 0
    ) {
      return this.failure(
        "verification_receipt_invalid",
        "VerificationReceipt identity, digest, or PASS material is invalid.",
        startHead,
        startHead,
        false,
      );
    }
    if (
      canonicalJson(input.run.workspace_identity) !== canonicalJson(input.protected_baseline.workspace_identity) ||
      canonicalJson(input.run.workspace_identity) !== canonicalJson(input.owned_patch.workspace_identity) ||
      input.run.protected_baseline_digest !== input.protected_baseline.baseline_digest ||
      input.protected_baseline.baseline_digest !== input.owned_patch.baseline_digest ||
      input.protected_baseline.head_oid !== input.owned_patch.head_oid ||
      input.verification.owned_diff_digest !== input.owned_patch.patch_digest
    ) {
      return this.failure(
        "owned_patch_invalid",
        "OwnedPatch, ProtectedBaseline, Run, and VerificationReceipt do not identify one verified workspace state.",
        startHead,
        startHead,
        false,
      );
    }

    const current = this.changeGuard.captureCurrent(input.run.workspace_identity);
    if (current instanceof WorkspaceGuardError) {
      return this.workspaceFailure(current, startHead);
    }
    if (current.head_oid !== startHead) {
      return this.failure(
        "head_drift",
        "Git HEAD changed after Slice verification.",
        startHead,
        current.head_oid,
        false,
      );
    }
    const changeSet = this.changeGuard.classify(
      input.protected_baseline,
      current,
      input.slice.owned_paths,
    );
    if (changeSet instanceof WorkspaceGuardError) {
      return this.workspaceFailure(changeSet, startHead);
    }
    const recomputed = this.changeGuard.assertCommittable(changeSet);
    if (recomputed instanceof WorkspaceGuardError) {
      return this.failure(
        "protected_change_overlap",
        "Current changes can no longer be proven Slice-owned.",
        startHead,
        current.head_oid,
        false,
        recomputed,
      );
    }
    if (canonicalJson(recomputed) !== canonicalJson(input.owned_patch)) {
      return this.failure(
        "owned_patch_invalid",
        "OwnedPatch changed after deterministic verification.",
        startHead,
        current.head_oid,
        false,
      );
    }
    return recomputed;
  }

  private finishWithoutCommit(
    input: FinishSliceInput,
    ownedPatch: OwnedPatch,
  ): FinishReceipt | CommitCoordinatorError {
    const checkpoint = this.writeCheckpoint(input, "none", ownedPatch.head_oid);
    if (checkpoint instanceof CheckpointWriteError) {
      return this.checkpointFailure(checkpoint, ownedPatch.head_oid, ownedPatch.head_oid, false);
    }
    const completedAt = this.now();
    if (!Number.isFinite(completedAt.getTime())) {
      return this.failure(
        "finish_input_invalid",
        "CommitCoordinator clock returned an invalid Date.",
        ownedPatch.head_oid,
        ownedPatch.head_oid,
        false,
      );
    }
    return finishMaterial({
      schema_version: COMMIT_COORDINATOR_SCHEMA_VERSION,
      run_id: input.run.run_id,
      slice_id: input.slice.slice_id,
      commit_mode: "none",
      commit_created: false,
      start_head: ownedPatch.head_oid,
      end_head: ownedPatch.head_oid,
      owned_diff_digest: ownedPatch.patch_digest,
      verification_receipt_digest: input.verification.receipt_digest,
      checkpoint_path: checkpoint.path,
      checkpoint_digest: checkpoint.digest,
      completed_at: completedAt.toISOString(),
    });
  }

  private finishWithCommit(
    input: FinishSliceInput,
    ownedPatch: OwnedPatch,
  ): FinishReceipt | CommitCoordinatorError {
    if (ownedPatch.paths.length === 0) {
      return this.failure(
        "owned_patch_invalid",
        "after_slice requires a non-empty OwnedPatch.",
        ownedPatch.head_oid,
        ownedPatch.head_oid,
        false,
      );
    }
    const root = input.run.workspace_identity.canonical_root;
    let alternateIndex: string | null = null;
    let commitCreated = false;
    let actualHead = ownedPatch.head_oid;
    try {
      alternateIndex = this.prepareAlternateIndex(root, ownedPatch);
      this.faultInjector?.("after_stage");
      const stagedCurrent = this.changeGuard.captureCurrent(input.run.workspace_identity);
      if (stagedCurrent instanceof WorkspaceGuardError) {
        return this.workspaceFailure(stagedCurrent, ownedPatch.head_oid);
      }
      actualHead = stagedCurrent.head_oid;
      if (stagedCurrent.head_oid !== ownedPatch.head_oid) {
        return this.failure(
          "head_drift",
          "Git HEAD changed between exact staging and commit.",
          ownedPatch.head_oid,
          actualHead,
          false,
        );
      }
      if (stagedCurrent.snapshot_digest !== ownedPatch.current_digest) {
        return this.failure(
          "owned_patch_invalid",
          "Workspace contents changed between verification and commit.",
          ownedPatch.head_oid,
          stagedCurrent.head_oid,
          false,
        );
      }
      const commitResult = this.git.run(
        root,
        ["commit", "--quiet", "--no-gpg-sign", "--message", input.commit_message],
        { extra_environment: { GIT_INDEX_FILE: alternateIndex } },
      );
      actualHead = this.tryReadHead(root) ?? ownedPatch.head_oid;
      commitCreated = actualHead !== ownedPatch.head_oid;
      if (commitResult.exit_code !== 0 || commitResult.failure_message !== null || !commitCreated) {
        return this.failure(
          "commit_failed",
          "Git commit failed; no checkpoint was written.",
          ownedPatch.head_oid,
          actualHead,
          commitCreated,
          new GitInvocationError(this.gitFailureMessage(commitResult)),
        );
      }
    } catch (error: unknown) {
      actualHead = this.tryReadHead(root) ?? actualHead;
      commitCreated = actualHead !== ownedPatch.head_oid;
      const code: CommitCoordinatorFailureCode = error instanceof CommitCoordinatorError
        ? error.code
        : "commit_failed";
      if (error instanceof CommitCoordinatorError) {
        return error;
      }
      return this.failure(
        code,
        "Exact Slice staging or commit failed closed.",
        ownedPatch.head_oid,
        actualHead,
        commitCreated,
        error,
      );
    } finally {
      if (alternateIndex !== null && existsSync(alternateIndex)) {
        try {
          unlinkSync(alternateIndex);
        } catch {
          // The finish result remains fail-closed even if temporary cleanup fails.
        }
      }
    }

    const reconcile = this.git.run(
      root,
      ["--literal-pathspecs", "reset", "--quiet", actualHead, "--", ...ownedPatch.paths],
    );
    if (reconcile.exit_code !== 0 || reconcile.failure_message !== null) {
      return this.failure(
        "commit_failed",
        "Slice commit succeeded but the caller index could not be reconciled to the new HEAD.",
        ownedPatch.head_oid,
        actualHead,
        true,
        new GitInvocationError(this.gitFailureMessage(reconcile)),
      );
    }

    const checkpoint = this.writeCheckpoint(input, "after_slice", actualHead);
    if (checkpoint instanceof CheckpointWriteError) {
      return this.checkpointFailure(checkpoint, ownedPatch.head_oid, actualHead, true);
    }
    const completedAt = this.now();
    if (!Number.isFinite(completedAt.getTime())) {
      return this.failure(
        "finish_input_invalid",
        "CommitCoordinator clock returned an invalid Date after commit.",
        ownedPatch.head_oid,
        actualHead,
        true,
      );
    }
    return finishMaterial({
      schema_version: COMMIT_COORDINATOR_SCHEMA_VERSION,
      run_id: input.run.run_id,
      slice_id: input.slice.slice_id,
      commit_mode: "after_slice",
      commit_created: true,
      start_head: ownedPatch.head_oid,
      end_head: actualHead,
      owned_diff_digest: ownedPatch.patch_digest,
      verification_receipt_digest: input.verification.receipt_digest,
      checkpoint_path: checkpoint.path,
      checkpoint_digest: checkpoint.digest,
      completed_at: completedAt.toISOString(),
    });
  }

  private prepareAlternateIndex(root: string, ownedPatch: OwnedPatch): string {
    const gitDirectoryOutput = this.runGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const gitDirectoryText = this.decodeGitText(gitDirectoryOutput, "Git directory").trim();
    const gitDirectory = path.isAbsolute(gitDirectoryText)
      ? gitDirectoryText
      : path.resolve(root, gitDirectoryText);
    const indexName = this.indexNameFactory();
    if (
      !isSafeSingleLine(indexName) ||
      path.basename(indexName) !== indexName ||
      indexName === "." ||
      indexName === ".."
    ) {
      throw new CommitCoordinatorError(
        "finish_input_invalid",
        "Alternate Git index name must be one safe path segment.",
        {
          commit_created: false,
          start_head: ownedPatch.head_oid,
          actual_head: ownedPatch.head_oid,
          checkpoint_path: CHECKPOINT_PATH,
        },
      );
    }
    const alternateIndex = path.join(gitDirectory, indexName);
    try {
      const environment = { extra_environment: { GIT_INDEX_FILE: alternateIndex } } as const;
      this.runGit(root, ["read-tree", ownedPatch.head_oid], environment);
      this.runGit(
        root,
        ["--literal-pathspecs", "add", "--all", "--", ...ownedPatch.paths],
        environment,
      );
      const stagedPaths = [...new Set(parseNullSeparated(this.runGit(
        root,
        ["diff", "--cached", "--name-only", "-z", "--no-renames", ownedPatch.head_oid, "--"],
        environment,
      )))].sort();
      const expectedPaths = [...ownedPatch.paths].sort();
      if (canonicalJson(stagedPaths) !== canonicalJson(expectedPaths)) {
        throw new CommitCoordinatorError(
          "stage_scope_mismatch",
          "The alternate index contains paths outside the exact OwnedPatch.",
          {
            commit_created: false,
            start_head: ownedPatch.head_oid,
            actual_head: ownedPatch.head_oid,
            checkpoint_path: CHECKPOINT_PATH,
          },
        );
      }
      const expectedEntries = new Map(ownedPatch.entries.map((entry) => [entry.path, entry]));
      for (const ownedPath of expectedPaths) {
        const expected = expectedEntries.get(ownedPath);
        if (expected === undefined) {
          throw new CommitCoordinatorError(
            "owned_patch_invalid",
            `OwnedPatch is missing Git material for ${ownedPath}.`,
            {
              commit_created: false,
              start_head: ownedPatch.head_oid,
              actual_head: ownedPatch.head_oid,
              checkpoint_path: CHECKPOINT_PATH,
            },
          );
        }
        let stagedMaterialMatches: boolean;
        if (expected.head === null && expected.index.length === 0 && expected.worktree !== null) {
          // Git may normalize a new file through attributes or autocrlf. Exact path
          // scope is checked here; a fresh WorkspaceSnapshot below proves the raw
          // worktree material did not change while Git produced its canonical blob.
          stagedMaterialMatches = true;
        } else {
          const stagedPatch = this.runGit(
            root,
            [
              "diff",
              "--cached",
              "--binary",
              "--full-index",
              "--no-renames",
              "--no-ext-diff",
              "--no-textconv",
              ownedPatch.head_oid,
              "--",
              ownedPath,
            ],
            environment,
          );
          stagedMaterialMatches = sha256Bytes(stagedPatch) === expected.combined_patch_digest;
        }
        if (!stagedMaterialMatches) {
          throw new CommitCoordinatorError(
            "stage_scope_mismatch",
            `Staged bytes do not match the verified OwnedPatch for ${ownedPath}.`,
            {
              commit_created: false,
              start_head: ownedPatch.head_oid,
              actual_head: ownedPatch.head_oid,
              checkpoint_path: CHECKPOINT_PATH,
            },
          );
        }
      }
      return alternateIndex;
    } catch (error: unknown) {
      if (existsSync(alternateIndex)) {
        try {
          unlinkSync(alternateIndex);
        } catch {
          // Preserve the primary staging failure.
        }
      }
      throw error;
    }
  }

  private writeCheckpoint(
    input: FinishSliceInput,
    mode: "after_slice" | "none",
    head: string,
  ): ReturnType<CheckpointWriter["atomicRewrite"]> {
    const document: CheckpointDocument = {
      schema_version: COMMIT_COORDINATOR_SCHEMA_VERSION,
      run_id: input.run.run_id,
      completed_slice_id: input.slice.slice_id,
      head,
      commit_mode: mode,
      owned_diff_digest: input.owned_patch.patch_digest,
      verification_receipt_digest: input.verification.receipt_digest,
      ...input.checkpoint,
    };
    return this.checkpointWriter.atomicRewrite(input.run.workspace_identity, document);
  }

  private runGit(
    root: string,
    args: readonly string[],
    options: GitCommandOptions = {},
  ): Buffer {
    const result = this.git.run(root, args, options);
    if (result.exit_code !== 0 || result.failure_message !== null) {
      throw new GitInvocationError(this.gitFailureMessage(result));
    }
    return result.stdout;
  }

  private readHead(root: string): string {
    return this.decodeGitText(
      this.runGit(root, ["rev-parse", "--verify", "HEAD"]),
      "Git HEAD",
    ).trim();
  }

  private tryReadHead(root: string): string | null {
    try {
      return this.readHead(root);
    } catch {
      return null;
    }
  }

  private decodeGitText(buffer: Buffer, label: string): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error: unknown) {
      throw new GitInvocationError(
        `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  private gitFailureMessage(result: ReturnType<GitCommandPort["run"]>): string {
    let stderr: string;
    try {
      stderr = new TextDecoder("utf-8", { fatal: true }).decode(result.stderr).trim();
    } catch {
      stderr = "<non-UTF-8 stderr>";
    }
    return result.failure_message ?? (stderr || `git exited ${String(result.exit_code)}`);
  }

  private workspaceFailure(
    error: WorkspaceGuardError,
    startHead: string,
  ): CommitCoordinatorError {
    const code: CommitCoordinatorFailureCode = error.code === "workspace_not_git_worktree"
      ? "workspace_not_git_worktree"
      : error.code === "protected_change_overlap"
        ? "protected_change_overlap"
        : "git_inspection_failed";
    return this.failure(
      code,
      error.message,
      startHead,
      startHead,
      false,
      error,
    );
  }

  private checkpointFailure(
    error: CheckpointWriteError,
    startHead: string,
    actualHead: string,
    commitCreated: boolean,
  ): CommitCoordinatorError {
    return this.failure(
      error.code,
      error.message,
      startHead,
      actualHead,
      commitCreated,
      error,
    );
  }

  private failure(
    code: CommitCoordinatorFailureCode,
    message: string,
    startHead: string | null,
    actualHead: string | null,
    commitCreated: boolean,
    cause?: unknown,
  ): CommitCoordinatorError {
    const options = cause === undefined ? undefined : { cause };
    return new CommitCoordinatorError(
      code,
      message,
      {
        commit_created: commitCreated,
        start_head: startHead,
        actual_head: actualHead,
        checkpoint_path: CHECKPOINT_PATH,
      },
      options,
    );
  }
}
