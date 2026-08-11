import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  APP_SERVER_PROTOCOL_VERSION,
  decodeAppServerCompletedCommandEvidence,
  decodeAppServerFreshThreadStartResponse,
  decodeAppServerItemCompletedNotification,
  decodeAppServerSkillsListParams,
  decodeAppServerThreadStartParams,
  decodeAppServerTurnCompletedNotification,
  decodeAppServerTurnStartParams,
  resolveAppServerSkill,
} from "../src/controller/production/index.js";

const THREAD_ID = "019fef54-3c37-7081-afe2-2a47124abb18";
const TURN_ID = "019fef54-3c37-7081-afe2-2a47124abb19";

function freshThread(turns: readonly unknown[] = []): Readonly<Record<string, unknown>> {
  return {
    id: THREAD_ID,
    sessionId: THREAD_ID,
    forkedFromId: null,
    parentThreadId: null,
    ephemeral: false,
    turns,
  };
}

function completedCommand(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    type: "commandExecution",
    id: "command-1",
    pluginId: null,
    scriptPath: null,
    command: "node helper.mjs prepare",
    cwd: "E:\\workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "{}",
    exitCode: 0,
    durationMs: 25,
    ...overrides,
  };
}

function completedItem(item: unknown): Readonly<Record<string, unknown>> {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    completedAtMs: 1_786_426_000_000,
    item,
  };
}

void test("S17 freezes 0.146.0 thread sandbox casing", () => {
  assert.equal(APP_SERVER_PROTOCOL_VERSION, "0.146.0");
  assert.deepEqual(decodeAppServerThreadStartParams({ sandbox: "workspace-write" }), {
    sandbox: "workspace-write",
  });
  assert.throws(
    () => decodeAppServerThreadStartParams({ sandbox: "workspaceWrite" }),
    /sandbox.*workspaceWrite/u,
  );
});

void test("S17 requires camelCase Turn sandbox policy and every workspaceWrite field", () => {
  const valid = {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "continue", text_elements: [] }],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["E:\\workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  } as const;
  assert.equal(decodeAppServerTurnStartParams(valid).sandboxPolicy?.type, "workspaceWrite");
  assert.throws(
    () => decodeAppServerTurnStartParams({
      ...valid,
      sandboxPolicy: { ...valid.sandboxPolicy, type: "workspace-write" },
    }),
    /sandboxPolicy\.type/u,
  );
  for (const missing of ["excludeTmpdirEnvVar", "excludeSlashTmp"] as const) {
    const incomplete = Object.fromEntries(
      Object.entries(valid.sandboxPolicy).filter(([key]) => key !== missing),
    );
    assert.throws(
      () => decodeAppServerTurnStartParams({ ...valid, sandboxPolicy: incomplete }),
      new RegExp(`sandboxPolicy\\.${missing}`),
    );
  }
});

void test("S17 requires text_elements and rejects unknown UserInput variants", () => {
  assert.throws(
    () => decodeAppServerTurnStartParams({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "continue" }],
    }),
    /text_elements/u,
  );
  assert.throws(
    () => decodeAppServerTurnStartParams({
      threadId: THREAD_ID,
      input: [{ type: "futureInput", value: "opaque" }],
    }),
    /futureInput/u,
  );
});

void test("S17 rejects a Turn that omits its required skill item", () => {
  const textOnly = {
    threadId: THREAD_ID,
    input: [{ type: "text", text: "$export-codex-handoff", text_elements: [] }],
  };
  assert.throws(
    () => decodeAppServerTurnStartParams(textOnly, {
      requiredSkill: {
        name: "export-codex-handoff",
        path: "C:\\skills\\export-codex-handoff\\SKILL.md",
      },
    }),
    /required skill item/u,
  );
  const decoded = decodeAppServerTurnStartParams({
    ...textOnly,
    input: [
      ...textOnly.input,
      {
        type: "skill",
        name: "export-codex-handoff",
        path: "C:\\skills\\export-codex-handoff\\SKILL.md",
      },
    ],
  }, {
    requiredSkill: {
      name: "export-codex-handoff",
      path: "C:\\skills\\export-codex-handoff\\SKILL.md",
    },
  });
  assert.equal(decoded.input[1]?.type, "skill");
});

