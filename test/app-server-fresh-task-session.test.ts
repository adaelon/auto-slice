import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import {
  CodexAppServerClient,
  CodexAppServerFreshTaskSessions,
  CodexAppServerTaskHost,
  ProductionRuntimeError,
  type AppServerFreshTaskTurnRequest,
  type DevelopmentTaskRequest,
} from "../src/controller/production/index.js";
import { sha256Bytes } from "../src/controller/state/index.js";

const FIXTURE = path.resolve("test/fixtures/process/fake-s19-app-server.mjs");
const SOURCE_THREAD_ID = "019fe6ab-0000-7000-8000-000000000001";
const PRIVATE_CANARY = "S19_PRIVATE_ITEM_CANARY";

function developmentRequest(): DevelopmentTaskRequest {
  return {
    schema_version: 1,
    run_id: "run-s19-shared-client",
    slice_id: "S19",
    idempotency_key: sha256Bytes("s19-development-task"),
    workspace_identity: createWorkspaceIdentity(process.cwd()),
    lease_id: "lease-s19",
    write_epoch: 1,
    model_decision: {
      mode: "model",
      model: "gpt-5.6-sol",
      effort: "max",
    },
    prompt: "Implement the frozen S19 fixture.",
  };
}

function compressionTurn(): AppServerFreshTaskTurnRequest {
  return {
    input: [{ type: "text", text: "compression", text_elements: [] }],
    cwd: process.cwd(),
    sandbox_policy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    model: "gpt-5.6-sol",
    effort: "medium",
    project_completed_item_types: ["agentMessage"],
  };
}

function continuationTurn(): AppServerFreshTaskTurnRequest {
  return {
    input: [{ type: "text", text: "continuation", text_elements: [] }],
    cwd: process.cwd(),
    sandbox_policy: { type: "readOnly", networkAccess: false },
    model: "gpt-5.6-sol",
    effort: "max",
    project_completed_item_types: ["agentMessage"],
  };
}

function temporaryTrace(context: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s19-trace-"));
  const trace = path.join(root, "protocol.jsonl");
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return trace;
}

function readTrace(trace: string): readonly Readonly<Record<string, unknown>>[] {
  return readFileSync(trace, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
}

function privateRuntime(
  context: TestContext,
  scenario: string,
  limits: Readonly<{
    maximum_completed_item_bytes?: number;
    maximum_completed_items_per_turn?: number;
    maximum_turn_projection_bytes?: number;
    maximum_turns_per_session?: number;
  }> = {},
): {
  readonly client: CodexAppServerClient;
  readonly sessions: CodexAppServerFreshTaskSessions;
} {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FIXTURE, scenario],
    request_timeout_ms: 5_000,
  });
  const sessions = new CodexAppServerFreshTaskSessions(client, limits);
  context.after(async () => {
    sessions.dispose();
    await client.dispose();
  });
  return { client, sessions };
}

async function withFailureTimeout(
  failure: Promise<ProductionRuntimeError>,
): Promise<ProductionRuntimeError> {
  let rejectTimeout: (reason: Error) => void = () => undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    rejectTimeout(new Error("private router failure was not observed"));
  }, 2_000);
  try {
    return await Promise.race([failure, timeoutFailure]);
  } finally {
    clearTimeout(timeout);
  }
}

async function startCompression(
  sessions: CodexAppServerFreshTaskSessions,
) {
  return sessions.start({
    kind: "compression",
    source_thread_id: SOURCE_THREAD_ID,
    cwd: process.cwd(),
  });
}

