import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { ModelDecision } from "../model-policy/index.js";
import {
  type AppServerFreshTaskTurnHandle,
  type AppServerFreshTaskTurnReceipt,
  type CodexAppServerFreshTaskSession,
  type CodexAppServerFreshTaskSessions,
} from "../production/app-server-fresh-task-session.js";
import type { AppServerThreadItemProjection } from "../production/app-server-protocol-v2.js";
import { ProductionRuntimeError } from "../production/errors.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type Sha256Digest,
} from "../state/index.js";

import type {
  ContinuationLauncher,
  LeaseReceipt,
  ProgressReceipt,
  ReadyReceipt,
  ResumeEnvelope,
} from "./types.js";

export const DEFAULT_CONTINUATION_HANDOFF_MARKDOWN_BYTES = 1024 * 1024;
export const MAXIMUM_CONTINUATION_GOAL_BYTES = 16 * 1024;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEGIN_HANDOFF = "<BEGIN VERIFIED HANDOFF>";
const END_HANDOFF = "<END VERIFIED HANDOFF>";
const PROHIBITED_READ_TURN_ITEMS = new Set<AppServerThreadItemProjection["type"]>([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
]);
const READ_TURN_PROJECTED_ITEMS = [
  "agentMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
] as const satisfies readonly AppServerThreadItemProjection["type"][];

export type AppServerContinuationLauncherFailureCode =
  | "INVALID_CONTINUATION_REQUEST"
  | "HANDOFF_INTEGRITY_FAILED"
  | "CONTINUATION_TASK_START_FAILED"
  | "READY_EVIDENCE_INVALID"
  | "WRITE_EPOCH_MISMATCH"
  | "CONTINUATION_WRITE_TURN_START_FAILED"
  | "CONTINUATION_WRITE_TURN_FAILED"
  | "RECEIPT_REPLAY_MISMATCH";

export interface AppServerContinuationTaskLauncherOptions {
  readonly fresh_task_sessions: CodexAppServerFreshTaskSessions;
  readonly now?: () => Date;
  readonly maximum_handoff_markdown_bytes?: number;
}

export class AppServerContinuationLauncherError extends Error {
  public constructor(
    public readonly code: AppServerContinuationLauncherFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppServerContinuationLauncherError";
  }
}

interface ActiveContinuation {
  readonly envelope: ResumeEnvelope;
  readonly session: CodexAppServerFreshTaskSession;
  readonly readTurn: AppServerFreshTaskTurnHandle;
  phase: "READ_TURN_ACTIVE" | "READY" | "WRITE_TURN_ACTIVE" | "PROGRESS" | "FAILED";
  readyPromise?: Promise<ReadyReceipt>;
  readyReceipt?: ReadyReceipt;
  writeTurn?: AppServerFreshTaskTurnHandle;
  leaseReceipt?: LeaseReceipt;
  progressPromise?: Promise<ProgressReceipt>;
  progressReceipt?: ProgressReceipt;
}

function launcherError(
  code: AppServerContinuationLauncherFailureCode,
  message: string,
  cause?: unknown,
): AppServerContinuationLauncherError {
  return new AppServerContinuationLauncherError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function sha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 && !/[\r\n\0]/u.test(value);
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateModelDecision(value: unknown): void {
  if (
    !isRecord(value) ||
    value.mode !== "model" ||
    value.model !== "gpt-5.6-sol" ||
    value.effort !== "max"
  ) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation launcher requires the exact gpt-5.6-sol/max model decision.",
    );
  }
}

