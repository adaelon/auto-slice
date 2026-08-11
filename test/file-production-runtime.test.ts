import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { runControllerCli, type ControllerIo } from "../src/controller/main.js";
import type { CompressionTaskLauncher } from "../src/controller/handoff/index.js";
import type { ContinuationLauncher } from "../src/controller/continuation/index.js";
import {
  CodexAppServerTaskHost,
  ProductionPlanError,
  ProductionRuntimeError,
  runProductionPlanFile,
  type DevelopmentTaskHandle,
  type DevelopmentTaskPort,
  type DevelopmentTaskRequest,
  type ProductionTaskHostPorts,
} from "../src/controller/production/index.js";
import { FileRunStore, sha256Json, StateStoreError } from "../src/controller/state/index.js";
import type { ThreadControlPort } from "../src/controller/thread-control/index.js";

const FIXED_TIME = "2026-08-09T12:00:00.000Z";

function fixedDate(): Date {
  return new Date(FIXED_TIME);
}

function temporaryDirectory(context: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-production-runtime-"));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initializeWorkspace(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Auto Slice Test"]);
  git(root, ["config", "user.email", "auto-slice@example.invalid"]);
  writeFileSync(
    path.join(root, "check.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("owned.txt", "utf8") !== "owned-by-development\\n") process.exit(7);',
      'if (JSON.parse(readFileSync("result.json", "utf8")).ok !== true) process.exit(8);',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md", "check.mjs"]);
  git(root, ["commit", "-m", "fixture baseline"]);
}

function productionPlan(
  runId: string,
  commitMode: "after_slice" | "none" = "none",
): unknown {
  return {
    schema_version: 1,
    run_id: runId,
    commit_mode: commitMode,
    model_capabilities: {
      schema_version: 1,
      source: "test-fixture",
      captured_at: "2026-08-09T11:59:00.000Z",
      expires_at: "2099-08-10T12:30:00.000Z",
      models: [{
        model: "gpt-5.6-sol",
        reasoning_efforts: ["medium", "max"],
      }],
    },
    slices: [{
      contract: {
        slice_id: "S13-runtime",
        contract_version: 1,
        objective: "Create the deterministic fixture outputs.",
        exclusions: [commitMode === "none" ? "Never commit or push." : "Never push."],
        owned_paths: ["owned.txt", "result.json"],
        checks: [{
          id: "fixture-check",
          argv: [process.execPath, "check.mjs"],
          cwd: ".",
          timeout_ms: 10_000,
          env_allowlist: ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"],
          expected_exit_code: 0,
          expected_artifacts: ["result.json"],
        }],
        expected_artifacts: [{ path: "result.json", kind: "fixture_result" }],
      },
      instructions: "Write owned.txt and result.json exactly as requested by the fixture.",
    }],
  };
}

const EMPTY_EVENTS: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

class FixtureTaskHost implements ProductionTaskHostPorts {
  public disposed = false;

  public constructor(
    private readonly commitMode: "after_slice" | "none" = "none",
    private readonly behavior: "outputs" | "no-op" | "multiple-commits-and-extra" = "outputs",
  ) {}

  public readonly development_tasks: DevelopmentTaskPort = {
    start: (request: DevelopmentTaskRequest): Promise<DevelopmentTaskHandle> => {
      assert.equal(
        request.prompt,
        this.commitMode === "after_slice"
          ? "设定goal：阅读checkpoint，实现S13-runtime，完成后commit，刷新checkpoint"
          : "设定goal：阅读checkpoint，实现S13-runtime，完成后刷新checkpoint",
      );
      if (this.behavior === "outputs") {
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "owned.txt"),
          "owned-by-development\n",
          "utf8",
        );
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "result.json"),
          '{"ok":true}\n',
          "utf8",
        );
        if (this.commitMode === "after_slice") {
          git(request.workspace_identity.canonical_root, ["add", "owned.txt", "result.json"]);
          git(request.workspace_identity.canonical_root, ["commit", "-m", "complete S13-runtime"]);
        }
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "SESSION_CHECKPOINT.md"),
          "# SESSION_CHECKPOINT\n\nS13-runtime complete.\n",
          "utf8",
        );
      } else if (this.behavior === "multiple-commits-and-extra") {
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "extra-one.txt"),
          "first unrelated commit\n",
          "utf8",
        );
        git(request.workspace_identity.canonical_root, ["add", "extra-one.txt"]);
        git(request.workspace_identity.canonical_root, ["commit", "-m", "first extra commit"]);
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "extra-two.txt"),
          "second unrelated commit\n",
          "utf8",
        );
        git(request.workspace_identity.canonical_root, ["add", "extra-two.txt"]);
        git(request.workspace_identity.canonical_root, ["commit", "-m", "second extra commit"]);
        writeFileSync(
          path.join(request.workspace_identity.canonical_root, "untracked-extra.txt"),
          "arbitrary extra file\n",
          "utf8",
        );
      }
      const material = {
        schema_version: 1 as const,
        run_id: request.run_id,
        slice_id: request.slice_id,
        thread_id: "thread-runtime-fixture",
        turn_id: "turn-runtime-fixture",
        outcome: "COMPLETED" as const,
        started_at: FIXED_TIME,
        completed_at: FIXED_TIME,
      };
      return Promise.resolve({
        thread_id: material.thread_id,
        turn_id: material.turn_id,
        events: EMPTY_EVENTS,
        completion: Promise.resolve({
          ...material,
          receipt_digest: sha256Json(material),
        }),
      });
    },
  };

  public readonly thread_control: ThreadControlPort = {
    interrupt: () => Promise.reject(new Error("unexpected source interruption")),
    inspect: () => Promise.reject(new Error("unexpected source inspection")),
  };

  public readonly compression_launcher: CompressionTaskLauncher = {
    start: () => Promise.reject(new Error("unexpected compression task")),
    awaitHandoff: () => Promise.reject(new Error("unexpected Handoff wait")),
  };

  public readonly continuation_launcher: ContinuationLauncher = {
    start: () => Promise.reject(new Error("unexpected Continuation Task")),
    awaitReady: () => Promise.reject(new Error("unexpected Continuation ready wait")),
    grantWrite: () => Promise.reject(new Error("unexpected write grant")),
    awaitProgress: () => Promise.reject(new Error("unexpected progress wait")),
  };

  public dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

