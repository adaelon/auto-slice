import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  GitGoalCompletionGuard,
  ProductionRuntimeError,
} from "../src/controller/production/index.js";
import { GitChangeGuard } from "../src/controller/workspace/index.js";

const FIXED_TIME = "2026-08-10T08:00:00.000Z";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function fixture(context: TestContext, name: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `auto-slice-goal-${name}-`));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Auto Slice Test"]);
  git(root, ["config", "user.email", "auto-slice@example.invalid"]);
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  writeFileSync(
    path.join(root, "SESSION_CHECKPOINT.md"),
    "# SESSION_CHECKPOINT\n\nNext: S0\n",
    "utf8",
  );
  git(root, ["add", "README.md", "SESSION_CHECKPOINT.md"]);
  git(root, ["commit", "-m", "fixture baseline"]);
  return root;
}

function snapshots(root: string) {
  const workspace = createWorkspaceIdentity(root);
  const changeGuard = new GitChangeGuard(() => new Date(FIXED_TIME));
  const baseline = changeGuard.captureBaseline(workspace);
  assert.ok(!(baseline instanceof Error));
  return { workspace, changeGuard, baseline };
}

void test("none mode observes owned work plus a refreshed checkpoint without changing HEAD", (context) => {
  const root = fixture(context, "none");
  const { workspace, changeGuard, baseline } = snapshots(root);
  writeFileSync(path.join(root, "owned.txt"), "implemented\n", "utf8");
  writeFileSync(
    path.join(root, "SESSION_CHECKPOINT.md"),
    "# SESSION_CHECKPOINT\n\nS0 complete; next: S1\n",
    "utf8",
  );
  const current = changeGuard.captureCurrent(workspace);
  assert.ok(!(current instanceof Error));

  const result = new GitGoalCompletionGuard(() => new Date(FIXED_TIME)).observe({
    workspace_identity: workspace,
    protected_baseline: baseline,
    workspace_snapshot: current,
    owned_paths: ["owned.txt"],
    commit_mode: "none",
  });
  assert.ok(
    !(result instanceof ProductionRuntimeError),
    result instanceof ProductionRuntimeError
      ? result.message
      : "unexpected goal completion result",
  );
  assert.equal(result.commit_created, false);
  assert.equal(result.start_head, result.end_head);
  assert.deepEqual(result.owned_paths, ["owned.txt"]);
  assert.equal(result.checkpoint_path, "SESSION_CHECKPOINT.md");
});

void test("after_slice mode observes one Slice-owned commit followed by checkpoint refresh", (context) => {
  const root = fixture(context, "commit");
  const { workspace, changeGuard, baseline } = snapshots(root);
  writeFileSync(path.join(root, "owned.txt"), "implemented\n", "utf8");
  git(root, ["add", "owned.txt"]);
  git(root, ["commit", "-m", "complete S0"]);
  writeFileSync(
    path.join(root, "SESSION_CHECKPOINT.md"),
    "# SESSION_CHECKPOINT\n\nS0 complete; next: S1\n",
    "utf8",
  );
  const current = changeGuard.captureCurrent(workspace);
  assert.ok(!(current instanceof Error));

  const result = new GitGoalCompletionGuard(() => new Date(FIXED_TIME)).observe({
    workspace_identity: workspace,
    protected_baseline: baseline,
    workspace_snapshot: current,
    owned_paths: ["owned.txt"],
    commit_mode: "after_slice",
  });
  assert.ok(
    !(result instanceof ProductionRuntimeError),
    result instanceof ProductionRuntimeError
      ? result.message
      : "unexpected goal completion result",
  );
  assert.equal(result.commit_created, true);
  assert.notEqual(result.start_head, result.end_head);
  assert.deepEqual(result.owned_paths, ["owned.txt"]);
});

void test("after_slice rejects committing the checkpoint instead of refreshing it afterward", (context) => {
  const root = fixture(context, "checkpoint-in-commit");
  const { workspace, changeGuard, baseline } = snapshots(root);
  writeFileSync(path.join(root, "owned.txt"), "implemented\n", "utf8");
  writeFileSync(
    path.join(root, "SESSION_CHECKPOINT.md"),
    "# SESSION_CHECKPOINT\n\nS0 complete; next: S1\n",
    "utf8",
  );
  git(root, ["add", "owned.txt", "SESSION_CHECKPOINT.md"]);
  git(root, ["commit", "-m", "incorrect finish order"]);
  const current = changeGuard.captureCurrent(workspace);
  assert.ok(!(current instanceof Error));

  const result = new GitGoalCompletionGuard(() => new Date(FIXED_TIME)).observe({
    workspace_identity: workspace,
    protected_baseline: baseline,
    workspace_snapshot: current,
    owned_paths: ["owned.txt"],
    commit_mode: "after_slice",
  });
  assert.ok(result instanceof ProductionRuntimeError);
  assert.equal(result.code, "slice_verification_failed");
});
