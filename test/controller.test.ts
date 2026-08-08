import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { runController, type ControllerIo } from "../src/controller/main.js";
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
