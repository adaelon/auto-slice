#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";

import {
  FileRunStore,
  StateStoreError,
} from "../dist/src/controller/state/index.js";

const USAGE = "Usage: replay-run-events <storage_root> <run_id>";

function main() {
  const [requestedRoot, runId] = process.argv.slice(2);
  if (requestedRoot === undefined || runId === undefined || process.argv.length !== 4) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const storageRoot = path.resolve(requestedRoot);
  if (!existsSync(path.join(storageRoot, "schema.json"))) {
    process.stderr.write(
      `${JSON.stringify({
        status: "RUN_REPLAY_FAILED",
        error: {
          code: "run_not_found",
          message: "The requested state store does not exist.",
        },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const store = FileRunStore.open(storageRoot);
  if (store instanceof StateStoreError) {
    process.stderr.write(`${JSON.stringify({ status: "RUN_REPLAY_FAILED", error: store.toJSON() })}\n`);
    process.exitCode = 1;
    return;
  }
  const report = store.replayRunEvents(runId);
  if (report instanceof StateStoreError) {
    process.stderr.write(`${JSON.stringify({ status: "RUN_REPLAY_FAILED", error: report.toJSON() })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ status: "RUN_REPLAYED", report }, null, 2)}\n`);
}

main();
