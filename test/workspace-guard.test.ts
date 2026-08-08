import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  FileWorkspaceGuard,
  GitChangeGuard,
  WorkspaceGuardError,
  type ChangeSet,
  type FileWorkspaceGuardOptions,
  type ProjectLease,
  type ProtectedBaseline,
  type WorkspaceSnapshot,
} from "../src/controller/workspace/index.js";

interface MutableClock {
  readonly now: () => Date;
  readonly advance: (milliseconds: number) => void;
}

interface WorkerResult {
  readonly outcome: "acquired" | "error";
  readonly run_id: string;
  readonly lease_id?: string;
  readonly epoch?: number;
  readonly code?: string;
}

function temporaryDirectory(context: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function mutableClock(initial = "2026-08-08T00:00:00.000Z"): MutableClock {
  let timestamp = Date.parse(initial);
  return {
    now: () => new Date(timestamp),
    advance: (milliseconds) => {
      timestamp += milliseconds;
    },
  };
}

function openGuard(storageRoot: string, options: FileWorkspaceGuardOptions = {}): FileWorkspaceGuard {
  const guard = FileWorkspaceGuard.open(storageRoot, options);
  if (guard instanceof WorkspaceGuardError) {
    assert.fail(`${guard.code}: ${guard.message}`);
  }
  return guard;
}

function unwrap<T>(result: T | WorkspaceGuardError): T {
  if (result instanceof WorkspaceGuardError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function expectCode(result: unknown, code: WorkspaceGuardError["code"]): WorkspaceGuardError {
  assert.ok(result instanceof WorkspaceGuardError);
  assert.equal(result.code, code);
  return result;
}

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-08T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-08T00:00:00Z",
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
  const root = temporaryDirectory(context, "auto-slice-s03-git-");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Auto Slice Test"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "tracked.txt"), "tracked-v1\n", "utf8");
  writeFileSync(path.join(root, "delete.txt"), "delete-v1\n", "utf8");
  writeFileSync(path.join(root, "old-name.txt"), "rename-v1\n", "utf8");
  writeFileSync(path.join(root, "protected.txt"), "protected-v1\n", "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "fixture baseline"]);
  return root;
}

function captureBaseline(guard: GitChangeGuard, root: string): ProtectedBaseline {
  return unwrap(guard.captureBaseline(createWorkspaceIdentity(root)));
}

function captureCurrent(guard: GitChangeGuard, root: string): WorkspaceSnapshot {
  return unwrap(guard.captureCurrent(createWorkspaceIdentity(root)));
}

function classify(
  guard: GitChangeGuard,
  baseline: ProtectedBaseline,
  root: string,
  ownedPaths: readonly string[],
): ChangeSet {
  return unwrap(guard.classify(baseline, captureCurrent(guard, root), ownedPaths));
}

function runLeaseWorker(
  workerPath: string,
  storageRoot: string,
  workspaceRoot: string,
  runId: string,
  leaseId: string,
  readyPath: string,
  startPath: string,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, storageRoot, workspaceRoot, runId, leaseId, readyPath, startPath],
      { cwd: process.cwd(), shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Workspace lease worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void test("two processes competing for one workspace produce exactly one Project Write Lease", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-race-");
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  mkdirSync(workspaceRoot);
  const workerPath = fileURLToPath(new URL("./helpers/workspace-lease-worker.js", import.meta.url));
  const readyA = path.join(root, "ready-a");
  const readyB = path.join(root, "ready-b");
  const start = path.join(root, "start");
  const first = runLeaseWorker(workerPath, storageRoot, workspaceRoot, "run-a", "lease-a", readyA, start);
  const second = runLeaseWorker(workerPath, storageRoot, workspaceRoot, "run-b", "lease-b", readyB, start);
  await waitForFiles([readyA, readyB], 10_000);
  writeFileSync(start, "go", "utf8");
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((entry) => entry.outcome === "acquired" ? "acquired" : entry.code).sort(),
    ["acquired", "project_lock_unavailable"],
  );
});

void test("a restarted process renews only with the persisted lease identity", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-restart-");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  const workspace = createWorkspaceIdentity(workspaceRoot);
  const clock = mutableClock();
  const first = openGuard(path.join(root, "storage"), {
    now: clock.now,
    leaseIdFactory: () => "restart-lease",
    leaseDurationMs: 10_000,
  });
  const acquired = unwrap(first.acquire(workspace, "run-restart"));
  clock.advance(1_000);
  const restarted = openGuard(path.join(root, "storage"), {
    now: clock.now,
    leaseDurationMs: 10_000,
  });
  const renewed = unwrap(restarted.renew(acquired.lease_id, acquired.epoch));
  assert.equal(renewed.run_id, "run-restart");
  assert.equal(renewed.epoch, acquired.epoch);
  expectCode(restarted.renew("unknown-lease", acquired.epoch), "lease_lost");
});

void test("freeze and epoch rotation invalidate every old write capability", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-epoch-");
  mkdirSync(path.join(root, "workspace"));
  const clock = mutableClock();
  const guard = openGuard(path.join(root, "storage"), {
    now: clock.now,
    leaseIdFactory: () => "epoch-lease",
    leaseDurationMs: 60_000,
  });
  const acquired = unwrap(guard.acquire(createWorkspaceIdentity(path.join(root, "workspace")), "run-epoch"));
  clock.advance(1_000);
  const frozen = unwrap(guard.freezeWrites(acquired.lease_id, acquired.epoch));
  expectCode(guard.assertWritable(acquired.lease_id, acquired.epoch), "lease_lost");
  clock.advance(1_000);
  const rotated = unwrap(guard.rotateEpoch(frozen));
  assert.equal(rotated.epoch, acquired.epoch + 1);
  expectCode(guard.assertWritable(acquired.lease_id, acquired.epoch), "stale_write_epoch");
  assert.equal(unwrap(guard.assertWritable(rotated.lease_id, rotated.epoch)).status, "ACTIVE");
  assert.deepEqual(
    unwrap(guard.inspectLeaseEvents(acquired.lease_id)).map((entry) => entry.action),
    ["ACQUIRED", "FROZEN", "EPOCH_ROTATED"],
  );
});

