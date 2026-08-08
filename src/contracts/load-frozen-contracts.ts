import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { ContractLoadError } from "./errors.js";
import {
  FROZEN_CONTRACT_SCHEMA_VERSION,
  type FrozenContractManifestV1,
  type FrozenContracts,
} from "./types.js";
import {
  canonicalizeWorkspaceRoot,
  createWorkspaceIdentity,
  isWithinWorkspace,
} from "./workspace-identity.js";

const CONTRACT_MANIFEST_PATH = "contracts/frozen-contracts.json";
const PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json";
const REQUIRED_CONTEXT_PATH = "CONTEXT.md";
const REQUIRED_DESIGN_PATH = "docs/auto-slice-design.md";
const REQUIRED_ADR_PATHS = [
  "docs/adr/0001-local-controller-and-task-isolation.md",
  "docs/adr/0002-deterministic-model-routing.md",
  "docs/adr/0003-commit-and-checkpoint-order.md",
  "docs/adr/0004-compaction-timeout-handoff.md",
] as const;

interface StrictTextFile {
  readonly bytes: Buffer;
  readonly text: string;
}

function fail(
  reason: ConstructorParameters<typeof ContractLoadError>[0],
  message: string,
  cause?: unknown,
): never {
  if (cause === undefined) {
    throw new ContractLoadError(reason, message);
  }
  throw new ContractLoadError(reason, message, { cause });
}

function resolveRequiredFile(canonicalRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    return fail(
      "required_path_outside_workspace",
      `Frozen contract path must be relative: ${relativePath}`,
    );
  }

  const lexicalPath = path.resolve(canonicalRoot, relativePath);
  if (!isWithinWorkspace(canonicalRoot, lexicalPath)) {
    return fail(
      "required_path_outside_workspace",
      `Frozen contract path escapes the workspace: ${relativePath}`,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(lexicalPath);
  } catch (error: unknown) {
    return fail("required_file_missing", `Required frozen contract is missing: ${relativePath}`, error);
  }

  if (!isWithinWorkspace(canonicalRoot, canonicalPath)) {
    return fail(
      "required_path_outside_workspace",
      `Frozen contract symlink escapes the workspace: ${relativePath}`,
    );
  }

  try {
    if (!statSync(canonicalPath).isFile()) {
      return fail("required_path_not_file", `Required frozen contract is not a file: ${relativePath}`);
    }
  } catch (error: unknown) {
    return fail("required_file_missing", `Required frozen contract cannot be read: ${relativePath}`, error);
  }

  return canonicalPath;
}

function readStrictUtf8(canonicalRoot: string, relativePath: string): StrictTextFile {
  const canonicalPath = resolveRequiredFile(canonicalRoot, relativePath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(canonicalPath);
  } catch (error: unknown) {
    return fail("required_file_missing", `Required frozen contract cannot be read: ${relativePath}`, error);
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { bytes, text };
  } catch (error: unknown) {
    return fail("invalid_utf8", `Required frozen contract is not valid UTF-8: ${relativePath}`, error);
  }
}

function parseJsonRecord(file: StrictTextFile, relativePath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(file.text) as unknown;
  } catch (error: unknown) {
    return fail("invalid_json", `JSON contract cannot be parsed: ${relativePath}`, error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid_json", `JSON contract must contain an object: ${relativePath}`);
  }
  return value as Record<string, unknown>;
}

function readStringArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return fail("invalid_contract_manifest", `Frozen contract manifest field '${field}' must be a non-empty string array.`);
  }
  return value as string[];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function loadContractManifest(canonicalRoot: string): FrozenContractManifestV1 {
  const file = readStrictUtf8(canonicalRoot, CONTRACT_MANIFEST_PATH);
  const record = parseJsonRecord(file, CONTRACT_MANIFEST_PATH);
  if (record.schema_version !== FROZEN_CONTRACT_SCHEMA_VERSION) {
    return fail(
      "unsupported_schema",
      `Unsupported frozen contract schema version: ${String(record.schema_version)}`,
    );
  }

  const pluginIds = readStringArray(record, "plugin_ids");
  if (new Set(pluginIds).size !== pluginIds.length) {
    return fail("duplicate_plugin_id", "Frozen contract manifest contains a duplicate plugin ID.");
  }
  if (record.context_path !== REQUIRED_CONTEXT_PATH || record.design_path !== REQUIRED_DESIGN_PATH) {
    return fail("invalid_contract_manifest", "Frozen contract manifest changed a required design path.");
  }

  const adrPaths = readStringArray(record, "adr_paths");
  if (!arraysEqual(adrPaths, REQUIRED_ADR_PATHS)) {
    return fail("invalid_contract_manifest", "Frozen contract manifest must list the four v1 ADRs in canonical order.");
  }

  return {
    schema_version: FROZEN_CONTRACT_SCHEMA_VERSION,
    plugin_ids: pluginIds,
    context_path: REQUIRED_CONTEXT_PATH,
    design_path: REQUIRED_DESIGN_PATH,
    adr_paths: adrPaths,
  };
}

function validatePluginId(canonicalRoot: string, expectedPluginIds: readonly string[]): void {
  const file = readStrictUtf8(canonicalRoot, PLUGIN_MANIFEST_PATH);
  const record = parseJsonRecord(file, PLUGIN_MANIFEST_PATH);
  const pluginName = record.name;
  if (
    expectedPluginIds.length !== 1 ||
    typeof pluginName !== "string" ||
    pluginName !== expectedPluginIds[0]
  ) {
    fail("plugin_id_mismatch", "Root plugin ID does not match the frozen contract manifest.");
  }
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function loadFrozenContractsOrThrow(workspaceRoot: string): FrozenContracts {
  const canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
  const manifest = loadContractManifest(canonicalRoot);
  validatePluginId(canonicalRoot, manifest.plugin_ids);

  const context = readStrictUtf8(canonicalRoot, manifest.context_path);
  const design = readStrictUtf8(canonicalRoot, manifest.design_path);
  const adrDigests = manifest.adr_paths.map((adrPath) => sha256(readStrictUtf8(canonicalRoot, adrPath).bytes));

  return {
    schema_version: FROZEN_CONTRACT_SCHEMA_VERSION,
    context_digest: sha256(context.bytes),
    design_digest: sha256(design.bytes),
    adr_digests: adrDigests,
    workspace_identity: createWorkspaceIdentity(canonicalRoot),
  };
}

export function loadFrozenContracts(workspaceRoot: string): FrozenContracts | ContractLoadError {
  try {
    return loadFrozenContractsOrThrow(workspaceRoot);
  } catch (error: unknown) {
    if (error instanceof ContractLoadError) {
      return error;
    }
    return new ContractLoadError(
      "invalid_contract_manifest",
      "Frozen contracts could not be loaded.",
      { cause: error },
    );
  }
}
