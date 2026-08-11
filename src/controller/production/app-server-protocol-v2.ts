import { ProductionRuntimeError } from "./errors.js";

export const APP_SERVER_PROTOCOL_VERSION = "0.146.0" as const;

export const APP_SERVER_THREAD_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

const USER_INPUT_TYPES = [
  "text",
  "image",
  "localImage",
  "audio",
  "localAudio",
  "skill",
  "mention",
] as const;
const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"] as const;
const TURN_ITEM_VIEWS = ["notLoaded", "summary", "full"] as const;
const COMMAND_STATUSES = ["inProgress", "completed", "failed", "declined"] as const;
const COMMAND_SOURCES = [
  "agent",
  "userShell",
  "unifiedExecStartup",
  "unifiedExecInteraction",
] as const;
const TOOL_STATUSES = ["inProgress", "completed", "failed"] as const;
const PATCH_STATUSES = ["inProgress", "completed", "failed", "declined"] as const;
const COLLAB_TOOLS = ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"] as const;
const SUB_AGENT_ACTIVITY_KINDS = ["started", "interacted", "interrupted"] as const;
const SKILL_SCOPES = ["user", "repo", "system", "admin"] as const;
const PASSIVE_THREAD_ITEM_TYPES = [
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
] as const;

type ElementOf<T extends readonly unknown[]> = T[number];

export type AppServerThreadSandboxMode = ElementOf<typeof APP_SERVER_THREAD_SANDBOX_MODES>;
export type AppServerTurnStatus = ElementOf<typeof TURN_STATUSES>;
export type AppServerTurnItemsView = ElementOf<typeof TURN_ITEM_VIEWS>;
export type AppServerCommandStatus = ElementOf<typeof COMMAND_STATUSES>;
export type AppServerCommandSource = ElementOf<typeof COMMAND_SOURCES>;
export type AppServerToolStatus = ElementOf<typeof TOOL_STATUSES>;
export type AppServerPatchStatus = ElementOf<typeof PATCH_STATUSES>;
export type AppServerCollabTool = ElementOf<typeof COLLAB_TOOLS>;
export type AppServerSubAgentActivityKind = ElementOf<typeof SUB_AGENT_ACTIVITY_KINDS>;
export type AppServerSkillScope = ElementOf<typeof SKILL_SCOPES>;
export type AppServerPassiveThreadItemType = ElementOf<typeof PASSIVE_THREAD_ITEM_TYPES>;

export interface AppServerTextInput {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: readonly unknown[];
}

export interface AppServerPathInput {
  readonly type: "localImage" | "localAudio";
  readonly path: string;
}

export interface AppServerUrlInput {
  readonly type: "image" | "audio";
  readonly url: string;
}

export interface AppServerNamedPathInput {
  readonly type: "skill" | "mention";
  readonly name: string;
  readonly path: string;
}

export type AppServerUserInput =
  | AppServerTextInput
  | AppServerPathInput
  | AppServerUrlInput
  | AppServerNamedPathInput;

export type AppServerTurnSandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "readOnly"; readonly networkAccess: boolean }
  | { readonly type: "externalSandbox"; readonly networkAccess: "restricted" | "enabled" }
  | {
      readonly type: "workspaceWrite";
      readonly writableRoots: readonly string[];
      readonly networkAccess: boolean;
      readonly excludeTmpdirEnvVar: boolean;
      readonly excludeSlashTmp: boolean;
    };

export interface AppServerThreadStartParamsProjection {
  readonly sandbox?: AppServerThreadSandboxMode | null;
}

export interface AppServerThreadProjection {
  readonly id: string;
  readonly sessionId: string;
  readonly forkedFromId: string | null;
  readonly parentThreadId: string | null;
  readonly ephemeral: boolean;
  readonly turns: readonly AppServerTurnProjection[];
}

export interface AppServerThreadStartResponseProjection {
  readonly thread: AppServerThreadProjection;
}

export interface AppServerThreadReadParamsProjection {
  readonly threadId: string;
  readonly includeTurns?: boolean;
}

export interface AppServerThreadReadResponseProjection {
  readonly thread: AppServerThreadProjection;
}

export interface AppServerSkillMetadataProjection {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly scope: AppServerSkillScope;
  readonly enabled: boolean;
}

export interface AppServerSkillsListParamsProjection {
  readonly cwds?: readonly string[];
  readonly forceReload?: boolean;
}

