import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  decodeAppServerSkillsListResponse,
  resolveAppServerSkill,
  type AppServerCommandExecutionItem,
} from "../production/app-server-protocol-v2.js";
import type { CodexAppServerClient } from "../production/app-server-client.js";
import type {
  AppServerFreshTaskTurnHandle,
  CodexAppServerFreshTaskSessions,
} from "../production/app-server-fresh-task-session.js";
import { ProductionRuntimeError } from "../production/errors.js";
import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type Sha256Digest,
} from "../state/index.js";

import {
  HANDOFF_RECEIPT_SCHEMA_VERSION,
  HANDOFF_WORKFLOW_VERSION,
  type CompressionRequest,
  type CompressionTaskLauncher,
  type CompressionTaskLaunchReceipt,
  type HandoffReceiptV2,
  type SynthesizeFirstConsumerContract,
} from "./types.js";

export const EXPORT_CODEX_HANDOFF_SKILL_NAME = "export-codex-handoff" as const;
export const DEFAULT_COMPRESSION_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_VERIFY_EVIDENCE_TIMEOUT_MS = 120_000;
export const DEFAULT_HANDOFF_STORAGE_ROOT = path.join(
  os.homedir(),
  ".codex",
  "auto-slice",
);

const JOURNAL_SCHEMA_VERSION = 1 as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STABLE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANAGED_WORK_DIR_PREFIX = "codex-handoff-task-";
const JOURNAL_DIRECTORY = "handoff-launcher-journal";
const HANDOFF_DIRECTORY = "handoffs";

type JournalStatus = "ALLOCATED" | "LAUNCHED" | "COMPLETED" | "FAILED";

interface CompressionLauncherJournalRecord {
  readonly schema_version: typeof JOURNAL_SCHEMA_VERSION;
  readonly effect_idempotency_key: Sha256Digest;
  readonly request_digest: Sha256Digest;
  readonly run_id: string;
  readonly slice_id: string;
  readonly source_thread_id: string;
  readonly attempt_number: number;
  readonly attempt_id: string;
  readonly artifact_root: string;
  readonly markdown_path: string;
  readonly evidence_index_path: string;
  readonly skill_path: string;
  readonly helper_path: string;
  readonly status: JournalStatus;
  readonly created_at: string;
  readonly compression_task_id?: string;
  readonly compression_turn_id?: string;
  readonly launch_receipt?: CompressionTaskLaunchReceipt;
  readonly receipt?: HandoffReceiptV2;
  readonly diagnostic_code?: string;
  readonly retained_work_dir?: string;
}

interface ResolvedExportSkill {
  readonly skillPath: string;
  readonly helperPath: string;
}

interface ArtifactAllocation {
  readonly journalPath: string;
  readonly attemptNumber: number;
  readonly attemptId: string;
  readonly artifactRoot: string;
  readonly markdownPath: string;
  readonly evidenceIndexPath: string;
}

interface ActiveCompressionLaunch {
  readonly request: CompressionRequest;
  readonly requestDigest: Sha256Digest;
  readonly allocation: ArtifactAllocation;
  readonly skill: ResolvedExportSkill;
  readonly launchReceipt: CompressionTaskLaunchReceipt;
  readonly turn: AppServerFreshTaskTurnHandle;
  readonly journal: CompressionLauncherJournalRecord;
}

interface PreparedHelperOutput {
  readonly sourceRevision: Sha256Digest;
  readonly workDir: string;
}

interface PublishedHelperOutput {
  readonly sourceRevision: Sha256Digest;
  readonly structuralDigest: Sha256Digest;
  readonly handoffDigest: Sha256Digest;
  readonly evidenceIndexDigest: Sha256Digest;
  readonly consumerContract: SynthesizeFirstConsumerContract;
  readonly retainedWorkDir?: string;
}

export interface AppServerCompressionTaskLauncherOptions {
  readonly client: CodexAppServerClient;
  readonly fresh_task_sessions: CodexAppServerFreshTaskSessions;
  readonly artifact_storage_root?: string;
  readonly node_executable?: string;
  readonly now?: () => Date;
  readonly maximum_command_output_bytes?: number;
  readonly verify_evidence_timeout_ms?: number;
}

export class AppServerCompressionLauncherError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retained_work_dir?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppServerCompressionLauncherError";
  }
}

