#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import readline from "node:readline";

const scenario = process.argv[2] ?? "s19-happy";
const tracePath = process.argv[3];
const sourceThreadId = "019fe6ab-0000-7000-8000-000000000001";
const compressionThreadId = "019fe6ab-0000-7000-8000-000000000101";
const continuationThreadId = "019fe6ab-0000-7000-8000-000000000201";
const fixedSeconds = 1_786_363_200;
const privateCanary = "S19_PRIVATE_ITEM_CANARY";
const expectedOptOuts = [
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

let turnSequence = 0;

function trace(message) {
  if (typeof tracePath === "string") {
    appendFileSync(tracePath, `${JSON.stringify(message)}\n`, "utf8");
  }
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

function turnId() {
  turnSequence += 1;
  return `019fe6ab-0000-7000-8000-${String(turnSequence).padStart(12, "0")}`;
}

function turn(id, status, items = []) {
  return {
    id,
    items,
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "private failure body" } : null,
    startedAt: fixedSeconds,
    completedAt: status === "inProgress" ? null : fixedSeconds + 1,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function freshThread(id) {
  const value = {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    ephemeral: false,
    turns: [],
  };
  if (scenario === "s19-session-mismatch") value.sessionId = sourceThreadId;
  if (scenario === "s19-ephemeral") value.ephemeral = true;
  if (scenario === "s19-parent") value.parentThreadId = sourceThreadId;
  if (scenario === "s19-fork") value.forkedFromId = sourceThreadId;
  if (scenario === "s19-history") value.turns = [turn(turnId(), "completed")];
  return value;
}

function threadIdFor(params) {
  if (params.serviceName === "auto_slice") return sourceThreadId;
  if (scenario === "s19-duplicate-source") return sourceThreadId;
  if (scenario === "s19-invalid-uuid") return "not-a-canonical-uuid";
  if (params.serviceName === "auto_slice_compression") return compressionThreadId;
  if (scenario === "s19-duplicate-private") return compressionThreadId;
  if (params.serviceName === "auto_slice_continuation") return continuationThreadId;
  return null;
}

function sendPrivateTurn(threadId, activeTurnId) {
  const item = {
    type: "agentMessage",
    id: `private-item-${String(turnSequence)}`,
    text: scenario === "s19-oversized"
      ? `${privateCanary}:${"x".repeat(4 * 1024)}`
      : scenario === "s19-two-large-items"
        ? `${privateCanary}:${"x".repeat(300)}`
      : privateCanary,
    phase: "final_answer",
    memoryCitation: null,
  };
  const itemNotification = {
    method: "item/completed",
    params: {
      threadId,
      turnId: activeTurnId,
      completedAtMs: fixedSeconds * 1_000 + 500,
      item,
    },
  };
  const terminal = {
    method: "turn/completed",
    params: {
      threadId,
      turn: turn(activeTurnId, "completed", [item]),
    },
  };

  if (scenario === "s19-cross-turn") {
    itemNotification.params.turnId = "019fe6ab-0000-7000-8000-999999999999";
    write(itemNotification);
    return;
  }
  if (scenario === "s19-cross-thread") {
    itemNotification.params.threadId = sourceThreadId;
    write(itemNotification);
    return;
  }
  if (scenario === "s19-late-item") {
    write(terminal);
    write(itemNotification);
    return;
  }
  if (scenario === "s19-duplicate-terminal") {
    write(itemNotification);
    write(terminal);
    write(terminal);
    return;
  }
  if (scenario === "s19-two-large-items") {
    write(itemNotification);
    write({
      ...itemNotification,
      params: {
        ...itemNotification.params,
        completedAtMs: itemNotification.params.completedAtMs + 1,
        item: { ...item, id: `${item.id}-second` },
      },
    });
    write(terminal);
    return;
  }
  write(itemNotification);
  write(terminal);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  trace({ direction: "request", method: message.method, params: message.params ?? null });

  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities;
    if (
      capabilities?.experimentalApi !== false ||
      capabilities?.requestAttestation !== false ||
      JSON.stringify(capabilities?.optOutNotificationMethods) !== JSON.stringify(expectedOptOuts)
    ) {
      failure(message.id, "initialize capabilities mismatch");
      return;
    }
    response(message.id, { userAgent: "fake-s19-app-server" });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params;
    const id = threadIdFor(params);
    const isDevelopment = params.serviceName === "auto_slice";
    const expectedSandbox = params.serviceName === "auto_slice_continuation"
      ? "read-only"
      : "workspace-write";
    if (
      id === null ||
      params.model !== "gpt-5.6-sol" ||
      params.approvalPolicy !== "never" ||
      params.sandbox !== expectedSandbox ||
      (isDevelopment ? "ephemeral" in params : params.ephemeral !== false)
    ) {
      failure(message.id, "thread/start contract mismatch");
      return;
    }
    response(message.id, { thread: freshThread(id), instructionSources: [] });
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params;
    const id = turnId();
    const isDevelopment = params.threadId === sourceThreadId;
    if (
      params.model !== "gpt-5.6-sol" ||
      params.approvalPolicy !== "never" ||
      typeof params.cwd !== "string" ||
      !Array.isArray(params.input) ||
      params.input[0]?.type !== "text"
    ) {
      failure(message.id, "turn/start contract mismatch");
      return;
    }
    if (!isDevelopment && !Array.isArray(params.input[0].text_elements)) {
      failure(message.id, "private turn text_elements missing");
      return;
    }
    response(message.id, { turn: turn(id, "inProgress") });
    setImmediate(() => {
      if (isDevelopment) {
        write({
          method: "turn/completed",
          params: { threadId: sourceThreadId, turn: turn(id, "completed") },
        });
      } else if (scenario !== "s19-held") {
        sendPrivateTurn(params.threadId, id);
      }
    });
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