export interface AppServerSkillsListEntryProjection {
  readonly cwd: string;
  readonly skills: readonly AppServerSkillMetadataProjection[];
  readonly errors: readonly Readonly<{ path: string; message: string }>[];
}

export interface AppServerSkillsListResponseProjection {
  readonly data: readonly AppServerSkillsListEntryProjection[];
}

export interface AppServerTurnStartRequirements {
  readonly requiredSkill?: Readonly<{ name: string; path: string }>;
}

export interface AppServerTurnStartParamsProjection {
  readonly threadId: string;
  readonly input: readonly AppServerUserInput[];
  readonly sandboxPolicy?: AppServerTurnSandboxPolicy | null;
}

export interface AppServerAgentMessageItem {
  readonly type: "agentMessage";
  readonly id: string;
  readonly text: string;
  readonly phase: "commentary" | "final_answer" | null;
  readonly memoryCitation: Readonly<Record<string, unknown>> | null;
}

export interface AppServerCommandExecutionItem {
  readonly type: "commandExecution";
  readonly id: string;
  readonly pluginId: string | null;
  readonly scriptPath: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly processId: string | null;
  readonly source: AppServerCommandSource;
  readonly status: AppServerCommandStatus;
  readonly commandActions: readonly unknown[];
  readonly aggregatedOutput: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export interface AppServerFileChangeItem {
  readonly type: "fileChange";
  readonly id: string;
  readonly changes: readonly unknown[];
  readonly status: AppServerPatchStatus;
}

export interface AppServerMcpToolCallItem {
  readonly type: "mcpToolCall";
  readonly id: string;
  readonly server: string;
  readonly tool: string;
  readonly status: AppServerToolStatus;
  readonly arguments: unknown;
  readonly appContext: Readonly<Record<string, unknown>> | null;
  readonly pluginId: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly durationMs: number | null;
}

export interface AppServerDynamicToolCallItem {
  readonly type: "dynamicToolCall";
  readonly id: string;
  readonly namespace: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly status: AppServerToolStatus;
  readonly contentItems: readonly unknown[] | null;
  readonly success: boolean | null;
  readonly durationMs: number | null;
}

export interface AppServerCollabAgentToolCallItem {
  readonly type: "collabAgentToolCall";
  readonly id: string;
  readonly tool: AppServerCollabTool;
  readonly status: AppServerToolStatus;
  readonly senderThreadId: string;
  readonly receiverThreadIds: readonly string[];
  readonly prompt: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentsStates: Readonly<Record<string, unknown>>;
}

export interface AppServerSubAgentActivityItem {
  readonly type: "subAgentActivity";
  readonly id: string;
  readonly kind: AppServerSubAgentActivityKind;
  readonly agentThreadId: string;
  readonly agentPath: string;
}

export interface AppServerWebSearchItem {
  readonly type: "webSearch";
  readonly id: string;
  readonly query: string;
  readonly action: Readonly<Record<string, unknown>> | null;
  readonly results: readonly unknown[] | null;
}

export interface AppServerPassiveThreadItem {
  readonly type: AppServerPassiveThreadItemType;
  readonly id: string;
}

export type AppServerThreadItemProjection =
  | AppServerAgentMessageItem
  | AppServerCommandExecutionItem
  | AppServerFileChangeItem
  | AppServerMcpToolCallItem
  | AppServerDynamicToolCallItem
  | AppServerCollabAgentToolCallItem
  | AppServerSubAgentActivityItem
  | AppServerWebSearchItem
  | AppServerPassiveThreadItem;

export interface AppServerTurnProjection {
  readonly id: string;
  readonly items: readonly AppServerThreadItemProjection[];
  readonly itemsView: AppServerTurnItemsView;
  readonly status: AppServerTurnStatus;
  readonly error: Readonly<Record<string, unknown>> | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
}

export interface AppServerTurnStartResponseProjection {
  readonly turn: AppServerTurnProjection;
}

export interface AppServerItemStartedNotificationProjection {
  readonly item: AppServerThreadItemProjection;
  readonly threadId: string;
  readonly turnId: string;
  readonly startedAtMs: number;
}

export interface AppServerItemCompletedNotificationProjection {
  readonly item: AppServerThreadItemProjection;
  readonly threadId: string;
  readonly turnId: string;
  readonly completedAtMs: number;
}

export interface AppServerCompletedCommandEvidence
  extends Omit<AppServerItemCompletedNotificationProjection, "item"> {
  readonly item: AppServerCommandExecutionItem & {
    readonly source: "agent";
    readonly status: "completed";
    readonly exitCode: 0;
  };
}

export interface AppServerTurnCompletedNotificationProjection {
  readonly threadId: string;
  readonly turn: AppServerTurnProjection & {
    readonly status: "completed" | "interrupted" | "failed";
  };
}

function protocolError(path: string, detail: string): ProductionRuntimeError {
  return new ProductionRuntimeError(
    "app_server_protocol_error",
    `App Server 0.146.0 ${path} ${detail}`,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw protocolError(path, "must be an object.");
  return value;
}

function property(value: Readonly<Record<string, unknown>>, key: string, path: string): unknown {
  if (!Object.hasOwn(value, key)) throw protocolError(`${path}.${key}`, "is required.");
  return value[key];
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw protocolError(path, "must be a string.");
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw protocolError(path, "must be a boolean.");
  return value;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(path, "must be a finite number.");
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : stringValue(value, path);
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : booleanValue(value, path);
}

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : numberValue(value, path);
}

function nullableRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> | null {
  return value === null ? null : record(value, path);
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(path, "must be an array.");
  return value;
}

function nullableArray(value: unknown, path: string): readonly unknown[] | null {
  return value === null ? null : arrayValue(value, path);
}

function stringArray(value: unknown, path: string): readonly string[] {
  return arrayValue(value, path).map((entry, index) => stringValue(entry, `${path}[${String(index)}]`));
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): ElementOf<T> {
  if (typeof value !== "string" || !values.includes(value)) {
    throw protocolError(path, `has unsupported value ${JSON.stringify(value)}.`);
  }
  return value;
}

function decodeUserInput(value: unknown, path: string): AppServerUserInput {
  const input = record(value, path);
  const type = enumValue(property(input, "type", path), USER_INPUT_TYPES, `${path}.type`);
  switch (type) {
    case "text":
      return {
        type,
        text: stringValue(property(input, "text", path), `${path}.text`),
        text_elements: arrayValue(property(input, "text_elements", path), `${path}.text_elements`),
      };
    case "image":
    case "audio":
      return {
        type,
        url: stringValue(property(input, "url", path), `${path}.url`),
      };
    case "localImage":
    case "localAudio":
      return {
        type,
        path: stringValue(property(input, "path", path), `${path}.path`),
      };
    case "skill":
    case "mention":
      return {
        type,
        name: stringValue(property(input, "name", path), `${path}.name`),
        path: stringValue(property(input, "path", path), `${path}.path`),
      };
  }
}

function decodeSandboxPolicy(value: unknown, path: string): AppServerTurnSandboxPolicy {
  const policy = record(value, path);
  const type = stringValue(property(policy, "type", path), `${path}.type`);
  switch (type) {
    case "dangerFullAccess":
      return { type };
    case "readOnly":
      return {
        type,
        networkAccess: booleanValue(property(policy, "networkAccess", path), `${path}.networkAccess`),
      };
    case "externalSandbox":
      return {
        type,
        networkAccess: enumValue(
          property(policy, "networkAccess", path),
          ["restricted", "enabled"] as const,
          `${path}.networkAccess`,
        ),
      };
    case "workspaceWrite":
      return {
        type,
        writableRoots: stringArray(property(policy, "writableRoots", path), `${path}.writableRoots`),
        networkAccess: booleanValue(property(policy, "networkAccess", path), `${path}.networkAccess`),
        excludeTmpdirEnvVar: booleanValue(
          property(policy, "excludeTmpdirEnvVar", path),
          `${path}.excludeTmpdirEnvVar`,
        ),
        excludeSlashTmp: booleanValue(
          property(policy, "excludeSlashTmp", path),
          `${path}.excludeSlashTmp`,
        ),
      };
    default:
      throw protocolError(`${path}.type`, `has unsupported value ${JSON.stringify(type)}.`);
  }
}

function decodeCommandItem(item: Readonly<Record<string, unknown>>, path: string): AppServerCommandExecutionItem {
  const exitCodeValue = property(item, "exitCode", path);
  const exitCode = exitCodeValue === null
    ? null
    : numberValue(exitCodeValue, `${path}.exitCode`);
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
    throw protocolError(`${path}.exitCode`, "must be a safe integer or null.");
  }
  return {
    type: "commandExecution",
    id: stringValue(property(item, "id", path), `${path}.id`),
    pluginId: nullableString(property(item, "pluginId", path), `${path}.pluginId`),
    scriptPath: nullableString(property(item, "scriptPath", path), `${path}.scriptPath`),
    command: stringValue(property(item, "command", path), `${path}.command`),
    cwd: stringValue(property(item, "cwd", path), `${path}.cwd`),
    processId: nullableString(property(item, "processId", path), `${path}.processId`),
    source: enumValue(property(item, "source", path), COMMAND_SOURCES, `${path}.source`),
    status: enumValue(property(item, "status", path), COMMAND_STATUSES, `${path}.status`),
    commandActions: arrayValue(property(item, "commandActions", path), `${path}.commandActions`),
    aggregatedOutput: nullableString(
      property(item, "aggregatedOutput", path),
      `${path}.aggregatedOutput`,
    ),
    exitCode,
    durationMs: nullableNumber(property(item, "durationMs", path), `${path}.durationMs`),
  };
}

