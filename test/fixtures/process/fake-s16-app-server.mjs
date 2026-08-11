#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const scenario = process.argv[2] ?? "normal-short";
const protocolTracePath = process.argv[3];
const suppliedBaseMillis = Number(process.argv[4]);
const baseMillis = Number.isFinite(suppliedBaseMillis) ? suppliedBaseMillis : Date.now();
const baseSeconds = Math.floor(baseMillis / 1_000);
const expectedSliceIds = JSON.parse(process.argv[5] ?? "[]");
const expectedCommitMode = process.argv[6] ?? "none";
const expectedScenarios = new Set([
  "normal-short",
  "normal-large",
  "compaction-29999",
  "timeout-revision-available",
  "timeout-revision-unavailable",
  "probe-fallback",
  "worker-failed",
  "worker-interrupted",
]);
const expectedContentNotificationOptOuts = [
  "turn/diff/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
];
const contentCanaries = {
  message: "S16_MESSAGE_CANARY",
  reasoning: "S16_REASONING_CANARY",
  command: "S16_COMMAND_CANARY",
  diff: "S16_DIFF_CANARY",
  tool: "S16_TOOL_CANARY",
  plan: "S16_PLAN_CANARY",
  summary: "S16_SUMMARY_CANARY",
  error: "S16_ERROR_CANARY",
};

if (
  !expectedScenarios.has(scenario) ||
  !Array.isArray(expectedSliceIds) ||
  expectedSliceIds.length === 0 ||
  expectedSliceIds.some((sliceId) => typeof sliceId !== "string" || sliceId.length === 0) ||
  (expectedCommitMode !== "none" && expectedCommitMode !== "after_slice")
) {
  process.stderr.write("S16 fake App Server received invalid fixture arguments.\n");
  process.exit(64);
}

let sessionSequence = 0;
const sessions = new Map();

