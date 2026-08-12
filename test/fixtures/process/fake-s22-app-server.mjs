#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const tracePath = process.argv[2];
const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "s22-export-codex-handoff",
);
const skillPath = path.join(fixtureRoot, "SKILL.md");
const helperPath = path.join(fixtureRoot, "scripts", "export-handoff.mjs");
const sourceThreadId = "019ff22a-0000-7000-8000-000000000001";
const sourceTurnId = "019ff22a-0000-7000-8000-000000000002";
const compressionThreadId = "019ff22a-0000-7000-8000-000000000003";
const compressionTurnId = "019ff22a-0000-7000-8000-000000000004";
const continuationThreadId = "019ff22a-0000-7000-8000-000000000005";
const continuationReadTurnId = "019ff22a-0000-7000-8000-000000000006";
const continuationWriteTurnId = "019ff22a-0000-7000-8000-000000000007";
const canary = "S22_HERMETIC_PRIVATE_CANARY";
const fixedSeconds = 1_786_449_600;
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

let continuationTurnCount = 0;

function trace(value) {
  if (typeof tracePath !== "string") return;
  appendFileSync(tracePath, `${JSON.stringify(value)}\n`, "utf8");
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

function roleForThread(threadId) {
  if (threadId === sourceThreadId) return "SOURCE";
  if (threadId === compressionThreadId) return "COMPRESSION";
  if (threadId === continuationThreadId) return "CONTINUATION";
  return "UNKNOWN";
}

function recordRequest(message) {
  const params = message.params ?? {};
  if (message.method === "skills/list") {
    trace({ kind: "app_server_request", method: message.method, role: "COMPRESSION" });
    return;
  }
  if (message.method === "thread/start") {
    const role = params.serviceName === "auto_slice"
      ? "SOURCE"
      : params.serviceName === "auto_slice_compression"
        ? "COMPRESSION"
        : params.serviceName === "auto_slice_continuation"
          ? "CONTINUATION"
          : "UNKNOWN";
    trace({ kind: "app_server_request", method: message.method, role, service_name: params.serviceName });
    return;
  }
  if (["turn/start", "turn/interrupt", "thread/read"].includes(message.method)) {
    trace({
      kind: "app_server_request",
      method: message.method,
      role: roleForThread(params.threadId),
      ...(message.method === "thread/read" ? { include_turns: params.includeTurns } : {}),
      ...(message.method === "turn/start" && params.sandboxPolicy?.type !== undefined
        ? { sandbox: params.sandboxPolicy.type }
        : {}),
    });
  }
}

function thread(id, cwd, active = true) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: canary,
    ephemeral: false,
    isPinned: false,
    modelProvider: "openai",
    createdAt: fixedSeconds,
    updatedAt: fixedSeconds + 1,
    recencyAt: fixedSeconds + 1,
    status: { type: active ? "active" : "idle" },
    path: `fake-s22-${id}.jsonl`,
    cwd,
    cliVersion: "0.146.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turn(id, status) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "bounded fixture failure" } : null,
    startedAt: fixedSeconds,
    completedAt: status === "inProgress" ? null : fixedSeconds + 1,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function completedItem(threadId, turnId, item, offset) {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: fixedSeconds * 1_000 + offset,
      item,
    },
  };
}

function commandText(argv) {
  return argv.map((entry) => JSON.stringify(entry)).join(" ");
}

function commandItem(id, argv, cwd, execution) {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: commandText(argv),
    cwd,
    processId: null,
    source: "agent",
    status: execution.status === 0 ? "completed" : "failed",
    commandActions: [],
    aggregatedOutput: execution.status === 0 ? execution.stdout : execution.stderr,
    exitCode: execution.status ?? 1,
    durationMs: 1,
  };
}

