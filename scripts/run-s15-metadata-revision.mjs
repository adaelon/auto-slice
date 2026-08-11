#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  CodexAppServerDevelopmentTask,
  ProductionRuntimeError,
} from "../dist/src/controller/production/index.js";
import {
  SourceInterruptionCoordinator,
  SourceInterruptionError,
  isOpaqueStableRevision,
} from "../dist/src/controller/thread-control/index.js";
import {
  canonicalJson,
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
} from "../dist/src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";

const FIXTURE = path.resolve("test/fixtures/process/fake-codex-app-server.mjs");
const FIXED_TIME = "2026-08-10T10:00:00.000Z";
const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

const SCENARIOS = [
  {
    id: "stable",
    fixture: "interrupt",
    revisions: [REVISION_A, REVISION_A],
    expected_reason: null,
    expected_status: "HANDOFF_EXPORTING",
  },
  {
    id: "unavailable",
    fixture: "interrupt",
    revisions: null,
    expected_reason: "thread_revision_unavailable",
    expected_status: "NEEDS_USER",
  },
  {
    id: "invalid",
    fixture: "interrupt",
    revisions: ["short-token"],
    expected_reason: "thread_revision_invalid",
    expected_status: "NEEDS_USER",
  },
  {
    id: "mismatch",
    fixture: "interrupt",
    revisions: [REVISION_A, REVISION_B],
    expected_reason: "thread_revision_mismatch",
    expected_status: "NEEDS_USER",
  },
  {
    id: "malicious_turns",
    fixture: "metadata-malicious-turns",
    revisions: [REVISION_A, REVISION_A],
    expected_reason: "thread_inspection_failed",
    expected_status: "NEEDS_USER",
  },
  {
    id: "malicious_items",
    fixture: "metadata-malicious-items",
    revisions: [REVISION_A, REVISION_A],
    expected_reason: "thread_inspection_failed",
    expected_status: "NEEDS_USER",
  },
];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function unwrapStore(value) {
  if (value instanceof StateStoreError) {
    throw new Error(`${value.code}: ${value.message}`);
  }
  return value;
}

function unwrapWorkspace(value) {
  if (value instanceof WorkspaceGuardError) {
    throw new Error(`${value.code}: ${value.message}`);
  }
  return value;
}

function createSourceInterruptingFixture(root, workspaceIdentity, sourceThreadId, scenarioId) {
  const storeRoot = path.join(root, "state");
  const guardRoot = path.join(root, "guard");
  const guard = FileWorkspaceGuard.open(guardRoot, {
    now: () => new Date(FIXED_TIME),
    leaseDurationMs: 120_000,
    leaseIdFactory: () => `lease-s15-${scenarioId}`,
  });
  ensure(!(guard instanceof WorkspaceGuardError), "workspace guard did not open");
  const runId = `run-s15-${scenarioId}`;
  const lease = unwrapWorkspace(guard.acquire(workspaceIdentity, runId));
  const store = FileRunStore.open(storeRoot, { now: () => new Date(FIXED_TIME) });
  ensure(!(store instanceof StateStoreError), "run store did not open");
  unwrapStore(store.create(createInitialRunState({
    run_id: runId,
    workspace_identity: workspaceIdentity,
    plan_digest: sha256Bytes(`plan-${scenarioId}`),
    commit_mode: "none",
    current_slice_id: "S15",
    protected_baseline_digest: sha256Bytes(`baseline-${scenarioId}`),
  })));
  unwrapStore(store.compareAndSwap(runId, 0, {
    action: "prepare_s15_evidence",
    to: "PREPARING",
    updates: {
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: sourceThreadId,
    },
  }));
  unwrapStore(store.compareAndSwap(runId, 1, {
    action: "start_s15_evidence",
    to: "SLICE_RUNNING",
  }));
  unwrapStore(store.compareAndSwap(runId, 2, {
    action: "observe_s15_compaction",
    to: "COMPACTION_WAIT",
    updates: {
      compaction: {
        compaction_id: `compaction-s15-${scenarioId}`,
        observed_started_at: "2026-08-10T09:59:30.000Z",
        deadline_at: FIXED_TIME,
        handoff_attempted: false,
      },
    },
  }));
  const interrupting = unwrapStore(store.compareAndSwap(runId, 3, {
    action: "expire_s15_compaction",
    to: "SOURCE_INTERRUPTING",
  }));
  return {
    workspaceIdentity,
    store,
    guard,
    lease,
    runId,
    stateVersion: interrupting.state.state_version,
  };
}

function developmentRequest(workspaceIdentity, scenarioId) {
  return {
    schema_version: 1,
    run_id: `run-s15-${scenarioId}`,
    slice_id: "S15",
    idempotency_key: sha256Bytes(`development-${scenarioId}`),
    workspace_identity: workspaceIdentity,
    lease_id: `task-lease-${scenarioId}`,
    write_epoch: 1,
    model_decision: {
      mode: "model",
      model: "gpt-5.6-sol",
      effort: "max",
    },
    prompt: "Implement the frozen S15 evidence scenario.",
  };
}