function decodeThreadItem(value: unknown, path: string): AppServerThreadItemProjection {
  const item = record(value, path);
  const type = stringValue(property(item, "type", path), `${path}.type`);
  switch (type) {
    case "agentMessage": {
      const phaseValue = property(item, "phase", path);
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        text: stringValue(property(item, "text", path), `${path}.text`),
        phase: phaseValue === null
          ? null
          : enumValue(phaseValue, ["commentary", "final_answer"] as const, `${path}.phase`),
        memoryCitation: nullableRecord(
          property(item, "memoryCitation", path),
          `${path}.memoryCitation`,
        ),
      };
    }
    case "commandExecution":
      return decodeCommandItem(item, path);
    case "fileChange":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        changes: arrayValue(property(item, "changes", path), `${path}.changes`),
        status: enumValue(property(item, "status", path), PATCH_STATUSES, `${path}.status`),
      };
    case "mcpToolCall":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        server: stringValue(property(item, "server", path), `${path}.server`),
        tool: stringValue(property(item, "tool", path), `${path}.tool`),
        status: enumValue(property(item, "status", path), TOOL_STATUSES, `${path}.status`),
        arguments: property(item, "arguments", path),
        appContext: nullableRecord(property(item, "appContext", path), `${path}.appContext`),
        pluginId: nullableString(property(item, "pluginId", path), `${path}.pluginId`),
        result: nullableRecord(property(item, "result", path), `${path}.result`),
        error: nullableRecord(property(item, "error", path), `${path}.error`),
        durationMs: nullableNumber(property(item, "durationMs", path), `${path}.durationMs`),
      };
    case "dynamicToolCall":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        namespace: nullableString(property(item, "namespace", path), `${path}.namespace`),
        tool: stringValue(property(item, "tool", path), `${path}.tool`),
        arguments: property(item, "arguments", path),
        status: enumValue(property(item, "status", path), TOOL_STATUSES, `${path}.status`),
        contentItems: nullableArray(property(item, "contentItems", path), `${path}.contentItems`),
        success: nullableBoolean(property(item, "success", path), `${path}.success`),
        durationMs: nullableNumber(property(item, "durationMs", path), `${path}.durationMs`),
      };
    case "collabAgentToolCall":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        tool: enumValue(property(item, "tool", path), COLLAB_TOOLS, `${path}.tool`),
        status: enumValue(property(item, "status", path), TOOL_STATUSES, `${path}.status`),
        senderThreadId: stringValue(
          property(item, "senderThreadId", path),
          `${path}.senderThreadId`,
        ),
        receiverThreadIds: stringArray(
          property(item, "receiverThreadIds", path),
          `${path}.receiverThreadIds`,
        ),
        prompt: nullableString(property(item, "prompt", path), `${path}.prompt`),
        model: nullableString(property(item, "model", path), `${path}.model`),
        reasoningEffort: nullableString(
          property(item, "reasoningEffort", path),
          `${path}.reasoningEffort`,
        ),
        agentsStates: record(property(item, "agentsStates", path), `${path}.agentsStates`),
      };
    case "subAgentActivity":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        kind: enumValue(
          property(item, "kind", path),
          SUB_AGENT_ACTIVITY_KINDS,
          `${path}.kind`,
        ),
        agentThreadId: stringValue(
          property(item, "agentThreadId", path),
          `${path}.agentThreadId`,
        ),
        agentPath: stringValue(property(item, "agentPath", path), `${path}.agentPath`),
      };
    case "webSearch":
      return {
        type,
        id: stringValue(property(item, "id", path), `${path}.id`),
        query: stringValue(property(item, "query", path), `${path}.query`),
        action: nullableRecord(property(item, "action", path), `${path}.action`),
        results: nullableArray(property(item, "results", path), `${path}.results`),
      };
    default:
      if ((PASSIVE_THREAD_ITEM_TYPES as readonly string[]).includes(type)) {
        return {
          type: type as AppServerPassiveThreadItemType,
          id: stringValue(property(item, "id", path), `${path}.id`),
        };
      }
      throw protocolError(`${path}.type`, `has unsupported required variant ${JSON.stringify(type)}.`);
  }
}

