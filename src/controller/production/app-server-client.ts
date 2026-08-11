import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { ProductionRuntimeError } from "./errors.js";
import type {
  ControllerSignal,
  ProductionHostCapabilities,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_STDERR_BYTES = 64 * 1024;
const DEFAULT_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_HOST_CAPABILITIES: ProductionHostCapabilities = Object.freeze({
  context_compaction_events: "AVAILABLE",
});
export const APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS = [
  "turn/diff/updated",
  "turn/plan/updated",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
] as const;
const NPM_CODEX_CLI_SEGMENTS = [
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
] as const;

export interface CodexAppServerClientOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly request_timeout_ms?: number;
  readonly maximum_message_bytes?: number;
  readonly maximum_stderr_bytes?: number;
  readonly now?: () => Date;
  readonly host_capabilities?: ProductionHostCapabilities;
}

export type AppServerNotification = Readonly<Record<string, unknown>>;
export type ControllerSignalListener = (signal: ControllerSignal) => void;
export type AppServerFailureListener = (error: ProductionRuntimeError) => void;

export interface HostEventFirewallTask {
  readonly run_id: string;
  readonly slice_id: string;
  readonly thread_id: string;
  readonly started_at: string;
}

export interface HostEventFirewallOptions {
  readonly now?: () => Date;
}

interface RegisteredFirewallTask extends HostEventFirewallTask {
  turnId: string | null;
  hostSequence: number;
}

export const DROP = Symbol("HostEventFirewall.DROP");

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProductionRuntimeError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function runtimeProtocolError(message: string): ProductionRuntimeError {
  return new ProductionRuntimeError("app_server_protocol_error", message);
}

function asIsoTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function timestampFromSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const timestamp = new Date(value * 1_000);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

export class HostEventFirewall {
  private readonly now: () => Date;
  private readonly tasks = new Map<string, RegisteredFirewallTask>();