function parseProtocolTrace(tracePath) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function runScenario(config) {
  const root = mkdtempSync(path.join(os.tmpdir(), `auto-slice-s15-${config.id}-`));
  const tracePath = path.join(root, "protocol-trace.jsonl");
  let revisionReads = 0;
  const provider = config.revisions === null
    ? undefined
    : {
      read: () => {
        const value = config.revisions[Math.min(revisionReads, config.revisions.length - 1)];
        revisionReads += 1;
        return Promise.resolve(value);
      },
    };
  const adapter = new CodexAppServerDevelopmentTask({
    command: process.execPath,
    args: [FIXTURE, config.fixture, tracePath],
    now: () => new Date(FIXED_TIME),
    request_timeout_ms: 5_000,
    ...(provider === undefined ? {} : { thread_revision_provider: provider }),
  });
  try {
    const workspaceRoot = path.join(root, "workspace");
    mkdirSync(workspaceRoot);
    const workspaceIdentity = createWorkspaceIdentity(workspaceRoot);
    const handle = await adapter.start(developmentRequest(workspaceIdentity, config.id));
    if (handle instanceof ProductionRuntimeError) {
      throw new Error(`Development Task failed: ${handle.code}`);
    }
    const firstEvent = await handle.events[Symbol.asyncIterator]().next();
    ensure(firstEvent.done === false, `${config.id} did not emit a compaction start`);
    const fixture = createSourceInterruptingFixture(
      path.join(root, "controller"),
      workspaceIdentity,
      handle.thread_id,
      config.id,
    );
    const coordinator = new SourceInterruptionCoordinator({
      run_store: fixture.store,
      workspace_guard: fixture.guard,
      thread_control: adapter,
      now: () => new Date(FIXED_TIME),
      interrupt_timeout_ms: 5_000,
    });
    const result = await coordinator.interruptSource(
      fixture.runId,
      fixture.lease.lease_id,
      fixture.lease.epoch,
      fixture.stateVersion,
    );
    const state = unwrapStore(fixture.store.load(fixture.runId)).state;
    const failed = result instanceof SourceInterruptionError;
    const reason = failed ? result.reason ?? null : null;
    ensure(reason === config.expected_reason, `${config.id} returned ${String(reason)}`);
    ensure(state.status === config.expected_status, `${config.id} ended in ${state.status}`);
    const compressionLauncherCalls = failed ? 0 : 1;
    const persistedRevision = failed ? null : result.receipt.persisted_revision;
    if (!failed) {
      ensure(isOpaqueStableRevision(persistedRevision), "stable scenario lost its opaque revision");
      ensure(result.source_thread_id === handle.thread_id, "Source identity drifted before Handoff");
    }
    const leaseEvents = unwrapWorkspace(
      fixture.guard.inspectLeaseEvents(fixture.lease.lease_id),
    ).map((entry) => entry.action);
    const protocol = parseProtocolTrace(tracePath);
    return {
      capability: {
        scenario: config.id,
        outcome: failed ? "FAIL_CLOSED" : result.outcome,
        reason,
        run_status: state.status,
        revision_provider_reads: revisionReads,
        opaque_revision_valid: persistedRevision === null
          ? null
          : isOpaqueStableRevision(persistedRevision),
      },
      gate: {
        scenario: config.id,
        source_thread_bound: failed ? null : result.source_thread_id === handle.thread_id,
        source_revision_bound: failed ? null : persistedRevision === REVISION_A,
        compression_launcher_calls: compressionLauncherCalls,
        lease_events: leaseEvents,
      },
      protocol: {
        scenario: config.id,
        thread_reads: protocol,
      },
    };
  } finally {
    await adapter.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  const threadReads = results.flatMap((entry) => entry.protocol.thread_reads);
  ensure(
    threadReads.every((entry) => entry.method === "thread/read" && entry.includeTurns === false),
    "S15 emitted a non-summary thread/read request",
  );
  const failures = results.filter((entry) => entry.capability.outcome === "FAIL_CLOSED");
  ensure(
    failures.every((entry) => entry.gate.compression_launcher_calls === 0),
    "A failed revision gate dispatched Compression",
  );
  const report = {
    schema_version: 1,
    slice_id: "S15",
    revision_capability_matrix: results.map((entry) => entry.capability),
    full_turn_read_trace: {
      thread_read_count: threadReads.length,
      include_turns_true_count: threadReads.filter((entry) => entry.includeTurns === true).length,
      all_requests_summary_only: threadReads.every((entry) => entry.includeTurns === false),
      scenarios: results.map((entry) => entry.protocol),
    },
    source_interruption_handoff: {
      stable_identity_binding: results.find((entry) => entry.capability.scenario === "stable")?.gate,
      failure_closures: failures.map((entry) => entry.gate),
      s09_revision_guard_regression: "dist/test/handoff.test.js",
    },
  };
  process.stdout.write(`${canonicalJson(report)}\n`);
}

await main();
