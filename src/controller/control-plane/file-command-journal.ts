import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  sha256Bytes,
  sha256Json,
  type Sha256Digest,
} from "../state/index.js";
import { ControlPlaneError } from "./errors.js";
import {
  CONTROL_COMMANDS,
  CONTROL_PLANE_SCHEMA_VERSION,
  type CommandIntentRecord,
  type CommandJournalBegin,
  type CommandJournalPort,
  type ControlCommand,
  type ControlCommandReceipt,
} from "./types.js";

interface CommandCompletionRecord {
  readonly schema_version: typeof CONTROL_PLANE_SCHEMA_VERSION;
  readonly intent_digest: Sha256Digest;
  readonly receipt: ControlCommandReceipt;
  readonly receipt_digest: Sha256Digest;
  readonly completed_at: string;
  readonly completion_digest: Sha256Digest;
}

const COMMAND_SET = new Set<string>(CONTROL_COMMANDS);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function journalFailure(
  code: "command_journal_failed" | "command_journal_corrupt",
  message: string,
  error?: unknown,
): ControlPlaneError {
  return new ControlPlaneError(code, message, error === undefined ? undefined : { cause: error });
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw journalFailure("command_journal_corrupt", `${label} is not a SHA-256 digest.`);
  }
  return value as Sha256Digest;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw journalFailure("command_journal_corrupt", `${label} is not an ISO timestamp.`);
  }
  return value;
}

function requireCommand(value: unknown, label: string): ControlCommand {
  if (typeof value !== "string" || !COMMAND_SET.has(value)) {
    throw journalFailure("command_journal_corrupt", `${label} is not a control command.`);
  }
  return value as ControlCommand;
}

function decodeIntent(value: unknown): CommandIntentRecord {
  if (!isRecord(value) || value.schema_version !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw journalFailure("command_journal_corrupt", "Command intent is not schema v1.");
  }
  if (typeof value.command_id !== "string" || value.command_id.length === 0) {
    throw journalFailure("command_journal_corrupt", "Command intent has no command_id.");
  }
  const material = {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    command_id: value.command_id,
    command: requireCommand(value.command, "Command intent command"),
    envelope_digest: requireDigest(value.envelope_digest, "Command intent envelope_digest"),
    started_at: requireTimestamp(value.started_at, "Command intent started_at"),
  };
  const intent = {
    ...material,
    intent_digest: requireDigest(value.intent_digest, "Command intent intent_digest"),
  } satisfies CommandIntentRecord;
  if (intent.intent_digest !== sha256Json(material)) {
    throw journalFailure("command_journal_corrupt", "Command intent digest does not match its content.");
  }
  return intent;
}

function decodeReceipt(value: unknown): ControlCommandReceipt {
  if (!isRecord(value) || value.schema_version !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw journalFailure("command_journal_corrupt", "Command receipt is not schema v1.");
  }
  const receiptDigest = requireDigest(value.receipt_digest, "Command receipt receipt_digest");
  const material = { ...value } as Record<string, unknown>;
  Reflect.deleteProperty(material, "receipt_digest");
  if (receiptDigest !== sha256Json(material)) {
    throw journalFailure("command_journal_corrupt", "Command receipt digest does not match its content.");
  }
  if (
    typeof value.command_id !== "string" ||
    value.command_id.length === 0 ||
    (value.outcome !== "OK" && value.outcome !== "NEEDS_USER" && value.outcome !== "REJECTED")
  ) {
    throw journalFailure("command_journal_corrupt", "Command receipt identity or outcome is invalid.");
  }
  requireCommand(value.command, "Command receipt command");
  requireTimestamp(value.completed_at, "Command receipt completed_at");
  return value as unknown as ControlCommandReceipt;
}

function decodeCompletion(value: unknown): CommandCompletionRecord {
  if (!isRecord(value) || value.schema_version !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw journalFailure("command_journal_corrupt", "Command completion is not schema v1.");
  }
  const receipt = decodeReceipt(value.receipt);
  const material = {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    intent_digest: requireDigest(value.intent_digest, "Command completion intent_digest"),
    receipt,
    receipt_digest: requireDigest(value.receipt_digest, "Command completion receipt_digest"),
    completed_at: requireTimestamp(value.completed_at, "Command completion completed_at"),
  };
  const completion = {
    ...material,
    completion_digest: requireDigest(value.completion_digest, "Command completion completion_digest"),
  } satisfies CommandCompletionRecord;
  if (
    completion.receipt_digest !== receipt.receipt_digest ||
    completion.completed_at !== receipt.completed_at ||
    completion.completion_digest !== sha256Json(material)
  ) {
    throw journalFailure("command_journal_corrupt", "Command completion is inconsistent with its receipt.");
  }
  return completion;
}

function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw isErrno(error, "ENOENT")
      ? error
      : journalFailure("command_journal_corrupt", `${label} cannot be decoded.`, error);
  }
}