function validateConsumerContract(value: unknown): void {
  if (!isRecord(value)) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation consumer contract is outside the frozen synthesize-first schema.",
    );
  }
  const firstDeliverableIds = value.firstDeliverableIds;
  const allowedReadReasons = value.allowedReadReasons;
  if (
    value.formatVersion !== 1 ||
    value.kind !== "codex-handoff-synthesize-first-consumer-contract" ||
    value.mode !== "synthesize_first" ||
    !Array.isArray(firstDeliverableIds) ||
    firstDeliverableIds.length === 0 ||
    firstDeliverableIds.some((entry) => !validIdentifier(entry)) ||
    value.preDraftEvidenceReads !== 0 ||
    !Number.isSafeInteger(value.maxTargetedReads) ||
    (value.maxTargetedReads as number) < 0 ||
    (value.maxTargetedReads as number) > 3 ||
    !Array.isArray(allowedReadReasons) ||
    allowedReadReasons.some((entry) => (
      entry !== "claim_verification" && entry !== "named_uncertainty"
    )) ||
    value.forbidBroadSearch !== true ||
    value.forbidFullFileReread !== true
  ) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation consumer contract is outside the frozen synthesize-first schema.",
    );
  }
}

function validHandoffReceiptBinding(value: Readonly<Record<string, unknown>>): boolean {
  const currentBinding = (value.handoff_receipt_schema_version === 2 ||
    value.handoff_receipt_schema_version === 3) &&
    canonicalUuid(value.compression_turn_id);
  const legacyReplayBinding = value.handoff_receipt_schema_version === undefined &&
    value.compression_turn_id === undefined;
  return currentBinding || legacyReplayBinding;
}

function validateEnvelope(value: unknown): asserts value is ResumeEnvelope {
  if (!isRecord(value)) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation ResumeEnvelope is outside the frozen S21 schema.",
    );
  }
  const workspace = value.expected_workspace_identity;
  const markdownPath = typeof value.handoff_markdown_path === "string"
    ? value.handoff_markdown_path
    : undefined;
  const resultPathBinding = value.handoff_receipt_schema_version === 3;
  const artifactFieldsValid = resultPathBinding
    ? value.evidence_index_path === undefined && value.handoff_digest === undefined
    : markdownPath !== undefined &&
      typeof value.evidence_index_path === "string" &&
      path.isAbsolute(value.evidence_index_path) &&
      path.resolve(markdownPath) !== path.resolve(value.evidence_index_path) &&
      sha256Digest(value.handoff_digest);
  if (
    !validIdentifier(value.run_id) ||
    !validIdentifier(value.current_slice_id) ||
    !validIdentifier(value.lease_id) ||
    !canonicalUuid(value.source_thread_id) ||
    !canonicalUuid(value.compression_task_id) ||
    !validHandoffReceiptBinding(value) ||
    value.source_thread_id === value.compression_task_id ||
    typeof value.handoff_markdown_path !== "string" ||
    !path.isAbsolute(value.handoff_markdown_path) ||
    !artifactFieldsValid ||
    !sha256Digest(value.handoff_artifact_digest) ||
    !isRecord(workspace) ||
    typeof workspace.canonical_root !== "string" ||
    !path.isAbsolute(workspace.canonical_root) ||
    !validIdentifier(workspace.filesystem_identity) ||
    !Number.isSafeInteger(value.write_epoch) ||
    (value.write_epoch as number) < 1 ||
    !Number.isSafeInteger(value.observed_state_version) ||
    (value.observed_state_version as number) < 0 ||
    (value.commit_mode !== "after_slice" && value.commit_mode !== "none") ||
    typeof value.goal_prompt !== "string" ||
    Buffer.byteLength(value.goal_prompt, "utf8") > MAXIMUM_CONTINUATION_GOAL_BYTES
  ) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation ResumeEnvelope is outside the frozen S21 schema.",
    );
  }
  validateConsumerContract(value.consumer_contract);
}

