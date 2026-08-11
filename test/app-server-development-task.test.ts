import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import type { DeadlineScheduler } from "../src/controller/compaction-monitor/index.js";
import {
  CodexAppServerDevelopmentTask,
  type CodexAppServerDevelopmentTaskOptions,
  type CompactionContentProbePort,
  type CompactionProbeResult,
  ProductionRuntimeError,
  type DevelopmentTaskRequest,
} from "../src/controller/production/index.js";
import { sha256Bytes } from "../src/controller/state/index.js";

const FIXTURE = path.resolve("test/fixtures/process/fake-codex-app-server.mjs");
const FIXED_TIME = "2026-08-09T12:00:10.000Z";
const MINUTE_MS = 60_000;
const CONTENT_CANARIES = [
  "S14_MESSAGE_CANARY",
  "S14_REASONING_CANARY",
  "S14_COMMAND_CANARY",
  "S14_DIFF_CANARY",
  "S14_TOOL_CANARY",
  "S14_PLAN_CANARY",
] as const;

class ProbeClock {
  private readonly origin = Date.parse(FIXED_TIME);
  private current = this.origin;

  public now(): Date {
    return new Date(this.current);
  }

  public setElapsed(elapsedMs: number): void {
    this.current = this.origin + elapsedMs;
  }
}

interface ProbeJob {
  readonly deadline: Date;
  readonly callback: () => void;
}

class ProbeScheduler implements DeadlineScheduler {
  private readonly jobs = new Map<string, ProbeJob>();

  public constructor(private readonly clock: ProbeClock) {}

  public schedule(key: string, deadline: Date, callback: () => void): void {
    this.jobs.set(key, { deadline: new Date(deadline), callback });
  }

  public cancel(key: string): void {
    this.jobs.delete(key);
  }

  public size(): number {
    return this.jobs.size;
  }

  public advanceToElapsed(elapsedMs: number): void {
    this.clock.setElapsed(elapsedMs);
    const now = this.clock.now().getTime();
    const due = [...this.jobs.entries()]
      .filter(([, job]) => job.deadline.getTime() <= now)
      .sort((left, right) => left[1].deadline.getTime() - right[1].deadline.getTime());
    for (const [key, job] of due) {
      this.jobs.delete(key);
      job.callback();
    }
  }
}

