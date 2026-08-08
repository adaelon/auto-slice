import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./canonical-json.js";
import { StateStoreError } from "./errors.js";
import { RUN_STORE_SCHEMA_VERSION } from "./types.js";

const SCHEMA_FILE = "schema.json";

export const STATE_STORE_MIGRATIONS = [
  {
    from: 0,
    to: RUN_STORE_SCHEMA_VERSION,
    name: "initialize-directory-event-store-v1",
  },
] as const;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function readSchema(schemaPath: string): unknown {
  let bytes: Buffer;
  try {
    bytes = readFileSync(schemaPath);
  } catch (error: unknown) {
    throw new StateStoreError("state_persist_failed", "State store schema cannot be read.", {
      cause: error,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new StateStoreError("state_corrupt", "State store schema is not valid UTF-8.", {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new StateStoreError("state_corrupt", "State store schema is not valid JSON.", {
      cause: error,
    });
  }
}

function validateSchema(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StateStoreError("state_corrupt", "State store schema must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== RUN_STORE_SCHEMA_VERSION) {
    throw new StateStoreError(
      "unsupported_state_schema",
      `Unsupported state store schema version: ${String(record.schema_version)}.`,
    );
  }
  if (record.migration !== STATE_STORE_MIGRATIONS[0].name || Object.keys(record).length !== 2) {
    throw new StateStoreError("state_corrupt", "State store schema metadata is invalid.");
  }
}

function createSchema(schemaPath: string): void {
  const payload = `${canonicalJson({
    schema_version: RUN_STORE_SCHEMA_VERSION,
    migration: STATE_STORE_MIGRATIONS[0].name,
  })}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(schemaPath, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
  } catch (error: unknown) {
    if (!isErrno(error, "EEXIST")) {
      throw new StateStoreError("state_persist_failed", "State store schema cannot be created.", {
        cause: error,
      });
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function ensureStateStoreSchema(storageRoot: string): void {
  try {
    mkdirSync(storageRoot, { recursive: true });
  } catch (error: unknown) {
    throw new StateStoreError("state_persist_failed", "State store directory cannot be created.", {
      cause: error,
    });
  }

  const schemaPath = path.join(storageRoot, SCHEMA_FILE);
  if (!existsSync(schemaPath)) {
    const existingEntries = readdirSync(storageRoot).filter((entry) => entry !== SCHEMA_FILE);
    if (existingEntries.length > 0) {
      throw new StateStoreError(
        "state_corrupt",
        "A non-empty state store is missing schema metadata.",
      );
    }
    createSchema(schemaPath);
  }
  validateSchema(readSchema(schemaPath));
}