void test("expired leases fail closed without appending a renewal event", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-expiry-");
  mkdirSync(path.join(root, "workspace"));
  const clock = mutableClock();
  const guard = openGuard(path.join(root, "storage"), {
    now: clock.now,
    leaseIdFactory: () => "expiring-lease",
    leaseDurationMs: 1_000,
  });
  const lease = unwrap(guard.acquire(createWorkspaceIdentity(path.join(root, "workspace")), "run-expiry"));
  const before = unwrap(guard.inspectLeaseEvents(lease.lease_id));
  clock.advance(1_000);
  expectCode(guard.renew(lease.lease_id, lease.epoch), "lease_lost");
  assert.deepEqual(unwrap(guard.inspectLeaseEvents(lease.lease_id)), before);
});

void test("wrong epochs and competing Runs cannot release another active lease", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-release-");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  let sequence = 0;
  const guard = openGuard(path.join(root, "storage"), {
    leaseIdFactory: () => `release-lease-${String(sequence += 1)}`,
    leaseDurationMs: 60_000,
  });
  const workspace = createWorkspaceIdentity(workspaceRoot);
  const first = unwrap(guard.acquire(workspace, "run-owner"));
  expectCode(guard.release(first.lease_id, first.epoch + 1), "stale_write_epoch");
  expectCode(guard.acquire(workspace, "run-other"), "project_lock_unavailable");
  const released = unwrap(guard.release(first.lease_id, first.epoch));
  assert.equal(released.status, "RELEASED");
  const second = unwrap(guard.acquire(workspace, "run-other"));
  assert.equal(second.run_id, "run-other");
  expectCode(guard.release(first.lease_id, first.epoch), "lease_lost");
});

const GIT_SCENARIOS = [
  {
    id: "clean",
    owned: ["tracked.txt"],
    mutate: (): void => {},
    expected: [],
  },
  {
    id: "untracked",
    owned: ["new.txt"],
    mutate: (root: string): void => {
      writeFileSync(path.join(root, "new.txt"), "new\n", "utf8");
    },
    expected: ["new.txt"],
  },
  {
    id: "staged",
    owned: ["tracked.txt"],
    mutate: (root: string): void => {
      writeFileSync(path.join(root, "tracked.txt"), "tracked-staged\n", "utf8");
      runGit(root, ["add", "tracked.txt"]);
    },
    expected: ["tracked.txt"],
  },
  {
    id: "unstaged",
    owned: ["tracked.txt"],
    mutate: (root: string): void => {
      writeFileSync(path.join(root, "tracked.txt"), "tracked-unstaged\n", "utf8");
    },
    expected: ["tracked.txt"],
  },
  {
    id: "rename",
    owned: ["old-name.txt", "renamed.txt"],
    mutate: (root: string): void => {
      runGit(root, ["mv", "old-name.txt", "renamed.txt"]);
    },
    expected: ["old-name.txt", "renamed.txt"],
  },
  {
    id: "deleted",
    owned: ["delete.txt"],
    mutate: (root: string): void => {
      unlinkSync(path.join(root, "delete.txt"));
    },
    expected: ["delete.txt"],
  },
] as const;