function firstTurnGoal(envelope: ResumeEnvelope): string {
  const deliverables = canonicalJson(envelope.consumer_contract.firstDeliverableIds);
  const bindingDigest = envelope.handoff_digest ?? envelope.handoff_artifact_digest;
  const goal = [
    "Auto Slice Continuation synthesize-first read-only Turn.",
    `run_id=${JSON.stringify(envelope.run_id)}; slice_id=${JSON.stringify(envelope.current_slice_id)}.`,
    `consumer_contract_digest=${sha256Json(envelope.consumer_contract)}; handoff_binding_digest=${bindingDigest}.`,
    `Produce only the first substantive draft for deliverables=${deliverables}.`,
    "The next input item is the complete Handoff body selected by Compression.",
    "Do not call tools, search, read files, modify files, continue implementation, or report receipt fields in this Turn.",
  ].join("\n");
  if (Buffer.byteLength(goal, "utf8") > MAXIMUM_CONTINUATION_GOAL_BYTES) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation synthesize-first goal exceeded its bounded input size.",
    );
  }
  return goal;
}

function handoffInput(markdown: string): string {
  if (markdown.includes(BEGIN_HANDOFF) || markdown.includes(END_HANDOFF)) {
    throw launcherError(
      "HANDOFF_INTEGRITY_FAILED",
      "Verified Handoff collides with its fixed data boundary.",
    );
  }
  return `${BEGIN_HANDOFF}\n${markdown}${markdown.endsWith("\n") ? "" : "\n"}${END_HANDOFF}`;
}

function secondTurnGoal(envelope: ResumeEnvelope): string {
  const completion = envelope.commit_mode === "after_slice"
    ? "完成后commit，刷新checkpoint"
    : "完成后刷新checkpoint";
  const goal = [
    `设定goal：已读取Handoff，继续实现${envelope.current_slice_id}，${completion}`,
    `继续同一Slice；run_id=${JSON.stringify(envelope.run_id)}；write_epoch=${String(envelope.write_epoch)}；handoff_binding_digest=${envelope.handoff_digest ?? envelope.handoff_artifact_digest}。`,
  ].join("\n");
  if (Buffer.byteLength(goal, "utf8") > MAXIMUM_CONTINUATION_GOAL_BYTES) {
    throw launcherError(
      "INVALID_CONTINUATION_REQUEST",
      "Continuation workspace-write goal exceeded its bounded input size.",
    );
  }
  return goal;
}

function observedAt(milliseconds: number): string {
  const value = new Date(milliseconds).toISOString();
  if (!validTimestamp(value)) {
    throw launcherError("READY_EVIDENCE_INVALID", "Continuation terminal time is invalid.");
  }
  return value;
}

function boundedTurnProjectionDigest(
  receipt: AppServerFreshTaskTurnReceipt,
): Sha256Digest {
  return sha256Json({
    thread_id: receipt.thread_id,
    turn_id: receipt.turn_id,
    terminal_status: receipt.terminal_status,
    completed_at_ms: receipt.completed_at_ms,
    completed_items: receipt.completed_items.map((entry) => ({
      completed_at_ms: entry.completed_at_ms,
      id: entry.item.id,
      type: entry.item.type,
      ...(entry.item.type === "agentMessage"
        ? {
          phase: entry.item.phase,
          text_bytes: Buffer.byteLength(entry.item.text, "utf8"),
          text_digest: sha256Bytes(entry.item.text),
        }
        : {}),
    })),
  });
}

export class AppServerContinuationTaskLauncher implements ContinuationLauncher {
  private readonly now: () => Date;
  private readonly maximumHandoffMarkdownBytes: number;
  private readonly startPromises = new Map<Sha256Digest, Promise<string>>();
  private readonly active = new Map<string, ActiveContinuation>();

  public constructor(private readonly options: AppServerContinuationTaskLauncherOptions) {
    this.now = options.now ?? (() => new Date());
    this.maximumHandoffMarkdownBytes = options.maximum_handoff_markdown_bytes ??
      DEFAULT_CONTINUATION_HANDOFF_MARKDOWN_BYTES;
    if (
      !Number.isSafeInteger(this.maximumHandoffMarkdownBytes) ||
      this.maximumHandoffMarkdownBytes <= 0
    ) {
      throw launcherError(
        "INVALID_CONTINUATION_REQUEST",
        "maximum_handoff_markdown_bytes must be a positive safe integer.",
      );
    }
  }

