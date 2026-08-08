#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  CheckpointWriter,
  CommitCoordinator,
  CommitCoordinatorError,
  GitProcessRunner,
} from "../dist/src/controller/git/index.js";
import { sha256Bytes, sha256Json } from "../dist/src/controller/state/index.js";
import {
  GitChangeGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";

const FIXED_TIME = "2026-08-08T08:00:00.000Z";
const BASELINE_CHECKPOINT = "# committed checkpoint\n";
const PREVIOUS_CHECKPOINT = "# previous uncommitted checkpoint\n";

process.env.GIT_AUTHOR_DATE = FIXED_TIME;
process.env.GIT_COMMITTER_DATE = FIXED_TIME;

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout;
}

function initializeRepository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s06-evidence-"));
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Auto Slice Evidence"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "owned.txt"), "owned-v1\n", "utf8");
  writeFileSync(path.join(root, "protected.txt"), "protected-v1\n", "utf8");
  writeFileSync(path.join(root, "SESSION_CHECKPOINT.md"), BASELINE_CHECKPOINT, "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--no-gpg-sign", "--message", "fixture baseline"]);
  return root;
}

function unwrapWorkspace(result) {
  if (result instanceof WorkspaceGuardError) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result;
}

function createInput(root, override) {
  writeFileSync(path.join(root, "protected.txt"), "protected-user\n", "utf8");
  runGit(root, ["add", "protected.txt"]);
  writeFileSync(path.join(root, "protected-untracked.txt"), "untracked-user\n", "utf8");
  writeFileSync(path.join(root, "SESSION_CHECKPOINT.md"), PREVIOUS_CHECKPOINT, "utf8");
  const workspace = createWorkspaceIdentity(root);
  const guard = new GitChangeGuard(() => new Date(FIXED_TIME));
  const baseline = unwrapWorkspace(guard.captureBaseline(workspace));
  writeFileSync(path.join(root, "owned.txt"), "owned-v2\n", "utf8");
  writeFileSync(path.join(root, "owned-new.txt"), "owned-new\n", "utf8");
  const current = unwrapWorkspace(guard.captureCurrent(workspace));
  const ownedPaths = ["owned.txt", "owned-new.txt"];
  const patch = unwrapWorkspace(guard.assertCommittable(unwrapWorkspace(
    guard.classify(baseline, current, ownedPaths),
  )));
  const contract = {
    slice_id: "S06-evidence",
    contract_version: 1,
    objective: "Produce deterministic S06 evidence.",
    exclusions: ["Never push."],
    owned_paths: ownedPaths,
    checks: [],
    expected_artifacts: [],
    ...(override === undefined ? {} : { commit_mode_override: override }),
  };
  const verificationMaterial = {
    schema_version: 1,
    slice_id: contract.slice_id,
    execution_id: "execution-s06-evidence",
    contract_digest: sha256Json(contract),
    result: "PASS",
    check_receipts: [],
    artifact_digests: [],
    owned_diff_digest: patch.patch_digest,
    overlap_paths: [],
    unowned_paths: [],
  };
  const run = {
    schema_version: 1,
    run_id: "run-s06-evidence",
    state_version: 6,
    workspace_identity: workspace,
    plan_digest: sha256Bytes("s06-evidence-plan"),
    status: "COMMITTING",
    commit_mode: "after_slice",
    current_slice_id: contract.slice_id,
    protected_baseline_digest: baseline.baseline_digest,
    project_lock_owner: "lease-s06-evidence",
    write_epoch: 1,
    source_thread_id: "thread-s06-evidence",
  };
  return {
    guard,
    startHead: baseline.head_oid,
    input: {
      run,
      slice: contract,
      verification: {
        ...verificationMaterial,
        receipt_digest: sha256Json(verificationMaterial),
      },
      protected_baseline: baseline,
      owned_patch: patch,
      commit_message: "feat: finish S06 evidence slice",
      checkpoint: {
        updated_at: FIXED_TIME,
        next_slice_id: "S07",
        current_summary: "S06-evidence 已完成，S07 可接手。",
        next_steps: ["读取 S07 SliceSpec。"],
        unfinished: ["S07 尚未开始。"],
        cold_start_reading_sequence: ["`CONTEXT.md` — 术语表。"],
      },
    },
  };
}

