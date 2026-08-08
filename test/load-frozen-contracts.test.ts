import assert from "node:assert/strict";
import {
  appendFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  ContractLoadError,
  loadFrozenContracts,
  type FrozenContracts,
} from "../src/contracts/index.js";
import {
  copyFixtureWorkspace,
  digestWorkspaceTree,
  FIXTURE_ROOT,
} from "./helpers/frozen-workspace.js";

interface MutableContractManifest {
  schema_version: number;
  plugin_ids: string[];
  context_path: string;
  design_path: string;
  adr_paths: string[];
}

function assertLoaded(result: FrozenContracts | ContractLoadError): asserts result is FrozenContracts {
  if (result instanceof ContractLoadError) {
    assert.fail(`${result.code}/${result.reason}: ${result.message}`);
  }
}

function assertLoadError(
  result: FrozenContracts | ContractLoadError,
  reason: ContractLoadError["reason"],
): asserts result is ContractLoadError {
  assert.ok(result instanceof ContractLoadError, "Expected contract_load_failed.");
  assert.equal(result.code, "contract_load_failed");
  assert.equal(result.reason, reason);
}

function readMutableManifest(root: string): MutableContractManifest {
  const manifestPath = path.join(root, "contracts", "frozen-contracts.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  const record = parsed as Record<string, unknown>;
  assert.equal(typeof record.schema_version, "number");
  assert.ok(Array.isArray(record.plugin_ids));
  assert.equal(typeof record.context_path, "string");
  assert.equal(typeof record.design_path, "string");
  assert.ok(Array.isArray(record.adr_paths));
  assert.ok(record.plugin_ids.every((entry) => typeof entry === "string"));
  assert.ok(record.adr_paths.every((entry) => typeof entry === "string"));
  return {
    schema_version: record.schema_version,
    plugin_ids: record.plugin_ids,
    context_path: record.context_path,
    design_path: record.design_path,
    adr_paths: record.adr_paths,
  } as MutableContractManifest;
}

function writeMutableManifest(root: string, manifest: MutableContractManifest): void {
  writeFileSync(
    path.join(root, "contracts", "frozen-contracts.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

void test("loads the fixed FrozenContracts fixture snapshot without writing", () => {
  const before = digestWorkspaceTree(FIXTURE_ROOT);
  const result = loadFrozenContracts(FIXTURE_ROOT);
  assertLoaded(result);
  const after = digestWorkspaceTree(FIXTURE_ROOT);
  assert.equal(after, before);

  const normalized = {
    ...result,
    workspace_identity: {
      canonical_root: "<FIXTURE_ROOT>",
      filesystem_identity: "<FILESYSTEM_IDENTITY>",
    },
  };
  const snapshot: unknown = JSON.parse(
    readFileSync("test/fixtures/frozen-contracts.snapshot.json", "utf8"),
  );
  assert.deepEqual(normalized, snapshot);
});

void test("relative, symlink, and Windows case spellings share one workspace identity", () => {
  const workspace = copyFixtureWorkspace();
  try {
    const absolute = loadFrozenContracts(workspace.root);
    assertLoaded(absolute);

    const relative = loadFrozenContracts(path.relative(process.cwd(), workspace.root));
    assertLoaded(relative);
    assert.deepEqual(relative.workspace_identity, absolute.workspace_identity);

    const alias = path.join(workspace.container, "workspace-alias");
    symlinkSync(workspace.root, alias, process.platform === "win32" ? "junction" : "dir");
    const throughSymlink = loadFrozenContracts(alias);
    assertLoaded(throughSymlink);
    assert.deepEqual(throughSymlink.workspace_identity, absolute.workspace_identity);

    if (process.platform === "win32") {
      const differentCase = loadFrozenContracts(workspace.root.toLocaleUpperCase("en-US"));
      assertLoaded(differentCase);
      assert.deepEqual(differentCase.workspace_identity, absolute.workspace_identity);
    }
  } finally {
    workspace.remove();
  }
});

void test("changing each frozen document changes only its corresponding digest", async (context) => {
  const adrPaths = [
    "docs/adr/0001-local-controller-and-task-isolation.md",
    "docs/adr/0002-deterministic-model-routing.md",
    "docs/adr/0003-commit-and-checkpoint-order.md",
    "docs/adr/0004-compaction-timeout-handoff.md",
  ] as const;
  const cases = [
    { path: "CONTEXT.md", field: "context_digest", adrIndex: -1 },
    { path: "docs/auto-slice-design.md", field: "design_digest", adrIndex: -1 },
    ...adrPaths.map((adrPath, adrIndex) => ({
      path: adrPath,
      field: "adr_digests",
      adrIndex,
    })),
  ] as const;

  for (const candidate of cases) {
    await context.test(candidate.path, () => {
      const workspace = copyFixtureWorkspace();
      try {
        const before = loadFrozenContracts(workspace.root);
        assertLoaded(before);
        appendFileSync(path.join(workspace.root, candidate.path), "changed\n", "utf8");
        const after = loadFrozenContracts(workspace.root);
        assertLoaded(after);

        if (candidate.field === "context_digest") {
          assert.notEqual(after.context_digest, before.context_digest);
          assert.equal(after.design_digest, before.design_digest);
          assert.deepEqual(after.adr_digests, before.adr_digests);
        } else if (candidate.field === "design_digest") {
          assert.equal(after.context_digest, before.context_digest);
          assert.notEqual(after.design_digest, before.design_digest);
          assert.deepEqual(after.adr_digests, before.adr_digests);
        } else {
          assert.equal(after.context_digest, before.context_digest);
          assert.equal(after.design_digest, before.design_digest);
          assert.notEqual(after.adr_digests[candidate.adrIndex], before.adr_digests[candidate.adrIndex]);
          const unchangedBefore = before.adr_digests.filter((_, index) => index !== candidate.adrIndex);
          const unchangedAfter = after.adr_digests.filter((_, index) => index !== candidate.adrIndex);
          assert.deepEqual(unchangedAfter, unchangedBefore);
        }
      } finally {
        workspace.remove();
      }
    });
  }
});

void test("fails closed when an ADR is missing", () => {
  const workspace = copyFixtureWorkspace();
  try {
    rmSync(path.join(workspace.root, "docs", "adr", "0004-compaction-timeout-handoff.md"));
    assertLoadError(loadFrozenContracts(workspace.root), "required_file_missing");
  } finally {
    workspace.remove();
  }
});

void test("fails closed on malformed UTF-8", () => {
  const workspace = copyFixtureWorkspace();
  try {
    writeFileSync(
      path.join(workspace.root, "docs", "adr", "0002-deterministic-model-routing.md"),
      Buffer.from([0xc3, 0x28]),
    );
    assertLoadError(loadFrozenContracts(workspace.root), "invalid_utf8");
  } finally {
    workspace.remove();
  }
});

void test("fails closed on an unsupported contract schema", () => {
  const workspace = copyFixtureWorkspace();
  try {
    const manifest = readMutableManifest(workspace.root);
    manifest.schema_version = 2;
    writeMutableManifest(workspace.root, manifest);
    assertLoadError(loadFrozenContracts(workspace.root), "unsupported_schema");
  } finally {
    workspace.remove();
  }
});

void test("fails closed on duplicate plugin IDs", () => {
  const workspace = copyFixtureWorkspace();
  try {
    const manifest = readMutableManifest(workspace.root);
    manifest.plugin_ids.push("auto-slice");
    writeMutableManifest(workspace.root, manifest);
    assertLoadError(loadFrozenContracts(workspace.root), "duplicate_plugin_id");
  } finally {
    workspace.remove();
  }
});

void test("fails closed when the workspace cannot be addressed", () => {
  assertLoadError(
    loadFrozenContracts(path.join(FIXTURE_ROOT, "missing-workspace")),
    "workspace_unaddressable",
  );
});
