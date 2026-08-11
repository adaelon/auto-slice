#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

import {
  DROP,
  HostEventFirewall,
} from "../dist/src/controller/production/index.js";
import {
  canonicalJson,
  FileRunStore,
  sha256Bytes,
  StateStoreError,
} from "../dist/src/controller/state/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const productionRunner = path.join(
  repoRoot,
  "test",
  "fixtures",
  "process",
  "run-s16-production-with-fake-host.mjs",
);
const runId = "s16-content-budget-production";
const sliceId = "S16-content-budget-fixture";
const fixedControlTime = "2026-08-10T12:00:00.000Z";
const maximumControllerSignalBytes = 8 * 1024;
const canaries = [
  "S16_MESSAGE_CANARY",
  "S16_REASONING_CANARY",
  "S16_COMMAND_CANARY",
  "S16_DIFF_CANARY",
  "S16_TOOL_CANARY",
  "S16_PLAN_CANARY",
  "S16_SUMMARY_CANARY",
  "S16_ERROR_CANARY",
];
const canaryTypes = [
  "agent_message",
  "reasoning",
  "command_output",
  "diff",
  "tool_payload",
  "plan",
  "thread_summary",
  "error_projection",
];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
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
  const gitTime = "2026-08-10T12:00:00.000Z";
  const result = run("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: gitTime,
      GIT_COMMITTER_DATE: gitTime,
    },
  });
  ensure(
    result.exitCode === 0,
    `S16 fixture Git ${args[0] ?? "operation"} failed with exit ${String(result.exitCode)}: ${result.stderr.trim()}`,
  );
  return result.stdout.trim();
}

function initializeWorkspace(root) {
  mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.name", "Auto Slice S16"]);
  git(root, ["config", "user.email", "auto-slice-s16@example.invalid"]);
  writeFileSync(path.join(root, "README.md"), "s16 fixture\n", "utf8");
  writeFileSync(
    path.join(root, "check.mjs"),
    [
      'import { readFileSync } from "node:fs";',
      'if (readFileSync("owned.txt", "utf8") !== "owned-by-s16-production\\n") process.exit(7);',
      'if (JSON.parse(readFileSync("result.json", "utf8")).ok !== true) process.exit(8);',
      "",
    ].join("\n"),
    "utf8",
  );
  git(root, ["add", "README.md", "check.mjs"]);
  git(root, ["commit", "-m", "fixture baseline"]);
}

function scenarioSliceIds(scenario) {
  if (scenario === "normal-short" || scenario === "normal-large") {
    return ["S16-trusted-a", "S16-trusted-b"];
  }
  if (scenario === "worker-failed" || scenario === "worker-interrupted") {
    return ["S16-failure-a", "S16-failure-b"];
  }
  if (scenario === "probe-fallback") {
    return ["S16-probe-fallback"];
  }
  return [sliceId];
}

function productionSlice(sliceIdentity) {
  return {
    contract: {
      slice_id: sliceIdentity,
      contract_version: 1,
      objective: "Prove the end-to-end Controller content budget.",
      exclusions: ["Never commit or push."],
      owned_paths: ["owned.txt", "result.json"],
      checks: [{
        id: `legacy-check-${sliceIdentity}`,
        argv: [process.execPath, "-e", "process.exit(91)"],
        cwd: ".",
        timeout_ms: 10_000,
        env_allowlist: ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"],
        expected_exit_code: 0,
        expected_artifacts: ["never-created.json"],
      }],
      expected_artifacts: [{ path: "never-created.json", kind: "fixture_result" }],
    },
    instructions: "Worker Content and legacy acceptance fields must remain outside the Controller.",
  };
}

function productionPlan(scenario) {
  const now = Date.now();
  return {
    schema_version: 1,
    run_id: runId,
    commit_mode: scenario === "normal-short" || scenario === "normal-large"
      ? "after_slice"
      : "none",
    model_capabilities: {
      schema_version: 1,
      source: "s16-deterministic-fixture",
      captured_at: new Date(now - 60_000).toISOString(),
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["medium", "max"] }],
    },
    slices: scenarioSliceIds(scenario).map(productionSlice),
  };
}

