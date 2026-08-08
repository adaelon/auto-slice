import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  CheckpointWriter,
  CommitCoordinator,
  CommitCoordinatorError,
  GitProcessRunner,
  type FinishReceipt,
  type FinishSliceInput,
  type GitCommandOptions,
  type GitCommandPort,
  type GitCommandResult,
} from "../src/controller/git/index.js";
import { sha256Bytes, sha256Json, type RunState } from "../src/controller/state/index.js";
import type {
  SliceContractV1,
  VerificationReceipt,
} from "../src/controller/slices/index.js";
import {
  GitChangeGuard,
  WorkspaceGuardError,
  type OwnedPatch,
  type ProtectedBaseline,
} from "../src/controller/workspace/index.js";

const FIXED_TIME = "2026-08-08T08:00:00.000Z";
const BASELINE_CHECKPOINT = "# committed checkpoint\n";
const PREVIOUS_CHECKPOINT = "# previous uncommitted checkpoint\n";

function temporaryDirectory(context: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: FIXED_TIME,
      GIT_COMMITTER_DATE: FIXED_TIME,
    },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    assert.fail(`git ${args.join(" ")} failed: ${result.stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout;
}

function initializeRepository(context: TestContext): string {
  const root = temporaryDirectory(context, "auto-slice-s06-git-");
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Auto Slice Test"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "owned.txt"), "owned-v1\n", "utf8");
  writeFileSync(path.join(root, "protected-staged.txt"), "staged-v1\n", "utf8");
  writeFileSync(path.join(root, "protected-unstaged.txt"), "unstaged-v1\n", "utf8");
  writeFileSync(path.join(root, "SESSION_CHECKPOINT.md"), BASELINE_CHECKPOINT, "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--no-gpg-sign", "--message", "fixture baseline"]);
  return root;
}

function unwrapWorkspace<T>(result: T | WorkspaceGuardError): T {
  if (result instanceof WorkspaceGuardError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapFinish(result: FinishReceipt | CommitCoordinatorError): FinishReceipt {
  if (result instanceof CommitCoordinatorError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function expectFinishError(
  result: FinishReceipt | CommitCoordinatorError,
  code: CommitCoordinatorError["code"],
): CommitCoordinatorError {
  assert.ok(result instanceof CommitCoordinatorError);
  assert.equal(result.code, code);
  return result;
}

function verificationReceipt(
  contract: SliceContractV1,
  patch: OwnedPatch,
  result: "PASS" | "FAIL" = "PASS",
): VerificationReceipt {
  const base = {
    schema_version: 1 as const,
    slice_id: contract.slice_id,
    execution_id: `execution-${contract.slice_id}`,
    contract_digest: sha256Json(contract),
    result,
    check_receipts: [],
    artifact_digests: [],
    owned_diff_digest: patch.patch_digest,
    overlap_paths: [],
    unowned_paths: [],
  };
  const material = result === "PASS"
    ? base
    : { ...base, failure_code: "check_nonzero_exit" as const };
  return {
    ...material,
    receipt_digest: sha256Json(material),
  };
}

interface Harness {
  readonly root: string;
  readonly input: FinishSliceInput;
  readonly guard: GitChangeGuard;
  readonly startHead: string;
}

function createHarness(
  context: TestContext,
  runMode: "after_slice" | "none" = "after_slice",
  override?: "after_slice" | "none",
): Harness {
  const root = initializeRepository(context);
  writeFileSync(path.join(root, "protected-staged.txt"), "staged-user\n", "utf8");
  runGit(root, ["add", "protected-staged.txt"]);
  writeFileSync(path.join(root, "protected-unstaged.txt"), "unstaged-user\n", "utf8");
  writeFileSync(path.join(root, "protected-untracked.txt"), "untracked-user\n", "utf8");
  writeFileSync(path.join(root, "SESSION_CHECKPOINT.md"), PREVIOUS_CHECKPOINT, "utf8");

  const guard = new GitChangeGuard(() => new Date(FIXED_TIME));
  const workspace = createWorkspaceIdentity(root);
  const baseline = unwrapWorkspace(guard.captureBaseline(workspace));
  writeFileSync(path.join(root, "owned.txt"), "owned-v2\n", "utf8");
  writeFileSync(path.join(root, "owned-new.txt"), "owned-new\n", "utf8");
  const current = unwrapWorkspace(guard.captureCurrent(workspace));
  const ownedPaths = ["owned.txt", "owned-new.txt"];
  const patch = unwrapWorkspace(
    guard.assertCommittable(unwrapWorkspace(guard.classify(baseline, current, ownedPaths))),
  );
  const contractBase = {
    slice_id: "S06-test",
    contract_version: 1 as const,
    objective: "Commit exactly one verified Slice.",
    exclusions: ["Never push."],
    owned_paths: ownedPaths,
    checks: [],
    expected_artifacts: [],
  };
  const contract: SliceContractV1 = override === undefined
    ? contractBase
    : { ...contractBase, commit_mode_override: override };
  const run: RunState = {
    schema_version: 1,
    run_id: "run-s06-test",
    state_version: 6,
    workspace_identity: workspace,
    plan_digest: sha256Bytes("s06-plan"),
    status: "COMMITTING",
    commit_mode: runMode,
    current_slice_id: contract.slice_id,
    protected_baseline_digest: baseline.baseline_digest,
    project_lock_owner: "lease-s06-test",
    write_epoch: 1,
    source_thread_id: "thread-s06-test",
  };
  return {
    root,
    guard,
    startHead: baseline.head_oid,
    input: {
      run,
      slice: contract,
      verification: verificationReceipt(contract, patch),
      protected_baseline: baseline,
      owned_patch: patch,
      commit_message: "feat: finish S06 test slice",
      checkpoint: {
        updated_at: FIXED_TIME,
        next_slice_id: "S07",
        current_summary: "S06-test 已完成，S07 可接手。",
        next_steps: ["读取 S07 SliceSpec。"],
        unfinished: ["S07 尚未开始。"],
        cold_start_reading_sequence: ["`CONTEXT.md` — 术语表。"],
      },
    },
  };
}

class RecordingGitRunner implements GitCommandPort {
  public readonly invocations: string[][] = [];
  public constructor(private readonly inner: GitCommandPort = new GitProcessRunner()) {}

  public run(
    workspaceRoot: string,
    args: readonly string[],
    options?: GitCommandOptions,
  ): GitCommandResult {
    this.invocations.push([...args]);
    return options === undefined
      ? this.inner.run(workspaceRoot, args)
      : this.inner.run(workspaceRoot, args, options);
  }
}

class ExtraStagedPathRunner implements GitCommandPort {
  private readonly inner = new GitProcessRunner();

  public run(
    workspaceRoot: string,
    args: readonly string[],
    options?: GitCommandOptions,
  ): GitCommandResult {
    const result = options === undefined
      ? this.inner.run(workspaceRoot, args)
      : this.inner.run(workspaceRoot, args, options);
    if (
      args.includes("--cached") &&
      args.includes("--name-only") &&
      result.exit_code === 0
    ) {
      return {
        ...result,
        stdout: Buffer.concat([result.stdout, Buffer.from("intruder.txt\0", "utf8")]),
      };
    }
    return result;
  }
}

void test("after_slice commits only OwnedPatch and preserves every Protected Change", (context) => {
  const harness = createHarness(context);
  const runner = new RecordingGitRunner();
  const coordinator = new CommitCoordinator({
    git: runner,
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-test-index",
    checkpointWriter: new CheckpointWriter({
      temporaryNameFactory: () => ".auto-slice-checkpoint-test.tmp",
    }),
    changeGuard: harness.guard,
  });

  const receipt = unwrapFinish(coordinator.finishSlice(harness.input));
  assert.equal(receipt.commit_mode, "after_slice");
  assert.equal(receipt.commit_created, true);
  assert.equal(receipt.start_head, harness.startHead);
  assert.notEqual(receipt.end_head, harness.startHead);
  assert.equal(runGit(harness.root, ["rev-list", "--count", "HEAD"]).trim(), "2");
  assert.equal(runGit(harness.root, ["show", "HEAD:owned.txt"]), "owned-v2\n");
  assert.equal(runGit(harness.root, ["show", "HEAD:owned-new.txt"]), "owned-new\n");
  assert.equal(runGit(harness.root, ["show", "HEAD:protected-staged.txt"]), "staged-v1\n");
  assert.equal(runGit(harness.root, ["show", "HEAD:protected-unstaged.txt"]), "unstaged-v1\n");
  assert.equal(runGit(harness.root, ["show", "HEAD:SESSION_CHECKPOINT.md"]), BASELINE_CHECKPOINT);
  assert.equal(runGit(harness.root, ["diff", "--cached", "--name-only"]).trim(), "protected-staged.txt");
  assert.equal(readFileSync(path.join(harness.root, "protected-unstaged.txt"), "utf8"), "unstaged-user\n");
  assert.equal(readFileSync(path.join(harness.root, "protected-untracked.txt"), "utf8"), "untracked-user\n");
  const checkpoint = readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8");
  assert.match(checkpoint, new RegExp(receipt.end_head, "u"));
  assert.match(checkpoint, /下一 Slice：`S07`/u);
  assert.equal(receipt.checkpoint_digest, sha256Bytes(checkpoint));
  assert.equal(runner.invocations.some((args) => args.includes("push")), false);
});

void test("none mode and a Slice override do not create a commit or mutate the Run policy", (context) => {
  const harness = createHarness(context, "after_slice", "none");
  const current = unwrapWorkspace(harness.guard.captureCurrent(harness.input.run.workspace_identity));
  const first = unwrapWorkspace(harness.guard.assertCommittable(unwrapWorkspace(
    harness.guard.classify(
      harness.input.protected_baseline,
      current,
      harness.input.slice.owned_paths,
    ),
  )));
  const second = unwrapWorkspace(harness.guard.assertCommittable(unwrapWorkspace(
    harness.guard.classify(
      harness.input.protected_baseline,
      current,
      harness.input.slice.owned_paths,
    ),
  )));
  assert.equal(second.patch_digest, first.patch_digest, "normalized owned diff changed in one workspace state");

  const receipt = unwrapFinish(new CommitCoordinator({
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-none-index",
    checkpointWriter: new CheckpointWriter({
      temporaryNameFactory: () => ".auto-slice-checkpoint-none.tmp",
    }),
    changeGuard: harness.guard,
  }).finishSlice(harness.input));
  assert.equal(receipt.commit_mode, "none");
  assert.equal(receipt.commit_created, false);
  assert.equal(receipt.end_head, harness.startHead);
  assert.equal(receipt.owned_diff_digest, harness.input.owned_patch.patch_digest);
  assert.equal(harness.input.run.commit_mode, "after_slice");
  assert.equal(runGit(harness.root, ["rev-list", "--count", "HEAD"]).trim(), "1");
  assert.match(readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8"), /Commit mode：`none`/u);
});

void test("FAIL or tampered VerificationReceipt cannot change Git or checkpoint", (context) => {
  const failed = createHarness(context);
  const failedReceipt = verificationReceipt(
    failed.input.slice,
    failed.input.owned_patch,
    "FAIL",
  );
  const failedResult = new CommitCoordinator({ changeGuard: failed.guard }).finishSlice({
    ...failed.input,
    verification: failedReceipt,
  });
  expectFinishError(failedResult, "verification_failed");
  assert.equal(runGit(failed.root, ["rev-parse", "HEAD"]).trim(), failed.startHead);
  assert.equal(readFileSync(path.join(failed.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);

  const tampered = createHarness(context);
  const tamperedResult = new CommitCoordinator({ changeGuard: tampered.guard }).finishSlice({
    ...tampered.input,
    verification: {
      ...tampered.input.verification,
      receipt_digest: sha256Bytes("tampered"),
    },
  });
  expectFinishError(tamperedResult, "verification_receipt_invalid");
  assert.equal(runGit(tampered.root, ["rev-parse", "HEAD"]).trim(), tampered.startHead);
  assert.equal(readFileSync(path.join(tampered.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);
});

void test("a pre-commit hook failure preserves HEAD, caller index, and old checkpoint", (context) => {
  const harness = createHarness(context);
  const hook = path.join(harness.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 9\n", "utf8");
  chmodSync(hook, 0o755);
  const result = new CommitCoordinator({
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-hook-index",
    changeGuard: harness.guard,
  }).finishSlice(harness.input);
  const error = expectFinishError(result, "commit_failed");
  assert.equal(error.context.commit_created, false);
  assert.equal(runGit(harness.root, ["rev-parse", "HEAD"]).trim(), harness.startHead);
  assert.equal(runGit(harness.root, ["diff", "--cached", "--name-only"]).trim(), "protected-staged.txt");
  assert.equal(readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);
});

void test("HEAD competition wins before commit and closes as head_drift", (context) => {
  const harness = createHarness(context);
  let competitorHead = "";
  const result = new CommitCoordinator({
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-race-index",
    faultInjector: () => {
      const tree = runGit(harness.root, ["rev-parse", `${harness.startHead}^{tree}`]).trim();
      competitorHead = runGit(
        harness.root,
        ["commit-tree", tree, "-p", harness.startHead, "-m", "competing commit"],
      ).trim();
      runGit(harness.root, ["update-ref", "HEAD", competitorHead, harness.startHead]);
    },
    changeGuard: harness.guard,
  }).finishSlice(harness.input);
  const error = expectFinishError(result, "head_drift");
  assert.equal(error.context.commit_created, false);
  assert.equal(error.context.actual_head, competitorHead);
  assert.equal(runGit(harness.root, ["rev-parse", "HEAD"]).trim(), competitorHead);
  assert.equal(readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);
});

void test("a staged scope mismatch aborts before commit", (context) => {
  const harness = createHarness(context);
  const result = new CommitCoordinator({
    git: new ExtraStagedPathRunner(),
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-scope-index",
    changeGuard: harness.guard,
  }).finishSlice(harness.input);
  expectFinishError(result, "stage_scope_mismatch");
  assert.equal(runGit(harness.root, ["rev-parse", "HEAD"]).trim(), harness.startHead);
  assert.equal(readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);
});

void test("checkpoint rename failure preserves the successful commit and real new HEAD", (context) => {
  const harness = createHarness(context);
  const writer = new CheckpointWriter({
    temporaryNameFactory: () => ".auto-slice-checkpoint-failure.tmp",
    rename: () => {
      throw new Error("injected rename failure");
    },
  });
  const result = new CommitCoordinator({
    checkpointWriter: writer,
    now: () => new Date(FIXED_TIME),
    indexNameFactory: () => "auto-slice-checkpoint-index",
    changeGuard: harness.guard,
  }).finishSlice(harness.input);
  const error = expectFinishError(result, "checkpoint_refresh_failed");
  assert.equal(error.context.commit_created, true);
  assert.notEqual(error.context.actual_head, harness.startHead);
  assert.equal(runGit(harness.root, ["rev-parse", "HEAD"]).trim(), error.context.actual_head);
  assert.equal(runGit(harness.root, ["rev-list", "--count", "HEAD"]).trim(), "2");
  assert.equal(readFileSync(path.join(harness.root, "SESSION_CHECKPOINT.md"), "utf8"), PREVIOUS_CHECKPOINT);
});

void test("a non-Git workspace closes before staging", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s06-not-git-");
  mkdirSync(path.join(root, "nested"));
  const workspace = createWorkspaceIdentity(root);
  const head = "0".repeat(40);
  const snapshotMaterial = {
    workspace_identity: workspace,
    head_oid: head,
    entries: [],
  };
  const baseline: ProtectedBaseline = {
    schema_version: 1,
    kind: "PROTECTED_BASELINE",
    ...snapshotMaterial,
    captured_at: FIXED_TIME,
    baseline_digest: sha256Json(snapshotMaterial),
  };
  const patchMaterial = {
    schema_version: 1 as const,
    workspace_identity: workspace,
    head_oid: head,
    baseline_digest: baseline.baseline_digest,
    current_digest: sha256Json(snapshotMaterial),
    paths: [],
    entries: [],
  };
  const patch: OwnedPatch = {
    ...patchMaterial,
    patch_digest: sha256Json(patchMaterial),
  };
  const contract: SliceContractV1 = {
    slice_id: "S06-not-git",
    contract_version: 1,
    objective: "Fail before commit.",
    exclusions: [],
    owned_paths: ["owned.txt"],
    checks: [],
    expected_artifacts: [],
  };
  const run: RunState = {
    schema_version: 1,
    run_id: "run-not-git",
    state_version: 1,
    workspace_identity: workspace,
    plan_digest: sha256Bytes("not-git"),
    status: "COMMITTING",
    commit_mode: "after_slice",
    current_slice_id: contract.slice_id,
    protected_baseline_digest: baseline.baseline_digest,
    project_lock_owner: null,
    write_epoch: 0,
    source_thread_id: null,
  };
  const result = new CommitCoordinator().finishSlice({
    run,
    slice: contract,
    verification: verificationReceipt(contract, patch),
    protected_baseline: baseline,
    owned_patch: patch,
    commit_message: "test non git",
    checkpoint: {
      updated_at: FIXED_TIME,
      next_slice_id: null,
      current_summary: "Should fail.",
      next_steps: [],
      unfinished: [],
      cold_start_reading_sequence: [],
    },
  });
  expectFinishError(result, "workspace_not_git_worktree");
});