void test("S19 Task Host shares one initialized client across three distinct fresh roots", async (context) => {
  const trace = temporaryTrace(context);
  const host = new CodexAppServerTaskHost({
    command: process.execPath,
    args: [FIXTURE, "s19-host-shared", trace],
    request_timeout_ms: 5_000,
  });

  const source = await host.development_tasks.start(developmentRequest());
  assert.ok(!(source instanceof ProductionRuntimeError));
  const sourceCompletion = await source.completion;
  assert.ok(!(sourceCompletion instanceof ProductionRuntimeError));

  const compression = await host.fresh_task_sessions.start({
    kind: "compression",
    source_thread_id: source.thread_id,
    cwd: process.cwd(),
  });
  assert.ok(!(compression instanceof ProductionRuntimeError));
  const compressionTurnHandle = await compression.startTurn(compressionTurn());
  assert.ok(!(compressionTurnHandle instanceof ProductionRuntimeError));
  const compressionTerminal = await compressionTurnHandle.completion;
  assert.ok(!(compressionTerminal instanceof ProductionRuntimeError));

  const continuation = await host.fresh_task_sessions.start({
    kind: "continuation",
    source_thread_id: source.thread_id,
    cwd: process.cwd(),
  });
  assert.ok(!(continuation instanceof ProductionRuntimeError));
  const continuationTurnHandle = await continuation.startTurn(continuationTurn());
  assert.ok(!(continuationTurnHandle instanceof ProductionRuntimeError));
  const continuationTerminal = await continuationTurnHandle.completion;
  assert.ok(!(continuationTerminal instanceof ProductionRuntimeError));

  assert.equal(new Set([
    source.thread_id,
    compression.thread_id,
    continuation.thread_id,
  ]).size, 3);
  assert.equal(compressionTerminal.completed_items[0]?.item.type, "agentMessage");
  assert.equal(continuationTerminal.completed_items[0]?.item.type, "agentMessage");

  const firstDispose = host.dispose();
  const secondDispose = host.dispose();
  assert.strictEqual(secondDispose, firstDispose);
  await firstDispose;

  const requests = readTrace(trace);
  assert.equal(requests.filter((entry) => entry.method === "initialize").length, 1);
  assert.equal(requests.filter((entry) => entry.method === "thread/start").length, 3);
  assert.equal(requests.some((entry) => entry.method === "thread/resume"), false);
  assert.equal(requests.some((entry) => entry.method === "thread/fork"), false);
  assert.equal(requests.some((entry) => entry.method === "turn/steer"), false);

  const starts = requests.filter((entry) => entry.method === "thread/start")
    .map((entry) => entry.params as Readonly<Record<string, unknown>>);
  assert.deepEqual(starts.map((entry) => [entry.serviceName, entry.sandbox, entry.ephemeral]), [
    ["auto_slice", "workspace-write", undefined],
    ["auto_slice_compression", "workspace-write", false],
    ["auto_slice_continuation", "read-only", false],
  ]);
});

void test("S19 allows terminal-delimited sequential Turns and rejects a second active Turn", async (context) => {
  const sequential = privateRuntime(context, "s19-happy");
  const session = await startCompression(sequential.sessions);
  assert.ok(!(session instanceof ProductionRuntimeError));

  const first = await session.startTurn(compressionTurn());
  assert.ok(!(first instanceof ProductionRuntimeError));
  const firstTerminal = await first.completion;
  assert.ok(!(firstTerminal instanceof ProductionRuntimeError));
  const second = await session.startTurn(compressionTurn());
  assert.ok(!(second instanceof ProductionRuntimeError));
  const secondTerminal = await second.completion;
  assert.ok(!(secondTerminal instanceof ProductionRuntimeError));
  assert.notEqual(first.turn_id, second.turn_id);

  const held = privateRuntime(context, "s19-held");
  const heldSession = await startCompression(held.sessions);
  assert.ok(!(heldSession instanceof ProductionRuntimeError));
  const active = await heldSession.startTurn(compressionTurn());
  assert.ok(!(active instanceof ProductionRuntimeError));
  const rejected = await heldSession.startTurn(compressionTurn());
  assert.ok(rejected instanceof ProductionRuntimeError);
  assert.equal(rejected.code, "app_server_protocol_error");
});

void test("S19 bounds total Turns per fresh session", async (context) => {
  const runtime = privateRuntime(context, "s19-happy", { maximum_turns_per_session: 1 });
  const session = await startCompression(runtime.sessions);
  assert.ok(!(session instanceof ProductionRuntimeError));
  const first = await session.startTurn(compressionTurn());
  assert.ok(!(first instanceof ProductionRuntimeError));
  assert.ok(!((await first.completion) instanceof ProductionRuntimeError));
  const rejected = await session.startTurn(compressionTurn());
  assert.ok(rejected instanceof ProductionRuntimeError);
  assert.equal(rejected.code, "app_server_protocol_error");
});

for (const scenario of [
  "s19-session-mismatch",
  "s19-ephemeral",
  "s19-parent",
  "s19-fork",
  "s19-history",
  "s19-duplicate-source",
  "s19-invalid-uuid",
] as const) {
  void test(`S19 rejects non-fresh root proof: ${scenario}`, async (context) => {
    const runtime = privateRuntime(context, scenario);
    const result = await startCompression(runtime.sessions);
    assert.ok(result instanceof ProductionRuntimeError);
    assert.equal(result.code, "app_server_protocol_error");
  });
}

