#!/usr/bin/env node

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
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  FileWorkspaceGuard,
  GitChangeGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const FIXED_TIME = "2026-08-08T00:00:00.000Z";

function unwrap(result) {
  if (result instanceof WorkspaceGuardError) {
    throw result;
  }
  return result;
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
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
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout;
}

function initializeRepository(root) {
  mkdirSync(root, { recursive: true });
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Auto Slice Evidence"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "tracked.txt"), "tracked-v1\n", "utf8");
  writeFileSync(path.join(root, "delete.txt"), "delete-v1\n", "utf8");
  writeFileSync(path.join(root, "old-name.txt"), "rename-v1\n", "utf8");
  writeFileSync(path.join(root, "protected.txt"), "protected-v1\n", "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "fixture baseline"]);
}

function runLeaseWorker(workerPath, storageRoot, workspaceRoot, runId, leaseId, readyPath, startPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, storageRoot, workspaceRoot, runId, leaseId, readyPath, startPath],
      { cwd: repoRoot, shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Workspace lease worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForFiles(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function buildConcurrencyReport(root) {
  const workspaceRoot = path.join(root, "race-workspace");
  const storageRoot = path.join(root, "race-storage");
  mkdirSync(workspaceRoot);
  const workerPath = path.join(repoRoot, "dist", "test", "helpers", "workspace-lease-worker.js");
  const readyA = path.join(root, "race-ready-a");
  const readyB = path.join(root, "race-ready-b");
  const start = path.join(root, "race-start");
  const contenders = [
    runLeaseWorker(workerPath, storageRoot, workspaceRoot, "run-a", "lease-a", readyA, start),
    runLeaseWorker(workerPath, storageRoot, workspaceRoot, "run-b", "lease-b", readyB, start),
  ];
  await waitForFiles([readyA, readyB], 10_000);
  writeFileSync(start, "go", "utf8");
  const results = await Promise.all(contenders);
  const acquiredCount = results.filter((entry) => entry.outcome === "acquired").length;
  const unavailableCount = results.filter((entry) => entry.code === "project_lock_unavailable").length;
  requireCondition(acquiredCount === 1 && unavailableCount === 1, "The lease race did not produce one winner and one refusal.");
  return {
    schema_version: 1,
    slice_id: "S03",
    contenders: ["run-a", "run-b"],
    outcomes: results.map((entry) => entry.outcome === "acquired" ? "acquired" : entry.code).sort(),
    acquired_count: acquiredCount,
    project_lock_unavailable_count: unavailableCount,
    result: "PASS",
  };
}

function buildLeaseEventLog(root) {
  const guard = unwrap(FileWorkspaceGuard.open(path.join(root, "event-storage"), {
    now: () => new Date(FIXED_TIME),
    leaseIdFactory: () => "s03-evidence-lease",
    leaseDurationMs: 60_000,
  }));
  const workspace = {
    canonical_root: "E:\\auto-slice-fixture\\workspace",
    filesystem_identity: "win32:sha256:s03-evidence-workspace",
  };
  const acquired = unwrap(guard.acquire(workspace, "run-s03-evidence"));
  const renewed = unwrap(guard.renew(acquired.lease_id, acquired.epoch));
  const frozen = unwrap(guard.freezeWrites(renewed.lease_id, renewed.epoch));
  const rotated = unwrap(guard.rotateEpoch(frozen));
  const released = unwrap(guard.release(rotated.lease_id, rotated.epoch));
  const events = unwrap(guard.inspectLeaseEvents(acquired.lease_id));
  requireCondition(
    JSON.stringify(events.map((event) => event.action)) ===
      JSON.stringify(["ACQUIRED", "RENEWED", "FROZEN", "EPOCH_ROTATED", "RELEASED"]),
    "Lease evidence is missing a required transition.",
  );
  requireCondition(released.epoch === 2, "Lease evidence did not rotate its write epoch.");
  return {
    schema_version: 1,
    slice_id: "S03",
    lease_id: acquired.lease_id,
    final_epoch: released.epoch,
    final_status: released.status,
    events,
    result: "PASS",
  };
}

const GIT_SCENARIOS = [
  {
    id: "clean",
    owned: ["tracked.txt"],
    expected: [],
    mutate: () => undefined,
  },
  {
    id: "untracked",
    owned: ["new.txt"],
    expected: ["new.txt"],
    mutate: (root) => writeFileSync(path.join(root, "new.txt"), "new\n", "utf8"),
  },
  {
    id: "staged",
    owned: ["tracked.txt"],
    expected: ["tracked.txt"],
    mutate: (root) => {
      writeFileSync(path.join(root, "tracked.txt"), "staged\n", "utf8");
      runGit(root, ["add", "tracked.txt"]);
    },
  },
  {
    id: "unstaged",
    owned: ["tracked.txt"],
    expected: ["tracked.txt"],
    mutate: (root) => writeFileSync(path.join(root, "tracked.txt"), "unstaged\n", "utf8"),
  },
  {
    id: "rename",
    owned: ["old-name.txt", "renamed.txt"],
    expected: ["old-name.txt", "renamed.txt"],
    mutate: (root) => runGit(root, ["mv", "old-name.txt", "renamed.txt"]),
  },
  {
    id: "deleted",
    owned: ["delete.txt"],
    expected: ["delete.txt"],
    mutate: (root) => unlinkSync(path.join(root, "delete.txt")),
  },
];

function buildGitScenarioMatrix(root) {
  const scenarios = [];
  for (const [index, scenario] of GIT_SCENARIOS.entries()) {
    const scenarioRoot = path.join(root, `git-${String(index).padStart(2, "0")}-${scenario.id}`);
    initializeRepository(scenarioRoot);
    const guard = new GitChangeGuard(() => new Date(FIXED_TIME));
    const workspace = createWorkspaceIdentity(scenarioRoot);
    const baseline = unwrap(guard.captureBaseline(workspace));
    scenario.mutate(scenarioRoot);
    const current = unwrap(guard.captureCurrent(workspace));
    const changes = unwrap(guard.classify(baseline, current, scenario.owned));
    const patch = unwrap(guard.assertCommittable(changes));
    requireCondition(
      JSON.stringify(patch.paths) === JSON.stringify(scenario.expected),
      `Git scenario ${scenario.id} classified unexpected paths.`,
    );
    scenarios.push({
      id: scenario.id,
      owned_paths: patch.paths,
      overlap_paths: changes.overlap_paths,
      unowned_paths: changes.unowned_paths,
      outcome: "committable",
      result: "PASS",
    });
  }

  const overlapRoot = path.join(root, "git-06-protected-overlap");
  initializeRepository(overlapRoot);
  const overlapGuard = new GitChangeGuard(() => new Date(FIXED_TIME));
  const overlapWorkspace = createWorkspaceIdentity(overlapRoot);
  writeFileSync(path.join(overlapRoot, "protected.txt"), "user-change\n", "utf8");
  const overlapBaseline = unwrap(overlapGuard.captureBaseline(overlapWorkspace));
  writeFileSync(path.join(overlapRoot, "protected.txt"), "slice-overwrite\n", "utf8");
  const overlapCurrent = unwrap(overlapGuard.captureCurrent(overlapWorkspace));
  const overlapChanges = unwrap(
    overlapGuard.classify(overlapBaseline, overlapCurrent, ["protected.txt"]),
  );
  const overlapResult = overlapGuard.assertCommittable(overlapChanges);
  requireCondition(
    overlapResult instanceof WorkspaceGuardError && overlapResult.code === "protected_change_overlap",
    "The same-file baseline overlap did not fail closed.",
  );
  scenarios.push({
    id: "same_file_protected_overlap",
    owned_paths: overlapChanges.owned_paths,
    overlap_paths: overlapChanges.overlap_paths,
    unowned_paths: overlapChanges.unowned_paths,
    outcome: "protected_change_overlap",
    result: "PASS",
  });

  return {
    schema_version: 1,
    slice_id: "S03",
    scenarios,
    result: "PASS",
  };
}

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s03-evidence-"));
  try {
    const concurrencyReport = await buildConcurrencyReport(root);
    const leaseEventLog = buildLeaseEventLog(root);
    const gitScenarioMatrix = buildGitScenarioMatrix(root);
    process.stdout.write(
      `${JSON.stringify({
        concurrency_report: concurrencyReport,
        git_scenario_matrix: gitScenarioMatrix,
        lease_event_log: leaseEventLog,
      })}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