  public constructor(options: HostEventFirewallOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public registerTask(task: HostEventFirewallTask): void {
    if (
      !isIdentifier(task.run_id) ||
      !isIdentifier(task.slice_id) ||
      !isIdentifier(task.thread_id) ||
      asIsoTimestamp(task.started_at) === null
    ) {
      throw runtimeProtocolError("HostEventFirewall task registration is malformed.");
    }
    const current = this.tasks.get(task.thread_id);
    if (current !== undefined) {
      if (
        current.run_id !== task.run_id ||
        current.slice_id !== task.slice_id ||
        current.started_at !== task.started_at
      ) {
        throw runtimeProtocolError("HostEventFirewall thread identity was reused by another task.");
      }
      return;
    }
    this.tasks.set(task.thread_id, { ...task, turnId: null, hostSequence: 0 });
  }

  public registerTurn(threadId: string, turnId: string): void {
    if (!isIdentifier(threadId) || !isIdentifier(turnId)) {
      throw runtimeProtocolError("HostEventFirewall turn registration is malformed.");
    }
    const task = this.tasks.get(threadId);
    if (task === undefined) {
      throw runtimeProtocolError("HostEventFirewall cannot register a turn for an unknown thread.");
    }
    if (task.turnId !== null && task.turnId !== turnId) {
      throw runtimeProtocolError("HostEventFirewall task attempted to replace its active turn.");
    }
    task.turnId = turnId;
  }

  public project(notification: AppServerNotification): ControllerSignal | typeof DROP {
    const method = notification.method;
    if (typeof method !== "string") {
      return DROP;
    }
    if (method === "item/started" || method === "item/completed") {
      return this.projectItem(method, notification.params);
    }
    if (method === "turn/completed") {
      return this.projectTerminal(notification.params);
    }
    if (method === "model/rerouted") {
      return this.projectReroute(notification.params);
    }
    if (
      method === "thread/archived" ||
      method === "thread/deleted" ||
      method === "thread/unarchived" ||
      method === "thread/closed"
    ) {
      return this.projectThreadLifecycle(method, notification.params);
    }
    return DROP;
  }

  private projectItem(
    method: "item/started" | "item/completed",
    value: unknown,
  ): ControllerSignal | typeof DROP {
    if (!isRecord(value) || !isRecord(value.item) || typeof value.item.type !== "string") {
      throw runtimeProtocolError(`${method} has a malformed item.`);
    }
    if (value.item.type !== "contextCompaction") {
      return DROP;
    }
    if (
      !isIdentifier(value.threadId) ||
      !isIdentifier(value.turnId) ||
      !isIdentifier(value.item.id)
    ) {
      throw runtimeProtocolError(`${method} is missing required contextCompaction metadata.`);
    }
    const task = this.tasks.get(value.threadId);
    if (task === undefined || (task.turnId !== null && task.turnId !== value.turnId)) {
      return DROP;
    }
    task.hostSequence += 1;
    return {
      type: "COMPACTION",
      phase: method === "item/started" ? "STARTED" : "COMPLETED",
      thread_id: value.threadId,
      compaction_id: value.item.id,
      host_sequence: task.hostSequence,
      observed_at: this.timestamp(),
    };
  }

  private projectTerminal(value: unknown): ControllerSignal | typeof DROP {
    if (
      !isRecord(value) ||
      !isIdentifier(value.threadId) ||
      !isRecord(value.turn) ||
      !isIdentifier(value.turn.id) ||
      (value.turn.status !== "completed" &&
        value.turn.status !== "interrupted" &&
        value.turn.status !== "failed")
    ) {
      throw runtimeProtocolError("turn/completed is missing required terminal metadata.");
    }
    const task = this.tasks.get(value.threadId);
    if (task === undefined || (task.turnId !== null && task.turnId !== value.turn.id)) {
      return DROP;
    }
    const completedAt = timestampFromSeconds(value.turn.completedAt);
    if (completedAt === null) {
      throw runtimeProtocolError("turn/completed has an invalid completedAt timestamp.");
    }
    return {
      type: "TURN_TERMINAL",
      run_id: task.run_id,
      slice_id: task.slice_id,
      thread_id: value.threadId,
      turn_id: value.turn.id,
      outcome: value.turn.status === "completed"
        ? "COMPLETED"
        : value.turn.status === "interrupted"
          ? "INTERRUPTED"
          : "FAILED",
      started_at: task.started_at,
      completed_at: completedAt,
    };
  }

  private projectReroute(value: unknown): ControllerSignal | typeof DROP {
    if (
      !isRecord(value) ||
      !isIdentifier(value.threadId) ||
      !isIdentifier(value.turnId) ||
      !isIdentifier(value.fromModel) ||
      !isIdentifier(value.toModel) ||
      !isIdentifier(value.reason)
    ) {
      throw runtimeProtocolError("model/rerouted is missing required control metadata.");
    }
    const task = this.tasks.get(value.threadId);
    if (task === undefined || (task.turnId !== null && task.turnId !== value.turnId)) {
      return DROP;
    }
    return {
      type: "MODEL_REROUTED",
      thread_id: value.threadId,
      turn_id: value.turnId,
      from_model: value.fromModel,
      to_model: value.toModel,
      reason_code: value.reason === "highRiskCyberActivity"
        ? "HIGH_RISK_CYBER_ACTIVITY"
        : "OTHER",
    };
  }

  private projectThreadLifecycle(
    method: "thread/archived" | "thread/deleted" | "thread/unarchived" | "thread/closed",
    value: unknown,
  ): ControllerSignal | typeof DROP {
    if (!isRecord(value) || !isIdentifier(value.threadId)) {
      throw runtimeProtocolError(`${method} is missing its thread identity.`);
    }
    if (!this.tasks.has(value.threadId)) {
      return DROP;
    }
    return {
      type: "THREAD_LIFECYCLE",
      thread_id: value.threadId,
      state: method === "thread/archived"
        ? "ARCHIVED"
        : method === "thread/deleted"
          ? "DELETED"
          : method === "thread/unarchived"
            ? "UNARCHIVED"
            : "CLOSED",
    };
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw runtimeProtocolError("HostEventFirewall clock returned an invalid Date.");
    }
    return value.toISOString();
  }
}

function asRuntimeError(error: unknown): ProductionRuntimeError {
  return error instanceof ProductionRuntimeError
    ? error
    : new ProductionRuntimeError(
      "app_server_protocol_error",
      "Codex App Server operation failed outside the expected protocol.",
    );
}

function asSpawnError(error: unknown): ProductionRuntimeError {
  return error instanceof ProductionRuntimeError
    ? error
    : new ProductionRuntimeError(
      "app_server_spawn_failed",
      "Codex App Server process could not be started.",
      { cause: error },
    );
}

function existingFile(candidate: string): string | null {
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function npmCodexCliCandidates(): readonly string[] {
  const candidates: string[] = [];
  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry.length > 0);
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, ...NPM_CODEX_CLI_SEGMENTS));
    if (process.platform !== "win32") {
      candidates.push(path.resolve(entry, "..", "lib", ...NPM_CODEX_CLI_SEGMENTS));
    }
  }
  try {
    candidates.push(createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"));
  } catch {
    // A global npm Codex install may be outside this package's module graph.
  }
  return candidates;
}

