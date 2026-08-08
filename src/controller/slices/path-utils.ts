import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import { createWorkspaceIdentity } from "../../contracts/workspace-identity.js";
import { canonicalJson } from "../state/index.js";
import { SliceExecutionError } from "./errors.js";

export function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertWorkspaceIdentity(workspace: WorkspaceIdentity): string | SliceExecutionError {
  try {
    const root = realpathSync.native(workspace.canonical_root);
    const actual = createWorkspaceIdentity(root);
    if (canonicalJson(actual) !== canonicalJson(workspace)) {
      return new SliceExecutionError(
        "workspace_inspection_failed",
        "Workspace identity changed before Slice execution.",
      );
    }
    return root;
  } catch (error: unknown) {
    return new SliceExecutionError(
      "workspace_inspection_failed",
      "Workspace identity could not be verified.",
      { cause: error },
    );
  }
}

export function resolveWorkspaceDirectory(
  workspace: WorkspaceIdentity,
  relativePath: string,
): string | SliceExecutionError {
  const root = assertWorkspaceIdentity(workspace);
  if (root instanceof SliceExecutionError) {
    return root;
  }
  try {
    const candidate = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(root, candidate)) {
      return new SliceExecutionError(
        "path_outside_workspace",
        `Check cwd escapes the workspace: ${relativePath}.`,
      );
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isWithinRoot(root, realCandidate) || !statSync(realCandidate).isDirectory()) {
      return new SliceExecutionError(
        "path_outside_workspace",
        `Check cwd is not a directory inside the workspace: ${relativePath}.`,
      );
    }
    return realCandidate;
  } catch (error: unknown) {
    return new SliceExecutionError(
      "path_outside_workspace",
      `Check cwd cannot be resolved inside the workspace: ${relativePath}.`,
      { cause: error },
    );
  }
}

export function resolveWorkspaceArtifact(
  workspace: WorkspaceIdentity,
  relativePath: string,
): string | SliceExecutionError {
  const root = assertWorkspaceIdentity(workspace);
  if (root instanceof SliceExecutionError) {
    return root;
  }
  try {
    const candidate = path.resolve(root, ...relativePath.split("/"));
    if (!isWithinRoot(root, candidate)) {
      return new SliceExecutionError(
        "path_outside_workspace",
        `Artifact path escapes the workspace: ${relativePath}.`,
      );
    }
    const realCandidate = realpathSync.native(candidate);
    if (!isWithinRoot(root, realCandidate)) {
      return new SliceExecutionError(
        "path_outside_workspace",
        `Artifact resolves outside the workspace: ${relativePath}.`,
      );
    }
    if (!statSync(realCandidate).isFile()) {
      return new SliceExecutionError(
        "artifact_missing",
        `Artifact is not a file inside the workspace: ${relativePath}.`,
      );
    }
    return realCandidate;
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "ENOENT") {
      return new SliceExecutionError("artifact_missing", `Artifact is missing: ${relativePath}.`);
    }
    return new SliceExecutionError(
      "workspace_inspection_failed",
      `Artifact could not be inspected: ${relativePath}.`,
      { cause: error },
    );
  }
}