function decodeTurn(value: unknown, path: string): AppServerTurnProjection {
  const turn = record(value, path);
  return {
    id: stringValue(property(turn, "id", path), `${path}.id`),
    items: arrayValue(property(turn, "items", path), `${path}.items`).map((item, index) =>
      decodeThreadItem(item, `${path}.items[${String(index)}]`)
    ),
    itemsView: enumValue(property(turn, "itemsView", path), TURN_ITEM_VIEWS, `${path}.itemsView`),
    status: enumValue(property(turn, "status", path), TURN_STATUSES, `${path}.status`),
    error: nullableRecord(property(turn, "error", path), `${path}.error`),
    startedAt: nullableNumber(property(turn, "startedAt", path), `${path}.startedAt`),
    completedAt: nullableNumber(property(turn, "completedAt", path), `${path}.completedAt`),
    durationMs: nullableNumber(property(turn, "durationMs", path), `${path}.durationMs`),
  };
}

function decodeThread(value: unknown, path: string): AppServerThreadProjection {
  const thread = record(value, path);
  return {
    id: stringValue(property(thread, "id", path), `${path}.id`),
    sessionId: stringValue(property(thread, "sessionId", path), `${path}.sessionId`),
    forkedFromId: nullableString(property(thread, "forkedFromId", path), `${path}.forkedFromId`),
    parentThreadId: nullableString(
      property(thread, "parentThreadId", path),
      `${path}.parentThreadId`,
    ),
    ephemeral: booleanValue(property(thread, "ephemeral", path), `${path}.ephemeral`),
    turns: arrayValue(property(thread, "turns", path), `${path}.turns`).map((turn, index) =>
      decodeTurn(turn, `${path}.turns[${String(index)}]`)
    ),
  };
}

