#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

const tracePath = process.argv[2];
const childCommand = process.argv[3];
let childArgs;
try {
  childArgs = JSON.parse(process.argv[4] ?? "null");
} catch {
  childArgs = null;
}

if (
  typeof tracePath !== "string" ||
  tracePath.length === 0 ||
  typeof childCommand !== "string" ||
  childCommand.length === 0 ||
  !Array.isArray(childArgs) ||
  childArgs.some((entry) => typeof entry !== "string")
) {
  process.stderr.write("S22 App Server proxy received invalid argv.\n");
  process.exit(64);
}

const pending = new Map();
const threadRoles = new Map();
const turnRoles = new Map();

function trace(value) {
  appendFileSync(tracePath, `${JSON.stringify(value)}\n`, "utf8");
}

function roleForService(serviceName) {
  if (serviceName === "auto_slice") return "SOURCE";
  if (serviceName === "auto_slice_compression") return "COMPRESSION";
  if (serviceName === "auto_slice_continuation") return "CONTINUATION";
  return "UNKNOWN";
}

function inspectRequest(message) {
  if (
    (typeof message?.id === "number" || typeof message?.id === "string") &&
    typeof message.method === "string"
  ) {
    const serviceName = message.params?.serviceName;
    pending.set(message.id, {
      method: message.method,
      role: message.method === "thread/start"
        ? roleForService(serviceName)
        : threadRoles.get(message.params?.threadId),
    });
  }
  const params = message?.params ?? {};
  if (message?.method === "skills/list") {
    trace({ kind: "app_server_request", method: "skills/list", role: "COMPRESSION" });
    return;
  }
  if (message?.method === "thread/start") {
    trace({
      kind: "app_server_request",
      method: "thread/start",
      role: roleForService(params.serviceName),
      service_name: params.serviceName,
    });
    return;
  }
  if (["turn/start", "turn/interrupt", "thread/read"].includes(message?.method)) {
    trace({
      kind: "app_server_request",
      method: message.method,
      role: threadRoles.get(params.threadId) ?? "UNKNOWN",
      ...(message.method === "thread/read" ? { include_turns: params.includeTurns } : {}),
      ...(message.method === "turn/start" && params.sandboxPolicy?.type !== undefined
        ? { sandbox: params.sandboxPolicy.type }
        : {}),
    });
  }
}

function inspectOutput(message) {
  if (typeof message?.id === "number" || typeof message?.id === "string") {
    const request = pending.get(message.id);
    pending.delete(message.id);
    const threadId = message?.result?.thread?.id;
    if (
      request?.method === "thread/start" &&
      typeof request.role === "string" &&
      typeof threadId === "string"
    ) {
      threadRoles.set(threadId, request.role);
    }
    const turnId = message?.result?.turn?.id;
    if (
      request?.method === "turn/start" &&
      typeof request.role === "string" &&
      typeof turnId === "string"
    ) {
      turnRoles.set(turnId, request.role);
    }
    return;
  }
  if (message?.method === "turn/completed") {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    trace({
      kind: "turn_terminal",
      role: threadRoles.get(threadId) ?? turnRoles.get(turnId) ?? "UNKNOWN",
      status: message.params?.turn?.status ?? "UNKNOWN",
    });
    return;
  }
}

const child = spawn(childCommand, childArgs, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    inspectRequest(JSON.parse(line));
  } catch {
    // Forward malformed input unchanged; the real App Server owns protocol rejection.
  }
  child.stdin.write(`${line}\n`);
});
input.on("close", () => child.stdin.end());

const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
output.on("line", (line) => {
  try {
    inspectOutput(JSON.parse(line));
  } catch {
    // Never retain raw output in the trace.
  }
  process.stdout.write(`${line}\n`);
});

child.stderr.pipe(process.stderr);
child.once("error", (error) => {
  process.stderr.write(`S22 App Server proxy spawn failed: ${error.name}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  input.close();
  output.close();
  process.exitCode = code ?? (signal === null ? 1 : 128);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
