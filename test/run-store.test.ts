import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildRunTransitionMatrix,
  createEffectIdempotencyKey,
  createInitialRunState,
  FileRunStore,
  RUN_STATUSES,
  sha256Bytes,
  StateStoreError,
  type RunState,
  type StateStoreFaultPoint,
  type StoredRun,
} from "../src/controller/state/index.js";

const FIXED_TIME = "2026-08-08T00:00:00.000Z";

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s02-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const value = new Date(Date.parse(FIXED_TIME) + tick * 1_000);
    tick += 1;
    return value;
  };
}

function openStore(
  storageRoot: string,
  options: {
    readonly now?: () => Date;
    readonly faultInjector?: (point: StateStoreFaultPoint) => void;
  } = {},
): FileRunStore {
  const result = FileRunStore.open(storageRoot, options);
  if (result instanceof StateStoreError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrap<T>(result: T | StateStoreError): T {
  if (result instanceof StateStoreError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function expectError(result: unknown, code: StateStoreError["code"]): StateStoreError {
  assert.ok(result instanceof StateStoreError);
  assert.equal(result.code, code);
  return result;
}

function initialState(runId = "run-s02"): RunState {
  return createInitialRunState({
    run_id: runId,
    workspace_identity: {
      canonical_root: "E:\\workspace\\fixture",
      filesystem_identity: "win32:sha256:fixture",
    },
    plan_digest: sha256Bytes("plan"),
    commit_mode: "after_slice",
    current_slice_id: "S02",
    protected_baseline_digest: sha256Bytes("baseline"),
  });
}

function encodedRunId(runId: string): string {
  return Buffer.from(runId, "utf8").toString("base64url");
}

function snapshotPath(storageRoot: string, runId: string): string {
  return path.join(storageRoot, "runs", encodedRunId(runId), "snapshot.json");
}

function eventsPath(storageRoot: string, runId: string): string {
  return path.join(storageRoot, "runs", encodedRunId(runId), "events");
}

const OPERATIONAL = [
  "PREPARING",
  "SLICE_RUNNING",
  "VERIFYING",
  "COMMITTING",
  "CHECKPOINTING",
  "COMPACTION_WAIT",
  "SOURCE_INTERRUPTING",
  "HANDOFF_EXPORTING",
  "CONTINUATION_STARTING",
] as const;

const FORWARD = new Set([
  "IDLE->PREPARING",
  "PREPARING->SLICE_RUNNING",
  "SLICE_RUNNING->VERIFYING",
  "SLICE_RUNNING->COMPACTION_WAIT",
  "VERIFYING->COMMITTING",
  "VERIFYING->CHECKPOINTING",
  "COMMITTING->CHECKPOINTING",
  "CHECKPOINTING->SLICE_RUNNING",
  "CHECKPOINTING->DONE",
  "COMPACTION_WAIT->SLICE_RUNNING",
  "COMPACTION_WAIT->SOURCE_INTERRUPTING",
  "SOURCE_INTERRUPTING->HANDOFF_EXPORTING",
  "HANDOFF_EXPORTING->CONTINUATION_STARTING",
  "CONTINUATION_STARTING->SLICE_RUNNING",
  ...OPERATIONAL.map((status) => `PAUSED->${status}`),
  ...OPERATIONAL.map((status) => `NEEDS_USER->${status}`),
]);

function expectedTransition(from: (typeof RUN_STATUSES)[number], to: (typeof RUN_STATUSES)[number]): boolean {
  if (from === to || from === "DONE" || from === "ABORTED") {
    return false;
  }
  if (FORWARD.has(`${from}->${to}`)) {
    return true;
  }
  if (to === "ABORTED") {
    return true;
  }
  if (to === "NEEDS_USER") {
    return from !== "NEEDS_USER";
  }
  return to === "PAUSED" && from !== "PAUSED" && from !== "NEEDS_USER";
}

void test("transition matrix covers every legal and illegal RunState pair", () => {
  const matrix = buildRunTransitionMatrix();
  assert.equal(matrix.length, RUN_STATUSES.length * RUN_STATUSES.length);
  for (const entry of matrix) {
    assert.equal(
      entry.allowed,
      expectedTransition(entry.from, entry.to),
      `${entry.from} -> ${entry.to}`,
    );
  }
});

void test("creates, loads, and repeatedly replays one append-only Run event chain", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot, { now: deterministicClock() });
  const created = unwrap(store.create(initialState()));
  assert.equal(created.state.status, "IDLE");
  assert.equal(created.event_count, 1);
  assert.equal(created.recovered_from_event_log, false);

  const prepared = unwrap(store.compareAndSwap("run-s02", 0, {
    action: "prepare_run",
    to: "PREPARING",
  }));
  assert.equal(prepared.state.state_version, 1);
  const firstReplay = unwrap(store.replayRunEvents("run-s02"));
  const secondReplay = unwrap(store.replayRunEvents("run-s02"));
  assert.deepEqual(secondReplay, firstReplay);
  assert.equal(firstReplay.state.status, "PREPARING");
  assert.equal(firstReplay.event_count, 2);
});

void test("event replay matches the committed golden fixture", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot, { now: deterministicClock() });
  unwrap(store.create(initialState("golden-run")));
  unwrap(store.compareAndSwap("golden-run", 0, {
    action: "prepare_run",
    to: "PREPARING",
  }));
  unwrap(store.compareAndSwap("golden-run", 1, {
    action: "start_slice",
    to: "SLICE_RUNNING",
    updates: { source_thread_id: "thread-source-1" },
  }));
  const actual = unwrap(store.inspectRunEvents("golden-run"));
  const expected = JSON.parse(
    readFileSync("test/fixtures/state/event-log.golden.json", "utf8"),
  ) as unknown;
  assert.deepEqual(actual, expected);
});

