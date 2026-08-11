import path from "node:path";

import {
  decodeAppServerFreshThreadStartResponse,
  decodeAppServerItemCompletedNotification,
  decodeAppServerTurnStartParams,
  decodeAppServerTurnStartResponse,
  type AppServerThreadItemProjection,
  type AppServerTurnSandboxPolicy,
  type AppServerUserInput,
} from "./app-server-protocol-v2.js";
import {
  type AppServerNotification,
  type AppServerPrivateNotificationRoute,
  type AppServerPrivateNotificationRouter,
  CodexAppServerClient,
} from "./app-server-client.js";
import { ProductionRuntimeError } from "./errors.js";

export const DEFAULT_PRIVATE_COMPLETED_ITEMS_PER_TURN = 64;
export const DEFAULT_PRIVATE_COMPLETED_ITEM_BYTES = 1024 * 1024;
export const DEFAULT_PRIVATE_TURN_PROJECTION_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PRIVATE_TURNS_PER_SESSION = 16;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECTABLE_ITEM_TYPES = new Set<AppServerThreadItemProjection["type"]>([
  "agentMessage",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "userMessage",
  "hookPrompt",
  "plan",
  "reasoning",
  "imageView",
  "sleep",
  "imageGeneration",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

export type AppServerFreshTaskKind = "compression" | "continuation";
export type AppServerFreshTaskTerminalStatus = "completed" | "interrupted" | "failed";

export interface AppServerFreshTaskSessionRequest {
  readonly kind: AppServerFreshTaskKind;
  readonly source_thread_id: string;
  readonly cwd: string;
}

export interface AppServerFreshTaskTurnRequest {
  readonly input: readonly AppServerUserInput[];
  readonly cwd: string;
  readonly sandbox_policy: AppServerTurnSandboxPolicy;
  readonly model: "gpt-5.6-sol";
  readonly effort: "medium" | "max";
  readonly project_completed_item_types: readonly AppServerThreadItemProjection["type"][];
}

export interface AppServerFreshTaskCompletedItem {
  readonly completed_at_ms: number;
  readonly item: AppServerThreadItemProjection;
}

export interface AppServerFreshTaskTurnReceipt {
  readonly thread_id: string;
  readonly turn_id: string;
  readonly terminal_status: AppServerFreshTaskTerminalStatus;
  readonly completed_at_ms: number;
  readonly completed_items: readonly AppServerFreshTaskCompletedItem[];
}

export interface AppServerFreshTaskTurnHandle {
  readonly thread_id: string;
  readonly turn_id: string;
  readonly completion: Promise<AppServerFreshTaskTurnReceipt | ProductionRuntimeError>;
}

export interface CodexAppServerFreshTaskSession {
  readonly kind: AppServerFreshTaskKind;
  readonly source_thread_id: string;
  readonly thread_id: string;
  readonly cwd: string;
  startTurn(
    request: AppServerFreshTaskTurnRequest,
  ): Promise<AppServerFreshTaskTurnHandle | ProductionRuntimeError>;
}

export interface CodexAppServerFreshTaskSessionsOptions {
  readonly maximum_completed_items_per_turn?: number;
  readonly maximum_completed_item_bytes?: number;
  readonly maximum_turn_projection_bytes?: number;
  readonly maximum_turns_per_session?: number;
}

interface PrivateTerminalProjection {
  readonly status: AppServerFreshTaskTerminalStatus;
  readonly completedAtMs: number;
}

interface TurnAttempt {
  readonly token: symbol;
  readonly projectedTypes: ReadonlySet<AppServerThreadItemProjection["type"]>;
  readonly completion: Promise<AppServerFreshTaskTurnReceipt | ProductionRuntimeError>;
  readonly resolveCompletion: (
    value: AppServerFreshTaskTurnReceipt | ProductionRuntimeError,
  ) => void;
  turnId: string | null;
  candidateTurnId: string | null;
  pendingTerminal: PrivateTerminalProjection | null;
  projectedItems: AppServerFreshTaskCompletedItem[];
  projectedBytes: number;
  settled: boolean;
}

interface PrivateSessionRecord {
  readonly kind: AppServerFreshTaskKind;
  readonly sourceThreadId: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly completedTurnIds: Set<string>;
  phase: "READY" | "TURN_STARTING" | "TURN_ACTIVE" | "TURN_TERMINAL" | "FAILED";
  turnCount: number;
  attempt: TurnAttempt | null;
}

interface PrivateRouterLimits {
  readonly maximumCompletedItemsPerTurn: number;
  readonly maximumCompletedItemBytes: number;
  readonly maximumTurnProjectionBytes: number;
  readonly maximumTurnsPerSession: number;
}

function privateProtocolError(message: string): ProductionRuntimeError {
  return new ProductionRuntimeError("app_server_protocol_error", message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function terminalStatus(value: unknown): AppServerFreshTaskTerminalStatus | null {
  return value === "completed" || value === "interrupted" || value === "failed"
    ? value
    : null;
}

function itemByteLength(value: unknown): number | null {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

class FreshTaskPrivateEventRouter implements AppServerPrivateNotificationRouter {
  private readonly sessions = new Map<string, PrivateSessionRecord>();
  private readonly turnOwners = new Map<string, PrivateSessionRecord>();
  private fatalError: ProductionRuntimeError | null = null;

  public constructor(private readonly limits: PrivateRouterLimits) {}

  public registerSession(record: PrivateSessionRecord): ProductionRuntimeError | null {
    if (this.fatalError !== null) return this.fatalError;
    if (this.sessions.has(record.threadId)) {
      return privateProtocolError("Fresh-task root identity was reused.");
    }
    this.sessions.set(record.threadId, record);
    return null;
  }

  public hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  public beginTurn(
    session: PrivateSessionRecord,
    projectedTypes: ReadonlySet<AppServerThreadItemProjection["type"]>,
  ): TurnAttempt | ProductionRuntimeError {
    if (this.fatalError !== null) return this.fatalError;
    if (session.phase !== "READY" && session.phase !== "TURN_TERMINAL") {
      return privateProtocolError("Fresh-task session already has an active Turn.");
    }
    if (session.turnCount >= this.limits.maximumTurnsPerSession) {
      return privateProtocolError("Fresh-task session exceeded its bounded Turn count.");
    }
    let resolveCompletion: (
      value: AppServerFreshTaskTurnReceipt | ProductionRuntimeError,
    ) => void = () => undefined;
    const completion = new Promise<AppServerFreshTaskTurnReceipt | ProductionRuntimeError>(
      (resolve) => {
        resolveCompletion = resolve;
      },
    );
    const attempt: TurnAttempt = {
      token: Symbol("fresh-task-turn"),
      projectedTypes,
      completion,
      resolveCompletion,
      turnId: null,
      candidateTurnId: null,
      pendingTerminal: null,
      projectedItems: [],
      projectedBytes: 0,
      settled: false,
    };
    session.phase = "TURN_STARTING";
    session.attempt = attempt;
    return attempt;
  }

  public activateTurn(
    session: PrivateSessionRecord,
    attempt: TurnAttempt,
    turnId: string,
  ): ProductionRuntimeError | null {
    if (this.fatalError !== null) return this.fatalError;
    if (
      session.phase !== "TURN_STARTING" ||
      session.attempt !== attempt ||
      !canonicalUuid(turnId)
    ) {
      return privateProtocolError("Fresh-task Turn registration is invalid.");
    }
    if (attempt.candidateTurnId !== null && attempt.candidateTurnId !== turnId) {
      return privateProtocolError("Fresh-task Turn response disagreed with its private events.");
    }
    const owner = this.turnOwners.get(turnId);
    if (owner !== undefined || session.completedTurnIds.has(turnId)) {
      return privateProtocolError("Fresh-task Turn identity was reused.");
    }
    attempt.turnId = turnId;
    this.turnOwners.set(turnId, session);
    session.turnCount += 1;
    session.phase = "TURN_ACTIVE";
    if (attempt.pendingTerminal !== null) {
      this.finishTurn(session, attempt, attempt.pendingTerminal);
    }
    return null;
  }

  public failTurnStart(
    session: PrivateSessionRecord,
    attempt: TurnAttempt,
    error: ProductionRuntimeError,
  ): void {
    if (session.attempt !== attempt || attempt.settled) return;
    session.phase = "FAILED";
    attempt.settled = true;
    attempt.resolveCompletion(error);
  }

  public route(notification: AppServerNotification): AppServerPrivateNotificationRoute {
    if (notification.method === "item/completed") {
      return this.routeCompletedItem(notification.params);
    }
    if (notification.method === "turn/completed") {
      return this.routeTerminal(notification.params);
    }
    return "UNHANDLED";
  }

  public fail(error: ProductionRuntimeError): void {
    if (this.fatalError !== null) return;
    this.fatalError = error;
    for (const session of this.sessions.values()) {
      session.phase = "FAILED";
      const attempt = session.attempt;
      if (attempt !== null && !attempt.settled) {
        attempt.settled = true;
        attempt.resolveCompletion(error);
      }
    }
  }

  private routeCompletedItem(value: unknown): AppServerPrivateNotificationRoute {
    const params = isRecord(value) ? value : null;
    const threadId = params?.threadId;
    const turnId = params?.turnId;
    const located = this.locatePrivateSession(threadId, turnId);
    if (located === null) return "UNHANDLED";
    if (located instanceof ProductionRuntimeError) throw located;
    const { session, attempt } = located;
    if (attempt.pendingTerminal !== null || session.phase === "TURN_TERMINAL") {
      throw privateProtocolError("Fresh-task session received an item after Turn terminal.");
    }
    const bytes = itemByteLength(params?.item);
    if (bytes === null || bytes > this.limits.maximumCompletedItemBytes) {
      throw privateProtocolError("Fresh-task completed item exceeded its private projection bound.");
    }
    let decoded;
    try {
      decoded = decodeAppServerItemCompletedNotification(value);
    } catch {
      throw privateProtocolError("Fresh-task completed item violated its private projection contract.");
    }
    if (!attempt.projectedTypes.has(decoded.item.type)) return "HANDLED";
    if (
      attempt.projectedItems.length >= this.limits.maximumCompletedItemsPerTurn ||
      attempt.projectedBytes + bytes > this.limits.maximumTurnProjectionBytes
    ) {
      throw privateProtocolError("Fresh-task Turn exceeded its bounded private projection.");
    }
    attempt.projectedBytes += bytes;
    attempt.projectedItems.push({
      completed_at_ms: decoded.completedAtMs,
      item: decoded.item,
    });
    return "HANDLED";
  }

  private routeTerminal(value: unknown): AppServerPrivateNotificationRoute {
    const params = isRecord(value) ? value : null;
    const turn = params !== null && isRecord(params.turn) ? params.turn : null;
    const threadId = params?.threadId;
    const turnId = turn?.id;
    const located = this.locatePrivateSession(threadId, turnId);
    if (located === null) return "UNHANDLED";
    if (located instanceof ProductionRuntimeError) throw located;
    const { session, attempt } = located;
    if (attempt.pendingTerminal !== null || session.phase === "TURN_TERMINAL") {
      throw privateProtocolError("Fresh-task session received a duplicate Turn terminal.");
    }
    const status = terminalStatus(turn?.status);
    const completedAt = turn?.completedAt;
    if (
      status === null ||
      typeof completedAt !== "number" ||
      !Number.isFinite(completedAt) ||
      completedAt < 0
    ) {
      throw privateProtocolError("Fresh-task Turn terminal metadata is invalid.");
    }
    const terminal: PrivateTerminalProjection = {
      status,
      completedAtMs: completedAt * 1_000,
    };
    attempt.pendingTerminal = terminal;
    if (session.phase === "TURN_ACTIVE") {
      this.finishTurn(session, attempt, terminal);
    }
    return "HANDLED";
  }

  private locatePrivateSession(
    threadIdValue: unknown,
    turnIdValue: unknown,
  ):
    | Readonly<{ session: PrivateSessionRecord; attempt: TurnAttempt }>
    | ProductionRuntimeError
    | null {
    const threadSession = typeof threadIdValue === "string"
      ? this.sessions.get(threadIdValue)
      : undefined;
    const turnSession = typeof turnIdValue === "string"
      ? this.turnOwners.get(turnIdValue)
      : undefined;
    if (threadSession === undefined && turnSession === undefined) return null;
    if (
      !canonicalUuid(threadIdValue) ||
      !canonicalUuid(turnIdValue) ||
      (threadSession !== undefined && turnSession !== undefined && threadSession !== turnSession)
    ) {
      return privateProtocolError("Fresh-task private event crossed its thread/Turn identity boundary.");
    }
    const session = threadSession ?? turnSession;
    if (session === undefined) {
      return privateProtocolError("Fresh-task private event identity is incomplete.");
    }
    if (threadIdValue !== session.threadId) {
      return privateProtocolError("Fresh-task private event crossed its thread identity boundary.");
    }
    const attempt = session.attempt;
    if (
      attempt === null ||
      (session.phase !== "TURN_STARTING" && session.phase !== "TURN_ACTIVE")
    ) {
      return privateProtocolError("Fresh-task private event arrived outside an active Turn.");
    }
    if (session.phase === "TURN_STARTING") {
      if (attempt.candidateTurnId !== null && attempt.candidateTurnId !== turnIdValue) {
        return privateProtocolError("Fresh-task private events crossed Turn identities.");
      }
      const owner = this.turnOwners.get(turnIdValue);
      if (owner !== undefined && owner !== session) {
        return privateProtocolError("Fresh-task private event crossed session identities.");
      }
      attempt.candidateTurnId = turnIdValue;
    } else if (attempt.turnId !== turnIdValue) {
      return privateProtocolError("Fresh-task private event crossed the active Turn identity.");
    }
    return { session, attempt };
  }

  private finishTurn(
    session: PrivateSessionRecord,
    attempt: TurnAttempt,
    terminal: PrivateTerminalProjection,
  ): void {
    const turnId = attempt.turnId;
    if (turnId === null || attempt.settled) {
      throw privateProtocolError("Fresh-task Turn terminal preceded registration.");
    }
    attempt.settled = true;
    session.phase = "TURN_TERMINAL";
    session.completedTurnIds.add(turnId);
    attempt.resolveCompletion({
      thread_id: session.threadId,
      turn_id: turnId,
      terminal_status: terminal.status,
      completed_at_ms: terminal.completedAtMs,
      completed_items: [...attempt.projectedItems],
    });
  }
}

class FreshTaskSessionHandle implements CodexAppServerFreshTaskSession {
  public readonly kind: AppServerFreshTaskKind;
  public readonly source_thread_id: string;
  public readonly thread_id: string;
  public readonly cwd: string;

  public constructor(
    record: PrivateSessionRecord,
    private readonly startTurnHandler: (
      request: AppServerFreshTaskTurnRequest,
    ) => Promise<AppServerFreshTaskTurnHandle | ProductionRuntimeError>,
  ) {
    this.kind = record.kind;
    this.source_thread_id = record.sourceThreadId;
    this.thread_id = record.threadId;
    this.cwd = record.cwd;
  }

  public startTurn(
    request: AppServerFreshTaskTurnRequest,
  ): Promise<AppServerFreshTaskTurnHandle | ProductionRuntimeError> {
    return this.startTurnHandler(request);
  }
}

export class CodexAppServerFreshTaskSessions {
  private readonly router: FreshTaskPrivateEventRouter;
  private readonly detachRouter: () => void;
  private disposed = false;

  public constructor(
    private readonly client: CodexAppServerClient,
    options: CodexAppServerFreshTaskSessionsOptions = {},
  ) {
    const limits: PrivateRouterLimits = {
      maximumCompletedItemsPerTurn:
        options.maximum_completed_items_per_turn ?? DEFAULT_PRIVATE_COMPLETED_ITEMS_PER_TURN,
      maximumCompletedItemBytes:
        options.maximum_completed_item_bytes ?? DEFAULT_PRIVATE_COMPLETED_ITEM_BYTES,
      maximumTurnProjectionBytes:
        options.maximum_turn_projection_bytes ?? DEFAULT_PRIVATE_TURN_PROJECTION_BYTES,
      maximumTurnsPerSession:
        options.maximum_turns_per_session ?? DEFAULT_PRIVATE_TURNS_PER_SESSION,
    };
    if (
      !validPositiveInteger(limits.maximumCompletedItemsPerTurn) ||
      !validPositiveInteger(limits.maximumCompletedItemBytes) ||
      !validPositiveInteger(limits.maximumTurnProjectionBytes) ||
      !validPositiveInteger(limits.maximumTurnsPerSession) ||
      limits.maximumCompletedItemBytes > limits.maximumTurnProjectionBytes
    ) {
      throw privateProtocolError("Fresh-task private projection limits are invalid.");
    }
    this.router = new FreshTaskPrivateEventRouter(limits);
    this.detachRouter = this.client.attachPrivateNotificationRouter(this.router);
  }

  public async start(
    request: AppServerFreshTaskSessionRequest,
  ): Promise<CodexAppServerFreshTaskSession | ProductionRuntimeError> {
    if (
      this.disposed ||
      !canonicalUuid(request.source_thread_id) ||
      !path.isAbsolute(request.cwd)
    ) {
      return privateProtocolError("Fresh-task session request is invalid.");
    }
    const response = await this.client.request("thread/start", {
      model: "gpt-5.6-sol",
      cwd: request.cwd,
      approvalPolicy: "never",
      sandbox: request.kind === "compression" ? "workspace-write" : "read-only",
      serviceName: request.kind === "compression"
        ? "auto_slice_compression"
        : "auto_slice_continuation",
      ephemeral: false,
    });
    if (response instanceof ProductionRuntimeError) return response;
    let thread;
    try {
      thread = decodeAppServerFreshThreadStartResponse(response).thread;
    } catch {
      return privateProtocolError("Fresh-task thread/start did not prove an empty persistent root.");
    }
    if (
      !canonicalUuid(thread.id) ||
      thread.sessionId !== thread.id ||
      thread.id === request.source_thread_id ||
      this.router.hasSession(thread.id)
    ) {
      return privateProtocolError("Fresh-task thread/start returned an invalid or reused root identity.");
    }
    const record: PrivateSessionRecord = {
      kind: request.kind,
      sourceThreadId: request.source_thread_id,
      threadId: thread.id,
      cwd: request.cwd,
      completedTurnIds: new Set<string>(),
      phase: "READY",
      turnCount: 0,
      attempt: null,
    };
    const registrationError = this.router.registerSession(record);
    if (registrationError !== null) return registrationError;
    return new FreshTaskSessionHandle(
      record,
      (turnRequest) => this.startTurn(record, turnRequest),
    );
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachRouter();
    this.router.fail(new ProductionRuntimeError(
      "app_server_process_exited",
      "Fresh-task App Server sessions were disposed.",
    ));
  }

  private async startTurn(
    session: PrivateSessionRecord,
    request: AppServerFreshTaskTurnRequest,
  ): Promise<AppServerFreshTaskTurnHandle | ProductionRuntimeError> {
    const projectedTypes = this.validateTurnRequest(session, request);
    if (projectedTypes instanceof ProductionRuntimeError) return projectedTypes;
    const decodedParams = (() => {
      try {
        return decodeAppServerTurnStartParams({
          threadId: session.threadId,
          input: request.input,
          sandboxPolicy: request.sandbox_policy,
        });
      } catch {
        return privateProtocolError("Fresh-task turn/start request violates App Server 0.146.0.");
      }
    })();
    if (decodedParams instanceof ProductionRuntimeError) return decodedParams;
    const attempt = this.router.beginTurn(session, projectedTypes);
    if (attempt instanceof ProductionRuntimeError) return attempt;
    const response = await this.client.request("turn/start", {
      threadId: session.threadId,
      input: decodedParams.input,
      cwd: request.cwd,
      approvalPolicy: "never",
      sandboxPolicy: decodedParams.sandboxPolicy,
      model: request.model,
      effort: request.effort,
    });
    if (response instanceof ProductionRuntimeError) {
      this.router.failTurnStart(session, attempt, response);
      return response;
    }
    let turnId: string;
    try {
      turnId = decodeAppServerTurnStartResponse(response).turn.id;
    } catch {
      const error = privateProtocolError("Fresh-task turn/start response is invalid.");
      this.router.failTurnStart(session, attempt, error);
      return error;
    }
    const activationError = this.router.activateTurn(session, attempt, turnId);
    if (activationError !== null) {
      this.router.failTurnStart(session, attempt, activationError);
      return activationError;
    }
    return {
      thread_id: session.threadId,
      turn_id: turnId,
      completion: attempt.completion,
    };
  }

  private validateTurnRequest(
    session: PrivateSessionRecord,
    request: AppServerFreshTaskTurnRequest,
  ): ReadonlySet<AppServerThreadItemProjection["type"]> | ProductionRuntimeError {
    if (
      this.disposed ||
      request.cwd !== session.cwd ||
      !path.isAbsolute(request.cwd) ||
      request.input.length === 0 ||
      (session.kind === "compression" && request.effort !== "medium") ||
      (session.kind === "continuation" && request.effort !== "max") ||
      (session.kind === "compression" && request.sandbox_policy.type !== "workspaceWrite") ||
      (session.kind === "continuation" &&
        request.sandbox_policy.type !== "readOnly" &&
        request.sandbox_policy.type !== "workspaceWrite")
    ) {
      return privateProtocolError("Fresh-task Turn request violates its frozen task policy.");
    }
    const projectedTypes = new Set<AppServerThreadItemProjection["type"]>();
    for (const type of request.project_completed_item_types) {
      if (!PROJECTABLE_ITEM_TYPES.has(type) || projectedTypes.has(type)) {
        return privateProtocolError("Fresh-task completed-item projection list is invalid.");
      }
      projectedTypes.add(type);
    }
    return projectedTypes;
  }
}
