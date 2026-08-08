#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
} from "../dist/src/controller/state/index.js";

function unwrap(result) {
  if (result instanceof StateStoreError) {
    throw result;
  }
  return result;
}

function treeDigest(root) {
  const hash = createHash("sha256");
  function append(directory, relative = "") {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const childPath = path.join(directory, entry.name);
      hash.update(childRelative, "utf8");
      hash.update("\0", "utf8");
      if (entry.isDirectory()) {
        append(childPath, childRelative);
      } else if (entry.isFile()) {
        hash.update(readFileSync(childPath));
      } else {
        hash.update(String(statSync(childPath).mode), "utf8");
      }
      hash.update("\0", "utf8");
    }
  }
  append(root);
  return `sha256:${hash.digest("hex")}`;
}

function main() {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-replay-check-"));
  try {
    let tick = 0;
    const now = () => new Date(Date.parse("2026-08-08T00:00:00.000Z") + tick++ * 1_000);
    const store = unwrap(FileRunStore.open(storageRoot, { now }));
    unwrap(store.create(createInitialRunState({
      run_id: "replay-check",
      workspace_identity: {
        canonical_root: "E:\\workspace\\fixture",
        filesystem_identity: "win32:sha256:fixture",
      },
      plan_digest: sha256Bytes("plan"),
      commit_mode: "after_slice",
      current_slice_id: "S02",
      protected_baseline_digest: sha256Bytes("baseline"),
    })));
    unwrap(store.compareAndSwap("replay-check", 0, {
      action: "prepare_run",
      to: "PREPARING",
    }));
    const beforeDigest = treeDigest(storageRoot);
    const result = spawnSync(
      process.execPath,
      ["scripts/replay-run-events.mjs", storageRoot, "replay-check"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Replay CLI failed: ${result.stderr ?? result.error?.message ?? "unknown error"}`);
    }
    const payload = JSON.parse(result.stdout);
    if (
      payload?.status !== "RUN_REPLAYED" ||
      payload.report?.state?.status !== "PREPARING" ||
      payload.report?.state?.state_version !== 1 ||
      payload.report?.event_count !== 2
    ) {
      throw new Error("Replay CLI returned an invalid deterministic report.");
    }
    const afterDigest = treeDigest(storageRoot);
    if (afterDigest !== beforeDigest) {
      throw new Error("Replay CLI modified its state store.");
    }
    process.stdout.write(
      `S02 replay tool passed: state_version=1 event_count=2 tree_digest=${afterDigest}\n`,
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