function taskId(index, kind) {
  const suffix = index * 10 + (kind === "thread" ? 1 : 2);
  return `019feb16-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function createSession() {
  const index = sessionSequence;
  sessionSequence += 1;
  const session = {
    index,
    threadId: taskId(index, "thread"),
    turnId: taskId(index, "turn"),
    terminalStatus: "inProgress",
    terminalSent: false,
    cwd: null,
  };
  sessions.set(session.threadId, session);
  return session;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  write({ id, result });
}

function failure(id, message) {
  write({ id, error: { code: -32_602, message } });
}

function contentValue(value) {
  return scenario === "normal-short" ? value : `${value}:${"x".repeat(96 * 1024)}`;
}

function completedAtSeconds() {
  return scenario === "probe-fallback"
    ? baseSeconds + 20 * 60 + 1
    : baseSeconds + 1;
}

function turn(session, status, items = []) {
  return {
    id: session.turnId,
    items,
    itemsView: { type: "full" },
    status,
    error: status === "failed" ? { message: "fake failure" } : null,
    startedAt: baseSeconds,
    completedAt: status === "inProgress" ? null : completedAtSeconds(),
    durationMs: status === "inProgress" ? null : 1_000,
    ignoredDiagnostic: contentValue(contentCanaries.error),
  };
}

function thread(session, includeSummaryCanary = false) {
  return {
    id: session.threadId,
    sessionId: session.threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: includeSummaryCanary ? contentValue(contentCanaries.summary) : "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: baseSeconds,
    updatedAt: completedAtSeconds(),
    recencyAt: completedAtSeconds(),
    status: { type: session.terminalStatus === "inProgress" ? "active" : "idle" },
    path: `fake-s16-rollout-${String(session.index)}.jsonl`,
    cwd: session.cwd ?? process.cwd(),
    cliVersion: "fake-s16",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
  };
}

function contentItems() {
  return [
    { type: "agentMessage", id: "content-message", text: contentValue(contentCanaries.message), phase: "final_answer", memoryCitation: null },
    { type: "reasoning", id: "content-reasoning", summary: [contentValue(contentCanaries.reasoning)], content: [] },
    { type: "commandExecution", id: "content-command", command: "ignored", cwd: process.cwd(), processId: null, status: "completed", commandActions: [], aggregatedOutput: contentValue(contentCanaries.command), exitCode: 0, durationMs: 1 },
    { type: "fileChange", id: "content-diff", changes: [{ path: "ignored", kind: "update", diff: contentValue(contentCanaries.diff) }], status: "completed" },
    { type: "mcpToolCall", id: "content-tool", server: "ignored", tool: "ignored", status: "completed", arguments: { payload: contentValue(contentCanaries.tool) }, result: null, error: null, durationMs: 1 },
    { type: "plan", id: "content-plan", text: contentValue(contentCanaries.plan) },
  ];
}

function sendContentFlood(session) {
  const frames = [
    ["item/agentMessage/delta", { delta: contentValue(contentCanaries.message) }],
    ["item/reasoning/textDelta", { delta: contentValue(contentCanaries.reasoning) }],
    ["item/commandExecution/outputDelta", { delta: contentValue(contentCanaries.command) }],
    ["turn/diff/updated", { diff: contentValue(contentCanaries.diff) }],
    ["item/mcpToolCall/progress", { message: contentValue(contentCanaries.tool) }],
    ["turn/plan/updated", { explanation: contentValue(contentCanaries.plan), plan: [] }],
  ];
  for (const [method, extra] of frames) {
    write({
      method,
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        ...extra,
        ignoredDiagnostic: contentValue(contentCanaries.error),
      },
    });
  }
  for (const item of contentItems()) {
    write({
      method: "item/completed",
      params: {
        threadId: session.threadId,
        turnId: session.turnId,
        completedAtMs: baseMillis + 50,
        item,
        ignoredSummary: contentValue(contentCanaries.summary),
      },
    });
  }
}

function sendCompaction(session, phase) {
  write({
    method: phase === "STARTED" ? "item/started" : "item/completed",
    params: {
      threadId: session.threadId,
      turnId: session.turnId,
      item: {
        type: "contextCompaction",
        id: "compaction-s16-content-budget",
        ignoredWorkerContent: contentValue(
          phase === "STARTED" ? contentCanaries.message : contentCanaries.reasoning,
        ),
      },
    },
  });
}

function sendTerminal(session, status) {
  if (session.terminalSent) return;
  session.terminalSent = true;
  session.terminalStatus = status;
  write({
    method: "turn/completed",
    params: {
      threadId: session.threadId,
      turn: turn(session, status, status === "completed" ? contentItems() : []),
      ignoredSummary: contentValue(contentCanaries.summary),
      ignoredError: contentValue(contentCanaries.error),
    },
  });
}

function writeProductionOutputs(session) {
  if (typeof session.cwd !== "string") process.exit(19);
  writeFileSync(path.join(session.cwd, "owned.txt"), "owned-by-s16-production\n", "utf8");
  writeFileSync(path.join(session.cwd, "result.json"), '{"ok":true}\n', "utf8");
  writeFileSync(
    path.join(session.cwd, `worker-extra-${String(session.index + 1)}.txt`),
    `unowned output from ${expectedSliceIds[session.index]}\n`,
    "utf8",
  );
}

function afterTurnStarted(session) {
  sendContentFlood(session);
  if (scenario === "normal-short" || scenario === "normal-large") {
    writeProductionOutputs(session);
    sendTerminal(session, "completed");
    return;
  }
  if (scenario === "worker-failed") {
    sendTerminal(session, "failed");
    return;
  }
  if (scenario === "worker-interrupted") {
    sendTerminal(session, "interrupted");
    return;
  }
  if (scenario === "probe-fallback") {
    setTimeout(() => {
      writeProductionOutputs(session);
      sendTerminal(session, "completed");
    }, 25);
    return;
  }
  sendCompaction(session, "STARTED");
  if (scenario === "compaction-29999") {
    sendCompaction(session, "COMPLETED");
    writeProductionOutputs(session);
    sendTerminal(session, "completed");
  }
}

function traceRequest(message) {
  if (
    typeof protocolTracePath !== "string" ||
    !["thread/start", "turn/start", "turn/interrupt", "thread/read"].includes(message.method)
  ) {
    return;
  }
  appendFileSync(
    protocolTracePath,
    `${JSON.stringify({
      method: message.method,
      ...(message.method === "thread/read"
        ? { includeTurns: message.params?.includeTurns }
        : {}),
    })}\n`,
    "utf8",
  );
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  traceRequest(message);
  if (message.method === "initialized") {
    if (message.params === null || typeof message.params !== "object" || Object.keys(message.params).length !== 0) {
      process.exit(18);
    }
    return;
  }
  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities;
    if (
      capabilities?.experimentalApi !== false ||
      capabilities?.requestAttestation !== false ||
      JSON.stringify(capabilities?.optOutNotificationMethods) !==
        JSON.stringify(expectedContentNotificationOptOuts)
    ) {
      failure(message.id, "content notification opt-outs mismatch");
      return;
    }
    response(message.id, {
      userAgent: "fake-s16-codex-app-server",
      codexHome: process.cwd(),
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform,
    });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params;
    if (
      params.model !== "gpt-5.6-sol" ||
      params.approvalPolicy !== "never" ||
      params.sandbox !== "workspace-write" ||
      "ephemeral" in params
    ) {
      failure(message.id, "unsafe thread/start parameters");
      return;
    }
    const session = createSession();
    response(message.id, { thread: thread(session), instructionSources: [] });
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params;
    const session = sessions.get(params.threadId);
    const sliceId = session === undefined ? undefined : expectedSliceIds[session.index];
    const completionClause = expectedCommitMode === "after_slice"
      ? "完成后commit，刷新checkpoint"
      : "完成后刷新checkpoint";
    if (
      session === undefined ||
      typeof sliceId !== "string" ||
      params.model !== "gpt-5.6-sol" ||
      params.effort !== "max" ||
      params.approvalPolicy !== "never" ||
      typeof params.cwd !== "string" ||
      params.input?.[0]?.type !== "text" ||
      params.input[0].text !== `设定goal：阅读checkpoint，实现${sliceId}，${completionClause}`
    ) {
      failure(message.id, "S16 production goal prompt mismatch");
      return;
    }
    session.cwd = params.cwd;
    response(message.id, { turn: turn(session, "inProgress") });
    setImmediate(() => afterTurnStarted(session));
    return;
  }
  if (message.method === "turn/interrupt") {
    const session = sessions.get(message.params?.threadId);
    if (session === undefined || message.params?.turnId !== session.turnId) {
      failure(message.id, "turn/interrupt identity mismatch");
      return;
    }
    response(message.id, {});
    setImmediate(() => sendTerminal(session, "interrupted"));
    return;
  }
  if (message.method === "thread/read") {
    const session = sessions.get(message.params?.threadId);
    if (session === undefined || message.params?.includeTurns !== false) {
      failure(message.id, "thread/read must be summary-only");
      return;
    }
    response(message.id, { thread: thread(session, true) });
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
