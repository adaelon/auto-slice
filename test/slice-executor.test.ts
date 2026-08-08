import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createWorkspaceIdentity } from "../src/contracts/workspace-identity.js";
import { sha256Bytes } from "../src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  GitChangeGuard,
  WorkspaceGuardError,
  type ProjectLease,
} from "../src/controller/workspace/index.js";
import {
  CheckProcessRunner,
  SliceExecutionError,
  SliceExecutor,
  SliceVerifier,
  parseSliceContractV1,
  type CheckSpec,
  type ExecutionReceipt,
  type SliceContractV1,
  type VerificationReceipt,
} from "../src/controller/slices/index.js";

const FIXTURE = path.resolve("test/fixtures/process/check-fixture.mjs");
const FIXED_TIME = "2026-08-08T00:00:00.000Z";
const DEVELOPMENT_DECISION = {
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
} as const;

function temporaryDirectory(context: TestContext, prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function check(
  id: string,
  mode: string,
  args: readonly string[] = [],
  timeoutMs = 5_000,
): CheckSpec {
  return {
    id,
    argv: [process.execPath, FIXTURE, mode, ...args],
    cwd: ".",
    timeout_ms: timeoutMs,
    env_allowlist: ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"],
    expected_exit_code: 0,
    expected_artifacts: [],
  };
}

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: FIXED_TIME,
      GIT_COMMITTER_DATE: FIXED_TIME,
    },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    assert.fail(`git ${args.join(" ")} failed: ${result.stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout;
}

function initializeRepository(context: TestContext): string {
  const root = temporaryDirectory(context, "auto-slice-s05-git-");
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Auto Slice Test"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "tracked.txt"), "tracked-v1\n", "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "fixture baseline"]);
  return root;
}

function unwrap<T>(result: T | SliceExecutionError): T {
  if (result instanceof SliceExecutionError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

function unwrapWorkspace<T>(result: T | WorkspaceGuardError): T {
  if (result instanceof WorkspaceGuardError) {
    assert.fail(`${result.code}: ${result.message}`);
  }
  return result;
}

interface Harness {
  readonly contract: SliceContractV1;
  readonly executor: SliceExecutor;
  readonly lease: ProjectLease;
  readonly leaseGuard: FileWorkspaceGuard;
  readonly root: string;
  readonly run: () => Promise<ExecutionReceipt>;
}

function harness(
  context: TestContext,
  rawContract: unknown,
  maximumOutputBytes = 1024 * 1024,
): Harness {
  const root = initializeRepository(context);
  const storage = temporaryDirectory(context, "auto-slice-s05-lease-");
  const leaseGuard = unwrapWorkspace(FileWorkspaceGuard.open(storage, {
    now: () => new Date(FIXED_TIME),
    leaseIdFactory: () => "s05-test-lease",
    leaseDurationMs: 60_000,
  }));
  const lease = unwrapWorkspace(
    leaseGuard.acquire(createWorkspaceIdentity(root), "run-s05-test"),
  );
  const contract = unwrap(parseSliceContractV1(rawContract));
  const executor = new SliceExecutor({
    changeGuard: new GitChangeGuard(() => new Date(FIXED_TIME)),
    executionIdFactory: () => "execution-s05-test",
    leaseGuard,
    now: () => new Date(FIXED_TIME),
    processRunner: new CheckProcessRunner({ maximumOutputBytes }),
  });
  return {
    contract,
    executor,
    lease,
    leaseGuard,
    root,
    run: async () => {
      const executionId = unwrap(executor.start(contract, lease, DEVELOPMENT_DECISION));
      return unwrap(await executor.collect(executionId));
    },
  };
}

function contract(
  checks: readonly CheckSpec[],
  expectedArtifacts: SliceContractV1["expected_artifacts"] = [],
  ownedPaths: readonly string[] = ["owned/**"],
): SliceContractV1 {
  return {
    slice_id: "S05-test",
    contract_version: 1,
    objective: "Exercise one deterministic Slice.",
    exclusions: ["No commits."],
    owned_paths: ownedPaths,
    checks,
    expected_artifacts: expectedArtifacts,
  };
}

void test("SliceContractV1 rejects shell strings and workspace escapes", () => {
  const shellString = parseSliceContractV1({
    ...contract([]),
    checks: [{
      id: "shell",
      argv: "node -e pass",
      cwd: ".",
      timeout_ms: 1_000,
      env_allowlist: [],
      expected_exit_code: 0,
      expected_artifacts: [],
    }],
  });
  assert.ok(shellString instanceof SliceExecutionError);
  assert.equal(shellString.code, "slice_contract_invalid");

  const escaped = parseSliceContractV1(contract([{
    ...check("escape", "success"),
    cwd: "../outside",
  }]));
  assert.ok(escaped instanceof SliceExecutionError);
  assert.equal(escaped.code, "path_outside_workspace");
});

void test("real subprocess success records bounded stdout and stderr digests", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-process-");
  const receipt = await new CheckProcessRunner().run(
    check("success", "success"),
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "PASS");
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.stdout_digest, sha256Bytes("check-ok\n"));
  assert.equal(receipt.stderr_digest, sha256Bytes("check-note\n"));
  assert.equal(receipt.output_limit_exceeded, false);
});

void test("real subprocess receives only allowlisted environment variables", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-env-");
  const target = path.join(root, "observed-env.json");
  const allowedName = "AUTO_SLICE_S05_ALLOWED";
  const forbiddenName = "AUTO_SLICE_S05_FORBIDDEN";
  process.env[allowedName] = "visible";
  process.env[forbiddenName] = "secret";
  context.after(() => {
    delete process.env.AUTO_SLICE_S05_ALLOWED;
    delete process.env.AUTO_SLICE_S05_FORBIDDEN;
  });
  const environmentCheck: CheckSpec = {
    ...check("environment", "capture-env", [target, allowedName, forbiddenName]),
    env_allowlist: [allowedName],
  };
  const receipt = await new CheckProcessRunner().run(
    environmentCheck,
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "PASS");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")) as unknown, {
    allowed: "visible",
    forbidden: null,
  });
});

void test("real subprocess non-zero exit overrides an LLM pass claim", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-process-");
  const receipt = await new CheckProcessRunner().run(
    check("nonzero", "claim-pass-nonzero"),
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "CHECK_NONZERO_EXIT");
  assert.equal(receipt.exit_code, 7);
});

void test("real subprocess timeout terminates the process", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-process-");
  const receipt = await new CheckProcessRunner().run(
    check("timeout", "hang", [], 100),
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "CHECK_TIMEOUT");
  assert.equal(receipt.process_tree_terminated, true);
});

void test("real subprocess output overflow fails closed without buffering unbounded output", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-process-");
  const receipt = await new CheckProcessRunner({ maximumOutputBytes: 1_024 }).run(
    check("output", "output", ["8192"]),
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "CHECK_OUTPUT_LIMIT_EXCEEDED");
  assert.equal(receipt.output_limit_exceeded, true);
  assert.equal(receipt.process_tree_terminated, true);
});

void test("timeout terminates the entire real child process tree", async (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-tree-");
  const marker = path.join(root, "orphan-marker.txt");
  const receipt = await new CheckProcessRunner().run(
    check("tree", "tree-parent", [marker], 150),
    createWorkspaceIdentity(root),
  );
  assert.equal(receipt.outcome, "CHECK_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(existsSync(marker), false, "a grandchild survived the timeout kill");
});

void test("SliceExecutor and SliceVerifier produce a repeatable PASS receipt", async (context) => {
  const contents = "artifact-v1\n";
  const raw = contract(
    [check("write", "write-file", ["owned/result.txt", contents])],
    [{
      path: "owned/result.txt",
      kind: "test_artifact",
      digest: sha256Bytes(contents),
    }],
  );
  const runtime = harness(context, raw);
  writeFileSync(path.join(runtime.root, "protected-user.txt"), "user-change\n", "utf8");
  const execution = await runtime.run();
  const verifier = new SliceVerifier();
  const first = verifier.verify(runtime.contract, execution, runtime.lease.workspace_identity);
  const second = verifier.verify(runtime.contract, execution, runtime.lease.workspace_identity);
  assert.deepEqual(second, first);
  assert.equal(first.result, "PASS");
  assert.equal(first.failure_code, undefined);
  assert.deepEqual(first.artifact_digests, [{
    path: "owned/result.txt",
    digest: sha256Bytes(contents),
  }]);
  assert.equal(readFileSync(path.join(runtime.root, "owned/result.txt"), "utf8"), contents);
});

void test("Verifier closes non-zero, missing, and mismatched artifacts with distinct codes", async (context) => {
  const cases: readonly {
    readonly id: string;
    readonly maximumOutputBytes?: number;
    readonly raw: SliceContractV1;
    readonly expected: VerificationReceipt["failure_code"];
  }[] = [
    {
      id: "nonzero",
      raw: contract([check("nonzero", "claim-pass-nonzero")]),
      expected: "check_nonzero_exit",
    },
    {
      id: "spawn",
      raw: contract([{
        ...check("spawn", "success"),
        argv: ["auto-slice-s05-command-that-does-not-exist"],
      }]),
      expected: "check_spawn_failed",
    },
    {
      id: "timeout",
      raw: contract([check("timeout", "hang", [], 100)]),
      expected: "check_timeout",
    },
    {
      id: "output-limit",
      maximumOutputBytes: 1_024,
      raw: contract([check("output", "output", ["8192"])]),
      expected: "check_output_limit_exceeded",
    },
    {
      id: "missing",
      raw: contract([check("success", "success")], [{
        path: "owned/missing.txt",
        kind: "test_artifact",
      }]),
      expected: "artifact_missing",
    },
    {
      id: "mismatch",
      raw: contract(
        [check("write", "write-file", ["owned/result.txt", "actual\n"])],
        [{
          path: "owned/result.txt",
          kind: "test_artifact",
          digest: sha256Bytes("expected\n"),
        }],
      ),
      expected: "artifact_digest_mismatch",
    },
  ];
  for (const scenario of cases) {
    const runtime = scenario.maximumOutputBytes === undefined
      ? harness(context, scenario.raw)
      : harness(context, scenario.raw, scenario.maximumOutputBytes);
    const execution = await runtime.run();
    const receipt = new SliceVerifier().verify(
      runtime.contract,
      execution,
      runtime.lease.workspace_identity,
    );
    assert.equal(receipt.result, "FAIL", scenario.id);
    assert.equal(receipt.failure_code, scenario.expected, scenario.id);
  }
});

void test("Verifier rejects writes outside declared owned paths", async (context) => {
  const runtime = harness(
    context,
    contract([check("outside", "write-file", ["outside.txt", "not-owned\n"])]),
  );
  const execution = await runtime.run();
  const receipt = new SliceVerifier().verify(
    runtime.contract,
    execution,
    runtime.lease.workspace_identity,
  );
  assert.equal(receipt.result, "FAIL");
  assert.equal(receipt.failure_code, "unowned_change_detected");
});

void test("SliceExecutor closes invalid model, lost lease, and execution lifecycle errors", async (context) => {
  const raw = contract([check("success", "success")]);
  const invalidModel = harness(context, raw);
  const modelFailure = invalidModel.executor.start(
    invalidModel.contract,
    invalidModel.lease,
    { mode: "none" },
  );
  assert.ok(modelFailure instanceof SliceExecutionError);
  assert.equal(modelFailure.code, "model_decision_invalid");

  const lostLease = harness(context, raw);
  unwrapWorkspace(lostLease.leaseGuard.release(lostLease.lease.lease_id, lostLease.lease.epoch));
  const leaseFailure = lostLease.executor.start(
    lostLease.contract,
    lostLease.lease,
    DEVELOPMENT_DECISION,
  );
  assert.ok(leaseFailure instanceof SliceExecutionError);
  assert.equal(leaseFailure.code, "write_capability_unavailable");

  const lifecycle = harness(context, raw);
  const unknown = await lifecycle.executor.collect({
    schema_version: 1,
    execution_id: "unknown-execution",
    slice_id: lifecycle.contract.slice_id,
  });
  assert.ok(unknown instanceof SliceExecutionError);
  assert.equal(unknown.code, "execution_not_found");
  const executionId = unwrap(
    lifecycle.executor.start(lifecycle.contract, lifecycle.lease, DEVELOPMENT_DECISION),
  );
  unwrap(await lifecycle.executor.collect(executionId));
  const repeated = await lifecycle.executor.collect(executionId);
  assert.ok(repeated instanceof SliceExecutionError);
  assert.equal(repeated.code, "execution_already_collected");
});

void test("SliceExecutor fails closed when the lease workspace is not a Git worktree", (context) => {
  const root = temporaryDirectory(context, "auto-slice-s05-not-git-");
  const storage = temporaryDirectory(context, "auto-slice-s05-not-git-lease-");
  const leaseGuard = unwrapWorkspace(FileWorkspaceGuard.open(storage, {
    now: () => new Date(FIXED_TIME),
    leaseIdFactory: () => "s05-not-git-lease",
    leaseDurationMs: 60_000,
  }));
  const lease = unwrapWorkspace(
    leaseGuard.acquire(createWorkspaceIdentity(root), "run-s05-not-git"),
  );
  const executor = new SliceExecutor({ leaseGuard });
  const failure = executor.start(contract([check("success", "success")]), lease, DEVELOPMENT_DECISION);
  assert.ok(failure instanceof SliceExecutionError);
  assert.equal(failure.code, "workspace_inspection_failed");
});

void test("Verifier distinguishes Protected Change overlap from an unowned write", async (context) => {
  const runtime = harness(
    context,
    contract(
      [check("overwrite", "write-file", ["protected.txt", "slice-overwrite\n"])],
      [],
      ["protected.txt"],
    ),
  );
  writeFileSync(path.join(runtime.root, "protected.txt"), "user-change\n", "utf8");
  const execution = await runtime.run();
  const receipt = new SliceVerifier().verify(
    runtime.contract,
    execution,
    runtime.lease.workspace_identity,
  );
  assert.equal(receipt.result, "FAIL");
  assert.equal(receipt.failure_code, "protected_change_overlap");
  assert.deepEqual(receipt.overlap_paths, ["protected.txt"]);
});

void test("Verifier rejects a tampered ExecutionReceipt", async (context) => {
  const runtime = harness(context, contract([check("success", "success")]));
  const execution = await runtime.run();
  const tampered: ExecutionReceipt = {
    ...execution,
    receipt_digest: sha256Bytes("tampered"),
  };
  const receipt = new SliceVerifier().verify(
    runtime.contract,
    tampered,
    runtime.lease.workspace_identity,
  );
  assert.equal(receipt.result, "FAIL");
  assert.equal(receipt.failure_code, "verification_receipt_invalid");
});