async function settleProbe(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function probeRuntime(
  context: TestContext,
  probe: CompactionContentProbePort,
  capability: "AVAILABLE" | "UNAVAILABLE" = "UNAVAILABLE",
  scenario: "probe-wait" | "probe-wait-complete" = "probe-wait",
): {
  readonly adapter: CodexAppServerDevelopmentTask;
  readonly scheduler: ProbeScheduler;
} {
  const clock = new ProbeClock();
  const scheduler = new ProbeScheduler(clock);
  const adapter = new CodexAppServerDevelopmentTask({
    command: process.execPath,
    args: [FIXTURE, scenario],
    now: () => clock.now(),
    request_timeout_ms: 5_000,
    host_capabilities: { context_compaction_events: capability },
    compaction_content_probe: probe,
    compaction_probe_scheduler: scheduler,
  });
  context.after(() => adapter.dispose());
  return { adapter, scheduler };
}

function runtime(
  context: TestContext,
  scenario: string,
): CodexAppServerDevelopmentTask {
  const options = {
    command: process.execPath,
    args: [FIXTURE, scenario],
    now: () => new Date(FIXED_TIME),
    request_timeout_ms: 5_000,
  } as CodexAppServerDevelopmentTaskOptions;
  const adapter = new CodexAppServerDevelopmentTask(options);
  context.after(() => adapter.dispose());
  return adapter;
}

async function startInterruptible(
  adapter: CodexAppServerDevelopmentTask,
): Promise<{ readonly thread_id: string; readonly turn_id: string }> {
  const handle = await adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const iterator = handle.events[Symbol.asyncIterator]();
  const started = await iterator.next();
  assert.equal(started.done, false);
  assert.equal(started.value.type, "AUTO_COMPACTION_STARTED");
  return handle;
}

function request(): DevelopmentTaskRequest {
  return {
    schema_version: 1,
    run_id: "run-app-server-test",
    slice_id: "S13-app-server",
    idempotency_key: sha256Bytes("development-task"),
    workspace_identity: createWorkspaceIdentity(process.cwd()),
    lease_id: "lease-app-server-test",
    write_epoch: 1,
    model_decision: {
      mode: "model",
      model: "gpt-5.6-sol",
      effort: "max",
    },
    prompt: "Implement the frozen test Slice.",
  };
}

void test("App Server adapter starts a persistent exact-model turn and normalizes compaction events", async (context) => {
  const adapter = runtime(context, "happy");
  const handle = await adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const events = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  const receipt = await handle.completion;
  assert.ok(!(receipt instanceof ProductionRuntimeError));
  assert.equal(receipt.outcome, "COMPLETED");
  assert.equal("final_response_digest" in receipt, false);
  assert.deepEqual(events.map((event) => ({
    type: event.type,
    compaction_id: event.compaction_id,
    host_sequence: event.host_sequence,
  })), [
    { type: "AUTO_COMPACTION_STARTED", compaction_id: "compaction-1", host_sequence: 1 },
    { type: "AUTO_COMPACTION_COMPLETED", compaction_id: "compaction-1", host_sequence: 2 },
  ]);
});

void test("fallback probe follows 20/30/35/40/42 cadence and terminal cancellation", async (context) => {
  const calls: number[] = [];
  const fixture = probeRuntime(context, {
    probe(_threadId, _turnId, elapsedMs) {
      calls.push(elapsedMs);
      return Promise.resolve({ kind: "NO_COMPACTION" });
    },
  });
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));

  for (const [elapsedMs, expectedCalls] of [
    [19 * MINUTE_MS + 59_000, []],
    [20 * MINUTE_MS, [20 * MINUTE_MS]],
    [29 * MINUTE_MS + 59_000, [20 * MINUTE_MS]],
    [30 * MINUTE_MS, [20, 30].map((minutes) => minutes * MINUTE_MS)],
    [35 * MINUTE_MS, [20, 30, 35].map((minutes) => minutes * MINUTE_MS)],
    [40 * MINUTE_MS, [20, 30, 35, 40].map((minutes) => minutes * MINUTE_MS)],
    [42 * MINUTE_MS, [20, 30, 35, 40, 42].map((minutes) => minutes * MINUTE_MS)],
  ] as const) {
    fixture.scheduler.advanceToElapsed(elapsedMs);
    await settleProbe();
    assert.deepEqual(calls, expectedCalls);
  }

  await fixture.adapter.interrupt(handle.thread_id, sha256Bytes("probe-cadence-stop"));
  fixture.scheduler.advanceToElapsed(44 * MINUTE_MS);
  await settleProbe();
  assert.deepEqual(calls, [20, 30, 35, 40, 42].map((minutes) => minutes * MINUTE_MS));
  assert.equal(fixture.scheduler.size(), 0);
});

void test("structured compaction capability keeps the content probe at zero calls", async (context) => {
  let calls = 0;
  const fixture = probeRuntime(context, {
    probe() {
      calls += 1;
      return Promise.resolve({ kind: "NO_COMPACTION" });
    },
  }, "AVAILABLE");
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));

  fixture.scheduler.advanceToElapsed(42 * MINUTE_MS);
  await settleProbe();
  assert.equal(calls, 0);
  assert.equal(fixture.scheduler.size(), 0);
  await fixture.adapter.interrupt(handle.thread_id, sha256Bytes("event-capability-stop"));
});

void test("fallback probe allows only one in-flight content read", async (context) => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let resolveFirst: ((result: CompactionProbeResult) => void) | undefined;
  const fixture = probeRuntime(context, {
    probe() {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const result = calls === 1
        ? new Promise<CompactionProbeResult>((resolve) => {
          resolveFirst = resolve;
        })
        : Promise.resolve<CompactionProbeResult>({ kind: "NO_COMPACTION" });
      return result.finally(() => {
        active -= 1;
      });
    },
  });
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));

  fixture.scheduler.advanceToElapsed(20 * MINUTE_MS);
  await settleProbe();
  fixture.scheduler.advanceToElapsed(40 * MINUTE_MS);
  await settleProbe();
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);

  assert.ok(resolveFirst !== undefined);
  resolveFirst({ kind: "NO_COMPACTION" });
  await settleProbe();
  fixture.scheduler.advanceToElapsed(42 * MINUTE_MS);
  await settleProbe();
  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  await fixture.adapter.interrupt(handle.thread_id, sha256Bytes("single-probe-stop"));
});