  public async start(envelope: ResumeEnvelope, modelDecision: ModelDecision): Promise<unknown> {
    validateEnvelope(envelope);
    validateModelDecision(modelDecision);
    const key = sha256Json({ envelope, model_decision: modelDecision });
    const existing = this.startPromises.get(key);
    if (existing !== undefined) return existing;
    const pending = this.startInner(envelope);
    this.startPromises.set(key, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      if (this.startPromises.get(key) === pending) this.startPromises.delete(key);
      throw error;
    }
  }

  public async awaitReady(taskId: string): Promise<unknown> {
    const active = this.requireActive(taskId);
    if (active.readyReceipt !== undefined) return active.readyReceipt;
    if (active.readyPromise !== undefined) return active.readyPromise;
    const pending = this.completeReadTurn(active);
    active.readyPromise = pending;
    return pending;
  }

  public async grantWrite(taskId: string, newWriteEpoch: number): Promise<unknown> {
    const active = this.requireActive(taskId);
    if (active.leaseReceipt !== undefined) {
      if (active.leaseReceipt.write_epoch !== newWriteEpoch) {
        throw launcherError(
          "WRITE_EPOCH_MISMATCH",
          "Repeated Continuation write grant changed its write epoch.",
        );
      }
      return active.leaseReceipt;
    }
    if (active.phase !== "READY" || active.readyReceipt === undefined) {
      throw launcherError(
        "READY_EVIDENCE_INVALID",
        "Continuation write grant requires a verified terminal read-only Turn.",
      );
    }
    if (newWriteEpoch !== active.envelope.write_epoch) {
      throw launcherError(
        "WRITE_EPOCH_MISMATCH",
        "Continuation write grant does not match the rotated Project Write Lease epoch.",
      );
    }
    const turn = await active.session.startTurn({
      input: [{
        type: "text",
        text: secondTurnGoal(active.envelope),
        text_elements: [],
      }],
      cwd: active.envelope.expected_workspace_identity.canonical_root,
      sandbox_policy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: "gpt-5.6-sol",
      effort: "max",
      project_completed_item_types: [],
    });
    if (turn instanceof ProductionRuntimeError) {
      active.phase = "FAILED";
      throw launcherError(
        "CONTINUATION_WRITE_TURN_START_FAILED",
        "Continuation workspace-write Turn could not be started.",
        turn,
      );
    }
    const timestamp = this.now().toISOString();
    if (!validTimestamp(timestamp)) {
      active.phase = "FAILED";
      throw launcherError(
        "CONTINUATION_WRITE_TURN_START_FAILED",
        "Continuation launcher clock is not canonical.",
      );
    }
    const receipt: LeaseReceipt = {
      task_id: taskId,
      lease_id: active.envelope.lease_id,
      write_epoch: newWriteEpoch,
      workspace_identity: active.envelope.expected_workspace_identity,
      granted: true,
      observed_at: timestamp,
    };
    active.writeTurn = turn;
    active.leaseReceipt = receipt;
    active.phase = "WRITE_TURN_ACTIVE";
    return receipt;
  }

  public async awaitProgress(taskId: string): Promise<unknown> {
    const active = this.requireActive(taskId);
    if (active.progressReceipt !== undefined) return active.progressReceipt;
    if (active.progressPromise !== undefined) return active.progressPromise;
    if (active.phase !== "WRITE_TURN_ACTIVE" || active.writeTurn === undefined) {
      throw launcherError(
        "CONTINUATION_WRITE_TURN_FAILED",
        "Continuation progress requires one accepted workspace-write Turn.",
      );
    }
    const pending = this.completeWriteTurn(active);
    active.progressPromise = pending;
    return pending;
  }