function launcherError(
  code: string,
  message: string,
  retainedWorkDir?: string,
  cause?: unknown,
): AppServerCompressionLauncherError {
  return new AppServerCompressionLauncherError(
    code,
    message,
    retainedWorkDir,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function pathKey(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function requireStableSegment(value: string, label: string): void {
  if (!STABLE_PATH_SEGMENT.test(value)) {
    throw launcherError(
      "ARTIFACT_ALLOCATION_FAILED",
      `${label} cannot be represented as a bounded Handoff path segment.`,
    );
  }
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw launcherError("INVALID_LAUNCHER_CONFIGURATION", `${label} must be a positive integer.`);
  }
}

function validateCompressionRequest(request: CompressionRequest): void {
  const runtimeModel: unknown = request.model;
  const runtimeEffort: unknown = request.reasoning_effort;
  if (
    !STABLE_PATH_SEGMENT.test(request.run_id) ||
    !STABLE_PATH_SEGMENT.test(request.slice_id) ||
    !canonicalUuid(request.source_thread_id) ||
    !sha256Digest(request.idempotency_key) ||
    typeof request.compaction_id !== "string" ||
    request.compaction_id.length === 0 ||
    !path.isAbsolute(request.workspace_identity.canonical_root) ||
    runtimeModel !== "gpt-5.6-sol" ||
    runtimeEffort !== "medium"
  ) {
    throw launcherError("INVALID_COMPRESSION_REQUEST", "Compression launch request is invalid.");
  }
}

function decodeConsumerContract(value: unknown): SynthesizeFirstConsumerContract {
  if (!isRecord(value)) {
    throw launcherError("HANDOFF_RECEIPT_INVALID", "Publish output omitted its consumer contract.");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "allowedReadReasons",
    "firstDeliverableIds",
    "forbidBroadSearch",
    "forbidFullFileReread",
    "formatVersion",
    "kind",
    "maxTargetedReads",
    "mode",
    "preDraftEvidenceReads",
  ].sort();
  if (
    canonicalJson(keys) !== canonicalJson(expectedKeys) ||
    value.formatVersion !== 1 ||
    value.kind !== "codex-handoff-synthesize-first-consumer-contract" ||
    value.mode !== "synthesize_first" ||
    !Array.isArray(value.firstDeliverableIds) ||
    value.firstDeliverableIds.length === 0 ||
    value.firstDeliverableIds.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    value.preDraftEvidenceReads !== 0 ||
    !Number.isSafeInteger(value.maxTargetedReads) ||
    (value.maxTargetedReads as number) < 0 ||
    (value.maxTargetedReads as number) > 3 ||
    !Array.isArray(value.allowedReadReasons) ||
    value.allowedReadReasons.some((entry) => (
      entry !== "claim_verification" && entry !== "named_uncertainty"
    )) ||
    value.forbidBroadSearch !== true ||
    value.forbidFullFileReread !== true
  ) {
    throw launcherError(
      "HANDOFF_RECEIPT_INVALID",
      "Publish output consumer contract violated the synthesize-first schema.",
    );
  }
  return value as unknown as SynthesizeFirstConsumerContract;
}

function parseSingleJson(
  value: string | null,
  maximumBytes: number,
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw launcherError("HELPER_OUTPUT_INVALID", `${label} output is missing or exceeds its bound.`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error: unknown) {
    throw launcherError("HELPER_OUTPUT_INVALID", `${label} output is not one JSON object.`, undefined, error);
  }
}

function tokenizeDirectCommand(command: string): readonly string[] {
  if (
    command.length === 0 ||
    Buffer.byteLength(command, "utf8") > 32 * 1024 ||
    command.includes("\0") ||
    command.includes("\r") ||
    command.includes("\n")
  ) {
    throw launcherError("COMMAND_CHAIN_INVALID", "Compression command text is invalid.");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
    if (quote === null) {
      if (/\s/u.test(character)) {
        if (tokenStarted) {
          tokens.push(current);
          current = "";
          tokenStarted = false;
        }
        continue;
      }
      if (character === "\"" || character === "'") {
        quote = character;
        tokenStarted = true;
        continue;
      }
      if ("&|;<>`".includes(character)) {
        throw launcherError(
          "COMMAND_CHAIN_INVALID",
          "Compression command contains shell composition syntax.",
        );
      }
      current += character;
      tokenStarted = true;
      continue;
    }
    if (character === quote) {
      quote = null;
      continue;
    }
    if (character === "\\" && quote === "\"") {
      const next = command[index + 1];
      if (next === "\"" || next === "\\") {
        current += next;
        index += 1;
        continue;
      }
    }
    current += character;
  }
  if (quote !== null) {
    throw launcherError("COMMAND_CHAIN_INVALID", "Compression command contains an open quote.");
  }
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function exactNodeCommand(token: string, canonicalNode: string): boolean {
  return samePath(token, canonicalNode);
}

function commandIsCompletedAgentEvidence(item: AppServerCommandExecutionItem): boolean {
  return item.source === "agent" &&
    item.status === "completed" &&
    item.exitCode === 0;
}

function safeDiagnosticCode(items: readonly AppServerCommandExecutionItem[]): string | undefined {
  for (const item of [...items].reverse()) {
    if (typeof item.aggregatedOutput !== "string" || item.aggregatedOutput.length > 64 * 1024) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(item.aggregatedOutput);
      if (isRecord(parsed) && typeof parsed.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(parsed.code)) {
        return parsed.code;
      }
    } catch {
      // Only a single bounded JSON error code is eligible for diagnostic mapping.
    }
  }
  return undefined;
}

function promptForCompression(
  sourceThreadId: string,
  markdownPath: string,
  evidenceIndexPath: string,
): string {
  return `$${EXPORT_CODEX_HANDOFF_SKILL_NAME} ${sourceThreadId} Use continuation-map-v2. ` +
    `Publish the Handoff Markdown to ${JSON.stringify(markdownPath)} and the Evidence Index to ` +
    `${JSON.stringify(evidenceIndexPath)}.`;
}

function launchReceiptFromJournal(
  value: CompressionLauncherJournalRecord,
): CompressionTaskLaunchReceipt | undefined {
  const receipt: unknown = value.launch_receipt;
  if (
    !isRecord(receipt) ||
    !canonicalUuid(receipt.compression_task_id) ||
    receipt.source_thread_id !== value.source_thread_id ||
    receipt.history_empty !== true ||
    receipt.project_write_lease !== false ||
    receipt.model !== "gpt-5.6-sol" ||
    receipt.reasoning_effort !== "medium" ||
    !validTimestamp(receipt.created_at)
  ) {
    return undefined;
  }
  return receipt as unknown as CompressionTaskLaunchReceipt;
}

function decodeJournal(value: unknown): CompressionLauncherJournalRecord {
  if (
    !isRecord(value) ||
    value.schema_version !== JOURNAL_SCHEMA_VERSION ||
    !sha256Digest(value.effect_idempotency_key) ||
    !sha256Digest(value.request_digest) ||
    typeof value.run_id !== "string" ||
    typeof value.slice_id !== "string" ||
    !canonicalUuid(value.source_thread_id) ||
    !Number.isSafeInteger(value.attempt_number) ||
    (value.attempt_number as number) <= 0 ||
    typeof value.attempt_id !== "string" ||
    typeof value.artifact_root !== "string" ||
    typeof value.markdown_path !== "string" ||
    typeof value.evidence_index_path !== "string" ||
    typeof value.skill_path !== "string" ||
    typeof value.helper_path !== "string" ||
    !["ALLOCATED", "LAUNCHED", "COMPLETED", "FAILED"].includes(value.status as string) ||
    !validTimestamp(value.created_at)
  ) {
    throw launcherError("RECEIPT_REPLAY_MISMATCH", "Compression launcher journal is invalid.");
  }
  return value as unknown as CompressionLauncherJournalRecord;
}

async function assertRegularNonLink(
  filePath: string,
  label: string,
): Promise<Readonly<{ dev: number; ino: number }>> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw launcherError("HANDOFF_PATH_INVALID", `${label} is not a regular non-link file.`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

export class AppServerCompressionTaskLauncher implements CompressionTaskLauncher {
  private readonly now: () => Date;
  private readonly storageRoot: string;
  private readonly nodeExecutable: string;
  private readonly maximumCommandOutputBytes: number;
  private readonly verifyEvidenceTimeoutMs: number;
  private readonly startPromises = new Map<Sha256Digest, Promise<CompressionTaskLaunchReceipt>>();
  private readonly activeLaunches = new Map<string, ActiveCompressionLaunch>();
  private readonly handoffPromises = new Map<Sha256Digest, Promise<HandoffReceiptV2>>();
  private rootPromise: Promise<string> | null = null;

  public constructor(private readonly options: AppServerCompressionTaskLauncherOptions) {
    this.now = options.now ?? (() => new Date());
    this.storageRoot = path.resolve(options.artifact_storage_root ?? DEFAULT_HANDOFF_STORAGE_ROOT);
    this.nodeExecutable = path.resolve(options.node_executable ?? process.execPath);
    this.maximumCommandOutputBytes = options.maximum_command_output_bytes ??
      DEFAULT_COMPRESSION_COMMAND_OUTPUT_BYTES;
    this.verifyEvidenceTimeoutMs = options.verify_evidence_timeout_ms ??
      DEFAULT_VERIFY_EVIDENCE_TIMEOUT_MS;
    requirePositiveInteger(this.maximumCommandOutputBytes, "maximum_command_output_bytes");
    requirePositiveInteger(this.verifyEvidenceTimeoutMs, "verify_evidence_timeout_ms");
  }

  public async start(request: CompressionRequest): Promise<unknown> {
    validateCompressionRequest(request);
    const existing = this.startPromises.get(request.idempotency_key);
    if (existing !== undefined) return existing;
    const pending = this.startInner(request);
    this.startPromises.set(request.idempotency_key, pending);
    try {
      return await pending;
    } catch (error: unknown) {
      if (this.startPromises.get(request.idempotency_key) === pending) {
        this.startPromises.delete(request.idempotency_key);
      }
      throw error;
    }
  }

  public async awaitHandoff(
    compressionTaskId: string,
    idempotencyKey: Sha256Digest,
  ): Promise<unknown> {
    if (!canonicalUuid(compressionTaskId) || !sha256Digest(idempotencyKey)) {
      throw launcherError("INVALID_COMPRESSION_REQUEST", "Handoff wait identity is invalid.");
    }
    const existing = this.handoffPromises.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const active = this.activeLaunches.get(compressionTaskId);
    if (active !== undefined) {
      if (active.request.idempotency_key !== idempotencyKey) {
        throw launcherError("RECEIPT_REPLAY_MISMATCH", "Compression task crossed effect identities.");
      }
      const pending = this.completeActiveLaunch(active);
      this.handoffPromises.set(idempotencyKey, pending);
      return pending;
    }
    const journal = await this.readJournal(idempotencyKey);
    if (
      journal?.status !== "COMPLETED" ||
      journal.compression_task_id !== compressionTaskId ||
      journal.receipt === undefined ||
      journal.receipt.compression_task_id !== compressionTaskId ||
      journal.receipt.artifact_digest !== sha256Json(this.receiptMaterial(journal.receipt))
    ) {
      throw launcherError(
        "RECEIPT_REPLAY_MISMATCH",
        "No completed Compression receipt is bound to this effect and task.",
      );
    }
    return journal.receipt;
  }

  private async startInner(request: CompressionRequest): Promise<CompressionTaskLaunchReceipt> {
    const requestDigest = sha256Json(request);
    const prior = await this.readJournal(request.idempotency_key);
    if (prior !== null) {
      this.assertJournalBinding(prior, request, requestDigest);
      if (prior.status === "COMPLETED") {
        const replay = launchReceiptFromJournal(prior);
        if (replay === undefined || prior.receipt === undefined) {
          throw launcherError("RECEIPT_REPLAY_MISMATCH", "Completed launcher journal lost its receipt.");
        }
        return replay;
      }
    }

    const skill = await this.resolveExportSkill(request.workspace_identity.canonical_root);
    const allocation = await this.planArtifactAttempt(request, prior);
    const createdAt = this.now().toISOString();
    if (!validTimestamp(createdAt)) {
      throw launcherError("INVALID_LAUNCHER_CONFIGURATION", "Launcher clock is not canonical.");
    }
    const allocatedJournal: CompressionLauncherJournalRecord = {
      schema_version: JOURNAL_SCHEMA_VERSION,
      effect_idempotency_key: request.idempotency_key,
      request_digest: requestDigest,
      run_id: request.run_id,
      slice_id: request.slice_id,
      source_thread_id: request.source_thread_id,
      attempt_number: allocation.attemptNumber,
      attempt_id: allocation.attemptId,
      artifact_root: allocation.artifactRoot,
      markdown_path: allocation.markdownPath,
      evidence_index_path: allocation.evidenceIndexPath,
      skill_path: skill.skillPath,
      helper_path: skill.helperPath,
      status: "ALLOCATED",
      created_at: createdAt,
    };
    await this.writeJournal(allocation.journalPath, allocatedJournal);

    try {
      await this.materializeArtifactAttempt(request, allocation);
      const session = await this.options.fresh_task_sessions.start({
        kind: "compression",
        source_thread_id: request.source_thread_id,
        cwd: request.workspace_identity.canonical_root,
      });
      if (session instanceof ProductionRuntimeError) throw session;
      const turn = await session.startTurn({
        input: [
          {
            type: "text",
            text: promptForCompression(
              request.source_thread_id,
              allocation.markdownPath,
              allocation.evidenceIndexPath,
            ),
            text_elements: [],
          },
          {
            type: "skill",
            name: EXPORT_CODEX_HANDOFF_SKILL_NAME,
            path: skill.skillPath,
          },
        ],
        cwd: request.workspace_identity.canonical_root,
        sandbox_policy: {
          type: "workspaceWrite",
          writableRoots: [allocation.artifactRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        model: request.model,
        effort: request.reasoning_effort,
        project_completed_item_types: ["commandExecution"],
      });
      if (turn instanceof ProductionRuntimeError) throw turn;
      const launchReceipt: CompressionTaskLaunchReceipt = {
        compression_task_id: session.thread_id,
        source_thread_id: request.source_thread_id,
        workspace_identity: request.workspace_identity,
        history_empty: true,
        project_write_lease: false,
        model: request.model,
        reasoning_effort: request.reasoning_effort,
        created_at: createdAt,
      };
      const launchedJournal: CompressionLauncherJournalRecord = {
        ...allocatedJournal,
        status: "LAUNCHED",
        compression_task_id: session.thread_id,
        compression_turn_id: turn.turn_id,
        launch_receipt: launchReceipt,
      };
      await this.writeJournal(allocation.journalPath, launchedJournal);
      this.activeLaunches.set(session.thread_id, {
        request,
        requestDigest,
        allocation,
        skill,
        launchReceipt,
        turn,
        journal: launchedJournal,
      });
      return launchReceipt;
    } catch (error: unknown) {
      await this.writeJournal(allocation.journalPath, {
        ...allocatedJournal,
        status: "FAILED",
        diagnostic_code: error instanceof AppServerCompressionLauncherError
          ? error.code
          : error instanceof ProductionRuntimeError
            ? error.code
            : "COMPRESSION_TASK_START_FAILED",
        retained_work_dir: allocation.artifactRoot,
      }).catch(() => undefined);
      if (error instanceof AppServerCompressionLauncherError) throw error;
      throw launcherError(
        "COMPRESSION_TASK_START_FAILED",
        "Fresh Compression Task could not be started.",
        allocation.artifactRoot,
        error,
      );
    }
  }

  private async completeActiveLaunch(active: ActiveCompressionLaunch): Promise<HandoffReceiptV2> {
    try {
      const terminal = await active.turn.completion;
      if (terminal instanceof ProductionRuntimeError) throw terminal;
      const commands = terminal.completed_items
        .map((entry) => entry.item)
        .filter((item): item is AppServerCommandExecutionItem => item.type === "commandExecution");
      if (terminal.terminal_status !== "completed") {
        const diagnosticCode = safeDiagnosticCode(commands) ?? "COMPRESSION_TURN_FAILED";
        const retainedWorkDir = this.retainedWorkDirFromCommands(active, commands) ??
          active.allocation.artifactRoot;
        throw launcherError(
          diagnosticCode,
          "Compression Turn did not reach a completed terminal.",
          retainedWorkDir,
        );
      }
      const receipt = await this.buildReceipt(active, commands);
      const completedJournal: CompressionLauncherJournalRecord = {
        ...active.journal,
        status: "COMPLETED",
        receipt,
        ...(receipt.retained_work_dir === undefined
          ? {}
          : { retained_work_dir: receipt.retained_work_dir }),
      };
      await this.writeJournal(active.allocation.journalPath, completedJournal);
      return receipt;
    } catch (error: unknown) {
      const normalized = error instanceof AppServerCompressionLauncherError
        ? error
        : launcherError(
          "COMPRESSION_TURN_FAILED",
          "Compression Turn evidence could not be verified.",
          active.allocation.artifactRoot,
          error,
        );
      await this.writeJournal(active.allocation.journalPath, {
        ...active.journal,
        status: "FAILED",
        diagnostic_code: normalized.code,
        retained_work_dir: normalized.retained_work_dir ?? active.allocation.artifactRoot,
      }).catch(() => undefined);
      throw normalized;
    } finally {
      this.activeLaunches.delete(active.launchReceipt.compression_task_id);
    }
  }

  private async buildReceipt(
    active: ActiveCompressionLaunch,
    commands: readonly AppServerCommandExecutionItem[],
  ): Promise<HandoffReceiptV2> {
    if (commands.length !== 2 || commands.some((item) => !commandIsCompletedAgentEvidence(item))) {
      throw launcherError(
        "COMMAND_CHAIN_INVALID",
        "Compression Turn must contain exactly one completed prepare and one completed publish command.",
        active.allocation.artifactRoot,
      );
    }
    const prepareCommand = commands[0] as AppServerCommandExecutionItem;
    const publishCommand = commands[1] as AppServerCommandExecutionItem;
    if (
      !samePath(prepareCommand.cwd, active.request.workspace_identity.canonical_root) ||
      !samePath(publishCommand.cwd, active.request.workspace_identity.canonical_root)
    ) {
      throw launcherError(
        "COMMAND_CHAIN_INVALID",
        "Compression helper commands did not run in SourceCwd.",
        active.allocation.artifactRoot,
      );
    }
    const prepared = this.decodePrepareCommand(active, prepareCommand);
    const publishArgv = tokenizeDirectCommand(publishCommand.command);
    if (
      publishArgv.length !== 4 ||
      !exactNodeCommand(publishArgv[0] as string, this.nodeExecutable) ||
      !samePath(publishArgv[1] as string, active.skill.helperPath) ||
      publishArgv[2] !== "publish" ||
      !samePath(publishArgv[3] as string, prepared.workDir)
    ) {
      throw launcherError(
        "COMMAND_CHAIN_INVALID",
        "Compression publish command is not bound to the prepared workDir.",
        prepared.workDir,
      );
    }
    const published = this.decodePublishOutput(
      parseSingleJson(
        publishCommand.aggregatedOutput,
        this.maximumCommandOutputBytes,
        "publish",
      ),
      active,
      prepared,
    );
    const { markdown, evidence } = await this.verifyPublishedPair(active, published);
    const verifyResult = await this.verifyEvidence(active, published.sourceRevision);
    const retainedWorkDir = published.retainedWorkDir;
    const material = {
      receipt_schema_version: HANDOFF_RECEIPT_SCHEMA_VERSION,
      compression_task_id: active.launchReceipt.compression_task_id,
      compression_turn_id: active.turn.turn_id,
      source_thread_id: active.request.source_thread_id,
      workflow_version: HANDOFF_WORKFLOW_VERSION,
      markdown_path: active.allocation.markdownPath,
      evidence_index_path: active.allocation.evidenceIndexPath,
      source_revision: published.sourceRevision,
      structural_digest: published.structuralDigest,
      handoff_digest: sha256Bytes(markdown),
      evidence_index_digest: sha256Bytes(evidence),
      verify_evidence: "PASS",
      verify_evidence_result_digest: sha256Json(verifyResult),
      consumer_contract: published.consumerContract,
      ...(retainedWorkDir === undefined ? {} : { retained_work_dir: retainedWorkDir }),
    } satisfies Omit<HandoffReceiptV2, "artifact_digest">;
    return { ...material, artifact_digest: sha256Json(material) };
  }

  private decodePrepareCommand(
    active: ActiveCompressionLaunch,
    command: AppServerCommandExecutionItem,
  ): PreparedHelperOutput {
    if (
      !commandIsCompletedAgentEvidence(command) ||
      !samePath(command.cwd, active.request.workspace_identity.canonical_root)
    ) {
      throw launcherError(
        "COMMAND_CHAIN_INVALID",
        "Compression prepare evidence is not one completed agent command in SourceCwd.",
        active.allocation.artifactRoot,
      );
    }
    const argv = tokenizeDirectCommand(command.command);
    if (
      argv.length !== 10 ||
      !exactNodeCommand(argv[0] as string, this.nodeExecutable) ||
      !samePath(argv[1] as string, active.skill.helperPath) ||
      argv[2] !== "prepare" ||
      argv[3] !== active.request.source_thread_id ||
      argv[4] !== "--map-result-mode" ||
      argv[5] !== "continuation-map-v2" ||
      argv[6] !== "--output" ||
      !samePath(argv[7] as string, active.allocation.markdownPath) ||
      argv[8] !== "--evidence-index" ||
      !samePath(argv[9] as string, active.allocation.evidenceIndexPath)
    ) {
      throw launcherError(
        "COMMAND_CHAIN_INVALID",
        "Compression prepare command is outside the canonical helper argv contract.",
        active.allocation.artifactRoot,
      );
    }
    return this.decodePrepareOutput(
      parseSingleJson(
        command.aggregatedOutput,
        this.maximumCommandOutputBytes,
        "prepare",
      ),
      active,
    );
  }

  private retainedWorkDirFromCommands(
    active: ActiveCompressionLaunch,
    commands: readonly AppServerCommandExecutionItem[],
  ): string | undefined {
    const prepare = commands[0];
    if (prepare === undefined) return undefined;
    try {
      return this.decodePrepareCommand(active, prepare).workDir;
    } catch {
      return undefined;
    }
  }

  private decodePrepareOutput(
    value: Readonly<Record<string, unknown>>,
    active: ActiveCompressionLaunch,
  ): PreparedHelperOutput {
    if (
      value.formatVersion !== 2 ||
      value.sessionId !== active.request.source_thread_id ||
      value.mapResultMode !== "continuation-map-v2" ||
      typeof value.sourceCwd !== "string" ||
      !samePath(value.sourceCwd, active.request.workspace_identity.canonical_root) ||
      typeof value.outputPath !== "string" ||
      !samePath(value.outputPath, active.allocation.markdownPath) ||
      typeof value.evidenceIndexPath !== "string" ||
      !samePath(value.evidenceIndexPath, active.allocation.evidenceIndexPath) ||
      !sha256Digest(value.sourceRevision) ||
      typeof value.workDir !== "string" ||
      !path.isAbsolute(value.workDir) ||
      !path.basename(value.workDir).startsWith(MANAGED_WORK_DIR_PREFIX) ||
      !isWithin(path.resolve(os.tmpdir()), path.resolve(value.workDir))
    ) {
      throw launcherError(
        "HELPER_OUTPUT_INVALID",
        "Prepare output is not bound to SourceCwd, workflow mode, paths, and a managed workDir.",
        active.allocation.artifactRoot,
      );
    }
    return { sourceRevision: value.sourceRevision, workDir: path.resolve(value.workDir) };
  }

  private decodePublishOutput(
    value: Readonly<Record<string, unknown>>,
    active: ActiveCompressionLaunch,
    prepared: PreparedHelperOutput,
  ): PublishedHelperOutput {
    if (
      value.formatVersion !== 2 ||
      value.sessionId !== active.request.source_thread_id ||
      typeof value.outputPath !== "string" ||
      !samePath(value.outputPath, active.allocation.markdownPath) ||
      typeof value.evidenceIndexPath !== "string" ||
      !samePath(value.evidenceIndexPath, active.allocation.evidenceIndexPath) ||
      value.sourceRevision !== prepared.sourceRevision ||
      !sha256Digest(value.sourceRevision) ||
      !sha256Digest(value.structuralDigest) ||
      !sha256Digest(value.handoffDigest) ||
      !sha256Digest(value.evidenceIndexDigest) ||
      (value.workDir !== null && value.workDir !== undefined && (
        typeof value.workDir !== "string" || !samePath(value.workDir, prepared.workDir)
      ))
    ) {
      throw launcherError(
        "HANDOFF_RECEIPT_INVALID",
        "Publish output is not bound to prepare, Source revision, and preallocated paths.",
        prepared.workDir,
      );
    }
    return {
      sourceRevision: value.sourceRevision,
      structuralDigest: value.structuralDigest,
      handoffDigest: value.handoffDigest,
      evidenceIndexDigest: value.evidenceIndexDigest,
      consumerContract: decodeConsumerContract(value.consumerContract),
      ...(typeof value.workDir === "string" ? { retainedWorkDir: path.resolve(value.workDir) } : {}),
    };
  }

  private async verifyPublishedPair(
    active: ActiveCompressionLaunch,
    published: PublishedHelperOutput,
  ): Promise<Readonly<{ markdown: Buffer; evidence: Buffer }>> {
    try {
      const [markdownIdentity, evidenceIdentity] = await Promise.all([
        assertRegularNonLink(active.allocation.markdownPath, "Handoff Markdown"),
        assertRegularNonLink(active.allocation.evidenceIndexPath, "Evidence Index"),
      ]);
      if (
        markdownIdentity.ino !== 0 &&
        markdownIdentity.dev === evidenceIdentity.dev &&
        markdownIdentity.ino === evidenceIdentity.ino
      ) {
        throw launcherError(
          "HANDOFF_PATH_INVALID",
          "Published Handoff pair aliases one filesystem identity.",
          active.allocation.artifactRoot,
        );
      }
      const [realArtifactRoot, realMarkdown, realEvidence, markdown, evidence] = await Promise.all([
        realpath(active.allocation.artifactRoot),
        realpath(active.allocation.markdownPath),
        realpath(active.allocation.evidenceIndexPath),
        readFile(active.allocation.markdownPath),
        readFile(active.allocation.evidenceIndexPath),
      ]);
      if (
        !samePath(realMarkdown, active.allocation.markdownPath) ||
        !samePath(realEvidence, active.allocation.evidenceIndexPath) ||
        !isWithin(realArtifactRoot, realMarkdown) ||
        !isWithin(realArtifactRoot, realEvidence)
      ) {
        throw launcherError(
          "HANDOFF_PATH_INVALID",
          "Published Handoff pair escaped or replaced its preallocated paths.",
          active.allocation.artifactRoot,
        );
      }
      if (
        sha256Bytes(markdown) !== published.handoffDigest ||
        sha256Bytes(evidence) !== published.evidenceIndexDigest
      ) {
        throw launcherError(
          "HANDOFF_ARTIFACT_DIGEST_MISMATCH",
          "Published Handoff bytes differ from publish output.",
          active.allocation.artifactRoot,
        );
      }
      const evidenceValue: unknown = JSON.parse(evidence.toString("utf8"));
      if (
        !isRecord(evidenceValue) ||
        !isRecord(evidenceValue.source) ||
        evidenceValue.source.sourceRevision !== published.sourceRevision
      ) {
        throw launcherError(
          "HANDOFF_VERIFY_FAILED",
          "Evidence Index does not bind the published Source revision.",
          active.allocation.artifactRoot,
        );
      }
      return { markdown, evidence };
    } catch (error: unknown) {
      if (error instanceof AppServerCompressionLauncherError) throw error;
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "HANDOFF_ARTIFACT_MISSING"
        : "HANDOFF_VERIFY_FAILED";
      throw launcherError(
        code,
        "Published Handoff pair is incomplete or unreadable.",
        active.allocation.artifactRoot,
        error,
      );
    }
  }

  private async verifyEvidence(
    active: ActiveCompressionLaunch,
    sourceRevision: Sha256Digest,
  ): Promise<Readonly<Record<string, unknown>>> {
    const output = await this.spawnVerifyEvidence(
      active.skill.helperPath,
      active.allocation.evidenceIndexPath,
      active.request.workspace_identity.canonical_root,
    );
    const value = parseSingleJson(output, this.maximumCommandOutputBytes, "verify-evidence");
    if (value.valid !== true || value.sourceRevision !== sourceRevision) {
      throw launcherError(
        "HANDOFF_VERIFY_FAILED",
        "Host verify-evidence did not validate the published Source revision.",
        active.allocation.artifactRoot,
      );
    }
    return value;
  }

  private spawnVerifyEvidence(
    helperPath: string,
    evidencePath: string,
    cwd: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.nodeExecutable,
        [helperPath, "verify-evidence", evidencePath],
        {
          cwd,
          env: process.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const fail = (error: AppServerCompressionLauncherError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(launcherError("HANDOFF_VERIFY_FAILED", "Host verify-evidence timed out."));
      }, this.verifyEvidenceTimeoutMs);
      child.stdout.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes + stderrBytes > this.maximumCommandOutputBytes) {
          fail(launcherError("HANDOFF_VERIFY_FAILED", "Host verify-evidence output exceeded its bound."));
          return;
        }
        stdout.push(bytes);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += bytes.length;
        if (stdoutBytes + stderrBytes > this.maximumCommandOutputBytes) {
          fail(launcherError("HANDOFF_VERIFY_FAILED", "Host verify-evidence output exceeded its bound."));
        }
      });
      child.once("error", (error) => {
        fail(launcherError("HANDOFF_VERIFY_FAILED", "Host verify-evidence could not start.", undefined, error));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0 || signal !== null) {
          reject(launcherError("HANDOFF_VERIFY_FAILED", "Host verify-evidence failed."));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  }

  private async resolveExportSkill(cwd: string): Promise<ResolvedExportSkill> {
    const response = await this.options.client.request("skills/list", {
      cwds: [cwd],
      forceReload: true,
    });
    if (response instanceof ProductionRuntimeError) {
      throw launcherError(
        "SKILL_RESOLUTION_FAILED",
        "App Server could not list export-codex-handoff for SourceCwd.",
        undefined,
        response,
      );
    }
    try {
      const decoded = decodeAppServerSkillsListResponse(response);
      const entry = decoded.data.filter((candidate) => candidate.cwd === cwd);
      if (entry.length !== 1 || (entry[0]?.errors.length ?? 0) !== 0) {
        throw new Error("ambiguous cwd or skill errors");
      }
      const skill = resolveAppServerSkill(response, cwd, EXPORT_CODEX_HANDOFF_SKILL_NAME);
      if (!path.isAbsolute(skill.path) || path.basename(skill.path).toLowerCase() !== "skill.md") {
        throw new Error("skill path is not an absolute SKILL.md");
      }
      const skillPath = await realpath(skill.path);
      await assertRegularNonLink(skillPath, "export-codex-handoff SKILL.md");
      const skillRoot = path.dirname(skillPath);
      const helperPath = await realpath(path.join(skillRoot, "scripts", "export-handoff.mjs"));
      await assertRegularNonLink(helperPath, "export-codex-handoff helper");
      if (!isWithin(skillRoot, helperPath)) throw new Error("helper escaped skill root");
      return { skillPath, helperPath };
    } catch (error: unknown) {
      if (error instanceof AppServerCompressionLauncherError) throw error;
      throw launcherError(
        "SKILL_RESOLUTION_FAILED",
        "export-codex-handoff did not resolve to one enabled canonical skill and helper.",
        undefined,
        error,
      );
    }
  }

  private async planArtifactAttempt(
    request: CompressionRequest,
    prior: CompressionLauncherJournalRecord | null,
  ): Promise<ArtifactAllocation> {
    requireStableSegment(request.run_id, "run_id");
    requireStableSegment(request.slice_id, "slice_id");
    const root = await this.canonicalStorageRoot();
    const realCwd = await realpath(request.workspace_identity.canonical_root);
    if (isWithin(realCwd, root) || isWithin(root, realCwd)) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Handoff storage root must not overlap SourceCwd.",
      );
    }
    const journalRoot = await this.ensureDirectory(root, JOURNAL_DIRECTORY);
    const digestHex = request.idempotency_key.slice("sha256:".length);
    const journalPath = path.join(journalRoot, `${digestHex}.json`);
    const attemptNumber = (prior?.attempt_number ?? 0) + 1;
    const attemptId = `attempt-${String(attemptNumber).padStart(6, "0")}-${digestHex.slice(0, 16)}`;
    const handoffsRoot = path.join(root, HANDOFF_DIRECTORY);
    const runRoot = path.join(handoffsRoot, request.run_id);
    const sliceRoot = path.join(runRoot, request.slice_id);
    const artifactRoot = path.join(sliceRoot, attemptId);
    const markdownPath = path.join(
      artifactRoot,
      `handoff-${request.source_thread_id}.md`,
    );
    const evidenceIndexPath = path.join(
      artifactRoot,
      `handoff-${request.source_thread_id}.evidence.json`,
    );
    return {
      journalPath,
      attemptNumber,
      attemptId,
      artifactRoot,
      markdownPath,
      evidenceIndexPath,
    };
  }

  private async materializeArtifactAttempt(
    request: CompressionRequest,
    allocation: ArtifactAllocation,
  ): Promise<void> {
    const root = await this.canonicalStorageRoot();
    const handoffsRoot = await this.ensureDirectory(root, HANDOFF_DIRECTORY);
    const runRoot = await this.ensureDirectory(handoffsRoot, request.run_id);
    const sliceRoot = await this.ensureDirectory(runRoot, request.slice_id);
    if (!samePath(path.dirname(allocation.artifactRoot), sliceRoot)) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Persisted Handoff attempt path drifted from its Run and Slice binding.",
        allocation.artifactRoot,
      );
    }
    try {
      await mkdir(allocation.artifactRoot);
    } catch (error: unknown) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Handoff attempt path already exists or cannot be created.",
        allocation.artifactRoot,
        error,
      );
    }
    const realArtifactRoot = await realpath(allocation.artifactRoot);
    const metadata = await lstat(allocation.artifactRoot);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePath(realArtifactRoot, allocation.artifactRoot) ||
      !isWithin(root, realArtifactRoot)
    ) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Handoff attempt path is a link, reparse escape, or non-directory.",
        allocation.artifactRoot,
      );
    }
    if (
      !samePath(path.dirname(allocation.markdownPath), realArtifactRoot) ||
      !samePath(path.dirname(allocation.evidenceIndexPath), realArtifactRoot)
    ) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Persisted Handoff targets drifted from their attempt directory.",
        realArtifactRoot,
      );
    }
    for (const target of [allocation.markdownPath, allocation.evidenceIndexPath]) {
      try {
        await lstat(target);
        throw launcherError(
          "ARTIFACT_ALLOCATION_FAILED",
          "Preallocated Handoff target already exists.",
          realArtifactRoot,
        );
      } catch (error: unknown) {
        if (error instanceof AppServerCompressionLauncherError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw launcherError(
            "ARTIFACT_ALLOCATION_FAILED",
            "Preallocated Handoff target identity cannot be inspected.",
            realArtifactRoot,
            error,
          );
        }
      }
    }
  }

  private async canonicalStorageRoot(): Promise<string> {
    this.rootPromise ??= (async () => {
      await mkdir(this.storageRoot, { recursive: true });
      return realpath(this.storageRoot);
    })();
    return this.rootPromise;
  }

  private async ensureDirectory(root: string, segment: string): Promise<string> {
    requireStableSegment(segment, "Handoff directory segment");
    const candidate = path.join(root, segment);
    try {
      await mkdir(candidate);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw launcherError(
          "ARTIFACT_ALLOCATION_FAILED",
          "Handoff storage directory cannot be created.",
          candidate,
          error,
        );
      }
    }
    const metadata = await lstat(candidate);
    const resolved = await realpath(candidate);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePath(candidate, resolved) ||
      !isWithin(root, resolved)
    ) {
      throw launcherError(
        "ARTIFACT_ALLOCATION_FAILED",
        "Handoff storage directory is a link or reparse escape.",
        candidate,
      );
    }
    return resolved;
  }

  private journalPath(effectKey: Sha256Digest, root: string): string {
    return path.join(
      root,
      JOURNAL_DIRECTORY,
      `${effectKey.slice("sha256:".length)}.json`,
    );
  }

  private async readJournal(
    effectKey: Sha256Digest,
  ): Promise<CompressionLauncherJournalRecord | null> {
    const root = await this.canonicalStorageRoot();
    const target = this.journalPath(effectKey, root);
    try {
      const value: unknown = JSON.parse(await readFile(target, "utf8"));
      const decoded = decodeJournal(value);
      if (decoded.effect_idempotency_key !== effectKey) {
        throw launcherError("RECEIPT_REPLAY_MISMATCH", "Launcher journal effect key drifted.");
      }
      return decoded;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof AppServerCompressionLauncherError) throw error;
      throw launcherError("RECEIPT_REPLAY_MISMATCH", "Launcher journal cannot be read.", undefined, error);
    }
  }

  private assertJournalBinding(
    journal: CompressionLauncherJournalRecord,
    request: CompressionRequest,
    requestDigest: Sha256Digest,
  ): void {
    if (
      journal.request_digest !== requestDigest ||
      journal.run_id !== request.run_id ||
      journal.slice_id !== request.slice_id ||
      journal.source_thread_id !== request.source_thread_id ||
      journal.effect_idempotency_key !== request.idempotency_key
    ) {
      throw launcherError(
        "RECEIPT_REPLAY_MISMATCH",
        "Compression effect replay changed its frozen request binding.",
      );
    }
  }

  private async writeJournal(
    target: string,
    value: CompressionLauncherJournalRecord,
  ): Promise<void> {
    const root = await this.canonicalStorageRoot();
    const journalRoot = await this.ensureDirectory(root, JOURNAL_DIRECTORY);
    if (!samePath(path.dirname(target), journalRoot)) {
      throw launcherError("RECEIPT_REPLAY_MISMATCH", "Launcher journal path escaped its root.");
    }
    const temporary = path.join(
      journalRoot,
      `.${path.basename(target)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  private receiptMaterial(
    receipt: HandoffReceiptV2,
  ): Omit<HandoffReceiptV2, "artifact_digest"> {
    return {
      receipt_schema_version: receipt.receipt_schema_version,
      compression_task_id: receipt.compression_task_id,
      compression_turn_id: receipt.compression_turn_id,
      source_thread_id: receipt.source_thread_id,
      workflow_version: receipt.workflow_version,
      markdown_path: receipt.markdown_path,
      evidence_index_path: receipt.evidence_index_path,
      source_revision: receipt.source_revision,
      structural_digest: receipt.structural_digest,
      handoff_digest: receipt.handoff_digest,
      evidence_index_digest: receipt.evidence_index_digest,
      verify_evidence: receipt.verify_evidence,
      verify_evidence_result_digest: receipt.verify_evidence_result_digest,
      consumer_contract: receipt.consumer_contract,
      ...(receipt.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: receipt.retained_work_dir }),
    };
  }
}
