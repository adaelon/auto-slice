import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { ContractLoadError } from "./errors.js";
import type { WorkspaceIdentity } from "./types.js";

function normalizeForIdentity(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  try {
    const resolved = path.resolve(workspaceRoot);
    const canonicalRoot = realpathSync.native(resolved);
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new ContractLoadError(
        "workspace_unaddressable",
        `Workspace root is not a directory: ${workspaceRoot}`,
      );
    }
    return path.normalize(canonicalRoot);
  } catch (error: unknown) {
    if (error instanceof ContractLoadError) {
      throw error;
    }
    throw new ContractLoadError(
      "workspace_unaddressable",
      `Workspace root cannot be addressed: ${workspaceRoot}`,
      { cause: error },
    );
  }
}

export function createWorkspaceIdentity(canonicalRoot: string): WorkspaceIdentity {
  try {
    const stats = statSync(canonicalRoot, { bigint: true });
    const identityMaterial = [
      process.platform,
      stats.dev.toString(),
      stats.ino.toString(),
      normalizeForIdentity(canonicalRoot),
    ].join("\0");
    const digest = createHash("sha256").update(identityMaterial, "utf8").digest("hex");

    return {
      canonical_root: canonicalRoot,
      filesystem_identity: `${process.platform}:sha256:${digest}`,
    };
  } catch (error: unknown) {
    throw new ContractLoadError(
      "workspace_unaddressable",
      `Workspace identity cannot be read: ${canonicalRoot}`,
      { cause: error },
    );
  }
}

export function isWithinWorkspace(canonicalRoot: string, candidate: string): boolean {
  const comparableRoot = normalizeForIdentity(canonicalRoot);
  const comparableCandidate = normalizeForIdentity(candidate);
  const relative = path.relative(comparableRoot, comparableCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
