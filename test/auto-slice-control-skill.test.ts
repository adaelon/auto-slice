import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const SKILL_PATH = path.resolve("skills", "auto-slice-control", "SKILL.md");
const SKILL = readFileSync(SKILL_PATH, "utf8");

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `Missing section: ${heading}`);
  const next = markdown.indexOf("\n## ", start + heading.length + 3);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

void test("continue monitoring is a status-only control-plane operation", () => {
  const monitoring = section(SKILL, "Status-only monitoring");
  assert.match(monitoring, /继续监控/u);
  assert.match(monitoring, /continue monitoring/iu);

  const controllerCommands = monitoring.match(/auto-slice-controller\s+[a-z-]+/gu) ?? [];
  assert.deepEqual(
    [...new Set(controllerCommands)],
    ["auto-slice-controller status"],
  );
  assert.match(monitoring, /"payload": \{\}/u);
  assert.doesNotMatch(monitoring, /auto-slice-controller\s+(?:start|pause|resume|abort|override)\b/u);
});

void test("monitoring forbids Worker Task, Git, and workspace diagnostics", () => {
  const monitoring = section(SKILL, "Status-only monitoring");
  for (const forbiddenTool of ["list_threads", "read_thread", "wait_threads"]) {
    assert.match(monitoring, new RegExp(`\\b${forbiddenTool}\\b`, "u"));
  }
  assert.match(monitoring, /Git/u);
  assert.match(monitoring, /workspace/u);
  assert.match(monitoring, /checkpoint/u);
  assert.match(monitoring, /task command output/u);

  for (const allowedField of [
    "run_id",
    "current_slice_id",
    "status",
    "state_version",
    "error.code",
    "recovery_options",
  ]) {
    assert.match(monitoring, new RegExp(allowedField.replace(".", "\\."), "u"));
  }
});

void test("NEEDS_USER remains an explicit user-selected recovery", () => {
  const monitoring = section(SKILL, "Status-only monitoring");
  assert.match(monitoring, /NEEDS_USER/u);
  assert.match(monitoring, /explicitly selects/iu);
  assert.match(monitoring, /never automatically (?:resume|abort)/iu);

  const envelopes = section(SKILL, "Envelope shapes");
  assert.match(envelopes, /"expected_state_version": 7/u);
  assert.match(envelopes, /"resolution": "supply_model_policy"/u);
  assert.match(envelopes, /"evidence_path"/u);
  assert.match(envelopes, /"evidence_digest"/u);
});