void test("S19 rejects a fresh root reused by another private session", async (context) => {
  const runtime = privateRuntime(context, "s19-duplicate-private");
  const compression = await startCompression(runtime.sessions);
  assert.ok(!(compression instanceof ProductionRuntimeError));
  const continuation = await runtime.sessions.start({
    kind: "continuation",
    source_thread_id: SOURCE_THREAD_ID,
    cwd: process.cwd(),
  });
  assert.ok(continuation instanceof ProductionRuntimeError);
  assert.equal(continuation.code, "app_server_protocol_error");
});

for (const scenario of [
  "s19-cross-turn",
  "s19-cross-thread",
  "s19-late-item",
  "s19-duplicate-terminal",
  "s19-oversized",
] as const) {
  void test(`S19 private router fails closed without leaking raw content: ${scenario}`, async (context) => {
    const runtime = privateRuntime(
      context,
      scenario,
      scenario === "s19-oversized" ? { maximum_completed_item_bytes: 256 } : {},
    );
    let resolveFailure: (error: ProductionRuntimeError) => void = () => undefined;
    const failure = new Promise<ProductionRuntimeError>((resolve) => {
      resolveFailure = resolve;
    });
    const signals: unknown[] = [];
    const unsubscribe = runtime.client.subscribe(
      (signal) => {
        signals.push(signal);
      },
      (error) => {
        resolveFailure(error);
      },
    );
    context.after(unsubscribe);

    const session = await startCompression(runtime.sessions);
    assert.ok(!(session instanceof ProductionRuntimeError));
    const handle = await session.startTurn(compressionTurn());
    if (!(handle instanceof ProductionRuntimeError)) {
      await handle.completion;
    }
    const error = await withFailureTimeout(failure);
    assert.equal(error.code, "app_server_protocol_error");
    assert.equal(JSON.stringify(error.toJSON()).includes(PRIVATE_CANARY), false);
    assert.equal(JSON.stringify(signals).includes(PRIVATE_CANARY), false);
  });
}

void test("S19 private completed items stay private from Controller listeners", async (context) => {
  const runtime = privateRuntime(context, "s19-happy");
  const signals: unknown[] = [];
  const unsubscribe = runtime.client.subscribe(
    (signal) => signals.push(signal),
    () => undefined,
  );
  context.after(unsubscribe);

  const session = await startCompression(runtime.sessions);
  assert.ok(!(session instanceof ProductionRuntimeError));
  const handle = await session.startTurn(compressionTurn());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const terminal = await handle.completion;
  assert.ok(!(terminal instanceof ProductionRuntimeError));
  assert.equal(
    terminal.completed_items.some((entry) =>
      entry.item.type === "agentMessage" && entry.item.text === PRIVATE_CANARY
    ),
    true,
  );
  assert.deepEqual(signals, []);
});

void test("S19 private projector drops completed item types outside its per-Turn allowlist", async (context) => {
  const runtime = privateRuntime(context, "s19-happy");
  const session = await startCompression(runtime.sessions);
  assert.ok(!(session instanceof ProductionRuntimeError));
  const request = { ...compressionTurn(), project_completed_item_types: [] } as const;
  const handle = await session.startTurn(request);
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const terminal = await handle.completion;
  assert.ok(!(terminal instanceof ProductionRuntimeError));
  assert.deepEqual(terminal.completed_items, []);
});

for (const [label, limits] of [
  ["completed item count", { maximum_completed_items_per_turn: 1 }],
  [
    "aggregate Turn bytes",
    {
      maximum_completed_item_bytes: 512,
      maximum_turn_projection_bytes: 600,
    },
  ],
] as const) {
  void test(`S19 private projector enforces its ${label} bound`, async (context) => {
    const runtime = privateRuntime(context, "s19-two-large-items", limits);
    let resolveFailure: (error: ProductionRuntimeError) => void = () => undefined;
    const failure = new Promise<ProductionRuntimeError>((resolve) => {
      resolveFailure = resolve;
    });
    const unsubscribe = runtime.client.subscribe(
      () => undefined,
      (error) => {
        resolveFailure(error);
      },
    );
    context.after(unsubscribe);
    const session = await startCompression(runtime.sessions);
    assert.ok(!(session instanceof ProductionRuntimeError));
    const handle = await session.startTurn(compressionTurn());
    if (!(handle instanceof ProductionRuntimeError)) await handle.completion;
    const error = await withFailureTimeout(failure);
    assert.equal(error.code, "app_server_protocol_error");
    assert.equal(JSON.stringify(error.toJSON()).includes(PRIVATE_CANARY), false);
  });
}
