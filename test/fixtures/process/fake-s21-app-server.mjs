#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import readline from "node:readline";

const scenario = process.argv[2] ?? "happy";
const tracePath = process.argv[3];
const continuationThreadId = "019fe6ab-0000-7000-8000-000000000621";
const readTurnId = "019fe6ab-0000-7000-8000-000000000622";
const writeTurnId = "019fe6ab-0000-7000-8000-000000000623";
const fixedSeconds = 1_786_363_200;
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

let turnStartCount = 0;

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

function turn(id, status) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "bounded fixture failure" } : null,
    startedAt: fixedSeconds,
    completedAt: status === "inProgress" ? null : fixedSeconds + turnStartCount,
    durationMs: status === "inProgress" ? null : turnStartCount * 1_000,
  };
}

function completedItem(turnId, item, offset) {
  return {
    method: "item/completed",
    params: {
      threadId: continuationThreadId,
      turnId,
      completedAtMs: fixedSeconds * 1_000 + offset,
      item,
    },
  };
}

function agentMessage(text) {
  return {
    type: "agentMessage",
    id: "s21-first-substantive-draft",
    text,
    phase: "final_answer",
    memoryCitation: null,
  };
}

function commandItem() {
  return {
    type: "commandExecution",
    id: "s21-tool-before-draft",
    pluginId: null,
    scriptPath: null,
    command: "echo forbidden",
    cwd: process.cwd(),
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: "forbidden",
    exitCode: 0,
    durationMs: 1,
  };
}

function sendReadTurn() {
  if (scenario === "tool-before-draft") {
    write(completedItem(readTurnId, commandItem(), 10));
  }
  if (scenario !== "no-draft") {
    const text = scenario === "model-receipt"
      ? JSON.stringify({
        task_id: "model-forged-task",
        ready: true,
        write_access: true,
        first_deliverable_draft_digest: `sha256:${"f".repeat(64)}`,
      })
      : "S21 first substantive draft";
    write(completedItem(readTurnId, agentMessage(text), 20));
  }
  const status = scenario === "non-terminal-first" ? "interrupted" : "completed";
  write({
    method: "turn/completed",
    params: { threadId: continuationThreadId, turn: turn(readTurnId, status) },
  });
}

function sendWriteTurn() {
  const status = scenario === "write-turn-failed" ? "failed" : "completed";
  write({
    method: "turn/completed",
    params: { threadId: continuationThreadId, turn: turn(writeTurnId, status) },
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  trace({ direction: "request", method: message.method, params: message.params ?? null });

  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    if (
      message.params?.capabilities?.experimentalApi !== false ||
      message.params?.capabilities?.requestAttestation !== false ||
      JSON.stringify(message.params?.capabilities?.optOutNotificationMethods) !== JSON.stringify(expectedOptOuts)
    ) {
      failure(message.id, "initialize capabilities mismatch");
      return;
    }
    response(message.id, { userAgent: "fake-s21-app-server" });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params;
    if (
      params.serviceName !== "auto_slice_continuation" ||
      params.model !== "gpt-5.6-sol" ||
      params.approvalPolicy !== "never" ||
      params.sandbox !== "read-only" ||
      params.ephemeral !== false
    ) {
      failure(message.id, "thread/start contract mismatch");
      return;
    }
    response(message.id, {
      thread: {
        id: continuationThreadId,
        sessionId: continuationThreadId,
        forkedFromId: null,
        parentThreadId: null,
        ephemeral: false,
        turns: [],
      },
      instructionSources: [],
    });
    return;
  }
  if (message.method === "turn/start") {
    turnStartCount += 1;
    const params = message.params;
    if (turnStartCount === 1) {
      if (
        params.threadId !== continuationThreadId ||
        params.model !== "gpt-5.6-sol" ||
        params.effort !== "max" ||
        params.approvalPolicy !== "never" ||
        !Array.isArray(params.input) ||
        params.input.length !== 2 ||
        params.input.some((entry) => entry?.type !== "text" || !Array.isArray(entry?.text_elements)) ||
        !params.input[0].text.includes("synthesize-first") ||
        !params.input[1].text.includes("BEGIN VERIFIED HANDOFF") ||
        !params.input[1].text.includes("workflow: handoff-v2") ||
        params.sandboxPolicy?.type !== "readOnly" ||
        params.sandboxPolicy?.networkAccess !== false
      ) {
        failure(message.id, "read turn contract mismatch");
        return;
      }
      response(message.id, { turn: turn(readTurnId, "inProgress") });
      setImmediate(sendReadTurn);
      return;
    }
    if (turnStartCount === 2) {
      if (
        params.threadId !== continuationThreadId ||
        params.model !== "gpt-5.6-sol" ||
        params.effort !== "max" ||
        params.approvalPolicy !== "never" ||
        !Array.isArray(params.input) ||
        params.input.length !== 1 ||
        params.input[0]?.type !== "text" ||
        !Array.isArray(params.input[0]?.text_elements) ||
        !/write_epoch=\d+/u.test(params.input[0].text) ||
        params.sandboxPolicy?.type !== "workspaceWrite" ||
        params.sandboxPolicy?.networkAccess !== false ||
        params.sandboxPolicy?.excludeTmpdirEnvVar !== false ||
        params.sandboxPolicy?.excludeSlashTmp !== false ||
        !Array.isArray(params.sandboxPolicy?.writableRoots) ||
        params.sandboxPolicy.writableRoots.length !== 0
      ) {
        failure(message.id, "write turn contract mismatch");
        return;
      }
      response(message.id, { turn: turn(writeTurnId, "inProgress") });
      setImmediate(sendWriteTurn);
      return;
    }
    failure(message.id, "too many continuation turns");
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
