#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const scenario = process.argv[2] ?? "happy";
const protocolTracePath = process.argv[3];
const threadId = "019fe6aa-0000-7000-8000-000000000001";
const turnId = "019fe6aa-0000-7000-8000-000000000002";
const fixedSeconds = 1_786_276_800;
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
  message: "S14_MESSAGE_CANARY",
  reasoning: "S14_REASONING_CANARY",
  command: "S14_COMMAND_CANARY",
  diff: "S14_DIFF_CANARY",
  tool: "S14_TOOL_CANARY",
  plan: "S14_PLAN_CANARY",
};
let terminalStatus = "inProgress";
let terminalSent = false;
let activeCwd = null;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  write({ id, result });
}

function failure(id, message) {
  write({ id, error: { code: -32_602, message } });
}

function turn(status, items = []) {
  return {
    id: turnId,
    items,
    itemsView: { type: "full" },
    status,
    error: status === "failed" ? { message: "fake failure" } : null,
    startedAt: fixedSeconds,
    completedAt: status === "inProgress" ? null : fixedSeconds + 1,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function thread(turns = []) {
  return {
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: fixedSeconds,
    updatedAt: fixedSeconds + 1,
    recencyAt: fixedSeconds + 1,
    status: { type: terminalStatus === "inProgress" ? "active" : "idle" },
    path: "fake-rollout.jsonl",
    cwd: process.cwd(),
    cliVersion: "fake",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}

function sendTerminal(status, providedItems = null) {
  if (terminalSent) return;
  terminalSent = true;
  terminalStatus = status;
  const items = providedItems ?? (status === "completed"
    ? [{ type: "agentMessage", id: "agent-final", text: "fake final response", phase: "final_answer", memoryCitation: null }]
    : []);
  write({ method: "turn/completed", params: { threadId, turn: turn(status, items) } });
}

function contentValue(value) {
  return scenario.endsWith("large") ? `${value}:${"x".repeat(96 * 1024)}` : value;
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

function sendContentFlood() {
  const values = contentItems();
  const frames = [
    ["item/agentMessage/delta", { delta: contentValue(contentCanaries.message) }],
    ["item/reasoning/textDelta", { delta: contentValue(contentCanaries.reasoning) }],
    ["item/commandExecution/outputDelta", { delta: contentValue(contentCanaries.command) }],
    ["turn/diff/updated", { diff: contentValue(contentCanaries.diff) }],
    ["item/mcpToolCall/progress", { message: contentValue(contentCanaries.tool) }],
    ["turn/plan/updated", { explanation: contentValue(contentCanaries.plan), plan: [] }],
  ];
  for (const [method, extra] of frames) {
    write({ method, params: { threadId, turnId, ...extra } });
  }
  for (const item of values) {
    write({ method: "item/completed", params: { threadId, turnId, completedAtMs: fixedSeconds * 1_000 + 50, item } });
  }
}

function writeProductionOutputs(checkpointLabel) {
  if (typeof activeCwd !== "string") process.exit(19);
  writeFileSync(path.join(activeCwd, "owned.txt"), "owned-by-production-cli\n", "utf8");
  writeFileSync(path.join(activeCwd, "result.json"), '{"ok":true}\n', "utf8");
  writeFileSync(
    path.join(activeCwd, "SESSION_CHECKPOINT.md"),
    `# SESSION_CHECKPOINT\n\n${checkpointLabel}\n`,
    "utf8",
  );
}

function sendFirewallControlSequence() {
  write({
    method: "item/started",
    params: {
      threadId,
      turnId,
      startedAtMs: fixedSeconds * 1_000 + 100,
      item: { type: "contextCompaction", id: "compaction-firewall", ignored: contentValue(contentCanaries.message) },
    },
  });
  write({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: fixedSeconds * 1_000 + 200,
      item: { type: "contextCompaction", id: "compaction-firewall", ignored: contentValue(contentCanaries.reasoning) },
    },
  });
}

function afterTurnStarted() {
  if (scenario === "probe-wait" || scenario === "probe-wait-complete") {
    return;
  }
  if (scenario === "production-write") {
    writeProductionOutputs("S13-runtime complete.");
    write({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: fixedSeconds * 1_000 + 300,
        item: { type: "agentMessage", id: "agent-final", text: "production fixture complete", phase: "final_answer", memoryCitation: null },
      },
    });
    sendTerminal("completed");
    return;
  }
  if (scenario === "production-firewall-short" || scenario === "production-firewall-large") {
    writeProductionOutputs("S14-firewall-runtime complete.");
    sendContentFlood();
    sendFirewallControlSequence();
    sendTerminal("completed", contentItems());
    return;
  }
  if (scenario === "happy") {
    write({
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: fixedSeconds * 1_000 + 100,
        item: { type: "contextCompaction", id: "compaction-1" },
      },
    });
    write({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: fixedSeconds * 1_000 + 200,
        item: { type: "contextCompaction", id: "compaction-1" },
      },
    });
    write({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: fixedSeconds * 1_000 + 300,
        item: { type: "agentMessage", id: "agent-final", text: "fake final response", phase: "final_answer", memoryCitation: null },
      },
    });
    sendTerminal("completed");
    return;
  }
  if (scenario === "firewall-short" || scenario === "firewall-large") {
    sendContentFlood();
    sendFirewallControlSequence();
    sendTerminal("completed", contentItems());
    return;
  }
  if (
    scenario === "interrupt" ||
    scenario === "interrupt-completed" ||
    scenario === "metadata-archived-readable" ||
    scenario === "metadata-closed-readable" ||
    scenario === "metadata-deleted" ||
    scenario === "metadata-malicious-turns" ||
    scenario === "metadata-malicious-items"
  ) {
    write({
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: fixedSeconds * 1_000 + 100,
        item: { type: "contextCompaction", id: "compaction-timeout" },
      },
    });
    if (scenario === "metadata-archived-readable") {
      write({ method: "thread/archived", params: { threadId } });
    } else if (scenario === "metadata-closed-readable") {
      write({ method: "thread/closed", params: { threadId } });
    } else if (scenario === "metadata-deleted") {
      write({ method: "thread/deleted", params: { threadId } });
    }
    return;
  }
  if (scenario === "reroute") {
    write({
      method: "model/rerouted",
      params: {
        threadId,
        turnId,
        fromModel: "gpt-5.6-sol",
        toModel: "another-model",
        reason: "fallback",
      },
    });
    return;
  }
  if (scenario === "malformed-compaction") {
    write({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: fixedSeconds * 1_000 + 100,
        item: { type: "contextCompaction", id: "missing-start" },
      },
    });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof protocolTracePath === "string" && message.method === "thread/read") {
    appendFileSync(
      protocolTracePath,
      `${JSON.stringify({
        method: message.method,
        includeTurns: message.params?.includeTurns,
      })}\n`,
      "utf8",
    );
  }
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
      JSON.stringify(capabilities?.optOutNotificationMethods) !== JSON.stringify(expectedContentNotificationOptOuts)
    ) {
      failure(message.id, "content notification opt-outs mismatch");
      return;
    }
    response(message.id, {
      userAgent: "fake-codex-app-server",
      codexHome: process.cwd(),
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform,
    });
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "exit") process.exit(17);
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
    response(message.id, {
      thread: thread(),
      instructionSources: [],
    });
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params;
    if (
      params.threadId !== threadId ||
      params.model !== "gpt-5.6-sol" ||
      params.effort !== "max" ||
      params.approvalPolicy !== "never" ||
      typeof params.cwd !== "string" ||
      params.input?.[0]?.type !== "text" ||
      "text_elements" in params.input[0]
    ) {
      failure(message.id, "unsafe turn/start parameters");
      return;
    }
    if (
      scenario === "production-write" &&
      params.input[0].text !==
        "设定goal：阅读checkpoint，实现S13-entry-fixture，完成后刷新checkpoint"
    ) {
      failure(message.id, "production goal prompt mismatch");
      return;
    }
    if (
      (scenario === "production-firewall-short" || scenario === "production-firewall-large") &&
      params.input[0].text !==
        "设定goal：阅读checkpoint，实现S14-firewall-fixture，完成后刷新checkpoint"
    ) {
      failure(message.id, "S14 production goal prompt mismatch");
      return;
    }
    activeCwd = params.cwd;
    response(message.id, { turn: turn("inProgress") });
    setImmediate(afterTurnStarted);
    return;
  }
  if (message.method === "turn/interrupt") {
    response(message.id, {});
    setImmediate(() => sendTerminal(scenario === "interrupt-completed" ? "completed" : "interrupted"));
    return;
  }
  if (message.method === "thread/read") {
    if (message.params?.threadId !== threadId || message.params?.includeTurns !== false) {
      failure(message.id, "thread/read must be summary-only");
      return;
    }
    if (scenario === "metadata-malicious-turns") {
      response(message.id, { thread: thread([turn(terminalStatus)]) });
      return;
    }
    if (scenario === "metadata-malicious-items") {
      response(message.id, { thread: { ...thread(), items: contentItems() } });
      return;
    }
    response(message.id, { thread: thread() });
    if (scenario === "probe-wait-complete") {
      setImmediate(() => sendTerminal("completed"));
    }
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
