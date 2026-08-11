import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS,
  CodexAppServerClient,
  DROP,
  HostEventFirewall,
  ProductionRuntimeError,
} from "../src/controller/production/index.js";

const EXPECTED_CONTENT_NOTIFICATION_OPT_OUTS = [
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
] as const;

const FAKE_NPM_CODEX_SOURCE = `
import readline from "node:readline";

const expectedOptOuts = ${JSON.stringify([
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
])};

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server", "--listen", "stdio://"])) {
  process.exit(64);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities;
    if (
      capabilities?.experimentalApi !== false ||
      capabilities?.requestAttestation !== false ||
      JSON.stringify(capabilities?.optOutNotificationMethods) !== JSON.stringify(expectedOptOuts)
    ) {
      process.exit(65);
    }
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { userAgent: "fake-npm-codex" },
    }) + "\\n");
  }
});
`;

function fakeNpmBin(context: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-npm-codex-"));
  const cliPath = path.join(
    root,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  mkdirSync(path.dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, FAKE_NPM_CODEX_SOURCE, "utf8");
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

void test("default App Server launch uses npm Codex and exact Worker Content notification opt-outs", async (context) => {
  assert.deepEqual(APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS, EXPECTED_CONTENT_NOTIFICATION_OPT_OUTS);
  const npmBin = fakeNpmBin(context);
  const previousPath = process.env.PATH;
  process.env.PATH = npmBin;
  context.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  });

  const client = new CodexAppServerClient({ request_timeout_ms: 5_000 });
  context.after(() => client.dispose());

  assert.equal(await client.initialize(), null);
});

void test("HostEventFirewall projects fresh control DTOs and drops Worker Content", () => {
  const firewall = new HostEventFirewall({
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  firewall.registerTask({
    run_id: "run-s14",
    slice_id: "S14",
    thread_id: "thread-s14",
    started_at: "2026-08-10T11:59:00.000Z",
  });
  firewall.registerTurn("thread-s14", "turn-s14");

  const canary = "S14_MESSAGE_CANARY";
  assert.equal(firewall.project({
    method: "item/completed",
    params: {
      threadId: "thread-s14",
      turnId: "turn-s14",
      item: { id: "message-1", type: "agentMessage", text: canary },
    },
  }), DROP);

  assert.deepEqual(firewall.project({
    method: "item/started",
    params: {
      threadId: "thread-s14",
      turnId: "turn-s14",
      item: { id: "compaction-1", type: "contextCompaction", ignored: canary },
    },
  }), {
    type: "COMPACTION",
    phase: "STARTED",
    thread_id: "thread-s14",
    compaction_id: "compaction-1",
    host_sequence: 1,
    observed_at: "2026-08-10T12:00:00.000Z",
  });

  const terminal = firewall.project({
    method: "turn/completed",
    params: {
      threadId: "thread-s14",
      turn: {
        id: "turn-s14",
        status: "completed",
        startedAt: 1_786_363_140,
        completedAt: 1_786_363_200,
        items: [{ id: "message-1", type: "agentMessage", text: canary }],
      },
    },
  });
  assert.deepEqual(terminal, {
    type: "TURN_TERMINAL",
    run_id: "run-s14",
    slice_id: "S14",
    thread_id: "thread-s14",
    turn_id: "turn-s14",
    outcome: "COMPLETED",
    started_at: "2026-08-10T11:59:00.000Z",
    completed_at: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(terminal).includes(canary), false);
});

void test("App Server Host compaction capability defaults to events and accepts explicit unavailability", () => {
  const eventClient = new CodexAppServerClient();
  assert.deepEqual(eventClient.hostCapabilities(), {
    context_compaction_events: "AVAILABLE",
  });

  const probeClient = new CodexAppServerClient({
    host_capabilities: { context_compaction_events: "UNAVAILABLE" },
  });
  assert.deepEqual(probeClient.hostCapabilities(), {
    context_compaction_events: "UNAVAILABLE",
  });
});

void test("synchronous App Server spawn failures use the spawn failure code", async (context) => {
  const client = new CodexAppServerClient({ command: "\0" });
  context.after(() => client.dispose());

  const result = await client.initialize();
  assert.ok(result instanceof ProductionRuntimeError);
  assert.equal(result.code, "app_server_spawn_failed");
});