export function decodeAppServerThreadStartParams(
  value: unknown,
): AppServerThreadStartParamsProjection {
  const params = record(value, "ThreadStartParams");
  if (!Object.hasOwn(params, "sandbox")) return {};
  const sandbox = params.sandbox;
  if (sandbox === null) return { sandbox: null };
  return {
    sandbox: enumValue(sandbox, APP_SERVER_THREAD_SANDBOX_MODES, "ThreadStartParams.sandbox"),
  };
}

export function decodeAppServerFreshThreadStartResponse(
  value: unknown,
): AppServerThreadStartResponseProjection {
  const response = record(value, "ThreadStartResponse");
  const threadValue = record(property(response, "thread", "ThreadStartResponse"), "ThreadStartResponse.thread");
  const turns = arrayValue(
    property(threadValue, "turns", "ThreadStartResponse.thread"),
    "ThreadStartResponse.thread.turns",
  );
  if (turns.length !== 0) {
    throw protocolError("ThreadStartResponse.thread.turns", "must be empty for a fresh root thread.");
  }
  const thread = decodeThread(threadValue, "ThreadStartResponse.thread");
  if (thread.ephemeral || thread.forkedFromId !== null || thread.parentThreadId !== null) {
    throw protocolError(
      "ThreadStartResponse.thread",
      "must be persistent, unforked, and parentless for a fresh root thread.",
    );
  }
  return { thread };
}

export function decodeAppServerThreadReadParams(
  value: unknown,
): AppServerThreadReadParamsProjection {
  const params = record(value, "ThreadReadParams");
  const threadId = stringValue(property(params, "threadId", "ThreadReadParams"), "ThreadReadParams.threadId");
  if (!Object.hasOwn(params, "includeTurns")) return { threadId };
  return {
    threadId,
    includeTurns: booleanValue(params.includeTurns, "ThreadReadParams.includeTurns"),
  };
}

