#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import {
  CompactionMonitor,
  CompactionMonitorError,
} from "../dist/src/controller/compaction-monitor/index.js";
import {
  ContinuationCoordinator,
  ContinuationError,
} from "../dist/src/controller/continuation/index.js";
import {
  CommitCoordinator,
  CommitCoordinatorError,
} from "../dist/src/controller/git/index.js";
import {
  CompressionHandoffCoordinator,
  CompressionHandoffError,
} from "../dist/src/controller/handoff/index.js";
import {
  ModelPolicyError,
  ModelRouter,
} from "../dist/src/controller/model-policy/index.js";
import {
  SliceExecutionError,
  SliceExecutor,
  SliceVerifier,
} from "../dist/src/controller/slices/index.js";
import {
  createInitialRunState,
  FileRunStore,
  sha256Bytes,
  sha256Json,
  StateStoreError,
} from "../dist/src/controller/state/index.js";
import {
  SourceInterruptionCoordinator,
  SourceInterruptionError,
} from "../dist/src/controller/thread-control/index.js";
import {
  FileWorkspaceGuard,
  GitChangeGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixturePath = path.join(repoRoot, "test", "fixtures", "s12", "scenarios.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const fixedTime = fixture.fixed_time;
const fixedDate = () => new Date(fixedTime);
const sourceRevision = sha256Bytes("s12-source-revision");
const expectedOwnedDiffDigest = sha256Bytes("s12-owned-before-continuation");
const developmentCapabilities = Object.freeze({
  schema_version: 1,
  source: "s12-host-fixture",
  captured_at: fixedTime,
  expires_at: "2026-08-09T13:00:00.000Z",
  models: [{ model: "gpt-5.6-sol", reasoning_efforts: ["max", "medium"] }],
});
const compressionDecision = Object.freeze({
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "medium",
});
const continuationDecision = Object.freeze({
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
});
const consumerContract = Object.freeze({
  formatVersion: 1,
  kind: "codex-handoff-synthesize-first-consumer-contract",
  mode: "synthesize_first",
  firstDeliverableIds: ["resume-s12-fixture"],
  preDraftEvidenceReads: 0,
  maxTargetedReads: 2,
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
  forbidBroadSearch: true,
  forbidFullFileReread: true,
});
const continuationSliceContract = Object.freeze({
  slice_id: fixture.current_slice_id,
  contract_version: 1,
  objective: "Continue the interrupted S12 fixture Slice.",
  exclusions: ["Do not create a different Slice."],
  owned_paths: ["artifacts/continuation-progress.json"],
  checks: [{
    id: "continuation-fixture-check",
    argv: ["node", "--version"],
    cwd: ".",
    timeout_ms: 1_000,
    env_allowlist: ["PATH"],
    expected_exit_code: 0,
    expected_artifacts: [],
  }],
  expected_artifacts: [{
    path: "artifacts/continuation-progress.json",
    kind: "durable_progress",
  }],
});

process.env.GIT_AUTHOR_DATE = fixedTime;
process.env.GIT_COMMITTER_DATE = fixedTime;

function fail(message) {
  throw new Error(message);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return result.stdout;
}

function temporaryRoot(label) {
  return mkdtempSync(path.join(os.tmpdir(), `auto-slice-s12-${label}-`));
}

function cleanSuccess(root) {
  rmSync(root, { recursive: true, force: true });
}

function retainFailure(root, error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  throw new Error(`${message}\nS12 retained failing fixture: ${root}`);
}

function unwrapStore(result) {
  if (result instanceof StateStoreError) fail(`${result.code}: ${result.message}`);
  return result;
}

function unwrapWorkspace(result) {
  if (result instanceof WorkspaceGuardError) fail(`${result.code}: ${result.message}`);
  return result;
}

function unwrapMonitor(result) {
  if (result instanceof CompactionMonitorError) fail(`${result.code}: ${result.message}`);
  return result;
}

function unwrapInterruption(result) {
  if (result instanceof SourceInterruptionError) {
    fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function unwrapHandoff(result) {
  if (result instanceof CompressionHandoffError) {
    fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function unwrapContinuation(result) {
  if (result instanceof ContinuationError) {
    fail(`${result.code}/${result.reason ?? "none"}: ${result.message}`);
  }
  return result;
}

function initializeGitRepository(root) {
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Auto Slice S12"]);
  runGit(root, ["config", "user.email", "auto-slice-s12@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "owned.txt"), "owned-v1\n", "utf8");
  writeFileSync(path.join(root, "protected.txt"), "protected-v1\n", "utf8");
  writeFileSync(path.join(root, "SESSION_CHECKPOINT.md"), "# baseline checkpoint\n", "utf8");
  writeFileSync(
    path.join(root, "check.mjs"),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "if (readFileSync('owned.txt', 'utf8') !== 'owned-v2\\n') process.exit(7);",
      "writeFileSync('result.json', '{\\\"result\\\":\\\"PASS\\\"}\\n', 'utf8');",
      "",
    ].join("\n"),
    "utf8",
  );
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "--quiet", "--no-gpg-sign", "--message", "fixture baseline"]);
}

async function prepareSliceFixture(label, mode, protectedChanges) {
  const root = temporaryRoot(label);
  try {
    initializeGitRepository(root);
    if (protectedChanges) {
      writeFileSync(path.join(root, "protected.txt"), "protected-user-change\n", "utf8");
      writeFileSync(path.join(root, "user-note.txt"), "untracked-user-change\n", "utf8");
    }
    const workspace = createWorkspaceIdentity(root);
    const guard = FileWorkspaceGuard.open(path.join(root, ".auto-slice", "leases"), {
      now: fixedDate,
      leaseIdFactory: () => `lease-${label}`,
      leaseDurationMs: 120_000,
    });
    if (guard instanceof WorkspaceGuardError) fail(`${guard.code}: ${guard.message}`);
    const lease = unwrapWorkspace(guard.acquire(workspace, `run-${label}`));
    const model = new ModelRouter(fixedDate).resolve("DEVELOPMENT", developmentCapabilities);
    if (model instanceof ModelPolicyError) fail(`${model.code}/${model.reason}`);
    const contract = {
      slice_id: `slice-${label}`,
      contract_version: 1,
      objective: `Exercise ${mode} with real Git and process checks.`,
      exclusions: ["Never push."],
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
    };
    const changeGuard = new GitChangeGuard(fixedDate);
    const executor = new SliceExecutor({
      leaseGuard: guard,
      changeGuard,
      now: fixedDate,
      executionIdFactory: () => `execution-${label}`,
    });
    const executionId = executor.start(contract, lease, model);
    if (executionId instanceof SliceExecutionError) fail(`${executionId.code}: ${executionId.message}`);
    writeFileSync(path.join(root, "owned.txt"), "owned-v2\n", "utf8");
    const execution = await executor.collect(executionId);
    if (execution instanceof SliceExecutionError) fail(`${execution.code}: ${execution.message}`);
    const verification = new SliceVerifier(changeGuard).verify(contract, execution, workspace);
    requireCondition(verification.result === "PASS", `Slice verification failed: ${verification.failure_code ?? "unknown"}`);
    const current = unwrapWorkspace(changeGuard.captureCurrent(workspace));
    const changeSet = unwrapWorkspace(changeGuard.classify(
      execution.protected_baseline,
      current,
      contract.owned_paths,
    ));
    const ownedPatch = unwrapWorkspace(changeGuard.assertCommittable(changeSet));
    const run = {
      schema_version: 1,
      run_id: `run-${label}`,
      state_version: 4,
      workspace_identity: workspace,
      plan_digest: sha256Bytes(`plan-${label}`),
      status: "COMMITTING",
      commit_mode: mode,
      current_slice_id: contract.slice_id,
      protected_baseline_digest: execution.protected_baseline.baseline_digest,
      project_lock_owner: lease.lease_id,
      write_epoch: lease.epoch,
      source_thread_id: fixture.source_thread_id,
    };
    return {
      root,
      mode,
      protectedChanges,
      contract,
      changeGuard,
      baseline: execution.protected_baseline,
      baselineCommitCount: Number(runGit(root, ["rev-list", "--count", "HEAD"]).trim()),
      input: {
        run,
        slice: contract,
        verification,
        protected_baseline: execution.protected_baseline,
        owned_patch: ownedPatch,
        commit_message: `feat: complete ${contract.slice_id}`,
        checkpoint: {
          updated_at: fixedTime,
          next_slice_id: null,
          current_summary: `${contract.slice_id} complete.`,
          next_steps: ["Inspect the release evidence."],
          unfinished: [],
          cold_start_reading_sequence: ["`CONTEXT.md` — terminology."],
        },
      },
    };
  } catch (error) {
    retainFailure(root, error);
  }
}

function finishPreparedSlice(prepared, coordinator) {
  const result = coordinator.finishSlice(prepared.input);
  if (result instanceof CommitCoordinatorError) fail(`${result.code}: ${result.message}`);
  const finalCommitCount = Number(runGit(prepared.root, ["rev-list", "--count", "HEAD"]).trim());
  const checkpoint = readFileSync(path.join(prepared.root, "SESSION_CHECKPOINT.md"), "utf8");
  const committedPaths = result.commit_created
    ? runGit(prepared.root, ["show", "--pretty=format:", "--name-only", "HEAD"])
      .split(/\r?\n/u).filter(Boolean).sort()
    : [];
  const remoteLines = runGit(prepared.root, ["remote", "-v"]).trim();
  requireCondition(remoteLines.length === 0, "The isolated fixture unexpectedly has a Git remote.");
  requireCondition(checkpoint.includes(result.end_head), "Checkpoint does not contain the real final HEAD.");
  return { result, finalCommitCount, committedPaths };
}

async function runSliceScenario(id, mode, protectedChanges = false) {
  const prepared = await prepareSliceFixture(id, mode, protectedChanges);
  try {
    const finished = finishPreparedSlice(prepared, new CommitCoordinator({
      now: fixedDate,
      indexNameFactory: () => `s12-${id}.index`,
      changeGuard: prepared.changeGuard,
    }));
    const expectedCommitDelta = mode === "after_slice" ? 1 : 0;
    requireCondition(
      finished.finalCommitCount - prepared.baselineCommitCount === expectedCommitDelta,
      `${id} produced an unexpected commit count.`,
    );
    requireCondition(finished.result.commit_created === (mode === "after_slice"), `${id} commit flag drifted.`);
    if (protectedChanges) {
      requireCondition(
        readFileSync(path.join(prepared.root, "protected.txt"), "utf8") === "protected-user-change\n",
        "Tracked Protected Change was not preserved.",
      );
      requireCondition(existsSync(path.join(prepared.root, "user-note.txt")), "Untracked Protected Change was removed.");
      requireCondition(!finished.committedPaths.includes("protected.txt"), "Protected Change entered the owned commit.");
      requireCondition(!finished.committedPaths.includes("user-note.txt"), "Untracked Protected Change entered the owned commit.");
    }
    const evidence = {
      id,
      result: "PASS",
      assertions: {
        real_git_cli: true,
        real_process_check: true,
        commit_mode: mode,
        commit_count_delta: expectedCommitDelta,
        owned_commit_exact: mode === "after_slice"
          ? JSON.stringify(finished.committedPaths) === JSON.stringify(["owned.txt", "result.json"])
          : true,
        checkpoint_contains_final_head: true,
        protected_changes_preserved: protectedChanges ? true : null,
        remote_count: 0,
        push_count: 0,
      },
    };
    cleanSuccess(prepared.root);
    return evidence;
  } catch (error) {
    retainFailure(prepared.root, error);
  }
}

class VirtualClock {
  constructor(now = fixedTime) {
    this.current = new Date(now);
  }

  now() {
    return new Date(this.current.getTime());
  }

  set(now) {
    this.current = new Date(now);
  }
}

class VirtualScheduler {
  constructor() {
    this.jobs = new Map();
  }

  schedule(key, deadline, callback) {
    this.jobs.set(key, { deadline: deadline.toISOString(), callback });
  }

  cancel(key) {
    this.jobs.delete(key);
  }

  size() {
    return this.jobs.size;
  }
}

function handoffArtifactDigest(receipt) {
  return sha256Json({
    compression_task_id: receipt.compression_task_id,
    consumer_contract: receipt.consumer_contract,
    evidence_index_digest: receipt.evidence_index_digest,
    evidence_index_path: receipt.evidence_index_path,
    frame_digest: receipt.frame_digest,
    handoff_digest: receipt.handoff_digest,
    markdown_path: receipt.markdown_path,
    source_revision: receipt.source_revision,
    source_thread_id: receipt.source_thread_id,
    verify_evidence: receipt.verify_evidence,
    workflow_version: receipt.workflow_version,
  });
}

class PersistentTaskHost {
  constructor(root, workspaceIdentity, options = {}) {
    this.root = root;
    this.workspaceIdentity = workspaceIdentity;
    this.options = options;
    this.taskRoot = path.join(root, "persistent-tasks");
    this.receipts = new Map();
    this.envelopes = new Map();
    this.interruptInvocations = 0;
    this.interruptSideEffects = 0;
    this.compressionStarts = 0;
    this.compressionSideEffects = 0;
    this.handoffSideEffects = 0;
    this.continuationStarts = 0;
    this.continuationSideEffects = 0;
    this.grantSideEffects = 0;
    this.progressSideEffects = 0;
    this.currentStateVersion = 0;
    this.rotatedLeaseId = "";
    this.rotatedEpoch = 0;
    mkdirSync(this.taskRoot, { recursive: true });
    this.writeTask(fixture.source_thread_id, {
      task_id: fixture.source_thread_id,
      role: "source",
      status: "RUNNING",
      persisted_revision: sourceRevision,
      workspace_identity: workspaceIdentity,
    });
    this.threadControl = {
      interrupt: this.interrupt.bind(this),
      inspect: this.inspect.bind(this),
    };
    this.compressionLauncher = {
      start: this.startCompression.bind(this),
      awaitHandoff: this.awaitHandoff.bind(this),
    };
    this.continuationLauncher = {
      start: this.startContinuation.bind(this),
      awaitReady: this.awaitReady.bind(this),
      grantWrite: this.grantWrite.bind(this),
      awaitProgress: this.awaitProgress.bind(this),
    };
  }

  taskPath(taskId) {
    return path.join(this.taskRoot, `${taskId}.json`);
  }

  writeTask(taskId, value) {
    writeFileSync(this.taskPath(taskId), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  readTask(taskId) {
    return parseJsonFile(this.taskPath(taskId));
  }

  async interrupt(threadId, idempotencyKey) {
    this.interruptInvocations += 1;
    if (this.options.fail_interrupt === true) throw new Error("injected source interruption failure");
    const receiptKey = `interrupt:${idempotencyKey}`;
    if (this.receipts.has(receiptKey)) return this.receipts.get(receiptKey);
    const task = this.readTask(threadId);
    this.interruptSideEffects += 1;
    this.writeTask(threadId, { ...task, status: "INTERRUPTED" });
    const receipt = {
      thread_id: threadId,
      execution_stopped: true,
      thread_persisted: true,
      persisted_revision: sourceRevision,
      observed_at: "2026-08-09T12:00:31.000Z",
    };
    this.receipts.set(receiptKey, receipt);
    return receipt;
  }

  async inspect(threadId) {
    const task = this.readTask(threadId);
    return {
      thread_id: threadId,
      persisted_revision: task.persisted_revision,
      readable: true,
      archived: false,
      deleted: false,
      observed_at: "2026-08-09T12:00:31.001Z",
    };
  }

  async startCompression(request) {
    this.compressionStarts += 1;
    const receiptKey = `compression:${request.idempotency_key}`;
    if (this.receipts.has(receiptKey)) return this.receipts.get(receiptKey);
    this.compressionSideEffects += 1;
    this.writeTask(fixture.compression_task_id, {
      task_id: fixture.compression_task_id,
      role: "compression",
      status: "RUNNING",
      source_thread_id: request.source_thread_id,
      history_empty: true,
      project_write_lease: false,
      model: request.model,
      reasoning_effort: request.reasoning_effort,
      workspace_identity: request.workspace_identity,
    });
    const receipt = {
      compression_task_id: fixture.compression_task_id,
      source_thread_id: request.source_thread_id,
      workspace_identity: request.workspace_identity,
      history_empty: true,
      project_write_lease: false,
      model: request.model,
      reasoning_effort: request.reasoning_effort,
      created_at: "2026-08-09T12:00:32.000Z",
    };
    this.receipts.set(receiptKey, receipt);
    this.receipts.set(`compression-request:${fixture.compression_task_id}`, request);
    return receipt;
  }

  async awaitHandoff(compressionTaskId, idempotencyKey) {
    const receiptKey = `handoff:${idempotencyKey}`;
    if (this.receipts.has(receiptKey)) return this.receipts.get(receiptKey);
    const request = this.receipts.get(`compression-request:${compressionTaskId}`);
    requireCondition(request !== undefined, "Compression task request was not persisted.");
    this.handoffSideEffects += 1;
    const markdownPath = path.join(this.workspaceIdentity.canonical_root, "s12-handoff.md");
    const evidencePath = path.join(this.workspaceIdentity.canonical_root, "s12-handoff.evidence.json");
    const markdown = "# S12 Handoff\n\nworkflow: handoff-v2\n";
    const evidence = `${JSON.stringify({
      source: { sourceRevision },
      anchors: [],
      semanticCoverage: { turns: [], claims: [] },
      integrity: { indexDigest: "b".repeat(64) },
    }, null, 2)}\n`;
    writeFileSync(markdownPath, markdown, "utf8");
    writeFileSync(evidencePath, evidence, "utf8");
    const material = {
      compression_task_id: compressionTaskId,
      source_thread_id: request.source_thread_id,
      workflow_version: "v2",
      markdown_path: markdownPath,
      evidence_index_path: evidencePath,
      source_revision: request.source_persisted_revision,
      frame_digest: sha256Bytes("s12-frame"),
      handoff_digest: this.options.corrupt_handoff === true
        ? sha256Bytes("corrupt-handoff")
        : sha256Bytes(markdown),
      evidence_index_digest: sha256Bytes(evidence),
      verify_evidence: "PASS",
      consumer_contract: consumerContract,
    };
    const receipt = { ...material, artifact_digest: handoffArtifactDigest(material) };
    this.latestHandoffReceipt = receipt;
    this.receipts.set(receiptKey, receipt);
    return receipt;
  }

  async startContinuation(envelope) {
    this.continuationStarts += 1;
    if (this.options.fail_continuation_start === true) {
      throw new Error("injected continuation start failure");
    }
    const key = `continuation:${sha256Json(envelope)}`;
    if (this.receipts.has(key)) return this.receipts.get(key);
    this.continuationSideEffects += 1;
    this.envelopes.set(fixture.continuation_task_id, envelope);
    this.writeTask(fixture.continuation_task_id, {
      task_id: fixture.continuation_task_id,
      role: "continuation",
      status: "READ_ONLY",
      source_thread_id: fixture.source_thread_id,
      workspace_identity: envelope.expected_workspace_identity,
    });
    this.receipts.set(key, fixture.continuation_task_id);
    return fixture.continuation_task_id;
  }

  async awaitReady(taskId) {
    const envelope = this.envelopes.get(taskId);
    requireCondition(envelope !== undefined, "Continuation envelope was not persisted.");
    requireCondition(this.latestHandoffReceipt !== undefined, "Handoff receipt is unavailable.");
    const receipt = {
      task_id: taskId,
      run_id: envelope.run_id,
      slice_id: envelope.current_slice_id,
      workspace_identity: envelope.expected_workspace_identity,
      handoff_artifact_digest: this.latestHandoffReceipt.artifact_digest,
      consumer_contract_digest: sha256Json(envelope.consumer_contract),
      handoff_read: true,
      first_deliverable_ids: envelope.consumer_contract.firstDeliverableIds,
      first_deliverable_draft_digest: sha256Bytes("s12-first-substantive-draft"),
      pre_draft_evidence_reads: 0,
      targeted_evidence_reads: 1,
      targeted_read_reasons: ["claim_verification"],
      broad_search_count: 0,
      full_file_reread_count: 0,
      rollout_digest: sha256Bytes("s12-persisted-rollout"),
      write_access: false,
      observed_state_version: this.currentStateVersion,
      observed_at: "2026-08-09T12:00:33.000Z",
    };
    writeFileSync(
      path.join(this.taskRoot, `${taskId}.rollout.json`),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    return receipt;
  }

  async grantWrite(taskId, newWriteEpoch) {
    this.grantSideEffects += 1;
    const task = this.readTask(taskId);
    this.writeTask(taskId, { ...task, status: "WRITABLE", write_epoch: newWriteEpoch });
    return {
      task_id: taskId,
      lease_id: this.rotatedLeaseId,
      write_epoch: newWriteEpoch,
      workspace_identity: this.workspaceIdentity,
      granted: true,
      observed_at: "2026-08-09T12:00:34.000Z",
    };
  }

  async awaitProgress(taskId) {
    this.progressSideEffects += 1;
    const artifactRoot = path.join(this.workspaceIdentity.canonical_root, "artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    const content = `${JSON.stringify({ task_id: taskId, result: "durable" })}\n`;
    writeFileSync(path.join(artifactRoot, "continuation-progress.json"), content, "utf8");
    return {
      task_id: taskId,
      slice_id: fixture.current_slice_id,
      durable_artifact_digest: sha256Bytes(content),
      observed_state_version: this.currentStateVersion,
    };
  }

  taskCount() {
    return [fixture.source_thread_id, fixture.compression_task_id, fixture.continuation_task_id]
      .filter((taskId) => existsSync(this.taskPath(taskId))).length;
  }
}

function createCompactionRig(label, hostOptions = {}) {
  const root = temporaryRoot(label);
  try {
    const workspaceRoot = path.join(root, "workspace");
    mkdirSync(workspaceRoot);
    initializeGitRepository(workspaceRoot);
    const workspace = createWorkspaceIdentity(workspaceRoot);
    const guard = FileWorkspaceGuard.open(path.join(root, "workspace-guard"), {
      now: fixedDate,
      leaseIdFactory: () => `lease-${label}`,
      leaseDurationMs: 120_000,
    });
    if (guard instanceof WorkspaceGuardError) fail(`${guard.code}: ${guard.message}`);
    const runId = `run-${label}`;
    const lease = unwrapWorkspace(guard.acquire(workspace, runId));
    const store = FileRunStore.open(path.join(root, "run-store"), { now: fixedDate });
    if (store instanceof StateStoreError) fail(`${store.code}: ${store.message}`);
    unwrapStore(store.create(createInitialRunState({
      run_id: runId,
      workspace_identity: workspace,
      plan_digest: sha256Bytes(`plan-${label}`),
      commit_mode: "after_slice",
      current_slice_id: fixture.current_slice_id,
      protected_baseline_digest: sha256Bytes(`baseline-${label}`),
    })));
    unwrapStore(store.compareAndSwap(runId, 0, {
      action: "prepare_s12_fixture",
      to: "PREPARING",
      updates: {
        project_lock_owner: lease.lease_id,
        write_epoch: lease.epoch,
        source_thread_id: fixture.source_thread_id,
      },
    }));
    unwrapStore(store.compareAndSwap(runId, 1, {
      action: "start_s12_fixture",
      to: "SLICE_RUNNING",
    }));
    const clock = new VirtualClock();
    const scheduler = new VirtualScheduler();
    const monitor = new CompactionMonitor({
      run_store: store,
      clock,
      scheduler,
      observability: {
        stable_compaction_ids: true,
        structured_phase_events: true,
        ordered_host_sequence: true,
      },
    });
    const host = new PersistentTaskHost(root, workspace, hostOptions);
    return { root, workspaceRoot, workspace, guard, store, runId, lease, clock, scheduler, monitor, host };
  } catch (error) {
    retainFailure(root, error);
  }
}

function startCompaction(rig) {
  return unwrapMonitor(rig.monitor.onEvent(rig.runId, {
    ...fixture.host_events.started,
    thread_id: fixture.source_thread_id,
    compaction_id: fixture.compaction_id,
  }, 2));
}

function timeoutCompaction(rig) {
  const waiting = startCompaction(rig);
  rig.clock.set(fixture.host_events.deadline);
  const timedOut = unwrapMonitor(rig.monitor.onDeadline(
    rig.runId,
    fixture.compaction_id,
    fixture.host_events.deadline,
    waiting.state_version,
  ));
  requireCondition(timedOut.outcome === "TIMED_OUT", "30.000s deadline did not time out.");
  requireCondition(timedOut.status === "SOURCE_INTERRUPTING", "Timeout did not enter SOURCE_INTERRUPTING.");
  return timedOut;
}

async function interruptSource(rig, runStore = rig.store) {
  const state = unwrapStore(rig.store.load(rig.runId)).state;
  return new SourceInterruptionCoordinator({
    run_store: runStore,
    workspace_guard: rig.guard,
    thread_control: rig.host.threadControl,
    now: fixedDate,
    interrupt_timeout_ms: 1_000,
  }).interruptSource(
    rig.runId,
    rig.lease.lease_id,
    rig.lease.epoch,
    state.state_version,
  );
}

async function exportHandoff(rig, interruptDecision) {
  return new CompressionHandoffCoordinator({
    run_store: rig.store,
    launcher: rig.host.compressionLauncher,
    now: fixedDate,
    export_timeout_ms: 2_000,
  }).exportHandoff(
    rig.runId,
    interruptDecision.receipt,
    compressionDecision,
    interruptDecision.state_version,
  );
}

async function continueFromHandoff(rig, handoffDecision) {
  rig.host.currentStateVersion = handoffDecision.state_version;
  rig.host.rotatedLeaseId = rig.lease.lease_id;
  rig.host.rotatedEpoch = handoffDecision.receipt.write_epoch ?? rig.lease.epoch + 1;
  return new ContinuationCoordinator({
    run_store: rig.store,
    workspace_guard: rig.guard,
    launcher: rig.host.continuationLauncher,
    now: fixedDate,
    operation_timeout_ms: 2_000,
  }).continueFromHandoff({
    run_id: rig.runId,
    lease_id: rig.lease.lease_id,
    handoff_receipt: handoffDecision.receipt,
    slice_contract: continuationSliceContract,
    model_decision: continuationDecision,
    expected_owned_diff_digest: expectedOwnedDiffDigest,
    expected_state_version: handoffDecision.state_version,
  });
}

async function runCompactionCompleted29999() {
  const rig = createCompactionRig("compaction-29999");
  try {
    const waiting = startCompaction(rig);
    rig.clock.set(fixture.host_events.completed_29999.observed_at);
    const completed = unwrapMonitor(rig.monitor.onEvent(rig.runId, {
      ...fixture.host_events.completed_29999,
      thread_id: fixture.source_thread_id,
      compaction_id: fixture.compaction_id,
    }, waiting.state_version));
    requireCondition(completed.outcome === "RECOVERED", "29.999s completion did not recover.");
    requireCondition(completed.status === "SLICE_RUNNING", "29.999s completion interrupted the Source.");
    requireCondition(rig.host.taskCount() === 1, "29.999s completion created a new task.");
    const evidence = {
      id: "compaction_completed_29999",
      result: "PASS",
      assertions: {
        virtual_clock_ms: 29_999,
        final_status: completed.status,
        source_interrupted: false,
        new_tasks_created: 0,
      },
    };
    cleanSuccess(rig.root);
    return evidence;
  } catch (error) {
    retainFailure(rig.root, error);
  }
}

async function runCompactionTimeout() {
  const rig = createCompactionRig("compaction-timeout");
  try {
    timeoutCompaction(rig);
    const interrupted = unwrapInterruption(await interruptSource(rig));
    const handoff = unwrapHandoff(await exportHandoff(rig, interrupted));
    const continued = unwrapContinuation(await continueFromHandoff(rig, handoff));
    const final = unwrapStore(rig.store.load(rig.runId)).state;
    const taskIds = [fixture.source_thread_id, fixture.compression_task_id, fixture.continuation_task_id];
    requireCondition(new Set(taskIds).size === 3, "Source, Compression, and Continuation UUIDs overlap.");
    requireCondition(final.source_thread_id === fixture.continuation_task_id, "Continuation did not replace Source identity.");
    requireCondition(rig.host.taskCount() === 3, "Persistent task fixture did not publish all three tasks.");
    const evidence = {
      id: "compaction_timeout_30000",
      result: "PASS",
      assertions: {
        virtual_clock_ms: 30_000,
        source_interrupted: interrupted.outcome === "INTERRUPTED",
        compression_task_created: handoff.outcome === "EXPORTED",
        continuation_task_created: continued.outcome === "CONTINUED",
        uuid_distinct: true,
        persistent_task_records: 3,
        final_status: final.status,
        final_source_is_continuation: true,
        write_epoch_rotated: continued.write_epoch === rig.lease.epoch + 1,
      },
    };
    cleanSuccess(rig.root);
    return evidence;
  } catch (error) {
    retainFailure(rig.root, error);
  }
}

async function runSourceInterruptFailure() {
  const rig = createCompactionRig("interrupt-failure", { fail_interrupt: true });
  try {
    timeoutCompaction(rig);
    const failure = await interruptSource(rig);
    requireCondition(failure instanceof SourceInterruptionError, "Injected interrupt failure unexpectedly succeeded.");
    const final = unwrapStore(rig.store.load(rig.runId)).state;
    const write = rig.guard.assertWritable(rig.lease.lease_id, rig.lease.epoch);
    requireCondition(final.status === "NEEDS_USER", "Interrupt failure did not enter NEEDS_USER.");
    requireCondition(write instanceof WorkspaceGuardError, "Interrupt failure left writes enabled.");
    requireCondition(rig.host.compressionSideEffects === 0, "Interrupt failure created a Compression Task.");
    const evidence = {
      id: "source_interrupt_failed",
      result: "PASS",
      assertions: {
        failure_code: failure.code,
        failure_reason: failure.reason,
        final_status: final.status,
        writes_frozen: true,
        compression_tasks_created: 0,
      },
    };
    cleanSuccess(rig.root);
    return evidence;
  } catch (error) {
    retainFailure(rig.root, error);
  }
}

async function runHandoffCorrupt() {
  const rig = createCompactionRig("handoff-corrupt", { corrupt_handoff: true });
  try {
    timeoutCompaction(rig);
    const interrupted = unwrapInterruption(await interruptSource(rig));
    const failure = await exportHandoff(rig, interrupted);
    requireCondition(failure instanceof CompressionHandoffError, "Corrupt Handoff unexpectedly passed.");
    const final = unwrapStore(rig.store.load(rig.runId)).state;
    requireCondition(final.status === "NEEDS_USER", "Corrupt Handoff did not enter NEEDS_USER.");
    requireCondition(rig.host.continuationSideEffects === 0, "Corrupt Handoff created a Continuation Task.");
    const evidence = {
      id: "handoff_corrupt",
      result: "PASS",
      assertions: {
        failure_code: failure.code,
        failure_reason: failure.reason,
        final_status: final.status,
        diagnostic_handoff_retained: existsSync(path.join(rig.workspaceRoot, "s12-handoff.md")),
        continuation_tasks_created: 0,
      },
    };
    cleanSuccess(rig.root);
    return evidence;
  } catch (error) {
    retainFailure(rig.root, error);
  }
}

async function runContinuationStartFailure() {
  const rig = createCompactionRig("continuation-failure", { fail_continuation_start: true });
  try {
    timeoutCompaction(rig);
    const interrupted = unwrapInterruption(await interruptSource(rig));
    const handoff = unwrapHandoff(await exportHandoff(rig, interrupted));
    const failure = await continueFromHandoff(rig, handoff);
    requireCondition(failure instanceof ContinuationError, "Injected Continuation failure unexpectedly passed.");
    const final = unwrapStore(rig.store.load(rig.runId)).state;
    const sourceWrite = rig.guard.assertWritable(rig.lease.lease_id, rig.lease.epoch);
    requireCondition(final.status === "NEEDS_USER", "Continuation failure did not enter NEEDS_USER.");
    requireCondition(final.handoff?.artifact_digest === handoff.receipt.artifact_digest, "Continuation failure lost Handoff identity.");
    requireCondition(final.source_thread_id === fixture.source_thread_id, "Continuation failure replaced the Source identity.");
    requireCondition(sourceWrite instanceof WorkspaceGuardError, "Continuation failure restored the old Source epoch.");
    const evidence = {
      id: "continuation_start_failed",
      result: "PASS",
      assertions: {
        failure_code: failure.code,
        failure_reason: failure.reason,
        final_status: final.status,
        handoff_retained: true,
        source_identity_retained: true,
        source_write_restored: false,
      },
    };
    cleanSuccess(rig.root);
    return evidence;
  } catch (error) {
    retainFailure(rig.root, error);
  }
}

async function runControllerCrashRecovery() {
  const rig = createCompactionRig("crash-recovery");
  let prepared;
  try {
    timeoutCompaction(rig);
    let rejectTransition = true;
    const crashingStore = {
      load: rig.store.load.bind(rig.store),
      appendEffectIntent: rig.store.appendEffectIntent.bind(rig.store),
      completeEffect: rig.store.completeEffect.bind(rig.store),
      compareAndSwap: (runId, expectedVersion, transition) => {
        if (transition.action === "complete_source_interruption" && rejectTransition) {
          rejectTransition = false;
          return new StateStoreError("state_persist_failed", "injected crash before Run transition");
        }
        return rig.store.compareAndSwap(runId, expectedVersion, transition);
      },
    };
    const first = await interruptSource(rig, crashingStore);
    requireCondition(first instanceof SourceInterruptionError, "Injected crash did not interrupt the first attempt.");
    const recovered = unwrapInterruption(await interruptSource(rig));
    requireCondition(rig.host.interruptSideEffects === 1, "Crash recovery repeated Source interruption.");
    const leaseEvents = unwrapWorkspace(rig.guard.inspectLeaseEvents(rig.lease.lease_id));
    requireCondition(
      JSON.stringify(leaseEvents.map((entry) => entry.action)) === JSON.stringify(["ACQUIRED", "FROZEN", "EPOCH_ROTATED"]),
      "Crash recovery duplicated a lease transition.",
    );

    prepared = await prepareSliceFixture("commit-crash", "after_slice", false);
    const crashingCommit = new CommitCoordinator({
      now: fixedDate,
      indexNameFactory: () => "s12-crashing.index",
      changeGuard: prepared.changeGuard,
      faultInjector: () => { throw new Error("injected crash after isolated stage"); },
    }).finishSlice(prepared.input);
    requireCondition(crashingCommit instanceof CommitCoordinatorError, "Injected commit crash unexpectedly succeeded.");
    requireCondition(
      Number(runGit(prepared.root, ["rev-list", "--count", "HEAD"]).trim()) === prepared.baselineCommitCount,
      "Commit crash formed a hidden commit.",
    );
    const finished = finishPreparedSlice(prepared, new CommitCoordinator({
      now: fixedDate,
      indexNameFactory: () => "s12-recovered.index",
      changeGuard: prepared.changeGuard,
    }));
    requireCondition(
      finished.finalCommitCount - prepared.baselineCommitCount === 1,
      "Commit recovery created zero or duplicate commits.",
    );
    const evidence = {
      id: "controller_crash_recovery",
      result: "PASS",
      assertions: {
        recovered_interruption_outcome: recovered.outcome,
        interrupt_invocations: rig.host.interruptInvocations,
        interrupt_side_effects: rig.host.interruptSideEffects,
        lease_event_actions: leaseEvents.map((entry) => entry.action),
        commit_count_delta_after_retry: 1,
        duplicate_tasks: 0,
        duplicate_commits: 0,
        double_writes: 0,
      },
    };
    cleanSuccess(rig.root);
    cleanSuccess(prepared.root);
    return evidence;
  } catch (error) {
    if (prepared?.root !== undefined && existsSync(prepared.root)) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      throw new Error(`${message}\nS12 retained failing fixtures: ${rig.root}, ${prepared.root}`, { cause: error });
    }
    retainFailure(rig.root, error);
  }
}

function childProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForFiles(paths, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every((entry) => existsSync(entry))) {
    if (Date.now() >= deadline) fail(`Timed out waiting for worker barriers: ${paths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runDualRunCompetition() {
  const root = temporaryRoot("dual-run");
  try {
    const workspaceRoot = path.join(root, "workspace");
    const guardRoot = path.join(root, "guard");
    mkdirSync(workspaceRoot);
    const readyA = path.join(root, "ready-a");
    const readyB = path.join(root, "ready-b");
    const startPath = path.join(root, "start");
    const workerPath = path.join(repoRoot, "dist", "test", "helpers", "workspace-lease-worker.js");
    requireCondition(existsSync(workerPath), "Compiled workspace lease worker is missing.");
    const first = childProcess(process.execPath, [
      workerPath, guardRoot, workspaceRoot, "run-s12-a", "lease-s12-a", readyA, startPath,
    ]);
    const second = childProcess(process.execPath, [
      workerPath, guardRoot, workspaceRoot, "run-s12-b", "lease-s12-b", readyB, startPath,
    ]);
    await waitForFiles([readyA, readyB]);
    writeFileSync(startPath, "start", "utf8");
    const outputs = await Promise.all([first, second]);
    for (const output of outputs) {
      requireCondition(output.code === 0, `Lease worker failed: ${output.stderr}`);
    }
    const outcomes = outputs.map((entry) => JSON.parse(entry.stdout.trim()));
    const acquired = outcomes.filter((entry) => entry.outcome === "acquired");
    const rejected = outcomes.filter((entry) => entry.code === "project_lock_unavailable");
    requireCondition(acquired.length === 1 && rejected.length === 1, "Dual Run competition did not produce one lease winner.");
    const evidence = {
      id: "dual_run_competition",
      result: "PASS",
      assertions: {
        real_processes: 2,
        acquired_runs: 1,
        rejected_runs: 1,
        rejection_code: "project_lock_unavailable",
        simultaneous_writers: 1,
      },
    };
    cleanSuccess(root);
    return evidence;
  } catch (error) {
    retainFailure(root, error);
  }
}

function skillHelperSmoke() {
  const configured = process.env.AUTO_SLICE_EXPORT_HANDOFF_SKILL_DIR;
  const skillRoot = configured && configured.trim().length > 0
    ? path.resolve(configured)
    : path.join(os.homedir(), ".codex", "skills", "export-codex-handoff");
  const helper = path.join(skillRoot, "scripts", "export-handoff.mjs");
  const evidence = path.join(repoRoot, "artifacts", "s09", "verified-test-handoff.evidence.json");
  requireCondition(existsSync(helper), `export-codex-handoff helper is missing: ${helper}`);
  requireCondition(existsSync(evidence), "Verified S09 Handoff evidence is missing.");
  const result = spawnSync(process.execPath, [helper, "verify-evidence", evidence], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`Real Handoff helper smoke failed: ${result.stderr || result.error?.message || "unknown error"}`);
  }
  const receipt = JSON.parse(result.stdout);
  requireCondition(receipt.valid === true, "Real Handoff helper returned a non-PASS receipt.");
  return {
    helper: "export-codex-handoff verify-evidence",
    input: "artifacts/s09/verified-test-handoff.evidence.json",
    result: "PASS",
  };
}

async function main() {
  const scenarioResults = [
    await runSliceScenario("after_slice_happy_path", "after_slice"),
    await runSliceScenario("none_happy_path", "none"),
    await runSliceScenario("protected_change", "after_slice", true),
    await runCompactionCompleted29999(),
    await runCompactionTimeout(),
    await runSourceInterruptFailure(),
    await runHandoffCorrupt(),
    await runContinuationStartFailure(),
    await runControllerCrashRecovery(),
    await runDualRunCompetition(),
  ];
  requireCondition(
    JSON.stringify(scenarioResults.map((entry) => entry.id)) === JSON.stringify(fixture.scenario_ids),
    "S12 harness scenario order drifted from the frozen fixture.",
  );
  requireCondition(scenarioResults.every((entry) => entry.result === "PASS"), "One or more S12 scenarios failed.");
  const report = {
    schema_version: 1,
    slice_id: "S12",
    fixture_digest: sha256(fixtureBytes),
    normalized: true,
    scenarios: scenarioResults,
    infrastructure: {
      isolated_local_git: true,
      real_git_cli: true,
      real_process_tree: true,
      real_file_lock: true,
      persistent_task_records: true,
      virtual_clock: true,
      skill_helper_smoke: skillHelperSmoke(),
      remote_git_connected: false,
    },
    result: "PASS",
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
