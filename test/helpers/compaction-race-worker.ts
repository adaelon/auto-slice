import { existsSync, writeFileSync } from "node:fs";

import {
  CompactionMonitor,
  CompactionMonitorError,
  type Clock,
  type DeadlineScheduler,
} from "../../src/controller/compaction-monitor/index.js";
import { FileRunStore, StateStoreError } from "../../src/controller/state/index.js";

class FixedClock implements Clock {
  public now(): Date {
    return new Date("2026-08-08T00:00:30.000Z");
  }
}

class NoopScheduler implements DeadlineScheduler {
  public schedule(): void {}
  public cancel(): void {}
}

async function waitForStart(startPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the race start barrier.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function main(): Promise<void> {
  const [storageRoot, runId, readyPath, startPath, contender] = process.argv.slice(2);
  if (
    storageRoot === undefined ||
    runId === undefined ||
    readyPath === undefined ||
    startPath === undefined ||
    (contender !== "completion" && contender !== "deadline")
  ) {
    throw new Error("Expected storageRoot, runId, readyPath, startPath, and completion|deadline.");
  }
  const store = FileRunStore.open(storageRoot);
  if (store instanceof StateStoreError) {
    throw store;
  }
  const monitor = new CompactionMonitor({
    run_store: store,
    clock: new FixedClock(),
    scheduler: new NoopScheduler(),
    observability: {
      stable_compaction_ids: true,
      structured_phase_events: true,
      ordered_host_sequence: true,
    },
  });
  writeFileSync(readyPath, contender, "utf8");
  await waitForStart(startPath);
  const result = contender === "completion"
    ? monitor.onEvent(runId, {
        type: "AUTO_COMPACTION_COMPLETED",
        thread_id: "thread-source-s07",
        compaction_id: "compaction-s07",
        host_sequence: 2,
        observed_at: "2026-08-08T00:00:30.000Z",
      }, 3)
    : monitor.onDeadline(
        runId,
        "compaction-s07",
        "2026-08-08T00:00:30.000Z",
        3,
      );
  if (result instanceof CompactionMonitorError) {
    process.stdout.write(JSON.stringify({ kind: "error", code: result.code }));
    return;
  }
  process.stdout.write(JSON.stringify({
    kind: "decision",
    outcome: result.outcome,
    diagnostic: result.diagnostic,
    state_version: result.state_version,
    status: result.status,
  }));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