async function captureProbedCompaction(
  context: TestContext,
  privateContent: string,
  interruptKey: string,
): Promise<unknown> {
  const fixture = probeRuntime(context, {
    probe() {
      assert.ok(Buffer.byteLength(privateContent, "utf8") > 0);
      return Promise.resolve({
        kind: "COMPACTION_SEEN",
        observedAt: new Date(Date.parse(FIXED_TIME) + 20 * MINUTE_MS).toISOString(),
      });
    },
  });
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const iterator = handle.events[Symbol.asyncIterator]();
  fixture.scheduler.advanceToElapsed(20 * MINUTE_MS);
  await settleProbe();
  const event = await iterator.next();
  assert.equal(event.done, false);
  await fixture.adapter.interrupt(handle.thread_id, sha256Bytes(interruptKey));
  return event.value;
}

void test("short and large private probe content yield the same canary-free compaction DTO", async (context) => {
  const canary = "S_PROBE_PRIVATE_CONTENT_CANARY";
  const short = await captureProbedCompaction(context, canary, "probe-short-stop");
  const large = await captureProbedCompaction(
    context,
    `${canary}:${"x".repeat(96 * 1024)}`,
    "probe-large-stop",
  );
  assert.deepEqual(large, short);
  assert.equal(JSON.stringify(short).includes(canary), false);
});

void test("a terminal turn cancels probing and closes a probed compaction before queue shutdown", async (context) => {
  const observedAt = new Date(Date.parse(FIXED_TIME) + 500).toISOString();
  const fixture = probeRuntime(context, {
    probe() {
      return Promise.resolve({ kind: "COMPACTION_SEEN", observedAt });
    },
  }, "UNAVAILABLE", "probe-wait-complete");
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const iterator = handle.events[Symbol.asyncIterator]();

  fixture.scheduler.advanceToElapsed(20 * MINUTE_MS);
  await settleProbe();
  const started = await iterator.next();
  assert.equal(started.done, false);
  assert.equal(started.value.type, "AUTO_COMPACTION_STARTED");

  await fixture.adapter.inspect(handle.thread_id);
  const completed = await iterator.next();
  assert.equal(completed.done, false);
  assert.equal(completed.value.type, "AUTO_COMPACTION_COMPLETED");
  assert.equal(completed.value.compaction_id, started.value.compaction_id);
  assert.equal(completed.value.host_sequence, 2);
  const terminal = await handle.completion;
  assert.ok(!(terminal instanceof ProductionRuntimeError));
  assert.equal(terminal.outcome, "COMPLETED");
  fixture.scheduler.advanceToElapsed(42 * MINUTE_MS);
  assert.equal(fixture.scheduler.size(), 0);
});

void test("malformed probe failure reasons close without leaking private content", async (context) => {
  const canary = "S_PROBE_FAILURE_CONTENT_CANARY";
  const probe = {
    probe: () => Promise.resolve({
      kind: "PROBE_FAILED",
      reasonCode: canary,
    }),
  } as unknown as CompactionContentProbePort;
  const fixture = probeRuntime(context, probe);
  const handle = await fixture.adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));

  fixture.scheduler.advanceToElapsed(20 * MINUTE_MS);
  const terminal = await handle.completion;
  assert.ok(terminal instanceof ProductionRuntimeError);
  assert.equal(terminal.code, "compaction_probe_failed");
  assert.equal(JSON.stringify(terminal.toJSON()).includes(canary), false);
});

async function captureContentScenario(
  context: TestContext,
  scenario: "firewall-short" | "firewall-large",
): Promise<Readonly<Record<string, unknown>>> {
  const adapter = runtime(context, scenario);
  const handle = await adapter.start(request());
  assert.ok(!(handle instanceof ProductionRuntimeError));
  const events = [];
  for await (const event of handle.events) {
    events.push(event);
  }
  const receipt = await handle.completion;
  assert.ok(!(receipt instanceof ProductionRuntimeError));
  return { events, receipt };
}

