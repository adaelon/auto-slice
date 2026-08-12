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
import { fileURLToPath } from "node:url";

import {
  decodeAppServerSkillsListResponse,
  resolveAppServerSkill,
  type AppServerAgentMessageItem,
} from "../production/app-server-protocol-v2.js";
import type { CodexAppServerClient } from "../production/app-server-client.js";
import type {
  AppServerFreshTaskTurnHandle,
  AppServerFreshTaskTurnReceipt,
  CodexAppServerFreshTaskSessions,
} from "../production/app-server-fresh-task-session.js";
import { ProductionRuntimeError } from "../production/errors.js";
import {
  sha256Json,
  type Sha256Digest,
} from "../state/index.js";

import {
  HANDOFF_RESULT_RECEIPT_SCHEMA_VERSION,
  HANDOFF_RESULT_WORKFLOW_VERSION,
  type CompressionRequest,
  type CompressionTaskLauncher,
  type CompressionTaskLaunchReceipt,
  type HandoffResultReceipt,
} from "./types.js";

export const EXPORT_CODEX_HANDOFF_SKILL_NAME = "export-codex-handoff" as const;
export const DEFAULT_COMPRESSION_FINAL_RESULT_BYTES = 64 * 1024;
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
  readonly receipt?: HandoffResultReceipt;
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
  readonly launchReceipt: CompressionTaskLaunchReceipt;
  readonly turn: AppServerFreshTaskTurnHandle;
  readonly journal: CompressionLauncherJournalRecord;
}

export interface AppServerCompressionTaskLauncherOptions {
  readonly client: CodexAppServerClient;
  readonly fresh_task_sessions: CodexAppServerFreshTaskSessions;
  readonly artifact_storage_root?: string;
  readonly now?: () => Date;
  readonly maximum_final_result_bytes?: number;
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

function firstMarkdownFileAddress(
  terminal: AppServerFreshTaskTurnReceipt,
  maximumBytes: number,
  artifactRoot: string,
): string {
  const messages = terminal.completed_items
    .map((entry) => entry.item)
    .filter((item): item is AppServerAgentMessageItem => (
      item.type === "agentMessage" && item.text.trim().length > 0
    ));
  const finalMessages = messages.filter((item) => item.phase === "final_answer");
  const result = finalMessages.at(-1) ?? messages.at(-1);
  if (
    result === undefined ||
    Buffer.byteLength(result.text, "utf8") > maximumBytes
  ) {
    throw launcherError(
      "HANDOFF_RESULT_INVALID",
      "Compression final result is missing or exceeds its bound.",
      artifactRoot,
    );
  }
  const match = /\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^)\r\n]+?)\s*\)/u.exec(result.text);
  if (match === null) {
    throw launcherError(
      "HANDOFF_RESULT_INVALID",
      "Compression final result contains no Markdown file address.",
      artifactRoot,
    );
  }
  const captured = match[1] as string;
  const destination = captured.startsWith("<") && captured.endsWith(">")
    ? captured.slice(1, -1)
    : captured;
  let filePath: string;
  try {
    filePath = destination.startsWith("file:")
      ? fileURLToPath(destination)
      : destination;
  } catch (error: unknown) {
    throw launcherError(
      "HANDOFF_RESULT_INVALID",
      "Compression final result contains an invalid file address.",
      artifactRoot,
      error,
    );
  }
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    throw launcherError(
      "HANDOFF_RESULT_INVALID",
      "Compression final result's first file address is not an absolute local path.",
      artifactRoot,
    );
  }
  return path.normalize(filePath);
}

function promptForCompression(
  sourceThreadId: string,
  markdownPath: string,
  evidenceIndexPath: string,
): string {
  return `$${EXPORT_CODEX_HANDOFF_SKILL_NAME} ${sourceThreadId} Use continuation-map-v2. ` +
    `Publish the Handoff Markdown to ${JSON.stringify(markdownPath)} and the Evidence Index to ` +
    `${JSON.stringify(evidenceIndexPath)}. Complete the skill workflow and end the Turn only after both ` +
    `final files exist.`;
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
  private readonly maximumFinalResultBytes: number;
  private readonly startPromises = new Map<Sha256Digest, Promise<CompressionTaskLaunchReceipt>>();
  private readonly activeLaunches = new Map<string, ActiveCompressionLaunch>();
  private readonly handoffPromises = new Map<Sha256Digest, Promise<HandoffResultReceipt>>();
  private rootPromise: Promise<string> | null = null;

  public constructor(private readonly options: AppServerCompressionTaskLauncherOptions) {
    this.now = options.now ?? (() => new Date());
    this.storageRoot = path.resolve(options.artifact_storage_root ?? DEFAULT_HANDOFF_STORAGE_ROOT);
    this.maximumFinalResultBytes = options.maximum_final_result_bytes ??
      DEFAULT_COMPRESSION_FINAL_RESULT_BYTES;
    requirePositiveInteger(this.maximumFinalResultBytes, "maximum_final_result_bytes");
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
        project_completed_item_types: ["agentMessage"],
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

  private async completeActiveLaunch(active: ActiveCompressionLaunch): Promise<HandoffResultReceipt> {
    try {
      const terminal = await active.turn.completion;
      if (terminal instanceof ProductionRuntimeError) throw terminal;
      if (terminal.terminal_status !== "completed") {
        throw launcherError(
          "COMPRESSION_TURN_FAILED",
          "Compression Turn did not reach a completed terminal.",
          active.allocation.artifactRoot,
        );
      }
      const receipt = this.buildReceipt(active, terminal);
      const completedJournal: CompressionLauncherJournalRecord = {
        ...active.journal,
        status: "COMPLETED",
        receipt,
      };
      await this.writeJournal(active.allocation.journalPath, completedJournal);
      return receipt;
    } catch (error: unknown) {
      const normalized = error instanceof AppServerCompressionLauncherError
        ? error
        : launcherError(
          "COMPRESSION_TURN_FAILED",
          "Compression Turn final result could not be accepted.",
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

  private buildReceipt(
    active: ActiveCompressionLaunch,
    terminal: AppServerFreshTaskTurnReceipt,
  ): HandoffResultReceipt {
    const material = {
      receipt_schema_version: HANDOFF_RESULT_RECEIPT_SCHEMA_VERSION,
      compression_task_id: active.launchReceipt.compression_task_id,
      compression_turn_id: active.turn.turn_id,
      source_thread_id: active.request.source_thread_id,
      workflow_version: HANDOFF_RESULT_WORKFLOW_VERSION,
      markdown_path: firstMarkdownFileAddress(
        terminal,
        this.maximumFinalResultBytes,
        active.allocation.artifactRoot,
      ),
    } satisfies Omit<HandoffResultReceipt, "artifact_digest">;
    return { ...material, artifact_digest: sha256Json(material) };
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
    receipt: HandoffResultReceipt,
  ): Omit<HandoffResultReceipt, "artifact_digest"> {
    return {
      receipt_schema_version: receipt.receipt_schema_version,
      compression_task_id: receipt.compression_task_id,
      compression_turn_id: receipt.compression_turn_id,
      source_thread_id: receipt.source_thread_id,
      workflow_version: receipt.workflow_version,
      markdown_path: receipt.markdown_path,
    };
  }
}