export function decodeAppServerThreadReadResponse(
  value: unknown,
): AppServerThreadReadResponseProjection {
  const response = record(value, "ThreadReadResponse");
  return {
    thread: decodeThread(property(response, "thread", "ThreadReadResponse"), "ThreadReadResponse.thread"),
  };
}

export function decodeAppServerSkillsListResponse(
  value: unknown,
): AppServerSkillsListResponseProjection {
  const response = record(value, "SkillsListResponse");
  const entries = arrayValue(property(response, "data", "SkillsListResponse"), "SkillsListResponse.data");
  return {
    data: entries.map((entryValue, entryIndex) => {
      const entryPath = `SkillsListResponse.data[${String(entryIndex)}]`;
      const entry = record(entryValue, entryPath);
      const skills = arrayValue(property(entry, "skills", entryPath), `${entryPath}.skills`);
      const errors = arrayValue(property(entry, "errors", entryPath), `${entryPath}.errors`);
      return {
        cwd: stringValue(property(entry, "cwd", entryPath), `${entryPath}.cwd`),
        skills: skills.map((skillValue, skillIndex) => {
          const skillPath = `${entryPath}.skills[${String(skillIndex)}]`;
          const skill = record(skillValue, skillPath);
          return {
            name: stringValue(property(skill, "name", skillPath), `${skillPath}.name`),
            description: stringValue(
              property(skill, "description", skillPath),
              `${skillPath}.description`,
            ),
            path: stringValue(property(skill, "path", skillPath), `${skillPath}.path`),
            scope: enumValue(property(skill, "scope", skillPath), SKILL_SCOPES, `${skillPath}.scope`),
            enabled: booleanValue(property(skill, "enabled", skillPath), `${skillPath}.enabled`),
          };
        }),
        errors: errors.map((errorValue, errorIndex) => {
          const errorPath = `${entryPath}.errors[${String(errorIndex)}]`;
          const error = record(errorValue, errorPath);
          return {
            path: stringValue(property(error, "path", errorPath), `${errorPath}.path`),
            message: stringValue(property(error, "message", errorPath), `${errorPath}.message`),
          };
        }),
      };
    }),
  };
}

export function decodeAppServerSkillsListParams(
  value: unknown,
): AppServerSkillsListParamsProjection {
  const params = record(value, "SkillsListParams");
  return {
    ...(Object.hasOwn(params, "cwds")
      ? { cwds: stringArray(params.cwds, "SkillsListParams.cwds") }
      : {}),
    ...(Object.hasOwn(params, "forceReload")
      ? { forceReload: booleanValue(params.forceReload, "SkillsListParams.forceReload") }
      : {}),
  };
}

export function resolveAppServerSkill(
  value: unknown,
  cwd: string,
  name: string,
): AppServerSkillMetadataProjection {
  const response = decodeAppServerSkillsListResponse(value);
  const entries = response.data.filter((entry) => entry.cwd === cwd);
  if (entries.length !== 1) {
    throw protocolError(
      "SkillsListResponse.data",
      `is ambiguous for cwd ${JSON.stringify(cwd)}; expected one entry, got ${String(entries.length)}.`,
    );
  }
  const matches = entries[0]?.skills.filter((skill) => skill.name === name) ?? [];
  if (matches.length !== 1) {
    throw protocolError(
      "SkillsListResponse.skills",
      `is ambiguous for skill ${JSON.stringify(name)}; expected one match, got ${String(matches.length)}.`,
    );
  }
  const skill = matches[0];
  if (skill === undefined) throw protocolError("SkillsListResponse.skills", "lost its unique match.");
  if (!skill.enabled) {
    throw protocolError("SkillsListResponse.skills", `resolved disabled skill ${JSON.stringify(name)}.`);
  }
  return skill;
}