void test("S17 resolves exactly one enabled skill and rejects ambiguous or disabled matches", () => {
  assert.deepEqual(decodeAppServerSkillsListParams({
    cwds: ["E:\\workspace"],
    forceReload: true,
  }), {
    cwds: ["E:\\workspace"],
    forceReload: true,
  });
  const skill = {
    name: "export-codex-handoff",
    description: "Export a verified Handoff.",
    path: "C:\\skills\\export-codex-handoff\\SKILL.md",
    scope: "user",
    enabled: true,
  } as const;
  const response = {
    data: [{ cwd: "E:\\workspace", skills: [skill], errors: [] }],
  };
  assert.deepEqual(
    resolveAppServerSkill(response, "E:\\workspace", "export-codex-handoff"),
    skill,
  );
  assert.throws(
    () => resolveAppServerSkill({
      data: [{ cwd: "E:\\workspace", skills: [skill, { ...skill }], errors: [] }],
    }, "E:\\workspace", "export-codex-handoff"),
    /ambiguous/u,
  );
  assert.throws(
    () => resolveAppServerSkill({
      data: [{ cwd: "E:\\workspace", skills: [{ ...skill, enabled: false }], errors: [] }],
    }, "E:\\workspace", "export-codex-handoff"),
    /disabled/u,
  );
});

void test("S17 fresh-root projection rejects non-empty turns", () => {
  assert.equal(
    decodeAppServerFreshThreadStartResponse({ thread: freshThread() }).thread.id,
    THREAD_ID,
  );
  assert.throws(
    () => decodeAppServerFreshThreadStartResponse({
      thread: freshThread([{ id: TURN_ID }]),
    }),
    /turns.*fresh/u,
  );
});

void test("S17 completed-command evidence is fail-closed", () => {
  const evidence = decodeAppServerCompletedCommandEvidence(completedItem(completedCommand()));
  assert.equal(evidence.item.command, "node helper.mjs prepare");
  assert.equal(evidence.item.exitCode, 0);

  assert.throws(
    () => decodeAppServerCompletedCommandEvidence(completedItem(completedCommand({ status: "inProgress" }))),
    /completed command/u,
  );
  assert.throws(
    () => decodeAppServerCompletedCommandEvidence(completedItem(completedCommand({ exitCode: null }))),
    /exitCode/u,
  );
  const missingStatus = { ...completedCommand() } as Record<string, unknown>;
  delete missingStatus.status;
  assert.throws(
    () => decodeAppServerCompletedCommandEvidence(completedItem(missingStatus)),
    /status/u,
  );
});

void test("S17 projects required agent/tool variants and rejects an unknown ThreadItem variant", () => {
  const agent = decodeAppServerItemCompletedNotification(completedItem({
    type: "agentMessage",
    id: "message-1",
    text: "ready",
    phase: "final_answer",
    memoryCitation: null,
  }));
  assert.equal(agent.item.type, "agentMessage");

  const web = decodeAppServerItemCompletedNotification(completedItem({
    type: "webSearch",
    id: "search-1",
    query: "Codex App Server",
    action: null,
    results: null,
  }));
  assert.equal(web.item.type, "webSearch");

  assert.throws(
    () => decodeAppServerItemCompletedNotification(completedItem({
      type: "futureRequiredItem",
      id: "future-1",
    })),
    /futureRequiredItem/u,
  );
});

void test("S17 Turn completion codec requires a terminal status and complete projected fields", () => {
  const notification = {
    threadId: THREAD_ID,
    turn: {
      id: TURN_ID,
      items: [completedCommand()],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1_786_425_900,
      completedAt: 1_786_426_000,
      durationMs: 100_000,
    },
  };
  assert.equal(decodeAppServerTurnCompletedNotification(notification).turn.status, "completed");
  assert.throws(
    () => decodeAppServerTurnCompletedNotification({
      ...notification,
      turn: { ...notification.turn, status: "inProgress" },
    }),
    /terminal/u,
  );
});

void test("S17 local generated-schema projection passes or explicitly skips without Codex", (context) => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/verify-s17.mjs"), "--schema-only", "--unit-test"],
    { cwd: process.cwd(), encoding: "utf8", shell: false, windowsHide: true },
  );
  if (result.status === 2 && result.stdout.includes("S17_SCHEMA_PROJECTION_SKIP")) {
    context.skip("Codex binary is unavailable; release verification remains fail-closed.");
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /S17_SCHEMA_PROJECTION_PASS/u);
});