function readOptionalJson(filePath: string, label: string): unknown {
  try {
    return readJson(filePath, label);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function writeTemporaryFile(targetPath: string, payload: unknown): string {
  const directory = path.dirname(targetPath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${canonicalJson(payload)}\n`, "utf8");
    fsyncSync(descriptor);
    return temporary;
  } catch (error: unknown) {
    throw journalFailure("command_journal_failed", `Cannot write command journal file ${targetPath}.`, error);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function removeQuietly(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Published immutable files remain authoritative.
  }
}

function publishImmutable(targetPath: string, payload: unknown): boolean {
  const temporary = writeTemporaryFile(targetPath, payload);
  try {
    linkSync(temporary, targetPath);
    return true;
  } catch (error: unknown) {
    if (isErrno(error, "EEXIST")) {
      return false;
    }
    throw journalFailure("command_journal_failed", `Cannot publish command journal file ${targetPath}.`, error);
  } finally {
    removeQuietly(temporary);
  }
}

export class FileCommandJournal implements CommandJournalPort {
  private constructor(private readonly storageRoot: string) {}

  public static open(storageRoot: string): FileCommandJournal | ControlPlaneError {
    try {
      const resolved = path.resolve(storageRoot);
      mkdirSync(path.join(resolved, "commands"), { recursive: true });
      return new FileCommandJournal(resolved);
    } catch (error: unknown) {
      return journalFailure("command_journal_failed", "Command journal storage cannot be opened.", error);
    }
  }

  public begin(
    command: ControlCommand,
    commandId: string,
    envelopeDigest: Sha256Digest,
    startedAt: string,
  ): CommandJournalBegin | ControlPlaneError {
    try {
      const directory = this.commandDirectory(commandId);
      const intentPath = path.join(directory, "intent.json");
      const completionPath = path.join(directory, "completion.json");
      const existingIntentValue = readOptionalJson(intentPath, "Command intent");
      if (existingIntentValue !== undefined) {
        return this.replayExisting(existingIntentValue, completionPath, command, commandId, envelopeDigest);
      }
      const material = {
        schema_version: CONTROL_PLANE_SCHEMA_VERSION,
        command_id: commandId,
        command,
        envelope_digest: envelopeDigest,
        started_at: startedAt,
      };
      const intent = {
        ...material,
        intent_digest: sha256Json(material),
      } satisfies CommandIntentRecord;
      if (!publishImmutable(intentPath, intent)) {
        return this.replayExisting(readJson(intentPath, "Command intent"), completionPath, command, commandId, envelopeDigest);
      }
      return { outcome: "CLAIMED", intent };
    } catch (error: unknown) {
      return error instanceof ControlPlaneError
        ? error
        : journalFailure("command_journal_failed", "Command journal claim failed.", error);
    }
  }

  public complete(
    intent: CommandIntentRecord,
    receipt: ControlCommandReceipt,
  ): ControlCommandReceipt | ControlPlaneError {
    try {
      if (intent.command_id !== receipt.command_id || intent.command !== receipt.command) {
        return new ControlPlaneError("command_replay_conflict", "Command receipt does not match its intent.");
      }
      const material = {
        schema_version: CONTROL_PLANE_SCHEMA_VERSION,
        intent_digest: intent.intent_digest,
        receipt,
        receipt_digest: receipt.receipt_digest,
        completed_at: receipt.completed_at,
      };
      const completion = {
        ...material,
        completion_digest: sha256Json(material),
      } satisfies CommandCompletionRecord;
      const completionPath = path.join(this.commandDirectory(intent.command_id), "completion.json");
      if (!publishImmutable(completionPath, completion)) {
        const existing = decodeCompletion(readJson(completionPath, "Command completion"));
        if (
          existing.intent_digest !== intent.intent_digest ||
          existing.receipt_digest !== receipt.receipt_digest
        ) {
          return new ControlPlaneError("command_replay_conflict", "Command completion conflicts with the persisted receipt.");
        }
        return existing.receipt;
      }
      return receipt;
    } catch (error: unknown) {
      return error instanceof ControlPlaneError
        ? error
        : journalFailure("command_journal_failed", "Command journal completion failed.", error);
    }
  }

  private replayExisting(
    intentValue: unknown,
    completionPath: string,
    command: ControlCommand,
    commandId: string,
    envelopeDigest: Sha256Digest,
  ): CommandJournalBegin | ControlPlaneError {
    const intent = decodeIntent(intentValue);
    if (
      intent.command !== command ||
      intent.command_id !== commandId ||
      intent.envelope_digest !== envelopeDigest
    ) {
      return new ControlPlaneError("command_replay_conflict", "command_id was reused with a different request.");
    }
    const completionValue = readOptionalJson(completionPath, "Command completion");
    if (completionValue === undefined) {
      return { outcome: "IN_PROGRESS", intent };
    }
    const completion = decodeCompletion(completionValue);
    if (completion.intent_digest !== intent.intent_digest) {
      return journalFailure("command_journal_corrupt", "Command completion does not reference its intent.");
    }
    return { outcome: "REPLAY", receipt: completion.receipt };
  }

  private commandDirectory(commandId: string): string {
    return path.join(this.storageRoot, "commands", sha256Bytes(commandId).slice("sha256:".length));
  }
}