function parseCompressionPrompt(text) {
  const match = /^\$export-codex-handoff ([0-9a-f-]{36}) Use continuation-map-v2\. Publish the Handoff Markdown to ("(?:\\.|[^"\\])*") and the Evidence Index to ("(?:\\.|[^"\\])*")\. Complete the skill workflow and end the Turn only after both final files exist\.$/u.exec(text);
  if (match === null) throw new Error("Compression prompt mismatch");
  return {
    sourceThreadId: match[1],
    markdownPath: JSON.parse(match[2]),
    evidenceIndexPath: JSON.parse(match[3]),
  };
}

function runHelper(args, cwd) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
}

function sendSourceCompaction() {
  write({
    method: "item/agentMessage/delta",
    params: { threadId: sourceThreadId, turnId: sourceTurnId, delta: canary },
  });
  write(completedItem(sourceThreadId, sourceTurnId, {
    type: "agentMessage",
    id: "s22-source-private-content",
    text: canary,
    phase: "commentary",
    memoryCitation: null,
  }, 5));
  write({
    method: "item/started",
    params: {
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      item: { type: "contextCompaction", id: "s22-hermetic-compaction" },
    },
  });
}

function sendCompressionEvidence(params) {
  const prompt = parseCompressionPrompt(params.input[0].text);
  const prepareArgs = [
    "prepare",
    prompt.sourceThreadId,
    "--map-result-mode",
    "continuation-map-v2",
    "--output",
    prompt.markdownPath,
    "--evidence-index",
    prompt.evidenceIndexPath,
  ];
  const prepared = runHelper(prepareArgs, params.cwd);
  if (prepared.status !== 0) throw new Error("prepare failed");
  const preparedValue = JSON.parse(prepared.stdout);
  const publishArgs = ["publish", preparedValue.workDir];
  const published = runHelper(publishArgs, params.cwd);
  if (published.status !== 0) throw new Error("publish failed");
  write(completedItem(
    compressionThreadId,
    compressionTurnId,
    commandItem("s22-prepare", [process.execPath, helperPath, ...prepareArgs], params.cwd, prepared),
    10,
  ));
  write(completedItem(
    compressionThreadId,
    compressionTurnId,
    commandItem("s22-publish", [process.execPath, helperPath, ...publishArgs], params.cwd, published),
    20,
  ));
  write(completedItem(compressionThreadId, compressionTurnId, {
    type: "agentMessage",
    id: "s22-compression-final-result",
    text: [
      "Handoff 已发布，Evidence Index 完整性验证通过：",
      `[Handoff Markdown](${prompt.markdownPath.replaceAll("\\", "/")})`,
      `[Evidence Index](${prompt.evidenceIndexPath.replaceAll("\\", "/")})`,
    ].join("\n"),
    phase: "final_answer",
    memoryCitation: null,
  }, 30));
  write({
    method: "turn/completed",
    params: { threadId: compressionThreadId, turn: turn(compressionTurnId, "completed") },
  });
}

function sendContinuationReadTurn() {
  write(completedItem(continuationThreadId, continuationReadTurnId, {
    type: "agentMessage",
    id: "s22-continuation-first-draft",
    text: `${canary}: first substantive draft`,
    phase: "final_answer",
    memoryCitation: null,
  }, 30));
  write({
    method: "turn/completed",
    params: { threadId: continuationThreadId, turn: turn(continuationReadTurnId, "completed") },
  });
}