void test("App Server firewall makes short and large Worker Content byte-equivalent and canary-free", async (context) => {
  const short = await captureContentScenario(context, "firewall-short");
  const large = await captureContentScenario(context, "firewall-large");
  assert.deepEqual(large, short);
  const serialized = JSON.stringify(short);
  for (const canary of CONTENT_CANARIES) {
    assert.equal(serialized.includes(canary), false, canary);
  }
  const receipt = short.receipt as Readonly<Record<string, unknown>>;
  assert.equal("final_response_digest" in receipt, false);
});

void test("App Server adapter interrupts and independently re-reads a persisted Source Thread", async (context) => {
  const adapter = runtime(context, "interrupt");
  const handle = await startInterruptible(adapter);
  const interrupt = await adapter.interrupt(handle.thread_id, sha256Bytes("interrupt-once"));
  assert.deepEqual(interrupt, {
    thread_id: handle.thread_id,
    turn_id: handle.turn_id,
    terminal_status: "interrupted",
    execution_stopped: true,
    thread_persisted: true,
    observed_at: FIXED_TIME,
  });
  const repeated = await adapter.interrupt(handle.thread_id, sha256Bytes("interrupt-once"));
  assert.deepEqual(repeated, interrupt);
  const inspection = await adapter.inspect(handle.thread_id) as {
    thread_id: string;
    readable: boolean;
    persistent: boolean;
  };
  assert.deepEqual(inspection, {
    thread_id: handle.thread_id,
    readable: true,
    persistent: true,
    observed_at: FIXED_TIME,
  });
});

void test("App Server adapter rejects a completed terminal after turn/interrupt was accepted", async (context) => {
  const adapter = runtime(context, "interrupt-completed");
  const handle = await startInterruptible(adapter);

  await assert.rejects(
    adapter.interrupt(handle.thread_id, sha256Bytes("completed-not-interrupted")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { readonly reason?: string }).reason, "interrupt_receipt_invalid");
      return true;
    },
  );
});

for (const scenario of ["metadata-archived-readable", "metadata-closed-readable"] as const) {
  void test(`App Server summary-only read decides persistence after ${scenario}`, async (context) => {
    const adapter = runtime(context, scenario);
    const handle = await startInterruptible(adapter);
    await adapter.interrupt(handle.thread_id, sha256Bytes(`interrupt-${scenario}`));

    const inspection = await adapter.inspect(handle.thread_id) as Readonly<Record<string, unknown>>;
    assert.equal(inspection.thread_id, handle.thread_id);
    assert.equal(inspection.persistent, true);
    assert.equal("archived" in inspection, false);
    assert.equal("deleted" in inspection, false);
  });
}

void test("App Server summary-only inspection rejects an observed delete without reading content", async (context) => {
  const adapter = runtime(context, "metadata-deleted");
  const handle = await startInterruptible(adapter);
  await adapter.interrupt(handle.thread_id, sha256Bytes("interrupt-metadata-deleted"));
  await assert.rejects(adapter.inspect(handle.thread_id), ProductionRuntimeError);
});

for (const scenario of ["metadata-malicious-turns", "metadata-malicious-items"] as const) {
  void test(`App Server summary-only inspection rejects ${scenario}`, async (context) => {
    const adapter = runtime(context, scenario);
    const handle = await startInterruptible(adapter);
    await adapter.interrupt(handle.thread_id, sha256Bytes(`interrupt-${scenario}`));

    await assert.rejects(
      adapter.inspect(handle.thread_id),
      (error: unknown) => {
        assert.ok(error instanceof ProductionRuntimeError);
        assert.equal(error.code, "app_server_protocol_error");
        return true;
      },
    );
  });
}

void test("App Server adapter fails closed on model rerouting and malformed compaction lifecycle", async (context) => {
  for (const [scenario, expectedCode] of [
    ["reroute", "model_policy_unavailable"],
    ["malformed-compaction", "app_server_protocol_error"],
  ] as const) {
    const adapter = runtime(context, scenario);
    const handle = await adapter.start(request());
    assert.ok(!(handle instanceof ProductionRuntimeError), scenario);
    const terminal = await handle.completion;
    assert.ok(terminal instanceof ProductionRuntimeError, scenario);
    assert.equal(terminal.code, expectedCode, scenario);
  }
});

void test("App Server adapter reports a child exit without leaking raw process output", async (context) => {
  const adapter = runtime(context, "exit");
  const result = await adapter.start(request());
  assert.ok(result instanceof ProductionRuntimeError);
  assert.equal(result.code, "app_server_process_exited");
});
