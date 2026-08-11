#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS,
  CodexAppServerDevelopmentTask,
  DROP,
  HostEventFirewall,
  ProductionRuntimeError,
} from "../dist/src/controller/production/index.js";
import {
  canonicalJson,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
} from "../dist/src/controller/state/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixture = path.resolve("test/fixtures/process/fake-codex-app-server.mjs");
const productionRunner = path.join(
  repoRoot,
  "test",
  "fixtures",
  "process",
  "run-s14-production-with-fake-host.mjs",
);
const fixedTime = "2026-08-09T12:00:10.000Z";
const canaries = [
  "S14_MESSAGE_CANARY",
  "S14_REASONING_CANARY",
  "S14_COMMAND_CANARY",
  "S14_DIFF_CANARY",
  "S14_TOOL_CANARY",
  "S14_PLAN_CANARY",
];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stderr: `${result.stderr ?? ""}${result.error === undefined ? "" : `${result.error.name}\n`}`,
    stdout: result.stdout ?? "",
  };
}

function git(root, args) {
  const gitTime = "2026-08-09T12:00:00.000Z";
  const result = run("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: gitTime,
      GIT_COMMITTER_DATE: gitTime,
    },
  });
  ensure(result.exitCode === 0, "S14 production fixture Git operation failed.");
  return result.stdout.trim();
}

function productionPlan() {
  const now = Date.now();
  return {
    schema_version: 1,
    run_id: "s14-firewall-production",
    commit_mode: "none",
    model_capabilities: {
      schema_version: 1,
      source: "s14-deterministic-fixture",
      captured_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["medium", "max"] }],
    },
    slices: [{
      contract: {
        slice_id: "S14-firewall-fixture",
        contract_version: 1,
        objective: "Prove content-independent production control events.",
        exclusions: ["Never commit or push."],
        owned_paths: ["owned.txt", "result.json"],
        checks: [{
          id: "fixture-check",
          argv: [process.execPath, "check.mjs"],
          cwd: ".",
          timeout_ms: 10_000,
          env_allowlist: ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"],
          expected_exit_code: 0,
          expected_artifacts: ["result.json"],
        }],
        expected_artifacts: [{ path: "result.json", kind: "fixture_result" }],
      },
      instructions: "Write the frozen fixture outputs.",
    }],
  };
}

function initializeWorkspace(root) {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Auto Slice S14"]);
  git(root, ["config", "user.email", "auto-slice-s14@example.invalid"]);
  writeFileSync(path.join(root, "README.md"), "s14 fixture\n", "utf8");
  writeFileSync(
    path.join(root, "check.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("owned.txt", "utf8") !== "owned-by-production-cli\\n") process.exit(7);',
      'if (JSON.parse(readFileSync("result.json", "utf8")).ok !== true) process.exit(8);',
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["add", "README.md", "check.mjs"]);
  git(root, ["commit", "-m", "fixture baseline"]);
}

function scanDirectoryForCanaries(root) {
  let fileCount = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        fileCount += 1;
        const bytes = readFileSync(entryPath);
        ensure(
          canaries.every((canary) => !bytes.includes(Buffer.from(canary, "utf8"))),
          "Worker Content reached the persisted Controller state directory.",
        );
      }
    }
  }
  return fileCount;
}

function normalizeRunEvents(events) {
  return events.map((event) => ({
    event_index: event.event_index,
    event_kind: event.event_kind,
    action: event.action.startsWith("control_start:") ? "control_start" : event.action,
    status: event.after_state.status,
    state_version: event.after_state.state_version,
    current_slice_id: event.after_state.current_slice_id ?? null,
    source_thread_id: event.after_state.source_thread_id ?? null,
    compaction_id: event.after_state.compaction?.compaction_id ?? null,
    last_successful_status: event.after_state.last_successful_status ?? null,
    last_error_code: event.after_state.last_error?.code ?? null,
  }));
}

function normalizeProductionDecision(output) {
  return {
    status: output.status,
    outcome: output.decision?.outcome,
    run_id: output.decision?.run_id,
    final_state_version: output.decision?.final_state_version,
    completed_slices: output.decision?.completed_slices?.map((slice) => ({
      slice_id: slice.slice_id,
      source_thread_id: slice.source_thread_id,
      state_version: slice.state_version,
    })),
  };
}

