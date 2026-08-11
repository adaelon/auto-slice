import path from "node:path";

import {
  nextCompactionProbeElapsedMs,
  TimeoutDeadlineScheduler,
  type DeadlineScheduler,
} from "../compaction-monitor/index.js";
import { sha256Json, type Sha256Digest } from "../state/index.js";
import {
  SourceInterruptionError,
  THREAD_REVISION_UNAVAILABLE,
  isOpaqueStableRevision,
  type InterruptReceipt,
  type OpaqueStableRevision,
  type ThreadControlPort,
  type ThreadInspection,
  type ThreadMetadataPort,
  type ThreadRevisionProvider,
  type ThreadSummary,
} from "../thread-control/index.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./app-server-client.js";
import { ProductionRuntimeError } from "./errors.js";
import {
  DEVELOPMENT_TASK_SCHEMA_VERSION,
  type CompactionContentProbePort,
  type CompactionProbeFailureReasonCode,
  type CompactionProbeResult,
  type ControllerSignal,
  type DevelopmentTaskEvent,
  type DevelopmentTaskHandle,
  type DevelopmentTaskPort,
  type DevelopmentTaskReceipt,
  type DevelopmentTaskRequest,
} from "./types.js";

interface QueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void;
}

type SessionControllerSignal = Exclude<
  ControllerSignal,
  { readonly type: "THREAD_LIFECYCLE" }
>;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private closed = false;

  public push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push({ resolve });
        });
      },
    };
  }
}

interface TaskSession {
  readonly request: DevelopmentTaskRequest;
  readonly threadId: string;
  readonly queue: AsyncEventQueue<DevelopmentTaskEvent>;
  readonly completion: Promise<DevelopmentTaskReceipt | ProductionRuntimeError>;
  readonly resolveCompletion: (value: DevelopmentTaskReceipt | ProductionRuntimeError) => void;
  readonly pendingSignals: SessionControllerSignal[];
  readonly activeCompactions: Set<string>;
  readonly startedAt: string;
  eventSequence: number;
  probeCompactionId: string | null;
  probeGeneration: number;
  probeInFlight: boolean;
  probeStartedAt: string | null;
  probeScheduleKey: string | null;
  probeStopped: boolean;
  turnId: string | null;
  forcedFailure: ProductionRuntimeError | null;
  terminal: DevelopmentTaskReceipt | ProductionRuntimeError | null;
  interruptPromise: Promise<void> | null;
}

// Codex app-server v2 serializes SandboxMode with kebab-case enum values.
const CODEX_WORKSPACE_WRITE_SANDBOX = "workspace-write" as const;

export interface CodexAppServerDevelopmentTaskOptions extends CodexAppServerClientOptions {
  readonly now?: () => Date;
  readonly thread_revision_provider?: ThreadRevisionProvider;
  readonly compaction_content_probe?: CompactionContentProbePort;
  readonly compaction_probe_scheduler?: DeadlineScheduler;
}

const PROBE_FAILURE_REASONS = new Set<CompactionProbeFailureReasonCode>([
  "content_read_failed",
  "probe_timeout",
  "probe_unavailable",
  "probe_protocol_error",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function decodeProbeResult(value: unknown): CompactionProbeResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return { kind: "PROBE_FAILED", reasonCode: "probe_protocol_error" };
  }
  if (value.kind === "NO_COMPACTION" && hasExactKeys(value, ["kind"])) {
    return { kind: "NO_COMPACTION" };
  }
  if (
    value.kind === "COMPACTION_SEEN" &&
    hasExactKeys(value, ["kind", "observedAt"]) &&
    canonicalTimestamp(value.observedAt)
  ) {
    return { kind: "COMPACTION_SEEN", observedAt: value.observedAt };
  }
  if (
    value.kind === "PROBE_FAILED" &&
    hasExactKeys(value, ["kind", "reasonCode"]) &&
    PROBE_FAILURE_REASONS.has(value.reasonCode as CompactionProbeFailureReasonCode)
  ) {
    return {
      kind: "PROBE_FAILED",
      reasonCode: value.reasonCode as CompactionProbeFailureReasonCode,
    };
  }
  return { kind: "PROBE_FAILED", reasonCode: "probe_protocol_error" };
}