for (const scenario of GIT_SCENARIOS) {
  void test(`real Git ${scenario.id} changes classify deterministically`, (context) => {
    const root = initializeRepository(context);
    const guard = new GitChangeGuard(() => new Date("2026-08-08T00:00:00.000Z"));
    const baseline = captureBaseline(guard, root);
    scenario.mutate(root);
    const changes = classify(guard, baseline, root, scenario.owned);
    assert.deepEqual(changes.owned_paths, scenario.expected);
    assert.deepEqual(changes.overlap_paths, []);
    assert.deepEqual(changes.unowned_paths, []);
    assert.deepEqual(unwrap(guard.assertCommittable(changes)).paths, scenario.expected);
  });
}

void test("an unchanged Protected Change stays protected while a new owned file remains committable", (context) => {
  const root = initializeRepository(context);
  const guard = new GitChangeGuard();
  writeFileSync(path.join(root, "protected.txt"), "user-change\n", "utf8");
  const baseline = captureBaseline(guard, root);
  writeFileSync(path.join(root, "new-owned.txt"), "slice-change\n", "utf8");
  const changes = classify(guard, baseline, root, ["new-owned.txt", "protected.txt"]);
  assert.deepEqual(changes.protected_paths, ["protected.txt"]);
  assert.deepEqual(changes.owned_paths, ["new-owned.txt"]);
  assert.deepEqual(unwrap(guard.assertCommittable(changes)).paths, ["new-owned.txt"]);
});

void test("editing a baseline-dirty file closes as protected_change_overlap", (context) => {
  const root = initializeRepository(context);
  const guard = new GitChangeGuard();
  writeFileSync(path.join(root, "protected.txt"), "user-change\n", "utf8");
  const baseline = captureBaseline(guard, root);
  writeFileSync(path.join(root, "protected.txt"), "slice-overwrite\n", "utf8");
  const changes = classify(guard, baseline, root, ["protected.txt"]);
  assert.deepEqual(changes.overlap_paths, ["protected.txt"]);
  expectCode(guard.assertCommittable(changes), "protected_change_overlap");
});

void test("a post-baseline path outside Slice ownership is protected by default", (context) => {
  const root = initializeRepository(context);
  const guard = new GitChangeGuard();
  const baseline = captureBaseline(guard, root);
  writeFileSync(path.join(root, "not-owned.txt"), "concurrent user change\n", "utf8");
  const changes = classify(guard, baseline, root, ["owned/**"]);
  assert.deepEqual(changes.unowned_paths, ["not-owned.txt"]);
  expectCode(guard.assertCommittable(changes), "protected_change_overlap");
});

void test("HEAD movement and unsafe ownership declarations fail closed", (context) => {
  const root = initializeRepository(context);
  const guard = new GitChangeGuard();
  const baseline = captureBaseline(guard, root);
  writeFileSync(path.join(root, "tracked.txt"), "new commit\n", "utf8");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, ["commit", "-m", "move head"]);
  const current = captureCurrent(guard, root);
  const moved = unwrap(guard.classify(baseline, current, ["tracked.txt"]));
  assert.equal(moved.head_changed, true);
  expectCode(guard.assertCommittable(moved), "protected_change_overlap");
  expectCode(guard.classify(baseline, current, ["../escape"]), "invalid_owned_path");
});

void test("V1 rejects a workspace that is only a subdirectory of a Git worktree", (context) => {
  const root = initializeRepository(context);
  const nested = path.join(root, "nested");
  mkdirSync(nested);
  const guard = new GitChangeGuard();
  expectCode(guard.captureBaseline(createWorkspaceIdentity(nested)), "workspace_not_git_worktree");
});

void test("V1 rejects a directory that is not a Git worktree", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-not-git-");
  const guard = new GitChangeGuard();
  expectCode(guard.captureBaseline(createWorkspaceIdentity(root)), "workspace_not_git_worktree");
});

void test("ProjectLease is structurally stable across acquisition and restart renewal", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s03-shape-");
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot);
  const clock = mutableClock();
  const guard = openGuard(path.join(root, "storage"), {
    now: clock.now,
    leaseIdFactory: () => "stable-shape",
    leaseDurationMs: 10_000,
  });
  const acquired: ProjectLease = unwrap(guard.acquire(createWorkspaceIdentity(workspaceRoot), "run-shape"));
  clock.advance(1_000);
  const renewed: ProjectLease = unwrap(guard.renew(acquired.lease_id, acquired.epoch));
  assert.deepEqual(Object.keys(renewed).sort(), Object.keys(acquired).sort());
});