function captureProductionScenario(scenario, plan) {
  ensure(existsSync(productionRunner), "S14 production runner is missing.");
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s14-firewall-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const storageRoot = path.join(temporaryRoot, "state");
  const planPath = path.join(temporaryRoot, "plan.json");
  try {
    initializeWorkspace(workspaceRoot);
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    const executed = run(process.execPath, [
      productionRunner,
      scenario,
      planPath,
      workspaceRoot,
      storageRoot,
    ]);
    ensure(
      canaries.every((canary) => !executed.stdout.includes(canary) && !executed.stderr.includes(canary)),
      "Worker Content reached production stdout or stderr.",
    );
    ensure(
      executed.exitCode === 0,
      `S14 production fixture did not complete (exit=${String(executed.exitCode)}).`,
    );
    const output = JSON.parse(executed.stdout);
    ensure(
      output.status === "PRODUCTION_RUN_COMPLETED" && output.decision?.outcome === "DONE",
      "S14 production fixture did not reach DONE.",
    );
    const store = FileRunStore.open(storageRoot);
    ensure(!(store instanceof StateStoreError), "S14 production state store could not be opened.");
    const events = store.inspectRunEvents(plan.run_id);
    ensure(!(events instanceof StateStoreError), "S14 production Run events could not be inspected.");
    const normalizedEvents = canonicalJson(normalizeRunEvents(events));
    const normalizedDecision = canonicalJson(normalizeProductionDecision(output));
    return {
      normalized_run_events_digest: sha256Bytes(Buffer.from(normalizedEvents, "utf8")),
      normalized_production_receipt_digest: sha256Bytes(Buffer.from(normalizedDecision, "utf8")),
      run_event_count: events.length,
      state_file_count: scanDirectoryForCanaries(storageRoot),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function request() {
  return {
    schema_version: 1,
    run_id: "run-s14-evidence",
    slice_id: "S14",
    idempotency_key: sha256Bytes("s14-development-task"),
    workspace_identity: createWorkspaceIdentity(process.cwd()),
    lease_id: "lease-s14-evidence",
    write_epoch: 1,
    model_decision: {
      mode: "model",
      model: "gpt-5.6-sol",
      effort: "max",
    },
    prompt: "Implement the frozen S14 evidence Slice.",
  };
}

async function captureScenario(scenario) {
  const adapter = new CodexAppServerDevelopmentTask({
    command: process.execPath,
    args: [fixture, scenario],
    now: () => new Date(fixedTime),
    request_timeout_ms: 5_000,
  });
  try {
    const handle = await adapter.start(request());
    ensure(!(handle instanceof ProductionRuntimeError), `${scenario} did not start.`);
    const events = [];
    for await (const event of handle.events) events.push(event);
    const receipt = await handle.completion;
    ensure(!(receipt instanceof ProductionRuntimeError), `${scenario} did not complete.`);
    ensure(!("final_response_digest" in receipt), `${scenario} receipt exposed final response content.`);
    return { events, receipt };
  } finally {
    await adapter.dispose();
  }
}

function projectionReport() {
  const firewall = new HostEventFirewall({ now: () => new Date(fixedTime) });
  firewall.registerTask({
    run_id: "run-s14-evidence",
    slice_id: "S14",
    thread_id: "thread-s14-evidence",
    started_at: fixedTime,
  });
  firewall.registerTurn("thread-s14-evidence", "turn-s14-evidence");

  const compaction = firewall.project({
    method: "item/started",
    params: {
      threadId: "thread-s14-evidence",
      turnId: "turn-s14-evidence",
      item: { id: "compaction-s14-evidence", type: "contextCompaction", text: canaries[0] },
    },
  });
  const terminal = firewall.project({
    method: "turn/completed",
    params: {
      threadId: "thread-s14-evidence",
      turn: {
        id: "turn-s14-evidence",
        status: "completed",
        completedAt: 1_786_276_801,
        items: [{ id: "message", type: "agentMessage", text: canaries[0] }],
      },
    },
  });
  const lifecycle = firewall.project({
    method: "thread/archived",
    params: { threadId: "thread-s14-evidence", preview: canaries[1] },
  });
  const reroute = firewall.project({
    method: "model/rerouted",
    params: {
      threadId: "thread-s14-evidence",
      turnId: "turn-s14-evidence",
      fromModel: "gpt-5.6-sol",
      toModel: "fallback-model",
      reason: canaries[2],
    },
  });
  const signals = [compaction, terminal, lifecycle, reroute];
  ensure(signals.every((signal) => signal !== DROP), "A whitelisted control notification was dropped.");

  const contentNotifications = [
    { method: "item/completed", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", item: { id: "message", type: "agentMessage", text: canaries[0] } } },
    { method: "item/completed", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", item: { id: "reasoning", type: "reasoning", content: canaries[1] } } },
    { method: "item/completed", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", item: { id: "command", type: "commandExecution", output: canaries[2] } } },
    { method: "turn/diff/updated", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", diff: canaries[3] } },
    { method: "item/mcpToolCall/progress", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", payload: canaries[4] } },
    { method: "turn/plan/updated", params: { threadId: "thread-s14-evidence", turnId: "turn-s14-evidence", plan: canaries[5] } },
  ];
  ensure(
    contentNotifications.every((notification) => firewall.project(notification) === DROP),
    "A Worker Content notification crossed the firewall.",
  );

  const serializedSignals = signals.map((signal) => canonicalJson(signal));
  ensure(
    canaries.every((canary) => serializedSignals.every((signal) => !signal.includes(canary))),
    "A Worker Content canary reached a projected ControllerSignal.",
  );
  return {
    projected_signal_types: signals.map((signal) => signal.type),
    signal_field_sets: Object.fromEntries(signals.map((signal) => [signal.type, Object.keys(signal)])),
    dropped_content_categories: ["agent_message", "reasoning", "command_output", "diff", "tool_payload", "plan"],
    dropped_notification_count: contentNotifications.length,
    maximum_signal_bytes: Math.max(...serializedSignals.map((signal) => Buffer.byteLength(signal, "utf8"))),
  };
}

async function main() {
  const [short, large] = await Promise.all([
    captureScenario("firewall-short"),
    captureScenario("firewall-large"),
  ]);
  const shortJson = canonicalJson(short);
  const largeJson = canonicalJson(large);
  ensure(shortJson === largeJson, "Short and large Worker Content changed Controller output bytes.");
  ensure(
    canaries.every((canary) => !shortJson.includes(canary) && !largeJson.includes(canary)),
    "A Worker Content canary reached a Development Task output.",
  );
  ensure(
    short.events.length === 2 &&
      short.events[0]?.type === "AUTO_COMPACTION_STARTED" &&
      short.events[1]?.type === "AUTO_COMPACTION_COMPLETED",
    "The existing contextCompaction lifecycle changed.",
  );

  const plan = productionPlan();
  const shortProduction = captureProductionScenario("production-firewall-short", plan);
  const largeProduction = captureProductionScenario("production-firewall-large", plan);
  ensure(
    shortProduction.normalized_run_events_digest === largeProduction.normalized_run_events_digest,
    "Short and large Worker Content changed normalized Run events.",
  );
  ensure(
    shortProduction.normalized_production_receipt_digest ===
      largeProduction.normalized_production_receipt_digest,
    "Short and large Worker Content changed the normalized Production receipt.",
  );
  ensure(
    shortProduction.run_event_count === largeProduction.run_event_count &&
      shortProduction.state_file_count === largeProduction.state_file_count,
    "Short and large Worker Content changed persisted Controller cardinality.",
  );

  const projection = projectionReport();
  const controllerDigest = sha256Bytes(Buffer.from(shortJson, "utf8"));
  const report = {
    schema_version: 1,
    slice_id: "S14",
    result: "PASS",
    notification_opt_out_methods: APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS,
    projected_signal_types: projection.projected_signal_types,
    signal_field_sets: projection.signal_field_sets,
    dropped_content_categories: projection.dropped_content_categories,
    dropped_notification_count: projection.dropped_notification_count,
    maximum_signal_bytes: projection.maximum_signal_bytes,
    canary_count: canaries.length,
    normalized_short_digest: controllerDigest,
    normalized_large_digest: controllerDigest,
    normalized_controller_bytes: Buffer.byteLength(shortJson, "utf8"),
    development_receipt_digest: short.receipt.receipt_digest,
    normalized_short_run_events_digest: shortProduction.normalized_run_events_digest,
    normalized_large_run_events_digest: largeProduction.normalized_run_events_digest,
    normalized_short_production_receipt_digest: shortProduction.normalized_production_receipt_digest,
    normalized_large_production_receipt_digest: largeProduction.normalized_production_receipt_digest,
    run_event_count: shortProduction.run_event_count,
    controller_state_file_count: shortProduction.state_file_count,
    assertions: {
      initialize_content_delta_opt_out_exact: true,
      controller_signal_whitelist_only: true,
      content_notifications_dropped: true,
      worker_content_canaries_absent: true,
      short_large_controller_bytes_equal: true,
      final_response_digest_absent: true,
      compaction_lifecycle_preserved: true,
      normalized_run_events_equal: true,
      normalized_production_receipts_equal: true,
      controller_state_canaries_absent: true,
    },
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
