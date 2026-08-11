#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const runnerPath = path.join(
  repoRoot,
  "test",
  "fixtures",
  "process",
  "run-production-cli-with-fake-host.mjs",
);
const controllerPath = path.join(repoRoot, "dist", "src", "controller", "main.js");

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs ?? 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(root, args) {
  const result = run("git", args, { cwd: root });
  if (result.exitCode !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function plan() {
  const now = Date.now();
  return {
    schema_version: 1,
    run_id: "s13-production-entry",
    commit_mode: "none",
    model_capabilities: {
      schema_version: 1,
      source: "s13-deterministic-fixture",
      captured_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      models: [{
        model: "gpt-5.6-sol",
        reasoning_efforts: ["medium", "max"],
      }],
    },
    slices: [{
      contract: {
        slice_id: "S13-entry-fixture",
        contract_version: 1,
        objective: "Create the deterministic production-entry fixture outputs.",
        exclusions: ["Never commit or push."],
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
      instructions: "Write owned.txt and result.json exactly as required by check.mjs.",
    }],
  };
}

function initializeWorkspace(root) {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Auto Slice S13"]);
  git(root, ["config", "user.email", "auto-slice-s13@example.invalid"]);
  writeFileSync(path.join(root, "README.md"), "s13 fixture\n", "utf8");
  writeFileSync(
    path.join(root, "check.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("owned.txt", "utf8") !== "owned-by-production-cli\\n") process.exit(7);',
      'if (JSON.parse(readFileSync("result.json", "utf8")).ok !== true) process.exit(8);',
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["add", "README.md", "check.mjs"]);
  git(root, ["commit", "-m", "fixture baseline"]);
}

function main() {
  if (!existsSync(controllerPath)) fail("Build output is missing; run npm run build first.");
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s13-entry-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const storageRoot = path.join(temporaryRoot, "state");
  const planPath = path.join(temporaryRoot, "plan.json");
  try {
    initializeWorkspace(workspaceRoot);
    writeFileSync(planPath, `${JSON.stringify(plan())}\n`, "utf8");
    const startHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
    const startCommitCount = Number(git(workspaceRoot, ["rev-list", "--count", "HEAD"]));
    const help = run(process.execPath, [controllerPath, "--help"]);
    if (help.exitCode !== 0 || !help.stdout.includes("run-plan <plan_json_path>")) {
      fail("Compiled controller help does not expose run-plan.");
    }
    const executed = run(process.execPath, [
      runnerPath,
      planPath,
      workspaceRoot,
      storageRoot,
    ], { timeoutMs: 120_000 });
    if (executed.exitCode !== 0) {
      fail(`run-plan failed (${String(executed.exitCode)}): ${executed.stderr}`);
    }
    const output = JSON.parse(executed.stdout);
    const endHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
    const endCommitCount = Number(git(workspaceRoot, ["rev-list", "--count", "HEAD"]));
    const remotes = git(workspaceRoot, ["remote", "-v"]);
    const status = git(workspaceRoot, ["status", "--short"])
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort();
    if (
      output.status !== "PRODUCTION_RUN_COMPLETED" ||
      output.decision?.outcome !== "DONE" ||
      output.decision?.run_id !== "s13-production-entry" ||
      startHead !== endHead ||
      startCommitCount !== endCommitCount ||
      remotes.length !== 0 ||
      !existsSync(storageRoot) ||
      existsSync(path.join(workspaceRoot, ".auto-slice")) ||
      readFileSync(path.join(workspaceRoot, "owned.txt"), "utf8") !== "owned-by-production-cli\n" ||
      JSON.parse(readFileSync(path.join(workspaceRoot, "result.json"), "utf8")).ok !== true
    ) {
      fail("Production entry assertions did not all pass.");
    }
    const report = {
      schema_version: 1,
      slice_id: "S13",
      result: "PASS",
      assertions: {
        compiled_bin_advertises_run_plan: true,
        production_plan_reached_orchestrator: true,
        default_development_adapter_protocol_exercised: true,
        commit_mode: "none",
        commit_count_delta: 0,
        head_unchanged: true,
        remote_count: 0,
        push_count: 0,
        state_storage_outside_workspace: true,
        workspace_state_directory_absent: true,
        deterministic_checks_passed: true,
        task_host_disposed: true,
      },
      workspace_status: status,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