function containsThreadContent(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      const children: readonly unknown[] = current;
      for (const child of children) {
        pending.push(child);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "turns" || key === "items") {
        return true;
      }
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
  }
  return false;
}

export const FAIL_CLOSED_THREAD_REVISION_PROVIDER: ThreadRevisionProvider = Object.freeze({
  read: () => Promise.resolve(THREAD_REVISION_UNAVAILABLE),
});

export class CodexAppServerThreadMetadataPort implements ThreadMetadataPort {
  public constructor(
    private readonly client: CodexAppServerClient,
    private readonly timestamp: () => string,
  ) {}

  public async inspect(threadId: string, includeTurns: boolean = false): Promise<ThreadSummary> {
    if (!isIdentifier(threadId) || includeTurns) {
      throw new ProductionRuntimeError(
        "app_server_protocol_error",
        "Thread metadata inspection requires a stable thread identity and includeTurns=false.",
      );
    }
    const response = await this.client.request("thread/read", {
      threadId,
      includeTurns: false,
    });
    if (response instanceof ProductionRuntimeError) {
      throw response;
    }
    if (
      !isRecord(response) ||
      !isRecord(response.thread) ||
      response.thread.id !== threadId ||
      response.thread.ephemeral !== false
    ) {
      throw new ProductionRuntimeError(
        "app_server_protocol_error",
        "Summary-only thread/read did not return the persisted Source Thread.",
      );
    }
    if (containsThreadContent(response.thread)) {
      throw new ProductionRuntimeError(
        "app_server_protocol_error",
        "Summary-only thread/read contained forbidden turns or items.",
      );
    }
    return {
      thread_id: threadId,
      readable: true,
      archived: false,
      deleted: false,
      observed_at: this.timestamp(),
    };
  }
}

export class CodexAppServerDevelopmentTask implements DevelopmentTaskPort, ThreadControlPort {
  private readonly client: CodexAppServerClient;
  private readonly now: () => Date;
  private readonly revisionProvider: ThreadRevisionProvider;
  private readonly compactionContentProbe: CompactionContentProbePort | undefined;
  private readonly compactionProbeScheduler: DeadlineScheduler;
  private readonly metadataPort: CodexAppServerThreadMetadataPort;
  private readonly sessions = new Map<string, TaskSession>();
  private readonly interruptReceipts = new Map<string, { readonly threadId: string; readonly receipt: InterruptReceipt }>();
  private readonly archivedThreads = new Set<string>();
  private readonly deletedThreads = new Set<string>();
  private readonly closedThreads = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private active: TaskSession | null = null;

  public constructor(options: CodexAppServerDevelopmentTaskOptions = {}) {
    this.client = new CodexAppServerClient(options);
    this.now = options.now ?? (() => new Date());
    this.revisionProvider = options.thread_revision_provider ?? FAIL_CLOSED_THREAD_REVISION_PROVIDER;
    this.compactionContentProbe = options.compaction_content_probe;
    this.compactionProbeScheduler = options.compaction_probe_scheduler ?? new TimeoutDeadlineScheduler({
      now: () => this.now(),
    });
    this.metadataPort = new CodexAppServerThreadMetadataPort(
      this.client,
      () => this.timestamp(),
    );
  }