function sendContinuationWriteTurn() {
  write({
    method: "turn/completed",
    params: { threadId: continuationThreadId, turn: turn(continuationWriteTurnId, "completed") },
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  recordRequest(message);
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
    response(message.id, { userAgent: "fake-s22-app-server" });
    return;
  }
  if (message.method === "skills/list") {
    response(message.id, {
      data: [{
        cwd: message.params?.cwds?.[0],
        skills: [{
          name: "export-codex-handoff",
          description: "S22 hermetic fixture skill",
          path: skillPath,
          scope: "user",
          enabled: true,
        }],
        errors: [],
      }],
    });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params;
    if (params.serviceName === "auto_slice") {
      if (
        params.model !== "gpt-5.6-sol" ||
        params.approvalPolicy !== "never" ||
        params.sandbox !== "workspace-write" ||
        "ephemeral" in params
      ) {
        failure(message.id, "Source thread/start mismatch");
        return;
      }
      response(message.id, { thread: thread(sourceThreadId, params.cwd), instructionSources: [] });
      return;
    }
    if (params.serviceName === "auto_slice_compression") {
      if (params.sandbox !== "workspace-write" || params.ephemeral !== false) {
        failure(message.id, "Compression thread/start mismatch");
        return;
      }
      response(message.id, { thread: thread(compressionThreadId, params.cwd), instructionSources: [] });
      return;
    }
    if (params.serviceName === "auto_slice_continuation") {
      if (params.sandbox !== "read-only" || params.ephemeral !== false) {
        failure(message.id, "Continuation thread/start mismatch");
        return;
      }
      response(message.id, { thread: thread(continuationThreadId, params.cwd), instructionSources: [] });
      return;
    }
    failure(message.id, "unknown thread/start service");
    return;
  }
  if (message.method === "turn/start") {
    const params = message.params;
    if (params.threadId === sourceThreadId) {
      if (
        params.model !== "gpt-5.6-sol" ||
        params.effort !== "max" ||
        params.input?.[0]?.text !== "设定goal：阅读checkpoint，实现S22-HERMETIC，完成后刷新checkpoint"
      ) {
        failure(message.id, "Source turn/start mismatch");
        return;
      }
      response(message.id, { turn: turn(sourceTurnId, "inProgress") });
      setImmediate(sendSourceCompaction);
      return;
    }
    if (params.threadId === compressionThreadId) {
      if (
        params.input?.length !== 2 ||
        params.input?.[0]?.type !== "text" ||
        params.input?.[1]?.type !== "skill" ||
        params.sandboxPolicy?.type !== "workspaceWrite"
      ) {
        failure(message.id, "Compression turn/start mismatch");
        return;
      }
      response(message.id, { turn: turn(compressionTurnId, "inProgress") });
      setImmediate(() => {
        try {
          sendCompressionEvidence(params);
        } catch {
          write({
            method: "turn/completed",
            params: { threadId: compressionThreadId, turn: turn(compressionTurnId, "failed") },
          });
        }
      });
      return;
    }
    if (params.threadId === continuationThreadId) {
      continuationTurnCount += 1;
      if (continuationTurnCount === 1) {
        if (params.sandboxPolicy?.type !== "readOnly" || params.input?.length !== 2) {
          failure(message.id, "Continuation read Turn mismatch");
          return;
        }
        response(message.id, { turn: turn(continuationReadTurnId, "inProgress") });
        setImmediate(sendContinuationReadTurn);
        return;
      }
      if (continuationTurnCount === 2) {
        if (params.sandboxPolicy?.type !== "workspaceWrite" || params.input?.length !== 1) {
          failure(message.id, "Continuation write Turn mismatch");
          return;
        }
        response(message.id, { turn: turn(continuationWriteTurnId, "inProgress") });
        setImmediate(sendContinuationWriteTurn);
        return;
      }
      failure(message.id, "too many Continuation Turns");
      return;
    }
    failure(message.id, "unknown turn/start thread");
    return;
  }
  if (message.method === "turn/interrupt") {
    if (message.params?.threadId !== sourceThreadId || message.params?.turnId !== sourceTurnId) {
      failure(message.id, "Source interrupt identity mismatch");
      return;
    }
    response(message.id, {});
    setImmediate(() => write({
      method: "turn/completed",
      params: { threadId: sourceThreadId, turn: turn(sourceTurnId, "interrupted") },
    }));
    return;
  }
  if (message.method === "thread/read") {
    if (message.params?.threadId !== sourceThreadId || message.params?.includeTurns !== false) {
      failure(message.id, "Source summary read mismatch");
      return;
    }
    response(message.id, { thread: thread(sourceThreadId, process.cwd(), false) });
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