  private async startInner(envelope: ResumeEnvelope): Promise<string> {
    const markdown = await this.readHandoff(envelope);
    let session: CodexAppServerFreshTaskSession | ProductionRuntimeError;
    try {
      session = await this.options.fresh_task_sessions.start({
        kind: "continuation",
        source_thread_id: envelope.source_thread_id,
        cwd: envelope.expected_workspace_identity.canonical_root,
      });
    } catch (error: unknown) {
      throw launcherError(
        "CONTINUATION_TASK_START_FAILED",
        "Fresh Continuation root could not be created.",
        error,
      );
    }
    if (session instanceof ProductionRuntimeError) {
      throw launcherError(
        "CONTINUATION_TASK_START_FAILED",
        "Fresh Continuation root could not be created.",
        session,
      );
    }
    if (
      session.thread_id === envelope.compression_task_id ||
      this.active.has(session.thread_id)
    ) {
      throw launcherError(
        "CONTINUATION_TASK_START_FAILED",
        "Source, Compression, and Continuation Task UUIDs must be pairwise distinct.",
      );
    }
    const turn = await session.startTurn({
      input: [
        { type: "text", text: firstTurnGoal(envelope), text_elements: [] },
        { type: "text", text: handoffInput(markdown), text_elements: [] },
      ],
      cwd: envelope.expected_workspace_identity.canonical_root,
      sandbox_policy: { type: "readOnly", networkAccess: false },
      model: "gpt-5.6-sol",
      effort: "max",
      project_completed_item_types: READ_TURN_PROJECTED_ITEMS,
    });
    if (turn instanceof ProductionRuntimeError) {
      throw launcherError(
        "CONTINUATION_TASK_START_FAILED",
        "Continuation synthesize-first Turn could not be started.",
        turn,
      );
    }
    this.active.set(session.thread_id, {
      envelope,
      session,
      readTurn: turn,
      phase: "READ_TURN_ACTIVE",
    });
    return session.thread_id;
  }