class RecordingGitRunner {
  constructor() {
    this.inner = new GitProcessRunner();
    this.invocations = [];
  }

  run(workspaceRoot, args, options) {
    this.invocations.push([...args]);
    return options === undefined
      ? this.inner.run(workspaceRoot, args)
      : this.inner.run(workspaceRoot, args, options);
  }
}

class ExtraStagedPathRunner {
  constructor() {
    this.inner = new GitProcessRunner();
  }

  run(workspaceRoot, args, options) {
    const result = options === undefined
      ? this.inner.run(workspaceRoot, args)
      : this.inner.run(workspaceRoot, args, options);
    if (args.includes("--cached") && args.includes("--name-only") && result.exit_code === 0) {
      return {
        ...result,
        stdout: Buffer.concat([result.stdout, Buffer.from("intruder.txt\0", "utf8")]),
      };
    }
    return result;
  }
}

function normalizeCheckpoint(content, head) {
  return content
    .replaceAll(head, "<HEAD>")
    .replace(/sha256:[0-9a-f]{64}/gu, "sha256:<digest>");
}

function runAfterSlice() {
  const root = initializeRepository();
  try {
    const runtime = createInput(root);
    const runner = new RecordingGitRunner();
    const result = new CommitCoordinator({
      git: runner,
      now: () => new Date(FIXED_TIME),
      indexNameFactory: () => "auto-slice-evidence-index",
      checkpointWriter: new CheckpointWriter({
        temporaryNameFactory: () => ".auto-slice-evidence-checkpoint.tmp",
      }),
      changeGuard: runtime.guard,
    }).finishSlice(runtime.input);
    ensure(!(result instanceof CommitCoordinatorError), "after_slice evidence did not finish");
    const checkpoint = readFileSync(path.join(root, "SESSION_CHECKPOINT.md"), "utf8");
    const committedPaths = runGit(
      root,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", result.end_head],
    ).trim().split(/\r?\n/u).filter(Boolean).sort();
    const stagedProtectedPaths = runGit(root, ["diff", "--cached", "--name-only"])
      .trim().split(/\r?\n/u).filter(Boolean).sort();
    return {
      report: {
        schema_version: 1,
        slice_id: "S06",
        after_slice: {
          commit_count: Number(runGit(root, ["rev-list", "--count", "HEAD"]).trim()),
          committed_paths: committedPaths,
          owned_content_digest: sha256Bytes(runGit(root, ["show", "HEAD:owned.txt"])),
          new_owned_content_digest: sha256Bytes(runGit(root, ["show", "HEAD:owned-new.txt"])),
          protected_head_digest: sha256Bytes(runGit(root, ["show", "HEAD:protected.txt"])),
          checkpoint_head_digest: sha256Bytes(runGit(root, ["show", "HEAD:SESSION_CHECKPOINT.md"])),
          protected_staged_paths: stagedProtectedPaths,
          protected_untracked_preserved: readFileSync(path.join(root, "protected-untracked.txt"), "utf8") === "untracked-user\n",
          checkpoint_references_new_head: checkpoint.includes(result.end_head),
          push_invocations: runner.invocations.filter((args) => args.includes("push")).length,
        },
        result: "PASS",
      },
      checkpointSample: normalizeCheckpoint(checkpoint, result.end_head),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runNoneMode() {
  const root = initializeRepository();
  try {
    const runtime = createInput(root, "none");
    const result = new CommitCoordinator({
      now: () => new Date(FIXED_TIME),
      indexNameFactory: () => "auto-slice-evidence-none-index",
      checkpointWriter: new CheckpointWriter({
        temporaryNameFactory: () => ".auto-slice-evidence-none-checkpoint.tmp",
      }),
      changeGuard: runtime.guard,
    }).finishSlice(runtime.input);
    ensure(!(result instanceof CommitCoordinatorError), "none evidence did not finish");
    return {
      commit_count_unchanged: runGit(root, ["rev-list", "--count", "HEAD"]).trim() === "1",
      head_unchanged: runGit(root, ["rev-parse", "HEAD"]).trim() === runtime.startHead,
      override_effective: result.commit_mode === "none" && runtime.input.run.commit_mode === "after_slice",
      diff_digest_preserved: result.owned_diff_digest === runtime.input.owned_patch.patch_digest,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function failureScene(id) {
  const root = initializeRepository();
  try {
    const runtime = createInput(root);
    let coordinator;
    if (id === "hook_failure") {
      const hook = path.join(root, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 9\n", "utf8");
      chmodSync(hook, 0o755);
      coordinator = new CommitCoordinator({
        now: () => new Date(FIXED_TIME),
        indexNameFactory: () => "auto-slice-evidence-hook-index",
        changeGuard: runtime.guard,
      });
    } else if (id === "head_drift") {
      coordinator = new CommitCoordinator({
        now: () => new Date(FIXED_TIME),
        indexNameFactory: () => "auto-slice-evidence-race-index",
        faultInjector: () => {
          const tree = runGit(root, ["rev-parse", `${runtime.startHead}^{tree}`]).trim();
          const competitor = runGit(
            root,
            ["commit-tree", tree, "-p", runtime.startHead, "-m", "competing commit"],
          ).trim();
          runGit(root, ["update-ref", "HEAD", competitor, runtime.startHead]);
        },
        changeGuard: runtime.guard,
      });
    } else if (id === "checkpoint_rename_failure") {
      coordinator = new CommitCoordinator({
        now: () => new Date(FIXED_TIME),
        indexNameFactory: () => "auto-slice-evidence-checkpoint-index",
        checkpointWriter: new CheckpointWriter({
          temporaryNameFactory: () => ".auto-slice-evidence-failure.tmp",
          rename: () => {
            throw new Error("injected rename failure");
          },
        }),
        changeGuard: runtime.guard,
      });
    } else if (id === "stage_scope_mismatch") {
      coordinator = new CommitCoordinator({
        git: new ExtraStagedPathRunner(),
        now: () => new Date(FIXED_TIME),
        indexNameFactory: () => "auto-slice-evidence-scope-index",
        changeGuard: runtime.guard,
      });
    } else {
      throw new Error(`Unknown failure scene: ${id}`);
    }
    const result = coordinator.finishSlice(runtime.input);
    ensure(result instanceof CommitCoordinatorError, `${id} unexpectedly succeeded`);
    return {
      id,
      failure_code: result.code,
      commit_created: result.context.commit_created,
      head_changed: runGit(root, ["rev-parse", "HEAD"]).trim() !== runtime.startHead,
      checkpoint_preserved: readFileSync(path.join(root, "SESSION_CHECKPOINT.md"), "utf8") === PREVIOUS_CHECKPOINT,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const afterSlice = runAfterSlice();
  const noneMode = runNoneMode();
  const expectedCodes = {
    hook_failure: "commit_failed",
    head_drift: "head_drift",
    checkpoint_rename_failure: "checkpoint_refresh_failed",
    stage_scope_mismatch: "stage_scope_mismatch",
  };
  const scenarios = Object.keys(expectedCodes).map(failureScene);
  ensure(noneMode.commit_count_unchanged, "none mode created a commit");
  ensure(noneMode.head_unchanged, "none mode moved HEAD");
  ensure(noneMode.override_effective, "Slice override mutated or failed to override Run mode");
  ensure(noneMode.diff_digest_preserved, "none mode changed its normalized diff digest");
  for (const scenario of scenarios) {
    ensure(scenario.failure_code === expectedCodes[scenario.id], `${scenario.id} returned the wrong code`);
    if (scenario.id === "checkpoint_rename_failure") {
      ensure(scenario.commit_created && scenario.head_changed, "checkpoint failure reset or hid the commit");
    } else if (scenario.id === "head_drift") {
      ensure(!scenario.commit_created && scenario.head_changed, "HEAD race was not distinguished from a Slice commit");
    } else {
      ensure(!scenario.commit_created && !scenario.head_changed, `${scenario.id} changed HEAD`);
    }
    ensure(scenario.checkpoint_preserved, `${scenario.id} changed checkpoint on failure`);
  }
  process.stdout.write(JSON.stringify({
    commit_tree_golden: {
      ...afterSlice.report,
      none: noneMode,
    },
    checkpoint_sample: afterSlice.checkpointSample,
    failure_scene_matrix: {
      schema_version: 1,
      slice_id: "S06",
      scenarios,
      result: "PASS",
    },
  }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