void test("rejects an illegal transition without appending an event", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot);
  unwrap(store.create(initialState()));
  const before = unwrap(store.inspectRunEvents("run-s02"));
  expectError(
    store.compareAndSwap("run-s02", 0, { action: "skip_prepare", to: "DONE" }),
    "invalid_transition",
  );
  const after = unwrap(store.inspectRunEvents("run-s02"));
  assert.deepEqual(after, before);
});

interface WorkerResult {
  readonly outcome: "stored" | "error";
  readonly version?: number;
  readonly code?: string;
}

function runCasWorker(
  workerPath: string,
  storageRoot: string,
  runId: string,
  readyPath: string,
  startPath: string,
  action: string,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, storageRoot, runId, readyPath, startPath, action], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`CAS worker exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult);
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function waitForFiles(paths: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((candidate) => existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for: ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void test("two process-level CAS contenders produce one winner and one stale_state", async (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot);
  unwrap(store.create(initialState("race-run")));
  const workerPath = fileURLToPath(new URL("./helpers/cas-worker.js", import.meta.url));
  const readyA = path.join(storageRoot, "ready-a");
  const readyB = path.join(storageRoot, "ready-b");
  const start = path.join(storageRoot, "start");
  const workerA = runCasWorker(workerPath, storageRoot, "race-run", readyA, start, "prepare_a");
  const workerB = runCasWorker(workerPath, storageRoot, "race-run", readyB, start, "prepare_b");
  await waitForFiles([readyA, readyB], 10_000);
  writeFileSync(start, "go", "utf8");
  const results = await Promise.all([workerA, workerB]);
  assert.deepEqual(
    results.map((entry) => entry.outcome === "stored" ? "stored" : entry.code).sort(),
    ["stale_state", "stored"],
  );
  assert.equal(unwrap(store.load("race-run")).state.state_version, 1);
});

void test("repairs a valid stale snapshot after a crash immediately following event publication", (context) => {
  const storageRoot = temporaryDirectory(context);
  const initialStore = openStore(storageRoot, { now: deterministicClock() });
  unwrap(initialStore.create(initialState("snapshot-crash")));
  const crashingStore = openStore(storageRoot, {
    now: deterministicClock(),
    faultInjector: (point) => {
      if (point === "after_run_event_persisted") {
        throw new Error("injected crash after event");
      }
    },
  });
  expectError(
    crashingStore.compareAndSwap("snapshot-crash", 0, {
      action: "prepare_before_crash",
      to: "PREPARING",
    }),
    "state_persist_failed",
  );

  const recoveredStore = openStore(storageRoot);
  const recovered = unwrap(recoveredStore.load("snapshot-crash"));
  assert.equal(recovered.state.state_version, 1);
  assert.equal(recovered.state.status, "PREPARING");
  assert.equal(recovered.recovered_from_event_log, true);
  assert.equal(unwrap(recoveredStore.load("snapshot-crash")).recovered_from_event_log, false);
});

void test("stale_state does not repair a lagging snapshot or append another event", (context) => {
  const storageRoot = temporaryDirectory(context);
  const initialStore = openStore(storageRoot);
  unwrap(initialStore.create(initialState("stale-no-write")));
  const crashingStore = openStore(storageRoot, {
    faultInjector: (point) => {
      if (point === "after_run_event_persisted") {
        throw new Error("leave snapshot at version zero");
      }
    },
  });
  expectError(
    crashingStore.compareAndSwap("stale-no-write", 0, {
      action: "prepare_once",
      to: "PREPARING",
    }),
    "state_persist_failed",
  );
  const snapshotBefore = readFileSync(snapshotPath(storageRoot, "stale-no-write"));
  const eventsBefore = unwrap(initialStore.inspectRunEvents("stale-no-write"));
  const contender = openStore(storageRoot);
  expectError(
    contender.compareAndSwap("stale-no-write", 0, {
      action: "stale_retry",
      to: "PREPARING",
    }),
    "stale_state",
  );
  assert.deepEqual(readFileSync(snapshotPath(storageRoot, "stale-no-write")), snapshotBefore);
  assert.deepEqual(unwrap(contender.inspectRunEvents("stale-no-write")), eventsBefore);
});

void test("same-version snapshot corruption fails closed and locks mutations", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot);
  unwrap(store.create(initialState("corrupt-run")));
  const target = snapshotPath(storageRoot, "corrupt-run");
  const snapshot = JSON.parse(readFileSync(target, "utf8")) as {
    state: { status: string };
  };
  snapshot.state.status = "DONE";
  writeFileSync(target, `${JSON.stringify(snapshot)}\n`, "utf8");
  expectError(store.load("corrupt-run"), "state_corrupt");
  const beforeCount = readFileSync(
    path.join(eventsPath(storageRoot, "corrupt-run"), "00000000000000000000.json"),
  ).byteLength;
  expectError(
    store.compareAndSwap("corrupt-run", 0, { action: "must_not_write", to: "PREPARING" }),
    "state_corrupt",
  );
  const afterCount = readFileSync(
    path.join(eventsPath(storageRoot, "corrupt-run"), "00000000000000000000.json"),
  ).byteLength;
  assert.equal(afterCount, beforeCount);
});

void test("recovers an effect intent persisted before its missing receipt", (context) => {
  const storageRoot = temporaryDirectory(context);
  const baseStore = openStore(storageRoot);
  unwrap(baseStore.create(initialState("intent-crash")));
  const key = createEffectIdempotencyKey("intent-crash", 0, "create_task", "task-1");
  const payloadDigest = sha256Bytes("payload");
  const crashingStore = openStore(storageRoot, {
    faultInjector: (point) => {
      if (point === "after_effect_intent_persisted") {
        throw new Error("injected crash after intent");
      }
    },
  });
  expectError(crashingStore.appendEffectIntent(key, payloadDigest), "state_persist_failed");

  const recoveredStore = openStore(storageRoot);
  const incomplete = unwrap(recoveredStore.recoverIncompleteEffects("intent-crash"));
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0]?.status, "INTENDED");
  assert.deepEqual(unwrap(recoveredStore.appendEffectIntent(key, payloadDigest)), incomplete[0]);
});

void test("recovers a completed effect whose caller crashed before observing the receipt", (context) => {
  const storageRoot = temporaryDirectory(context);
  const baseStore = openStore(storageRoot);
  unwrap(baseStore.create(initialState("receipt-crash")));
  const key = createEffectIdempotencyKey("receipt-crash", 0, "interrupt_source", "thread-1");
  unwrap(baseStore.appendEffectIntent(key, sha256Bytes("payload")));
  const receiptDigest = sha256Bytes("receipt");
  const crashingStore = openStore(storageRoot, {
    faultInjector: (point) => {
      if (point === "after_effect_completion_persisted") {
        throw new Error("injected crash after receipt");
      }
    },
  });
  expectError(crashingStore.completeEffect(key, receiptDigest), "state_persist_failed");

  const recoveredStore = openStore(storageRoot);
  assert.deepEqual(unwrap(recoveredStore.recoverIncompleteEffects("receipt-crash")), []);
  const completed = unwrap(recoveredStore.appendEffectIntent(key, sha256Bytes("payload")));
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.receipt_digest, receiptDigest);
  assert.deepEqual(unwrap(recoveredStore.completeEffect(key, receiptDigest)), completed);
});

void test("Run corruption prevents a new effect completion from being persisted", (context) => {
  const storageRoot = temporaryDirectory(context);
  const baseStore = openStore(storageRoot);
  unwrap(baseStore.create(initialState("corrupt-effect")));
  const key = createEffectIdempotencyKey("corrupt-effect", 0, "action", "target");
  unwrap(baseStore.appendEffectIntent(key, sha256Bytes("payload")));
  const target = snapshotPath(storageRoot, "corrupt-effect");
  const snapshot = JSON.parse(readFileSync(target, "utf8")) as {
    state: { status: string };
  };
  snapshot.state.status = "DONE";
  writeFileSync(target, `${JSON.stringify(snapshot)}\n`, "utf8");

  const reopened = openStore(storageRoot);
  expectError(reopened.completeEffect(key, sha256Bytes("receipt")), "state_corrupt");
  const completionPath = path.join(
    storageRoot,
    "runs",
    encodedRunId("corrupt-effect"),
    "effects",
    key.digest.slice("sha256:".length),
    "completion.json",
  );
  assert.equal(existsSync(completionPath), false);
});

void test("effect idempotency rejects stale state and conflicting payload or receipt digests", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot);
  unwrap(store.create(initialState("effect-conflict")));
  const staleKey = createEffectIdempotencyKey("effect-conflict", 1, "action", "target");
  expectError(store.appendEffectIntent(staleKey, sha256Bytes("payload")), "stale_state");

  const key = createEffectIdempotencyKey("effect-conflict", 0, "action", "target");
  unwrap(store.appendEffectIntent(key, sha256Bytes("payload")));
  expectError(store.appendEffectIntent(key, sha256Bytes("other-payload")), "state_corrupt");
});

void test("unsupported store schema refuses startup without guessing a migration", (context) => {
  const storageRoot = temporaryDirectory(context);
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(
    path.join(storageRoot, "schema.json"),
    `${JSON.stringify({ schema_version: 999, migration: "unknown" })}\n`,
    "utf8",
  );
  expectError(FileRunStore.open(storageRoot), "unsupported_state_schema");
});

void test("missing Run IDs close as run_not_found", (context) => {
  const store = openStore(temporaryDirectory(context));
  expectError(store.load("missing-run"), "run_not_found");
});

void test("creation rejects non-zero or non-IDLE initial state", (context) => {
  const storageRoot = temporaryDirectory(context);
  const store = openStore(storageRoot);
  const invalid = {
    ...initialState("invalid-initial"),
    state_version: 2,
  } satisfies RunState;
  expectError(store.create(invalid), "invalid_state");
});

void test("StoredRun is structurally stable across two independent store instances", (context) => {
  const storageRoot = temporaryDirectory(context);
  const first = openStore(storageRoot, { now: deterministicClock() });
  const created: StoredRun = unwrap(first.create(initialState("stable-run")));
  const second = openStore(storageRoot);
  assert.deepEqual(unwrap(second.load("stable-run")), created);
});