  public async start(
    request: DevelopmentTaskRequest,
  ): Promise<DevelopmentTaskHandle | ProductionRuntimeError> {
    const invalid = this.validateRequest(request);
    if (invalid !== null) {
      return invalid;
    }
    const probeConfigurationFailure = this.validateProbeConfiguration();
    if (probeConfigurationFailure !== null) {
      return probeConfigurationFailure;
    }
    if (this.active !== null && this.active.terminal === null) {
      return new ProductionRuntimeError(
        "development_task_busy",
        "Only one Development Task may run in one App Server adapter at a time.",
      );
    }
    const initialized = await this.client.initialize();
    if (initialized !== null) {
      return initialized;
    }
    this.ensureSubscribed();
    const threadResponse = await this.client.request("thread/start", {
      model: request.model_decision.model,
      cwd: request.workspace_identity.canonical_root,
      approvalPolicy: "never",
      sandbox: CODEX_WORKSPACE_WRITE_SANDBOX,
      serviceName: "auto_slice",
    });
    if (threadResponse instanceof ProductionRuntimeError) {
      return threadResponse;
    }
    const thread = this.decodeThreadStart(threadResponse);
    if (thread instanceof ProductionRuntimeError) {
      return thread;
    }
    const session = this.createSession(request, thread.threadId);
    try {
      this.client.registerTask({
        run_id: request.run_id,
        slice_id: request.slice_id,
        thread_id: thread.threadId,
        started_at: session.startedAt,
      });
    } catch (error: unknown) {
      return error instanceof ProductionRuntimeError
        ? error
        : new ProductionRuntimeError(
          "app_server_protocol_error",
          "HostEventFirewall rejected the Development Task registration.",
          { cause: error },
        );
    }
    this.sessions.set(thread.threadId, session);
    this.active = session;
    const turnResponse = await this.client.request("turn/start", {
      threadId: thread.threadId,
      input: [{ type: "text", text: request.prompt }],
      cwd: request.workspace_identity.canonical_root,
      approvalPolicy: "never",
      model: request.model_decision.model,
      effort: request.model_decision.effort,
    });
    if (turnResponse instanceof ProductionRuntimeError) {
      this.finishSession(session, turnResponse);
      return turnResponse;
    }
    const turn = this.decodeTurnStart(turnResponse);
    if (turn instanceof ProductionRuntimeError) {
      this.finishSession(session, turn);
      return turn;
    }
    try {
      this.client.registerTurn(thread.threadId, turn.turnId);
    } catch (error: unknown) {
      const registrationError = error instanceof ProductionRuntimeError
        ? error
        : new ProductionRuntimeError(
          "app_server_protocol_error",
          "HostEventFirewall rejected the Development Task turn registration.",
          { cause: error },
        );
      this.finishSession(session, registrationError);
      return registrationError;
    }
    session.turnId = turn.turnId;
    session.probeStartedAt = this.timestamp();
    for (const signal of session.pendingSignals.splice(0)) {
      this.handleSessionSignal(session, signal);
    }
    if (session.terminal === null && !session.probeStopped) {
      this.startCompactionProbe(session);
    }
    return {
      thread_id: session.threadId,
      turn_id: turn.turnId,
      events: session.queue,
      completion: session.completion,
    };
  }

  public async interrupt(threadId: string, idempotencyKey: Sha256Digest): Promise<unknown> {
    const cached = this.interruptReceipts.get(idempotencyKey);
    if (cached !== undefined) {
      if (cached.threadId !== threadId) {
        throw new ProductionRuntimeError(
          "app_server_protocol_error",
          "Interrupt idempotency key was reused for another thread.",
        );
      }
      return cached.receipt;
    }
    const session = this.sessions.get(threadId);
    if (session === undefined || session.turnId === null) {
      throw new ProductionRuntimeError(
        "app_server_request_failed",
        "Source Thread is unknown to this App Server adapter.",
      );
    }
    if (session.terminal === null) {
      await this.requestInterrupt(session);
    }
    const terminal = await session.completion;
    if (terminal instanceof ProductionRuntimeError) {
      throw terminal;
    }
    const persistedRevision = await this.readPersistedRevision(threadId);
    const receipt: InterruptReceipt = {
      thread_id: threadId,
      execution_stopped: true,
      thread_persisted: true,
      persisted_revision: persistedRevision,
      observed_at: this.timestamp(),
    };
    this.interruptReceipts.set(idempotencyKey, { threadId, receipt });
    return receipt;
  }

  public async inspect(threadId: string, includeTurns: false = false): Promise<unknown> {
    if (
      this.archivedThreads.has(threadId) ||
      this.deletedThreads.has(threadId) ||
      this.closedThreads.has(threadId)
    ) {
      throw new ProductionRuntimeError(
        "app_server_request_failed",
        "Source Thread is archived, deleted, or closed.",
      );
    }
    const summary = await this.metadataPort.inspect(threadId, includeTurns);
    const persistedRevision = await this.readPersistedRevision(threadId);
    const inspection: ThreadInspection = {
      ...summary,
      persisted_revision: persistedRevision,
    };
    return inspection;
  }