function createGitTrap(root) {
  const binRoot = path.join(root, "git-trap-bin");
  const tracePath = path.join(root, "controller-git-trace.log");
  mkdirSync(binRoot, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      path.join(binRoot, "git.cmd"),
      '@echo off\r\n>>"%S16_GIT_TRACE%" echo git\r\nexit /b 97\r\n',
      "utf8",
    );
  } else {
    const executable = path.join(binRoot, "git");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf "git\\n" >> "$S16_GIT_TRACE"\nexit 97\n',
      "utf8",
    );
    chmodSync(executable, 0o755);
  }
  return {
    tracePath,
    environment: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ""}`,
      S16_GIT_TRACE: tracePath,
    },
  };
}

function traceCount(tracePath) {
  if (!existsSync(tracePath)) return 0;
  return readFileSync(tracePath, "utf8").split(/\r?\n/u).filter(Boolean).length;
}

function firstCanaryMatch(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return canaries.findIndex((canary) => bytes.includes(Buffer.from(canary, "utf8")));
}

function assertCanaryFree(value, surface) {
  const match = firstCanaryMatch(value);
  ensure(match < 0, `Worker Content canary #${String(match)} reached ${surface}.`);
}

function scanDirectory(root) {
  const pending = [root];
  let fileCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        const bytes = readFileSync(entryPath);
        fileCount += 1;
        totalBytes += bytes.length;
        assertCanaryFree(bytes, "Controller state directory");
      }
    }
  }
  return { fileCount, totalBytes };
}

function normalizedCompactionId(compactionId) {
  return typeof compactionId === "string" && compactionId.startsWith("probe-")
    ? "probe-opaque-id"
    : compactionId;
}

function normalizedState(state) {
  return {
    schema_version: state.schema_version,
    run_id: state.run_id,
    state_version: state.state_version,
    status: state.status,
    commit_mode: state.commit_mode,
    current_slice_id: state.current_slice_id,
    project_lock_present: state.project_lock_owner !== null,
    write_epoch: state.write_epoch,
    source_thread_id: state.source_thread_id,
    compaction: state.compaction === undefined
      ? null
      : {
        compaction_id: normalizedCompactionId(state.compaction.compaction_id),
        handoff_attempted: state.compaction.handoff_attempted,
      },
    handoff: state.handoff === undefined
      ? null
      : {
        compression_task_id: state.handoff.compression_task_id,
        continuation_task_id: state.handoff.continuation_task_id ?? null,
      },
    last_error: state.last_error === undefined
      ? null
      : {
        code: state.last_error.code,
        last_successful_status: state.last_error.last_successful_status,
      },
  };
}

function normalizeRunEvents(events) {
  return events.map((event) => ({
    event_index: event.event_index,
    event_kind: event.event_kind,
    action: event.action.startsWith("control_start:") ? "control_start" : event.action,
    after_state: normalizedState(event.after_state),
  }));
}

function collectEffectLedger(root) {
  const pending = [root];
  const records = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === "intent.json") {
        const intent = JSON.parse(readFileSync(entryPath, "utf8"));
        if (intent.event_kind !== "EFFECT_INTENDED" || intent.idempotency_key === undefined) {
          continue;
        }
        records.push({
          action: intent.idempotency_key.action,
          state_version: intent.idempotency_key.state_version,
          status: existsSync(path.join(current, "completion.json")) ? "COMPLETED" : "INTENDED",
        });
      }
    }
  }
  return records.sort((left, right) =>
    left.action.localeCompare(right.action) || left.state_version - right.state_version
  );
}

function normalizeCliDecision(wrapper) {
  if (wrapper.cli_exit_code === 0) {
    const output = wrapper.stdout[0];
    const decision = output.decision;
    return {
      status: output.status,
      outcome: decision.outcome,
      run_id: decision.run_id,
      slice_id: decision.slice_id ?? null,
      final_state_version: decision.final_state_version ?? decision.state_version,
      source_thread_id: decision.source_thread_id ?? null,
      compression_task_id: decision.compression_task_id ?? null,
      continuation_task_id: decision.continuation_task_id ?? null,
      completed_slices: (decision.completed_slices ?? []).map((slice) => ({
        slice_id: slice.slice_id,
        source_thread_id: slice.source_thread_id,
        state_version: slice.state_version,
      })),
    };
  }
  const output = wrapper.stderr[0];
  return {
    status: output.status,
    outcome: "FAIL_CLOSED",
    error_code: output.error?.code ?? null,
  };
}