  private async readHandoff(envelope: ResumeEnvelope): Promise<string> {
    try {
      if (envelope.handoff_receipt_schema_version === 3) {
        const bytes = await readFile(envelope.handoff_markdown_path);
        if (bytes.byteLength === 0 || bytes.byteLength > this.maximumHandoffMarkdownBytes) {
          throw new Error("Handoff is empty or exceeds its bound");
        }
        const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (markdown.includes("\0")) throw new Error("Handoff contains NUL");
        return markdown;
      }
      const before = await lstat(envelope.handoff_markdown_path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
      const [canonicalPath, bytes] = await Promise.all([
        realpath(envelope.handoff_markdown_path),
        readFile(envelope.handoff_markdown_path),
      ]);
      if (
        path.relative(path.resolve(envelope.handoff_markdown_path), canonicalPath) !== "" ||
        bytes.byteLength === 0 ||
        bytes.byteLength > this.maximumHandoffMarkdownBytes ||
        sha256Bytes(bytes) !== envelope.handoff_digest
      ) {
        throw new Error("Handoff identity or bytes changed");
      }
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (markdown.includes("\0")) throw new Error("Handoff contains NUL");
      return markdown;
    } catch (error: unknown) {
      throw launcherError(
        "HANDOFF_INTEGRITY_FAILED",
        envelope.handoff_receipt_schema_version === 3
          ? "Continuation could not read the Handoff path selected by Compression."
          : "Continuation Handoff bytes no longer match the verified receipt.",
        error,
      );
    }
  }

  private async completeReadTurn(active: ActiveContinuation): Promise<ReadyReceipt> {
    try {
      const terminal = await active.readTurn.completion;
      if (terminal instanceof ProductionRuntimeError) throw terminal;
      if (terminal.terminal_status !== "completed") {
        throw launcherError(
          "READY_EVIDENCE_INVALID",
          "Continuation synthesize-first Turn did not reach a completed terminal.",
        );
      }
      let draft: Extract<AppServerThreadItemProjection, { type: "agentMessage" }> | undefined;
      for (const completed of terminal.completed_items) {
        if (PROHIBITED_READ_TURN_ITEMS.has(completed.item.type)) {
          throw launcherError(
            "READY_EVIDENCE_INVALID",
            "Continuation synthesize-first Turn used a tool or write item.",
          );
        }
        if (
          draft === undefined &&
          completed.item.type === "agentMessage" &&
          completed.item.text.trim().length > 0
        ) {
          draft = completed.item;
        }
      }
      if (draft === undefined) {
        throw launcherError(
          "READY_EVIDENCE_INVALID",
          "Continuation synthesize-first Turn produced no substantive draft.",
        );
      }
      const receipt: ReadyReceipt = {
        task_id: active.session.thread_id,
        run_id: active.envelope.run_id,
        slice_id: active.envelope.current_slice_id,
        workspace_identity: active.envelope.expected_workspace_identity,
        handoff_artifact_digest: active.envelope.handoff_artifact_digest,
        consumer_contract_digest: sha256Json(active.envelope.consumer_contract),
        handoff_read: true,
        first_deliverable_ids: active.envelope.consumer_contract.firstDeliverableIds,
        first_deliverable_draft_digest: sha256Bytes(draft.text),
        pre_draft_evidence_reads: 0,
        targeted_evidence_reads: 0,
        targeted_read_reasons: [],
        broad_search_count: 0,
        full_file_reread_count: 0,
        rollout_digest: boundedTurnProjectionDigest(terminal),
        write_access: false,
        observed_state_version: active.envelope.observed_state_version,
        observed_at: observedAt(terminal.completed_at_ms),
      };
      active.readyReceipt = receipt;
      active.phase = "READY";
      return receipt;
    } catch (error: unknown) {
      active.phase = "FAILED";
      if (error instanceof AppServerContinuationLauncherError) throw error;
      throw launcherError(
        "READY_EVIDENCE_INVALID",
        "Continuation synthesize-first evidence could not be verified.",
        error,
      );
    }
  }

  private async completeWriteTurn(active: ActiveContinuation): Promise<ProgressReceipt> {
    try {
      const terminal = await (active.writeTurn as AppServerFreshTaskTurnHandle).completion;
      if (terminal instanceof ProductionRuntimeError) throw terminal;
      if (terminal.terminal_status !== "completed") {
        throw launcherError(
          "CONTINUATION_WRITE_TURN_FAILED",
          "Continuation workspace-write Turn did not reach a completed terminal.",
        );
      }
      const receipt: ProgressReceipt = {
        task_id: active.session.thread_id,
        slice_id: active.envelope.current_slice_id,
        observed_state_version: active.envelope.observed_state_version,
        verification_receipt_digest: boundedTurnProjectionDigest(terminal),
      };
      active.progressReceipt = receipt;
      active.phase = "PROGRESS";
      return receipt;
    } catch (error: unknown) {
      active.phase = "FAILED";
      if (error instanceof AppServerContinuationLauncherError) throw error;
      throw launcherError(
        "CONTINUATION_WRITE_TURN_FAILED",
        "Continuation workspace-write terminal could not be verified.",
        error,
      );
    }
  }

  private requireActive(taskId: string): ActiveContinuation {
    if (!canonicalUuid(taskId)) {
      throw launcherError(
        "INVALID_CONTINUATION_REQUEST",
        "Continuation task identity is not one canonical UUID.",
      );
    }
    const active = this.active.get(taskId);
    if (active === undefined) {
      throw launcherError(
        "RECEIPT_REPLAY_MISMATCH",
        "Continuation task is not bound to this launcher instance.",
      );
    }
    return active;
  }
}