  public dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.stopCompactionProbe(session);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    return this.client.dispose();
  }

  private validateRequest(request: DevelopmentTaskRequest): ProductionRuntimeError | null {
    const schemaVersion: unknown = request.schema_version;
    const modelMode: unknown = request.model_decision.mode;
    const modelName: unknown = request.model_decision.model;
    if (
      schemaVersion !== DEVELOPMENT_TASK_SCHEMA_VERSION ||
      !isIdentifier(request.run_id) ||
      !isIdentifier(request.slice_id) ||
      !isIdentifier(request.lease_id) ||
      !Number.isSafeInteger(request.write_epoch) ||
      request.write_epoch < 1 ||
      modelMode !== "model" ||
      modelName !== "gpt-5.6-sol" ||
      request.model_decision.effort !== "max" ||
      typeof request.prompt !== "string" ||
      request.prompt.length === 0 ||
      !path.isAbsolute(request.workspace_identity.canonical_root)
    ) {
      return new ProductionRuntimeError(
        "development_task_invalid",
        "DevelopmentTaskRequest is invalid or violates the exact DEVELOPMENT policy.",
      );
    }
    return null;
  }

  private validateProbeConfiguration(): ProductionRuntimeError | null {
    const capabilities = this.client.hostCapabilities();
    const eventCapability: unknown = capabilities.context_compaction_events;
    if (
      eventCapability !== "AVAILABLE" &&
      eventCapability !== "UNAVAILABLE"
    ) {
      return new ProductionRuntimeError(
        "development_task_invalid",
        "The Host compaction capability report is invalid.",
      );
    }
    if (
      eventCapability === "UNAVAILABLE" &&
      this.compactionContentProbe === undefined
    ) {
      return new ProductionRuntimeError(
        "compaction_probe_failed",
        "The Host requires an isolated Compaction Content Probe, but no probe port is configured.",
      );
    }
    return null;
  }

  private decodeThreadStart(
    value: unknown,
  ): { readonly threadId: string } | ProductionRuntimeError {
    if (!isRecord(value) || !isRecord(value.thread)) {
      return new ProductionRuntimeError(
        "app_server_protocol_error",
        "thread/start response is malformed.",
      );
    }
    if (
      !isIdentifier(value.thread.id) ||
      value.thread.ephemeral !== false
    ) {
      return new ProductionRuntimeError(
        "model_policy_unavailable",
        "thread/start did not return the requested persistent Source Thread.",
      );
    }
    return { threadId: value.thread.id };
  }

  private decodeTurnStart(value: unknown): { readonly turnId: string } | ProductionRuntimeError {
    if (
      !isRecord(value) ||
      !isRecord(value.turn) ||
      !isIdentifier(value.turn.id) ||
      value.turn.status !== "inProgress"
    ) {
      return new ProductionRuntimeError(
        "app_server_protocol_error",
        "turn/start response is malformed or not in progress.",
      );
    }
    return { turnId: value.turn.id };
  }

  private createSession(request: DevelopmentTaskRequest, threadId: string): TaskSession {
    let resolveCompletion: (value: DevelopmentTaskReceipt | ProductionRuntimeError) => void = () => undefined;
    const completion = new Promise<DevelopmentTaskReceipt | ProductionRuntimeError>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      request,
      threadId,
      queue: new AsyncEventQueue<DevelopmentTaskEvent>(),
      completion,
      resolveCompletion,
      pendingSignals: [],
      activeCompactions: new Set<string>(),
      startedAt: this.timestamp(),
      eventSequence: 0,
      probeCompactionId: null,
      probeGeneration: 0,
      probeInFlight: false,
      probeStartedAt: null,
      probeScheduleKey: null,
      probeStopped: false,
      turnId: null,
      forcedFailure: null,
      terminal: null,
      interruptPromise: null,
    };
  }

  private ensureSubscribed(): void {
    this.unsubscribe ??= this.client.subscribe(
      (signal) => {
        this.handleSignal(signal);
      },
      (error) => {
        for (const session of this.sessions.values()) {
          if (session.terminal === null) {
            this.finishSession(session, error);
          }
        }
      },
    );
  }

  private handleSignal(signal: ControllerSignal): void {
    if (signal.type === "THREAD_LIFECYCLE") {
      if (signal.state === "ARCHIVED") {
        this.archivedThreads.add(signal.thread_id);
      } else if (signal.state === "DELETED") {
        this.deletedThreads.add(signal.thread_id);
      } else if (signal.state === "UNARCHIVED") {
        this.archivedThreads.delete(signal.thread_id);
      } else {
        this.closedThreads.add(signal.thread_id);
      }
      return;
    }
    const session = this.sessions.get(signal.thread_id);
    if (session === undefined || session.terminal !== null) {
      return;
    }
    if (session.turnId === null) {
      session.pendingSignals.push(signal);
      return;
    }
    this.handleSessionSignal(session, signal);
  }

  private handleSessionSignal(
    session: TaskSession,
    signal: SessionControllerSignal,
  ): void {
    if (session.terminal !== null) {
      return;
    }
    if (
      (signal.type === "MODEL_REROUTED" || signal.type === "TURN_TERMINAL") &&
      signal.turn_id !== session.turnId
    ) {
      return;
    }
    if (signal.type === "MODEL_REROUTED") {
      this.forceFailure(session, new ProductionRuntimeError(
        "model_policy_unavailable",
        "Codex rerouted the frozen DEVELOPMENT model.",
      ));
      return;
    }
    if (signal.type === "COMPACTION") {
      this.handleCompactionSignal(session, signal);
      return;
    }
    this.handleTurnTerminal(session, signal);
  }

  private handleCompactionSignal(
    session: TaskSession,
    signal: Extract<ControllerSignal, { readonly type: "COMPACTION" }>,
  ): void {
    this.stopCompactionProbe(session);
    if (session.probeCompactionId !== null) {
      this.completeProbeCompaction(session, signal.observed_at);
      if (signal.phase === "COMPLETED") {
        return;
      }
    }
    if (signal.phase === "STARTED") {
      if (session.activeCompactions.has(signal.compaction_id)) {
        this.forceFailure(session, new ProductionRuntimeError(
          "app_server_protocol_error",
          "contextCompaction item started more than once.",
        ));
        return;
      }
      session.activeCompactions.add(signal.compaction_id);
    } else if (!session.activeCompactions.delete(signal.compaction_id)) {
      this.forceFailure(session, new ProductionRuntimeError(
        "app_server_protocol_error",
        "contextCompaction item completed without a matching start.",
      ));
      return;
    }
    session.queue.push({
      type: signal.phase === "STARTED"
        ? "AUTO_COMPACTION_STARTED"
        : "AUTO_COMPACTION_COMPLETED",
      thread_id: session.threadId,
      compaction_id: signal.compaction_id,
      observed_at: signal.observed_at,
      host_sequence: this.nextEventSequence(session),
    });
  }

  private startCompactionProbe(session: TaskSession): void {
    if (this.client.hostCapabilities().context_compaction_events === "AVAILABLE") {
      return;
    }
    this.scheduleCompactionProbe(session, true);
  }

  private scheduleCompactionProbe(
    session: TaskSession,
    includeCurrent: boolean,
  ): void {
    if (
      session.terminal !== null ||
      session.probeStopped ||
      session.probeInFlight ||
      session.turnId === null ||
      session.probeStartedAt === null
    ) {
      return;
    }
    let elapsedMs: number;
    let scheduledElapsedMs: number;
    try {
      elapsedMs = this.probeElapsedMs(session);
      scheduledElapsedMs = nextCompactionProbeElapsedMs(elapsedMs, includeCurrent);
    } catch {
      this.forceFailure(session, this.probeFailure("probe_protocol_error"));
      return;
    }
    const scheduleKey = `compaction-content-probe:${session.threadId}:${session.turnId}`;
    const deadline = new Date(Date.parse(session.probeStartedAt) + scheduledElapsedMs);
    session.probeScheduleKey = scheduleKey;
    try {
      this.compactionProbeScheduler.schedule(scheduleKey, deadline, () => {
        if (session.probeScheduleKey !== scheduleKey) {
          return;
        }
        session.probeScheduleKey = null;
        void this.runCompactionProbe(session, scheduledElapsedMs);
      });
    } catch {
      session.probeScheduleKey = null;
      this.forceFailure(session, this.probeFailure("probe_protocol_error"));
    }
  }

  private async runCompactionProbe(
    session: TaskSession,
    scheduledElapsedMs: number,
  ): Promise<void> {
    if (
      session.terminal !== null ||
      session.probeStopped ||
      session.probeInFlight ||
      session.turnId === null ||
      session.probeStartedAt === null ||
      this.compactionContentProbe === undefined
    ) {
      return;
    }
    let elapsedMs: number;
    try {
      elapsedMs = this.probeElapsedMs(session);
    } catch {
      this.forceFailure(session, this.probeFailure("probe_protocol_error"));
      return;
    }
    if (elapsedMs < scheduledElapsedMs) {
      this.scheduleCompactionProbe(session, true);
      return;
    }
    session.probeInFlight = true;
    const generation = session.probeGeneration;
    let rawResult: unknown;
    try {
      rawResult = await this.compactionContentProbe.probe(
        session.threadId,
        session.turnId,
        elapsedMs,
      );
    } catch {
      rawResult = { kind: "PROBE_FAILED", reasonCode: "probe_protocol_error" };
    }
    session.probeInFlight = false;
    if (
      generation !== session.probeGeneration ||
      !this.probeSessionActive(session)
    ) {
      return;
    }
    const result = decodeProbeResult(rawResult);
    if (result.kind === "NO_COMPACTION") {
      this.scheduleCompactionProbe(session, false);
      return;
    }
    if (result.kind === "PROBE_FAILED") {
      this.stopCompactionProbe(session);
      this.forceFailure(session, this.probeFailure(result.reasonCode));
      return;
    }
    const observedMilliseconds = Date.parse(result.observedAt);
    const probeStartedMilliseconds = Date.parse(session.probeStartedAt);
    const probeNowMilliseconds = probeStartedMilliseconds + elapsedMs;
    if (
      observedMilliseconds < probeStartedMilliseconds ||
      observedMilliseconds > probeNowMilliseconds
    ) {
      this.stopCompactionProbe(session);
      this.forceFailure(session, this.probeFailure("probe_protocol_error"));
      return;
    }
    this.stopCompactionProbe(session);
    const compactionId = `probe-${sha256Json({
      kind: "compaction_content_probe",
      thread_id: session.threadId,
      turn_id: session.turnId,
      observed_at: result.observedAt,
    }).slice("sha256:".length)}`;
    session.probeCompactionId = compactionId;
    session.queue.push({
      type: "AUTO_COMPACTION_STARTED",
      thread_id: session.threadId,
      compaction_id: compactionId,
      observed_at: result.observedAt,
      host_sequence: this.nextEventSequence(session),
    });
  }

  private stopCompactionProbe(session: TaskSession): void {
    if (!session.probeStopped) {
      session.probeStopped = true;
      session.probeGeneration += 1;
    }
    const scheduleKey = session.probeScheduleKey;
    session.probeScheduleKey = null;
    if (scheduleKey !== null) {
      try {
        this.compactionProbeScheduler.cancel(scheduleKey);
      } catch {
        // Generation and stopped-state checks make a stale callback inert.
      }
    }
  }

  private completeProbeCompaction(session: TaskSession, observedAt: string): void {
    const compactionId = session.probeCompactionId;
    if (compactionId === null) {
      return;
    }
    session.probeCompactionId = null;
    session.queue.push({
      type: "AUTO_COMPACTION_COMPLETED",
      thread_id: session.threadId,
      compaction_id: compactionId,
      observed_at: observedAt,
      host_sequence: this.nextEventSequence(session),
    });
  }

  private nextEventSequence(session: TaskSession): number {
    session.eventSequence += 1;
    return session.eventSequence;
  }

  private probeElapsedMs(session: TaskSession): number {
    if (session.probeStartedAt === null) {
      throw new TypeError("probe start is unavailable");
    }
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("invalid probe clock");
    }
    return Math.max(0, value.getTime() - Date.parse(session.probeStartedAt));
  }

  private probeSessionActive(session: TaskSession): boolean {
    return session.terminal === null && !session.probeStopped;
  }

  private probeFailure(reasonCode: CompactionProbeFailureReasonCode): ProductionRuntimeError {
    return new ProductionRuntimeError(
      "compaction_probe_failed",
      `Compaction Content Probe failed with reason '${reasonCode}'.`,
    );
  }

  private handleTurnTerminal(
    session: TaskSession,
    signal: Extract<ControllerSignal, { readonly type: "TURN_TERMINAL" }>,
  ): void {
    this.stopCompactionProbe(session);
    if (signal.outcome !== "INTERRUPTED") {
      this.completeProbeCompaction(session, signal.completed_at);
    } else {
      session.probeCompactionId = null;
    }
    if (
      session.activeCompactions.size > 0 &&
      signal.outcome !== "INTERRUPTED"
    ) {
      this.forceFailure(session, new ProductionRuntimeError(
        "app_server_protocol_error",
        "Development turn ended with an incomplete contextCompaction item.",
      ));
    }
    if (signal.outcome === "INTERRUPTED") {
      session.activeCompactions.clear();
    }
    if (session.forcedFailure !== null) {
      this.finishSession(session, session.forcedFailure);
      return;
    }
    const material = {
      schema_version: DEVELOPMENT_TASK_SCHEMA_VERSION,
      run_id: session.request.run_id,
      slice_id: session.request.slice_id,
      thread_id: session.threadId,
      turn_id: session.turnId as string,
      outcome: signal.outcome,
      started_at: signal.started_at,
      completed_at: signal.completed_at,
    };
    this.finishSession(session, {
      ...material,
      receipt_digest: sha256Json(material),
    });
  }

  private forceFailure(session: TaskSession, error: ProductionRuntimeError): void {
    this.stopCompactionProbe(session);
    session.forcedFailure ??= error;
    if (session.turnId !== null) {
      void this.requestInterrupt(session);
    }
  }

  private requestInterrupt(session: TaskSession): Promise<void> {
    session.interruptPromise ??= (async () => {
      if (session.turnId === null || session.terminal !== null) {
        return;
      }
      const response = await this.client.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.turnId,
      });
      if (response instanceof ProductionRuntimeError) {
        this.finishSession(session, response);
      }
    })();
    return session.interruptPromise;
  }

  private finishSession(
    session: TaskSession,
    terminal: DevelopmentTaskReceipt | ProductionRuntimeError,
  ): void {
    if (session.terminal !== null) {
      return;
    }
    this.stopCompactionProbe(session);
    session.terminal = terminal;
    session.queue.close();
    session.resolveCompletion(terminal);
    if (this.active === session) {
      this.active = null;
    }
  }

  private async readPersistedRevision(threadId: string): Promise<OpaqueStableRevision> {
    if (
      this.archivedThreads.has(threadId) ||
      this.deletedThreads.has(threadId) ||
      this.closedThreads.has(threadId)
    ) {
      throw new ProductionRuntimeError(
        "app_server_request_failed",
        "Source Thread is not active and readable.",
      );
    }
    let revision: unknown;
    try {
      revision = await this.revisionProvider.read(threadId);
    } catch (error: unknown) {
      throw new SourceInterruptionError(
        "source_interrupt_failed",
        "The Host revision capability could not read a stable Source Thread revision.",
        { reason: "thread_revision_unavailable", cause: error },
      );
    }
    if (revision === THREAD_REVISION_UNAVAILABLE) {
      throw new SourceInterruptionError(
        "source_interrupt_failed",
        "The Host has no stable summary-only Source Thread revision capability.",
        { reason: "thread_revision_unavailable" },
      );
    }
    if (!isOpaqueStableRevision(revision)) {
      throw new SourceInterruptionError(
        "source_interrupt_failed",
        "The Host revision capability returned an invalid opaque revision token.",
        { reason: "thread_revision_invalid" },
      );
    }
    return revision;
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ProductionRuntimeError(
        "app_server_protocol_error",
        "Production adapter clock returned an invalid Date.",
      );
    }
    return value.toISOString();
  }

}
