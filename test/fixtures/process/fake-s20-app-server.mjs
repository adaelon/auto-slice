#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2] ?? "happy";
const tracePath = process.argv[3];
const skillPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "export-codex-handoff",
  "SKILL.md",
);
const helperPath = path.join(path.dirname(skillPath), "scripts", "export-handoff.mjs");
const compressionThreadId = "019fe6ab-0000-7000-8000-000000000520";
const compressionTurnId = "019fe6ab-0000-7000-8000-000000000521";
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

function trace(message) {
  if (typeof tracePath === "string") appendFileSync(tracePath, `${JSON.stringify(message)}\n`, "utf8");
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

function turn(status) {
  return {
    id: compressionTurnId,
    items: [],
    itemsView: "full",
    status,
    error: status === "failed" ? { message: "bounded fixture failure" } : null,
    startedAt: fixedSeconds,
    completedAt: status === "inProgress" ? null : fixedSeconds + 1,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

function commandText(argv) {
  return argv.map((entry) => JSON.stringify(entry)).join(" ");
}

function commandItem(id, command, cwd, execution) {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
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

function runHelper(args, cwd, helperScenario) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, S20_HELPER_SCENARIO: helperScenario },
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
}

function parsePrompt(text) {
  const match = /^\$export-codex-handoff ([0-9a-f-]{36}) Use continuation-map-v2\. Publish the Handoff Markdown to ("(?:\\.|[^"\\])*") and the Evidence Index to ("(?:\\.|[^"\\])*")\.$/u.exec(text);
  if (match === null) throw new Error("Compression prompt mismatch");
  return {
    sourceThreadId: match[1],
    markdownPath: JSON.parse(match[2]),
    evidenceIndexPath: JSON.parse(match[3]),
  };
}

function helperScenario() {
  if ([
    "source-changed",
    "single-file",
    "digest-tamper",
    "hardlink-pair",
    "consumer-tamper",
    "path-tamper",
    "verify-fail",
    "retain-workdir",
  ].includes(scenario)) return scenario;
  return "happy";
}

function completedNotification(threadId, item, offset) {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId: compressionTurnId,
      completedAtMs: fixedSeconds * 1_000 + offset,
      item,
    },
  };
}

