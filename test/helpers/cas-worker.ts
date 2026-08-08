import { existsSync, writeFileSync } from "node:fs";

import {
  FileRunStore,
  StateStoreError,
} from "../../src/controller/state/index.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const [storageRoot, runId, readyPath, startPath, action] = process.argv.slice(2);
  if (
    storageRoot === undefined ||
    runId === undefined ||
    readyPath === undefined ||
    startPath === undefined ||
    action === undefined
  ) {
    throw new Error("cas-worker requires storageRoot, runId, readyPath, startPath, and action.");
  }
  const store = FileRunStore.open(storageRoot);
  if (store instanceof StateStoreError) {
    throw store;
  }
  writeFileSync(readyPath, action, "utf8");
  while (!existsSync(startPath)) {
    await delay(2);
  }
  const result = store.compareAndSwap(runId, 0, {
    action,
    to: "PREPARING",
  });
  process.stdout.write(
    `${JSON.stringify(
      result instanceof StateStoreError
        ? { outcome: "error", code: result.code }
        : { outcome: "stored", version: result.state.state_version },
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