function captureIo(): {
  readonly io: ControllerIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

void test("file production runtime completes a real Git Slice with external state storage", async (context) => {
  const root = temporaryDirectory(context);
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state");
  const planPath = path.join(root, "plan.json");
  initializeWorkspace(workspaceRoot);
  writeFileSync(planPath, `${JSON.stringify(productionPlan("runtime-happy"))}\n`, "utf8");
  const beforeHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
  const host = new FixtureTaskHost();

  const result = await runProductionPlanFile({
    plan_path: planPath,
    workspace_root: workspaceRoot,
    storage_root: storageRoot,
    task_host: host,
    now: fixedDate,
    lease_duration_ms: 60_000,
    lease_renew_interval_ms: 10_000,
  });

  assert.ok(!(result instanceof ProductionPlanError));
  assert.ok(!(result instanceof ProductionRuntimeError));
  assert.equal(result.decision.outcome, "DONE");
  assert.equal(result.storage_root, storageRoot);
  assert.equal(host.disposed, true);
  assert.equal(git(workspaceRoot, ["rev-parse", "HEAD"]), beforeHead);
  assert.equal(readFileSync(path.join(workspaceRoot, "owned.txt"), "utf8"), "owned-by-development\n");
  assert.match(readFileSync(path.join(workspaceRoot, "SESSION_CHECKPOINT.md"), "utf8"), /S13-runtime/u);
  const store = FileRunStore.open(storageRoot, { now: fixedDate });
  assert.ok(!(store instanceof StateStoreError));
  const stored = store.load("runtime-happy");
  assert.ok(!(stored instanceof StateStoreError));
  assert.equal(stored.state.status, "DONE");
  assert.equal(stored.state.project_lock_owner, null);
});

void test("file production runtime needs no Git repository, work artifact, commit, or checkpoint", async (context) => {
  const root = temporaryDirectory(context);
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state");
  const planPath = path.join(root, "plan.json");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(productionPlan("runtime-structured-only"))}\n`, "utf8");
  const host = new FixtureTaskHost("none", "no-op");

  const result = await runProductionPlanFile({
    plan_path: planPath,
    workspace_root: workspaceRoot,
    storage_root: storageRoot,
    task_host: host,
    now: fixedDate,
    lease_duration_ms: 60_000,
    lease_renew_interval_ms: 10_000,
  });

  assert.ok(!(result instanceof ProductionPlanError));
  assert.ok(!(result instanceof ProductionRuntimeError));
  assert.equal(result.decision.outcome, "DONE");
  assert.equal(existsSync(path.join(workspaceRoot, ".git")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "owned.txt")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "result.json")), false);
  assert.equal(existsSync(path.join(workspaceRoot, "SESSION_CHECKPOINT.md")), false);
});

void test("file production runtime ignores multiple commits, checkpoint absence, and arbitrary extra files", async (context) => {
  const root = temporaryDirectory(context);
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state");
  const planPath = path.join(root, "plan.json");
  initializeWorkspace(workspaceRoot);
  writeFileSync(
    planPath,
    `${JSON.stringify(productionPlan("runtime-after-slice", "after_slice"))}\n`,
    "utf8",
  );
  const beforeHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
  const host = new FixtureTaskHost("after_slice", "multiple-commits-and-extra");

  const result = await runProductionPlanFile({
    plan_path: planPath,
    workspace_root: workspaceRoot,
    storage_root: storageRoot,
    task_host: host,
    now: fixedDate,
    lease_duration_ms: 60_000,
    lease_renew_interval_ms: 10_000,
  });

  assert.ok(!(result instanceof ProductionPlanError));
  assert.ok(!(result instanceof ProductionRuntimeError));
  assert.equal(result.decision.outcome, "DONE");
  assert.notEqual(git(workspaceRoot, ["rev-parse", "HEAD"]), beforeHead);
  assert.equal(git(workspaceRoot, ["rev-list", "--count", `${beforeHead}..HEAD`]), "2");
  assert.deepEqual(
    git(workspaceRoot, ["diff", "--name-only", `${beforeHead}..HEAD`]).split(/\r?\n/u),
    ["extra-one.txt", "extra-two.txt"],
  );
  assert.equal(existsSync(path.join(workspaceRoot, "SESSION_CHECKPOINT.md")), false);
  assert.equal(readFileSync(path.join(workspaceRoot, "untracked-extra.txt"), "utf8"), "arbitrary extra file\n");
});

void test("file production runtime rejects state storage inside the verified workspace", async (context) => {
  const root = temporaryDirectory(context);
  const workspaceRoot = path.join(root, "workspace");
  const planPath = path.join(root, "plan.json");
  initializeWorkspace(workspaceRoot);
  writeFileSync(planPath, `${JSON.stringify(productionPlan("runtime-inside-state"))}\n`, "utf8");
  const host = new FixtureTaskHost();

  const result = await runProductionPlanFile({
    plan_path: planPath,
    workspace_root: workspaceRoot,
    storage_root: path.join(workspaceRoot, ".auto-slice"),
    task_host: host,
    now: fixedDate,
  });

  assert.ok(result instanceof ProductionRuntimeError);
  assert.equal(result.code, "production_run_invalid");
  assert.match(result.message, /outside the verified workspace/u);
  assert.equal(host.disposed, true);
});

void test("run-plan CLI composes a file Production Plan into the orchestrator", async (context) => {
  const root = temporaryDirectory(context);
  const workspaceRoot = path.join(root, "workspace");
  const storageRoot = path.join(root, "state");
  const planPath = path.join(root, "plan.json");
  initializeWorkspace(workspaceRoot);
  writeFileSync(planPath, `${JSON.stringify(productionPlan("runtime-cli"))}\n`, "utf8");
  const beforeHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
  const host = new FixtureTaskHost();
  const capture = captureIo();

  const exitCode = await runControllerCli(
    ["run-plan", planPath, workspaceRoot, storageRoot],
    capture.io,
    () => host,
  );

  assert.equal(exitCode, 0);
  assert.equal(capture.stderr.length, 0);
  const output = JSON.parse(capture.stdout.join("\n")) as {
    readonly status: string;
    readonly decision: { readonly outcome: string };
  };
  assert.equal(output.status, "PRODUCTION_RUN_COMPLETED");
  assert.equal(output.decision.outcome, "DONE");
  assert.equal(host.disposed, true);
  assert.equal(git(workspaceRoot, ["rev-parse", "HEAD"]), beforeHead);
});

void test("default App Server Task Host fails closed when Compression launchers are absent", async () => {
  const host = new CodexAppServerTaskHost();

  await assert.rejects(
    host.compression_launcher.start({} as never),
    (error: unknown) => error instanceof ProductionRuntimeError &&
      error.code === "handoff_export_failed",
  );
  await assert.rejects(
    host.continuation_launcher.start({} as never, {} as never),
    (error: unknown) => error instanceof ProductionRuntimeError &&
      error.code === "continuation_start_failed",
  );
  await host.dispose();
});
