import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXTURE_ROOT = path.resolve("test/fixtures/frozen-workspace");

export interface TemporaryWorkspace {
  readonly container: string;
  readonly root: string;
  readonly remove: () => void;
}

export function copyFixtureWorkspace(): TemporaryWorkspace {
  const container = mkdtempSync(path.join(tmpdir(), "auto-slice-s01-"));
  const root = path.join(container, "workspace");
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return {
    container,
    root,
    remove: () => {
      rmSync(container, { force: true, recursive: true });
    },
  };
}

function appendTree(hash: ReturnType<typeof createHash>, directory: string, relative = ""): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const childPath = path.join(directory, entry.name);
    hash.update(childRelative, "utf8");
    hash.update("\0", "utf8");
    if (entry.isDirectory()) {
      appendTree(hash, childPath, childRelative);
    } else {
      hash.update(readFileSync(childPath));
    }
    hash.update("\0", "utf8");
  }
}

export function digestWorkspaceTree(root: string): string {
  const hash = createHash("sha256");
  appendTree(hash, root);
  return hash.digest("hex");
}