function resolveNpmCodexCli(): string | ProductionRuntimeError {
  const visited = new Set<string>();
  for (const candidate of npmCodexCliCandidates()) {
    const absolute = path.resolve(candidate);
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    const resolved = existingFile(candidate);
    if (resolved !== null) {
      return resolved;
    }
  }
  return new ProductionRuntimeError(
    "app_server_spawn_failed",
    "The npm @openai/codex CLI entrypoint could not be resolved from PATH or the active module graph.",
  );
}

export class CodexAppServerClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly requestTimeoutMs: number;
  private readonly maximumMessageBytes: number;
  private readonly maximumStderrBytes: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<ControllerSignalListener>();
  private readonly failureListeners = new Set<AppServerFailureListener>();
  private readonly firewall: HostEventFirewall;
  private readonly hostCapabilitySnapshot: ProductionHostCapabilities;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private requestId = 0;
  private fatalError: ProductionRuntimeError | null = null;
  private initialized: Promise<ProductionRuntimeError | null> | null = null;
  private readonly configurationError: ProductionRuntimeError | null;
  private disposed = false;

  public constructor(options: CodexAppServerClientOptions = {}) {
    const appServerArgs = options.args ?? DEFAULT_APP_SERVER_ARGS;
    if (options.command === undefined) {
      const npmCodexCli = resolveNpmCodexCli();
      this.command = process.execPath;
      this.args = npmCodexCli instanceof ProductionRuntimeError
        ? []
        : [npmCodexCli, ...appServerArgs];
      this.configurationError = npmCodexCli instanceof ProductionRuntimeError
        ? npmCodexCli
        : null;
    } else {
      this.command = options.command;
      this.args = appServerArgs;
      this.configurationError = null;
    }
    this.requestTimeoutMs = options.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maximumMessageBytes = options.maximum_message_bytes ?? DEFAULT_MAXIMUM_MESSAGE_BYTES;
    this.maximumStderrBytes = options.maximum_stderr_bytes ?? DEFAULT_MAXIMUM_STDERR_BYTES;
    this.hostCapabilitySnapshot = Object.freeze({
      ...(options.host_capabilities ?? DEFAULT_HOST_CAPABILITIES),
    });
    this.firewall = new HostEventFirewall(
      options.now === undefined ? {} : { now: options.now },
    );
  }

  public initialize(): Promise<ProductionRuntimeError | null> {
    this.initialized ??= this.startAndInitialize();
    return this.initialized;
  }

  public hostCapabilities(): ProductionHostCapabilities {
    return { ...this.hostCapabilitySnapshot };
  }

  public async request(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const initialization = await this.initialize();
    if (initialization !== null) {
      return initialization;
    }
    try {
      return await this.requestRaw(method, params);
    } catch (error: unknown) {
      return asRuntimeError(error);
    }
  }

  public subscribe(
    listener: ControllerSignalListener,
    onFailure: AppServerFailureListener,
  ): () => void {
    this.notificationListeners.add(listener);
    this.failureListeners.add(onFailure);
    return () => {
      this.notificationListeners.delete(listener);
      this.failureListeners.delete(onFailure);
    };
  }

  public registerTask(task: HostEventFirewallTask): void {
    this.firewall.registerTask(task);
  }

  public registerTurn(threadId: string, turnId: string): void {
    this.firewall.registerTurn(threadId, turnId);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.child;
    if (child === null || child.exitCode !== null) {
      return;
    }
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    child.stdin.end();
    child.kill();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
  }

  private async startAndInitialize(): Promise<ProductionRuntimeError | null> {
    if (this.configurationError !== null) {
      this.failConnection(this.configurationError);
      return this.configurationError;
    }
    if (
      this.command.trim().length === 0 ||
      !validPositiveInteger(this.requestTimeoutMs) ||
      !validPositiveInteger(this.maximumMessageBytes) ||
      !validPositiveInteger(this.maximumStderrBytes)
    ) {
      return new ProductionRuntimeError(
        "development_task_invalid",
        "Codex App Server process options are invalid.",
      );
    }
    try {
      try {
        this.child = spawn(this.command, [...this.args], {
          env: process.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error: unknown) {
        const spawnError = asSpawnError(error);
        this.failConnection(spawnError);
        return spawnError;
      }
      this.child.stdout.on("data", (chunk: Buffer) => {
        this.consumeStdout(chunk);
      });
      this.child.stderr.on("data", (chunk: Buffer) => {
        this.consumeStderr(chunk);
      });
      this.child.once("error", (error) => {
        this.failConnection(new ProductionRuntimeError(
          "app_server_spawn_failed",
          "Codex App Server process could not be started.",
          { cause: error },
        ));
      });
      this.child.once("close", (code, signal) => {
        if (!this.disposed) {
          this.failConnection(new ProductionRuntimeError(
            "app_server_process_exited",
            `Codex App Server exited before disposal (code=${String(code)}, signal=${String(signal)}).`,
          ));
        }
      });
      const response = await this.requestRaw("initialize", {
        clientInfo: {
          name: "auto_slice",
          title: "Auto Slice Controller",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [...APP_SERVER_CONTENT_NOTIFICATION_OPT_OUTS],
        },
      });
      if (!isRecord(response) || typeof response.userAgent !== "string") {
        throw new ProductionRuntimeError(
          "app_server_protocol_error",
          "Codex App Server initialize response is malformed.",
        );
      }
      this.sendLine({ method: "initialized", params: {} });
      return null;
    } catch (error: unknown) {
      const runtimeError = asRuntimeError(error);
      this.failConnection(runtimeError);
      return runtimeError;
    }
  }

  private requestRaw(method: string, params: unknown): Promise<unknown> {
    if (this.fatalError !== null) {
      return Promise.reject(this.fatalError);
    }
    if (this.child === null || this.child.exitCode !== null) {
      return Promise.reject(new ProductionRuntimeError(
        "app_server_process_exited",
        "Codex App Server is not running.",
      ));
    }
    const id = this.requestId;
    this.requestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProductionRuntimeError(
          "app_server_timeout",
          `Codex App Server request '${method}' timed out.`,
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.sendLine({ method, id, params });
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(asRuntimeError(error));
      }
    });
  }

  private sendLine(message: unknown): void {
    if (this.child === null || !this.child.stdin.writable) {
      throw new ProductionRuntimeError(
        "app_server_process_exited",
        "Codex App Server stdin is not writable.",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.fatalError !== null || this.disposed) {
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > this.maximumMessageBytes && !this.stdoutBuffer.includes(0x0a)) {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Codex App Server emitted an oversized JSONL message.",
      ));
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length > this.maximumMessageBytes) {
        this.failConnection(new ProductionRuntimeError(
          "app_server_protocol_error",
          "Codex App Server emitted an oversized JSONL message.",
        ));
        return;
      }
      if (line.length > 0) {
        this.consumeLine(line);
      }
      if (this.hasFatalError()) {
        return;
      }
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrBytes = Math.min(
      this.maximumStderrBytes,
      this.stderrBytes + chunk.length,
    );
  }

  private hasFatalError(): boolean {
    return this.fatalError !== null;
  }

  private consumeLine(line: Buffer): void {
    let message: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      message = JSON.parse(text) as unknown;
    } catch {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Codex App Server stdout is not valid UTF-8 JSONL.",
      ));
      return;
    }
    if (!isRecord(message)) {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Codex App Server JSONL message must be an object.",
      ));
      return;
    }
    if ("id" in message && !("method" in message)) {
      this.consumeResponse(message);
      return;
    }
    if (typeof message.method === "string" && !("id" in message)) {
      try {
        const signal = this.firewall.project(message);
        if (signal !== DROP) {
          for (const listener of this.notificationListeners) {
            listener(signal);
          }
        }
      } catch (error: unknown) {
        this.failConnection(asRuntimeError(error));
      }
      return;
    }
    if (typeof message.method === "string" && "id" in message) {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Unexpected server-initiated request received under approvalPolicy=never.",
      ));
      return;
    }
    this.failConnection(new ProductionRuntimeError(
      "app_server_protocol_error",
      "Codex App Server emitted an unrecognized JSONL envelope.",
    ));
  }

  private consumeResponse(message: Readonly<Record<string, unknown>>): void {
    if (!Number.isSafeInteger(message.id)) {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Codex App Server response has an invalid request id.",
      ));
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (pending === undefined) {
      this.failConnection(new ProductionRuntimeError(
        "app_server_protocol_error",
        "Codex App Server responded to an unknown request id.",
      ));
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id as number);
    if ("error" in message) {
      pending.reject(new ProductionRuntimeError(
        "app_server_request_failed",
        `Codex App Server rejected '${pending.method}'.`,
      ));
      return;
    }
    if (!("result" in message)) {
      pending.reject(new ProductionRuntimeError(
        "app_server_protocol_error",
        `Codex App Server response for '${pending.method}' has no result.`,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private failConnection(error: ProductionRuntimeError): void {
    if (this.fatalError !== null) {
      return;
    }
    this.fatalError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) {
      listener(error);
    }
  }
}