function canonicalMetric(value) {
  const json = canonicalJson(value);
  return {
    json,
    bytes: Buffer.byteLength(json, "utf8"),
    digest: sha256Bytes(Buffer.from(json, "utf8")),
  };
}

function captureProductionScenario(scenario) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), `auto-slice-s16-${scenario}-`));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const storageRoot = path.join(temporaryRoot, "state");
  const planPath = path.join(temporaryRoot, "plan.json");
  const tracePath = path.join(temporaryRoot, "protocol-trace.jsonl");
  let succeeded = false;
  try {
    initializeWorkspace(workspaceRoot);
    const baselineHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
    const plan = productionPlan(scenario);
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    const gitTrap = createGitTrap(temporaryRoot);
    const executed = run(process.execPath, [
      productionRunner,
      scenario,
      planPath,
      workspaceRoot,
      storageRoot,
      tracePath,
    ], { env: gitTrap.environment });
    assertCanaryFree(executed.stdout, `${scenario} captured stdout`);
    assertCanaryFree(executed.stderr, `${scenario} captured stderr`);
    ensure(executed.exitCode === 0, `S16 production runner failed for ${scenario}.`);
    const wrapper = JSON.parse(executed.stdout);
    assertCanaryFree(JSON.stringify(wrapper), `${scenario} captured CLI surfaces`);
    const controllerGitInvocationCount = traceCount(gitTrap.tracePath);
    ensure(
      controllerGitInvocationCount === 0,
      `${scenario} invoked Git from the Controller process.`,
    );
    const store = FileRunStore.open(storageRoot);
    ensure(!(store instanceof StateStoreError), `S16 RunStore did not open for ${scenario}.`);
    const loaded = store.load(runId);
    ensure(!(loaded instanceof StateStoreError), `S16 Run did not load for ${scenario}.`);
    const events = store.inspectRunEvents(runId);
    ensure(!(events instanceof StateStoreError), `S16 Run events did not load for ${scenario}.`);
    const observedProbeCompactionIds = [...new Set(events
      .map((event) => event.after_state.compaction?.compaction_id)
      .filter((compactionId) =>
        typeof compactionId === "string" && compactionId.startsWith("probe-")
      ))];
    const stateScan = scanDirectory(storageRoot);
    const snapshot = canonicalMetric(normalizedState(loaded.state));
    const runEvents = canonicalMetric(normalizeRunEvents(events));
    const effects = canonicalMetric(collectEffectLedger(storageRoot));
    const decision = canonicalMetric(normalizeCliDecision(wrapper));
    for (const [surface, metric] of [
      ["Run snapshot", snapshot],
      ["Run event ledger", runEvents],
      ["effect ledger", effects],
      ["terminal receipt", decision],
    ]) {
      assertCanaryFree(metric.json, `${scenario} normalized ${surface}`);
    }
    const threadReads = wrapper.protocol_trace.filter(
      (entry) => entry.method === "thread/read",
    );
    const fullTurnReadCount = threadReads.filter(
      (entry) => entry.method === "thread/read" && entry.includeTurns === true,
    ).length;
    ensure(fullTurnReadCount === 0, `${scenario} attempted a full-turn read.`);
    ensure(
      threadReads.every((entry) => entry.includeTurns === false),
      `${scenario} emitted a non-summary metadata request.`,
    );
    const normalizedDecision = JSON.parse(decision.json);
    const currentHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
    const headCommitDelta = Number(git(
      workspaceRoot,
      ["rev-list", "--count", `${baselineHead}..${currentHead}`],
    ));
    const workspaceEntries = readdirSync(workspaceRoot, { withFileTypes: true });
    const extraFileCount = workspaceEntries.filter(
      (entry) => entry.isFile() && /^worker-extra-\d+\.txt$/u.test(entry.name),
    ).length;
    const result = {
      id: scenario,
      worker_content_profile: scenario === "normal-short" ? "short" : "large_96_kib_per_value",
      cli_status: normalizedDecision.status,
      outcome: normalizedDecision.outcome,
      run_status: loaded.state.status,
      run_status_chain: events.map((event) => event.after_state.status),
      current_slice_id: loaded.state.current_slice_id,
      commit_mode: loaded.state.commit_mode,
      error_code: normalizedDecision.error_code ?? null,
      completed_slice_count: normalizedDecision.completed_slices?.length ?? 0,
      completed_slice_ids: (normalizedDecision.completed_slices ?? []).map((slice) => slice.slice_id),
      development_start_count: wrapper.protocol_trace.filter(
        (entry) => entry.method === "turn/start",
      ).length,
      full_turn_read_count: fullTurnReadCount,
      summary_only_thread_read_count: threadReads.length,
      host_clock_offsets_used: wrapper.host_clock_offsets_used,
      host_compaction_capability: wrapper.host_compaction_capability,
      probe_call_count: wrapper.probe_elapsed_ms.length,
      probe_elapsed_ms: wrapper.probe_elapsed_ms,
      probe_compaction_id_shape_valid: scenario !== "probe-fallback" || (
        observedProbeCompactionIds.length === 1 &&
        /^probe-[a-f0-9]{64}$/u.test(observedProbeCompactionIds[0])
      ),
      launcher_counts: wrapper.launcher_counts,
      controller_git_invocation_count: controllerGitInvocationCount,
      head_commit_delta: headCommitDelta,
      checkpoint_exists: existsSync(path.join(workspaceRoot, "SESSION_CHECKPOINT.md")),
      extra_file_count: extraFileCount,
      legacy_expected_artifact_exists: existsSync(path.join(workspaceRoot, "never-created.json")),
      legacy_contract_fields_present: plan.slices.every((slice) =>
        Array.isArray(slice.contract.owned_paths) &&
        Array.isArray(slice.contract.checks) &&
        Array.isArray(slice.contract.expected_artifacts)
      ),
      state_file_count: stateScan.fileCount,
      state_total_bytes: stateScan.totalBytes,
      snapshot: { bytes: snapshot.bytes, digest: snapshot.digest },
      run_events: { bytes: runEvents.bytes, digest: runEvents.digest, count: events.length },
      effects: {
        bytes: effects.bytes,
        digest: effects.digest,
        count: JSON.parse(effects.json).length,
      },
      terminal_receipt: { bytes: decision.bytes, digest: decision.digest },
      source_thread_id: loaded.state.source_thread_id,
      decision_source_thread_id: normalizedDecision.source_thread_id ?? null,
      compression_task_id: loaded.state.handoff?.compression_task_id ?? null,
      continuation_task_id: loaded.state.handoff?.continuation_task_id ?? null,
      canary_matches: 0,
      scanned_bytes:
        stateScan.totalBytes +
        Buffer.byteLength(executed.stdout, "utf8") +
        Buffer.byteLength(executed.stderr, "utf8") +
        snapshot.bytes +
        runEvents.bytes +
        effects.bytes +
        decision.bytes,
      _normalized: {
        snapshot: snapshot.json,
        run_events: runEvents.json,
        effects: effects.json,
        terminal_receipt: decision.json,
      },
    };
    succeeded = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Retained isolated S16 fixture: ${temporaryRoot}`, { cause: error });
  } finally {
    if (succeeded) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function buildSignalBudget() {
  const firewall = new HostEventFirewall({ now: () => new Date(fixedControlTime) });
  firewall.registerTask({
    run_id: runId,
    slice_id: sliceId,
    thread_id: "thread-s16-signal-budget",
    started_at: fixedControlTime,
  });
  firewall.registerTurn("thread-s16-signal-budget", "turn-s16-signal-budget");
  const signals = [
    firewall.project({
      method: "item/started",
      params: {
        threadId: "thread-s16-signal-budget",
        turnId: "turn-s16-signal-budget",
        item: { id: "compaction-s16-signal-budget", type: "contextCompaction", ignored: canaries[0] },
      },
    }),
    firewall.project({
      method: "turn/completed",
      params: {
        threadId: "thread-s16-signal-budget",
        turn: {
          id: "turn-s16-signal-budget",
          status: "completed",
          completedAt: 1_786_276_801,
          items: [{ type: "agentMessage", text: canaries[0] }],
        },
        ignoredError: canaries[7],
      },
    }),
    firewall.project({
      method: "thread/archived",
      params: { threadId: "thread-s16-signal-budget", preview: canaries[6] },
    }),
    firewall.project({
      method: "model/rerouted",
      params: {
        threadId: "thread-s16-signal-budget",
        turnId: "turn-s16-signal-budget",
        fromModel: "gpt-5.6-sol",
        toModel: "fallback-model",
        reason: canaries[7],
      },
    }),
  ];
  ensure(signals.every((signal) => signal !== DROP), "S16 control signal projection dropped a whitelist event.");
  const dropped = [
    { method: "item/completed", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", item: { id: "message", type: "agentMessage", text: canaries[0] } } },
    { method: "item/completed", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", item: { id: "reasoning", type: "reasoning", content: canaries[1] } } },
    { method: "item/completed", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", item: { id: "command", type: "commandExecution", output: canaries[2] } } },
    { method: "turn/diff/updated", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", diff: canaries[3] } },
    { method: "item/mcpToolCall/progress", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", payload: canaries[4] } },
    { method: "turn/plan/updated", params: { threadId: "thread-s16-signal-budget", turnId: "turn-s16-signal-budget", plan: canaries[5] } },
  ];
  ensure(
    dropped.every((notification) => firewall.project(notification) === DROP),
    "S16 firewall accepted a Worker Content notification.",
  );
  const signalMetrics = signals.map((signal) => {
    const json = canonicalJson(signal);
    assertCanaryFree(json, `ControllerSignal ${signal.type}`);
    const bytes = Buffer.byteLength(json, "utf8");
    ensure(bytes <= maximumControllerSignalBytes, `${signal.type} exceeded the 8 KiB budget.`);
    return { type: signal.type, bytes, fields: Object.keys(signal).sort() };
  });
  return {
    maximum_bytes: Math.max(...signalMetrics.map((entry) => entry.bytes)),
    limit_bytes: maximumControllerSignalBytes,
    signals: signalMetrics,
    dropped_content_categories: canaryTypes.slice(0, 6),
  };
}

function publicScenario(scenario) {
  const { _normalized: ignored, ...result } = scenario;
  void ignored;
  return result;
}

function main() {
  ensure(existsSync(productionRunner), "S16 production runner is missing.");
  const scenarios = [
    captureProductionScenario("normal-short"),
    captureProductionScenario("normal-large"),
    captureProductionScenario("compaction-29999"),
    captureProductionScenario("timeout-revision-available"),
    captureProductionScenario("timeout-revision-unavailable"),
    captureProductionScenario("probe-fallback"),
    captureProductionScenario("worker-failed"),
    captureProductionScenario("worker-interrupted"),
  ];
  const [
    normalShort,
    normalLarge,
    completed29999,
    revisionAvailable,
    revisionUnavailable,
    probeFallback,
    workerFailed,
    workerInterrupted,
  ] = scenarios;
  ensure(
    normalShort._normalized.snapshot === normalLarge._normalized.snapshot &&
      normalShort._normalized.run_events === normalLarge._normalized.run_events &&
      normalShort._normalized.effects === normalLarge._normalized.effects &&
      normalShort._normalized.terminal_receipt === normalLarge._normalized.terminal_receipt,
    "Short and large normal runs changed normalized Controller bytes.",
  );
  ensure(
    normalShort.state_file_count === normalLarge.state_file_count &&
      normalShort.state_total_bytes === normalLarge.state_total_bytes &&
      normalShort.run_events.count === normalLarge.run_events.count,
    "Short and large normal runs changed Controller storage cardinality or bytes.",
  );
  ensure(
    normalShort.run_status === "DONE" &&
      normalLarge.run_status === "DONE" &&
      normalShort.outcome === "DONE" &&
      normalLarge.outcome === "DONE" &&
      normalShort.completed_slice_count === 2 &&
      normalLarge.completed_slice_count === 2 &&
      normalShort.development_start_count === 2 &&
      normalLarge.development_start_count === 2 &&
      normalShort.commit_mode === "after_slice" &&
      normalLarge.commit_mode === "after_slice" &&
      normalShort.head_commit_delta === 0 &&
      normalLarge.head_commit_delta === 0 &&
      normalShort.checkpoint_exists === false &&
      normalLarge.checkpoint_exists === false &&
      normalShort.extra_file_count === 2 &&
      normalLarge.extra_file_count === 2 &&
      normalShort.legacy_expected_artifact_exists === false &&
      normalLarge.legacy_expected_artifact_exists === false &&
      normalShort.legacy_contract_fields_present === true &&
      normalLarge.legacy_contract_fields_present === true &&
      [normalShort, normalLarge].every((entry) =>
        entry.run_status_chain.every((status) =>
          !["VERIFYING", "COMMITTING", "CHECKPOINTING"].includes(status)
        )
      ),
    "Two-Slice trusted completion still depends on commit, checkpoint, owned paths, checks, or artifacts.",
  );
  ensure(
    completed29999.run_status === "DONE" &&
      completed29999.outcome === "DONE" &&
      completed29999.host_clock_offsets_used[2] - completed29999.host_clock_offsets_used[1] === 29_999 &&
      completed29999.summary_only_thread_read_count === 0 &&
      completed29999.host_compaction_capability === "AVAILABLE" &&
      completed29999.probe_call_count === 0,
    "The 29.999 second compaction completion boundary drifted.",
  );
  ensure(
    revisionAvailable.outcome === "CONTINUATION_STARTED" &&
      revisionAvailable.run_status === "SLICE_RUNNING" &&
      revisionAvailable.summary_only_thread_read_count === 1 &&
      revisionAvailable.launcher_counts.compression_starts === 1 &&
      revisionAvailable.launcher_counts.continuation_starts === 1 &&
      revisionAvailable.source_thread_id === revisionAvailable.continuation_task_id &&
      revisionAvailable.compression_task_id !== null &&
      revisionAvailable.host_compaction_capability === "AVAILABLE" &&
      revisionAvailable.probe_call_count === 0 &&
      new Set([
        revisionAvailable.decision_source_thread_id,
        revisionAvailable.compression_task_id,
        revisionAvailable.continuation_task_id,
      ]).size === 3,
    "The revision-available timeout path did not preserve Source/Compression/Continuation semantics.",
  );
  ensure(
    revisionUnavailable.outcome === "FAIL_CLOSED" &&
      revisionUnavailable.run_status === "NEEDS_USER" &&
      revisionUnavailable.error_code === "source_interrupt_failed" &&
      revisionUnavailable.summary_only_thread_read_count === 0 &&
      revisionUnavailable.launcher_counts.compression_starts === 0 &&
      revisionUnavailable.launcher_counts.continuation_starts === 0 &&
      revisionUnavailable.probe_call_count === 0,
    "The revision-unavailable timeout path did not fail closed before Handoff.",
  );
  ensure(
    probeFallback.run_status === "DONE" &&
      probeFallback.outcome === "DONE" &&
      probeFallback.host_compaction_capability === "UNAVAILABLE" &&
      probeFallback.probe_call_count === 1 &&
      JSON.stringify(probeFallback.probe_elapsed_ms) === JSON.stringify([20 * 60_000]) &&
      probeFallback.probe_compaction_id_shape_valid === true &&
      probeFallback.summary_only_thread_read_count === 0,
    "The explicit Host-capability fallback did not use exactly one bounded 20-minute probe.",
  );
  ensure(
    [workerFailed, workerInterrupted].every((failure) =>
      failure.run_status === "NEEDS_USER" &&
      failure.outcome === "FAIL_CLOSED" &&
      failure.error_code === "slice_execution_failed" &&
      failure.current_slice_id === "S16-failure-a" &&
      failure.completed_slice_count === 0 &&
      failure.development_start_count === 1
    ),
    "FAILED or INTERRUPTED Worker turns did not stop before the next Slice.",
  );
  ensure(
    scenarios.every((entry) =>
      entry.full_turn_read_count === 0 &&
      entry.canary_matches === 0 &&
      entry.controller_git_invocation_count === 0
    ),
    "A S16 scenario crossed the content-blind boundary.",
  );
  const signalBudget = buildSignalBudget();
  const report = {
    schema_version: 1,
    slice_id: "S16",
    result: "PASS",
    signal_budget: signalBudget,
    acceptance_matrix: {
      trusted_completion: {
        slice_count: normalShort.completed_slice_count,
        legacy_acceptance_states_seen: normalShort.run_status_chain.some((status) =>
          ["VERIFYING", "COMMITTING", "CHECKPOINTING"].includes(status)
        ),
        commit_mode: normalShort.commit_mode,
        head_commit_delta: normalShort.head_commit_delta,
        checkpoint_exists: normalShort.checkpoint_exists,
        arbitrary_extra_files: normalShort.extra_file_count,
        missing_expected_artifact_ignored: !normalShort.legacy_expected_artifact_exists,
      },
      failure_closure: {
        failed: { run_status: workerFailed.run_status, error_code: workerFailed.error_code },
        interrupted: {
          run_status: workerInterrupted.run_status,
          error_code: workerInterrupted.error_code,
        },
        next_slice_starts:
          workerFailed.development_start_count + workerInterrupted.development_start_count - 2,
      },
      compaction_observability: {
        event_path_probe_calls: completed29999.probe_call_count,
        fallback_probe_calls: probeFallback.probe_call_count,
        fallback_probe_elapsed_ms: probeFallback.probe_elapsed_ms,
        timeout_continuation_tasks_distinct: true,
      },
      controller_observation: {
        git_process_calls: scenarios.reduce(
          (sum, entry) => sum + entry.controller_git_invocation_count,
          0,
        ),
        full_turn_reads: scenarios.reduce((sum, entry) => sum + entry.full_turn_read_count, 0),
        worker_content_matches: 0,
      },
      compatibility: {
        production_plan_version: 1,
        legacy_slice_fields_present_and_inert: normalShort.legacy_contract_fields_present,
        legacy_acceptance_snapshot_tests_required: true,
      },
    },
    normal_content_equivalence: {
      compared_surfaces: ["Run snapshot", "effect ledger", "terminal receipt", "Run event bytes"],
      snapshot_digest: normalShort.snapshot.digest,
      effect_ledger_digest: normalShort.effects.digest,
      terminal_receipt_digest: normalShort.terminal_receipt.digest,
      run_event_digest: normalShort.run_events.digest,
      state_file_count: normalShort.state_file_count,
      state_total_bytes: normalShort.state_total_bytes,
      run_event_count: normalShort.run_events.count,
      equal: true,
    },
    canary_scan: {
      canary_types: canaryTypes,
      scanned_surfaces: [
        "ControllerSignal",
        "Run snapshot",
        "effect ledger",
        "terminal receipt",
        "Run event ledger",
        "Controller state directory",
        "harness stdout",
        "harness stderr",
        "error projection",
        "isolated probe projection",
      ],
      scenario_count: scenarios.length,
      state_files_scanned: scenarios.reduce((sum, scenario) => sum + scenario.state_file_count, 0),
      bytes_scanned: scenarios.reduce((sum, scenario) => sum + scenario.scanned_bytes, 0),
      matches: 0,
    },
    revision_gate: {
      available: {
        run_status: revisionAvailable.run_status,
        outcome: revisionAvailable.outcome,
        summary_only_thread_reads: revisionAvailable.summary_only_thread_read_count,
        source_thread_id: revisionAvailable.decision_source_thread_id,
        compression_task_id: revisionAvailable.compression_task_id,
        continuation_task_id: revisionAvailable.continuation_task_id,
        final_source_is_continuation: true,
      },
      unavailable: {
        run_status: revisionUnavailable.run_status,
        outcome: revisionUnavailable.outcome,
        error_code: revisionUnavailable.error_code,
        full_turn_read_count: revisionUnavailable.full_turn_read_count,
        compression_starts: revisionUnavailable.launcher_counts.compression_starts,
        continuation_starts: revisionUnavailable.launcher_counts.continuation_starts,
      },
      probe_fallback: {
        run_status: probeFallback.run_status,
        outcome: probeFallback.outcome,
        probe_calls: probeFallback.probe_call_count,
        probe_elapsed_ms: probeFallback.probe_elapsed_ms,
      },
    },
    scenarios: scenarios.map(publicScenario),
  };
  assertCanaryFree(canonicalJson(report), "S16 evidence report");
  process.stdout.write(`${canonicalJson(report)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