function sendCompressionEvidence(params) {
  if (scenario === "final-message-only") {
    write(completedNotification(params.threadId, {
      type: "agentMessage",
      id: "s20-final-attack",
      text: JSON.stringify({ verify_evidence: "PASS", source_revision: "fake" }),
      phase: "final_answer",
      memoryCitation: null,
    }, 10));
    write({ method: "turn/completed", params: { threadId: params.threadId, turn: turn("completed") } });
    return;
  }

  const prompt = parsePrompt(params.input[0].text);
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
  const prepared = runHelper(prepareArgs, params.cwd, helperScenario());
  if (prepared.status !== 0) throw new Error("fixture prepare failed");
  const preparedValue = JSON.parse(prepared.stdout);
  const publishArgs = ["publish", preparedValue.workDir];
  const published = runHelper(publishArgs, params.cwd, helperScenario());

  let prepareCommand = commandText([process.execPath, helperPath, ...prepareArgs]);
  let publishCommand = commandText([process.execPath, helperPath, ...publishArgs]);
  if (scenario === "bare-node") {
    prepareCommand = commandText(["node", helperPath, ...prepareArgs]);
  }
  if (scenario === "combined-shell") prepareCommand = `${prepareCommand} & echo injected`;
  if (scenario === "default-output") {
    prepareCommand = commandText([
      process.execPath,
      helperPath,
      "prepare",
      prompt.sourceThreadId,
      "--map-result-mode",
      "continuation-map-v2",
    ]);
  }
  if (scenario === "workdir-swap") {
    publishCommand = commandText([
      process.execPath,
      helperPath,
      "publish",
      path.join(path.dirname(preparedValue.workDir), "codex-handoff-task-substituted"),
    ]);
  }
  let prepareItem = commandItem("s20-prepare", prepareCommand, params.cwd, prepared);
  const publishItem = commandItem("s20-publish", publishCommand, params.cwd, published);
  if (scenario === "malformed-prepare-output") {
    prepareItem = { ...prepareItem, aggregatedOutput: "{" };
  }
  if (scenario === "oversized-prepare-output") {
    prepareItem = {
      ...prepareItem,
      aggregatedOutput: JSON.stringify({ ...preparedValue, padding: "x".repeat(70 * 1024) }),
    };
  }
  const events = [
    completedNotification(params.threadId, prepareItem, 10),
    completedNotification(params.threadId, publishItem, 20),
  ];
  if (scenario === "missing-prepare") events.shift();
  if (scenario === "duplicate-prepare") events.splice(1, 0, events[0]);
  if (scenario === "out-of-order") events.reverse();
  if (scenario === "extra-echo") {
    events.splice(1, 0, completedNotification(params.threadId, {
      ...prepareItem,
      id: "s20-echo",
      command: "echo fake-frame",
      aggregatedOutput: JSON.stringify({ structuralDigest: `sha256:${"f".repeat(64)}` }),
    }, 15));
  }
  for (const event of events) write(event);
  write({
    method: "turn/completed",
    params: {
      threadId: params.threadId,
      turn: turn(published.status === 0 ? "completed" : "failed"),
    },
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
    response(message.id, { userAgent: "fake-s20-app-server" });
    return;
  }
  if (message.method === "skills/list") {
    const cwd = message.params?.cwds?.[0];
    const baseSkill = {
      name: "export-codex-handoff",
      description: "S20 fixture skill",
      path: scenario === "skill-path-relative" ? "relative/SKILL.md" : skillPath,
      scope: "user",
      enabled: scenario !== "skill-disabled",
    };
    const skills = scenario === "skill-missing"
      ? []
      : scenario === "skill-duplicate"
        ? [baseSkill, { ...baseSkill }]
        : [baseSkill];
    response(message.id, {
      data: [{
        cwd,
        skills,
        errors: scenario === "skill-errors" ? [{ path: skillPath, message: "fixture error" }] : [],
      }],
    });
    return;
  }
  if (message.method === "thread/start") {
    const params = message.params;
    if (
      params.serviceName !== "auto_slice_compression" ||
      params.model !== "gpt-5.6-sol" ||
      params.approvalPolicy !== "never" ||
      params.sandbox !== "workspace-write" ||
      params.ephemeral !== false
    ) {
      failure(message.id, "thread/start contract mismatch");
      return;
    }
    response(message.id, {
      thread: {
        id: compressionThreadId,
        sessionId: compressionThreadId,
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
    const params = message.params;
    if (
      params.threadId !== compressionThreadId ||
      params.model !== "gpt-5.6-sol" ||
      params.effort !== "medium" ||
      params.approvalPolicy !== "never" ||
      !Array.isArray(params.input) ||
      params.input.length !== 2 ||
      params.input[0]?.type !== "text" ||
      !Array.isArray(params.input[0]?.text_elements) ||
      params.input[1]?.type !== "skill" ||
      params.input[1]?.name !== "export-codex-handoff" ||
      path.resolve(params.input[1]?.path ?? "") !== path.resolve(skillPath) ||
      params.sandboxPolicy?.type !== "workspaceWrite" ||
      params.sandboxPolicy?.networkAccess !== false ||
      params.sandboxPolicy?.excludeTmpdirEnvVar !== false ||
      params.sandboxPolicy?.excludeSlashTmp !== false ||
      !Array.isArray(params.sandboxPolicy?.writableRoots) ||
      params.sandboxPolicy.writableRoots.length !== 1
    ) {
      failure(message.id, "turn/start contract mismatch");
      return;
    }
    response(message.id, { turn: turn("inProgress") });
    setImmediate(() => {
      try {
        sendCompressionEvidence(params);
      } catch {
        write({ method: "turn/completed", params: { threadId: params.threadId, turn: turn("failed") } });
      }
    });
    return;
  }
  failure(message.id, `unsupported method ${String(message.method)}`);
});