export function decodeAppServerTurnStartParams(
  value: unknown,
  requirements: AppServerTurnStartRequirements = {},
): AppServerTurnStartParamsProjection {
  const params = record(value, "TurnStartParams");
  const input = arrayValue(property(params, "input", "TurnStartParams"), "TurnStartParams.input")
    .map((entry, index) => decodeUserInput(entry, `TurnStartParams.input[${String(index)}]`));
  if (requirements.requiredSkill !== undefined) {
    const matches = input.filter((entry) =>
      entry.type === "skill" &&
      entry.name === requirements.requiredSkill?.name &&
      entry.path === requirements.requiredSkill.path
    );
    if (matches.length !== 1) {
      throw protocolError(
        "TurnStartParams.input",
        `must contain exactly one required skill item ${JSON.stringify(requirements.requiredSkill.name)}.`,
      );
    }
  }
  const threadId = stringValue(property(params, "threadId", "TurnStartParams"), "TurnStartParams.threadId");
  if (!Object.hasOwn(params, "sandboxPolicy")) return { threadId, input };
  if (params.sandboxPolicy === null) return { threadId, input, sandboxPolicy: null };
  return {
    threadId,
    input,
    sandboxPolicy: decodeSandboxPolicy(params.sandboxPolicy, "TurnStartParams.sandboxPolicy"),
  };
}

export function decodeAppServerTurnStartResponse(
  value: unknown,
): AppServerTurnStartResponseProjection {
  const response = record(value, "TurnStartResponse");
  const turn = decodeTurn(property(response, "turn", "TurnStartResponse"), "TurnStartResponse.turn");
  if (turn.status !== "inProgress") {
    throw protocolError("TurnStartResponse.turn.status", "must be inProgress.");
  }
  return { turn };
}

export function decodeAppServerItemStartedNotification(
  value: unknown,
): AppServerItemStartedNotificationProjection {
  const notification = record(value, "ItemStartedNotification");
  return {
    item: decodeThreadItem(
      property(notification, "item", "ItemStartedNotification"),
      "ItemStartedNotification.item",
    ),
    threadId: stringValue(
      property(notification, "threadId", "ItemStartedNotification"),
      "ItemStartedNotification.threadId",
    ),
    turnId: stringValue(
      property(notification, "turnId", "ItemStartedNotification"),
      "ItemStartedNotification.turnId",
    ),
    startedAtMs: numberValue(
      property(notification, "startedAtMs", "ItemStartedNotification"),
      "ItemStartedNotification.startedAtMs",
    ),
  };
}

export function decodeAppServerItemCompletedNotification(
  value: unknown,
): AppServerItemCompletedNotificationProjection {
  const notification = record(value, "ItemCompletedNotification");
  return {
    item: decodeThreadItem(
      property(notification, "item", "ItemCompletedNotification"),
      "ItemCompletedNotification.item",
    ),
    threadId: stringValue(
      property(notification, "threadId", "ItemCompletedNotification"),
      "ItemCompletedNotification.threadId",
    ),
    turnId: stringValue(
      property(notification, "turnId", "ItemCompletedNotification"),
      "ItemCompletedNotification.turnId",
    ),
    completedAtMs: numberValue(
      property(notification, "completedAtMs", "ItemCompletedNotification"),
      "ItemCompletedNotification.completedAtMs",
    ),
  };
}

export function decodeAppServerCompletedCommandEvidence(
  value: unknown,
): AppServerCompletedCommandEvidence {
  const notification = decodeAppServerItemCompletedNotification(value);
  if (notification.item.type !== "commandExecution" || notification.item.status !== "completed") {
    throw protocolError("ItemCompletedNotification.item", "must be completed command evidence.");
  }
  if (notification.item.source !== "agent") {
    throw protocolError("ItemCompletedNotification.item.source", "must be agent for completed command evidence.");
  }
  if (notification.item.exitCode !== 0) {
    throw protocolError("ItemCompletedNotification.item.exitCode", "must be 0 for completed command evidence.");
  }
  return {
    ...notification,
    item: {
      ...notification.item,
      source: "agent",
      status: "completed",
      exitCode: 0,
    },
  };
}

export function decodeAppServerTurnCompletedNotification(
  value: unknown,
): AppServerTurnCompletedNotificationProjection {
  const notification = record(value, "TurnCompletedNotification");
  const turn = decodeTurn(
    property(notification, "turn", "TurnCompletedNotification"),
    "TurnCompletedNotification.turn",
  );
  if (turn.status === "inProgress") {
    throw protocolError("TurnCompletedNotification.turn.status", "must be terminal.");
  }
  return {
    threadId: stringValue(
      property(notification, "threadId", "TurnCompletedNotification"),
      "TurnCompletedNotification.threadId",
    ),
    turn: {
      ...turn,
      status: turn.status,
    },
  };
}
