import path from "node:path";

import { SliceExecutionError } from "./errors.js";
import {
  SLICE_CONTRACT_VERSION,
  type ArtifactExpectation,
  type CheckSpec,
  type SliceContractV1,
} from "./types.js";

const MAXIMUM_CHECK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): SliceExecutionError {
  return new SliceExecutionError("slice_contract_invalid", message);
}

function invalidPath(message: string): SliceExecutionError {
  return new SliceExecutionError("path_outside_workspace", message);
}

function normalizeRepositoryPath(
  value: unknown,
  label: string,
  options: { readonly allowRoot?: boolean; readonly allowRecursive?: boolean } = {},
): string | SliceExecutionError {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return invalid(`${label} must be a non-empty repository-relative path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (options.allowRoot === true && normalized === ".") {
    return normalized;
  }
  const recursive = options.allowRecursive === true && normalized.endsWith("/**");
  const base = recursive ? normalized.slice(0, -3) : normalized;
  const segments = base.split("/");
  if (
    base.length === 0 ||
    path.posix.isAbsolute(base) ||
    path.win32.isAbsolute(base) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /[*?\[\]]/u.test(base)
  ) {
    return invalidPath(`${label} escapes or ambiguously addresses the workspace: ${value}.`);
  }
  if (!recursive && /[*?\[\]]/u.test(normalized)) {
    return invalidPath(`${label} contains an unsupported wildcard: ${value}.`);
  }
  return recursive ? `${base}/**` : base;
}

function parseStringList(value: unknown, label: string): readonly string[] | SliceExecutionError {
  if (!Array.isArray(value)) {
    return invalid(`${label} must be an array of non-empty strings.`);
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return invalid(`${label} must be an array of non-empty strings.`);
    }
    strings.push(entry);
  }
  if (new Set(strings).size !== strings.length) {
    return invalid(`${label} must not contain duplicates.`);
  }
  return strings;
}

function parseArtifact(value: unknown, label: string): ArtifactExpectation | SliceExecutionError {
  if (typeof value === "string") {
    const artifactPath = normalizeRepositoryPath(value, label);
    if (artifactPath instanceof SliceExecutionError) {
      return artifactPath;
    }
    return { path: artifactPath, kind: "file" };
  }
  if (!isRecord(value)) {
    return invalid(`${label} must be a path string or ArtifactSpec object.`);
  }
  const artifactPath = normalizeRepositoryPath(value.path, `${label}.path`);
  if (artifactPath instanceof SliceExecutionError) {
    return artifactPath;
  }
  const kind = value.kind === undefined ? "file" : value.kind;
  if (typeof kind !== "string" || kind.trim().length === 0) {
    return invalid(`${label}.kind must be a non-empty string.`);
  }
  if (value.digest !== undefined && (typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest))) {
    return invalid(`${label}.digest must be a lowercase sha256 digest.`);
  }
  return value.digest === undefined
    ? { path: artifactPath, kind }
    : { path: artifactPath, kind, digest: value.digest as `sha256:${string}` };
}

function parseCheck(value: unknown, index: number): CheckSpec | SliceExecutionError {
  const label = `checks[${String(index)}]`;
  if (!isRecord(value)) {
    return invalid(`${label} must be a CheckSpec object.`);
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    return invalid(`${label}.id must be a non-empty string.`);
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0) {
    return invalid(`${label}.argv must be a non-empty argv string array, never a shell string.`);
  }
  const argv: string[] = [];
  for (const argument of value.argv) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      return invalid(`${label}.argv must be a non-empty argv string array, never a shell string.`);
    }
    argv.push(argument);
  }
  if (argv[0] === "") {
    return invalid(`${label}.argv command must be non-empty.`);
  }
  const cwd = normalizeRepositoryPath(value.cwd, `${label}.cwd`, { allowRoot: true });
  if (cwd instanceof SliceExecutionError) {
    return cwd;
  }
  if (
    typeof value.timeout_ms !== "number" ||
    !Number.isInteger(value.timeout_ms) ||
    value.timeout_ms <= 0 ||
    value.timeout_ms > MAXIMUM_CHECK_TIMEOUT_MS
  ) {
    return invalid(`${label}.timeout_ms must be an integer between 1 and ${String(MAXIMUM_CHECK_TIMEOUT_MS)}.`);
  }
  const environment = parseStringList(value.env_allowlist, `${label}.env_allowlist`);
  if (environment instanceof SliceExecutionError) {
    return environment;
  }
  if (environment.some((entry) => entry.includes("=") || entry.includes("\0"))) {
    return invalid(`${label}.env_allowlist contains an invalid variable name.`);
  }
  if (
    typeof value.expected_exit_code !== "number" ||
    !Number.isInteger(value.expected_exit_code) ||
    value.expected_exit_code < 0 ||
    value.expected_exit_code > 255
  ) {
    return invalid(`${label}.expected_exit_code must be an integer from 0 through 255.`);
  }
  if (!Array.isArray(value.expected_artifacts)) {
    return invalid(`${label}.expected_artifacts must be an array.`);
  }
  const expectedArtifacts: string[] = [];
  for (const [artifactIndex, artifact] of value.expected_artifacts.entries()) {
    const artifactPath = normalizeRepositoryPath(
      artifact,
      `${label}.expected_artifacts[${String(artifactIndex)}]`,
    );
    if (artifactPath instanceof SliceExecutionError) {
      return artifactPath;
    }
    expectedArtifacts.push(artifactPath);
  }
  if (new Set(expectedArtifacts).size !== expectedArtifacts.length) {
    return invalid(`${label}.expected_artifacts must not contain duplicates.`);
  }
  return {
    id: value.id,
    argv,
    cwd,
    timeout_ms: value.timeout_ms,
    env_allowlist: environment,
    expected_exit_code: value.expected_exit_code,
    expected_artifacts: expectedArtifacts,
  };
}

export function parseSliceContractV1(value: unknown): SliceContractV1 | SliceExecutionError {
  if (!isRecord(value)) {
    return invalid("SliceContractV1 must be an object.");
  }
  const sliceId = value.slice_id ?? value.id;
  if (
    typeof sliceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sliceId) ||
    (value.slice_id !== undefined && value.id !== undefined && value.slice_id !== value.id)
  ) {
    return invalid("SliceContractV1 must contain one stable slice_id (or matching SliceSpec id). ");
  }
  if (value.contract_version !== SLICE_CONTRACT_VERSION) {
    return invalid("SliceContractV1 must use contract_version 1.");
  }
  if (typeof value.objective !== "string" || value.objective.trim().length === 0) {
    return invalid("SliceContractV1 objective must be a non-empty string.");
  }
  const exclusions = parseStringList(value.exclusions, "exclusions");
  if (exclusions instanceof SliceExecutionError) {
    return exclusions;
  }
  if (!Array.isArray(value.owned_paths) || value.owned_paths.length === 0) {
    return invalid("owned_paths must be a non-empty array.");
  }
  const ownedPaths: string[] = [];
  for (const [index, ownedPath] of value.owned_paths.entries()) {
    const normalized = normalizeRepositoryPath(ownedPath, `owned_paths[${String(index)}]`, {
      allowRecursive: true,
    });
    if (normalized instanceof SliceExecutionError) {
      return normalized;
    }
    ownedPaths.push(normalized);
  }
  if (new Set(ownedPaths).size !== ownedPaths.length) {
    return invalid("owned_paths must not contain duplicates.");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    return invalid("checks must contain at least one deterministic CheckSpec.");
  }
  const checks: CheckSpec[] = [];
  for (const [index, check] of value.checks.entries()) {
    const parsed = parseCheck(check, index);
    if (parsed instanceof SliceExecutionError) {
      return parsed;
    }
    checks.push(parsed);
  }
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    return invalid("CheckSpec ids must be unique within one Slice.");
  }
  if (!Array.isArray(value.expected_artifacts)) {
    return invalid("expected_artifacts must be an array.");
  }
  const expectedArtifacts: ArtifactExpectation[] = [];
  for (const [index, artifact] of value.expected_artifacts.entries()) {
    const parsed = parseArtifact(artifact, `expected_artifacts[${String(index)}]`);
    if (parsed instanceof SliceExecutionError) {
      return parsed;
    }
    expectedArtifacts.push(parsed);
  }
  if (new Set(expectedArtifacts.map((artifact) => artifact.path)).size !== expectedArtifacts.length) {
    return invalid("expected_artifacts paths must be unique.");
  }
  if (
    value.commit_mode_override !== undefined &&
    value.commit_mode_override !== "after_slice" &&
    value.commit_mode_override !== "none"
  ) {
    return invalid("commit_mode_override must be after_slice or none when present.");
  }
  const base = {
    slice_id: sliceId,
    contract_version: SLICE_CONTRACT_VERSION,
    objective: value.objective,
    exclusions,
    owned_paths: ownedPaths,
    checks,
    expected_artifacts: expectedArtifacts,
  };
  return value.commit_mode_override === undefined
    ? base
    : { ...base, commit_mode_override: value.commit_mode_override };
}
