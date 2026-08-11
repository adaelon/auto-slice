import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { sha256Bytes } from "../src/controller/state/index.js";
import {
  isControllerEntryPath,
  runController,
  runControllerCli,
  type ControllerIo,
} from "../src/controller/main.js";
import { FIXTURE_ROOT } from "./helpers/frozen-workspace.js";

interface CapturedIo {
  readonly io: ControllerIo;
  readonly stderr: string[];
  readonly stdout: string[];
}

function captureIo(): CapturedIo {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    io: {
      writeStderr: (line) => stderr.push(line),
      writeStdout: (line) => stdout.push(line),
    },
    stderr,
    stdout,
  };
}

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "auto-slice-controller-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

void test("Controller reports loaded contracts without entering PREPARING", () => {
  const capture = captureIo();
  const exitCode = runController(["inspect-contracts", FIXTURE_ROOT], capture.io);
  assert.equal(exitCode, 0);
  assert.equal(capture.stderr.length, 0);
  assert.match(capture.stdout.join("\n"), /"status": "CONTRACTS_LOADED"/u);
  assert.doesNotMatch(capture.stdout.join("\n"), /PREPARING/u);
});

void test("Controller reports contract_load_failed and remains closed", () => {
  const capture = captureIo();
  const exitCode = runController(
    ["inspect-contracts", path.join(FIXTURE_ROOT, "missing")],
    capture.io,
  );
  assert.equal(exitCode, 1);
  assert.equal(capture.stdout.length, 0);
  assert.match(capture.stderr.join("\n"), /"status":"CONTRACT_LOAD_FAILED"/u);
  assert.match(capture.stderr.join("\n"), /"code":"contract_load_failed"/u);
  assert.doesNotMatch(capture.stderr.join("\n"), /PREPARING/u);
});

void test("Controller exposes a deterministic help and invalid-command exit", () => {
  const help = captureIo();
  assert.equal(runController(["--help"], help.io), 0);
  assert.match(help.stdout[0] ?? "", /^Usage:/u);

  const invalid = captureIo();
  assert.equal(runController(["start"], invalid.io), 2);
  assert.match(invalid.stderr[0] ?? "", /^Usage:/u);
});

void test("Controller recognizes an entry path reached through a directory link", (context) => {
  const root = temporaryDirectory(context);
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  const realEntry = path.join(realDirectory, "main.js");
  mkdirSync(realDirectory);
  writeFileSync(realEntry, "// entry fixture\n", "utf8");
  symlinkSync(
    realDirectory,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.equal(
    isControllerEntryPath(path.join(linkedDirectory, "main.js"), realEntry),
    true,
  );
  assert.equal(
    isControllerEntryPath(path.join(linkedDirectory, "other.js"), realEntry),
    false,
  );
});

void test("Controller executes file-backed start and status command envelopes", (context) => {
  const root = temporaryDirectory(context);
  const storageRoot = path.join(root, "state");
  const startPath = path.join(root, "start.json");
  writeFileSync(startPath, `${JSON.stringify({
    command_id: "cli-start",
    payload: {
      run_id: "cli-run",
      workspace_identity: {
        canonical_root: root,
        filesystem_identity: "test:cli-workspace",
      },
      plan_digest: sha256Bytes("cli-plan"),
      protected_baseline_digest: sha256Bytes("cli-baseline"),
      commit_mode: "after_slice",
      first_slice_id: "S11",
    },
  })}\n`, "utf8");
  const started = captureIo();
  assert.equal(runController(["start", startPath, storageRoot], started.io), 0);
  assert.match(started.stdout.join("\n"), /"status": "PREPARING"/u);

  const statusPath = path.join(root, "status.json");
  writeFileSync(statusPath, `${JSON.stringify({
    command_id: "cli-status",
    run_id: "cli-run",
    payload: {},
  })}\n`, "utf8");
  const status = captureIo();
  assert.equal(runController(["status", statusPath, storageRoot], status.io), 0);
  assert.match(status.stdout.join("\n"), /"state_version": 1/u);
});

void test("run-plan usage rejection does not construct a Production Task Host", async () => {
  const capture = captureIo();
  let constructed = false;

  const exitCode = await runControllerCli(["run-plan"], capture.io, () => {
    constructed = true;
    throw new Error("must not construct");
  });

  assert.equal(exitCode, 2);
  assert.equal(constructed, false);
  assert.match(capture.stderr.join("\n"), /run-plan <plan_json_path>/u);
});
