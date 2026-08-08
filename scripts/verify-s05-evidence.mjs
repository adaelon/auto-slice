#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkspaceIdentity } from "../dist/src/contracts/workspace-identity.js";
import { sha256Bytes, sha256Json } from "../dist/src/controller/state/index.js";
import {
  FileWorkspaceGuard,
  GitChangeGuard,
  WorkspaceGuardError,
} from "../dist/src/controller/workspace/index.js";
import {
  CheckProcessRunner,
  SliceExecutionError,
  SliceExecutor,
  SliceVerifier,
  parseSliceContractV1,
} from "../dist/src/controller/slices/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixturePath = path.join(repoRoot, "test", "fixtures", "process", "check-fixture.mjs");
const fixedTime = "2026-08-08T00:00:00.000Z";
const developmentDecision = {
  mode: "model",
  model: "gpt-5.6-sol",
  effort: "max",
};

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unwrap(result) {
  if (result instanceof SliceExecutionError || result instanceof WorkspaceGuardError) {
    throw result;
  }
  return result;
}

function check(id, mode, args = [], timeoutMs = 5_000) {
  return {
    id,
    argv: [process.execPath, fixturePath, mode, ...args],
    cwd: ".",
    timeout_ms: timeoutMs,
    env_allowlist: ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"],
    expected_exit_code: 0,
    expected_artifacts: [],
  };
}

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: fixedTime,
      GIT_COMMITTER_DATE: fixedTime,
    },
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.error?.message ?? ""}`);
  }
  return result.stdout;
}

function initializeRepository(root) {
  mkdirSync(root, { recursive: true });
  runGit(root, ["init"]);
  runGit(root, ["config", "user.name", "Auto Slice Evidence"]);
  runGit(root, ["config", "user.email", "auto-slice@example.invalid"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "tracked.txt"), "tracked-v1\n", "utf8");
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "fixture baseline"]);
}

async function processScenarioMatrix(root) {
  const processRoot = path.join(root, "process-workspace");
  mkdirSync(processRoot);
  const workspace = createWorkspaceIdentity(processRoot);
  const runner = new CheckProcessRunner();
  const overflowRunner = new CheckProcessRunner({ maximumOutputBytes: 1_024 });
  const marker = path.join(processRoot, "orphan-marker.txt");
  const cases = [
    {
      id: "success",
      expected: "PASS",
      execute: () => runner.run(check("success", "success"), workspace),
    },
    {
      id: "nonzero_llm_claim",
      expected: "CHECK_NONZERO_EXIT",
      execute: () => runner.run(check("nonzero", "claim-pass-nonzero"), workspace),
    },
    {
      id: "timeout",
      expected: "CHECK_TIMEOUT",
      execute: () => runner.run(check("timeout", "hang", [], 100), workspace),
    },
    {
      id: "output_limit",
      expected: "CHECK_OUTPUT_LIMIT_EXCEEDED",
      execute: () => overflowRunner.run(check("output", "output", ["8192"]), workspace),
    },
    {
      id: "process_tree_timeout",
      expected: "CHECK_TIMEOUT",
      execute: () => runner.run(check("tree", "tree-parent", [marker], 150), workspace),
    },
  ];
  const scenarios = [];
  for (const scenario of cases) {
    const receipt = await scenario.execute();
    requireCondition(receipt.outcome === scenario.expected, `Unexpected outcome for ${scenario.id}.`);
    if (scenario.id === "timeout" || scenario.id === "output_limit" || scenario.id === "process_tree_timeout") {
      requireCondition(receipt.process_tree_terminated, `${scenario.id} did not terminate its process tree.`);
    }
    if (scenario.id === "process_tree_timeout") {
      await new Promise((resolve) => setTimeout(resolve, 900));
      requireCondition(!existsSync(marker), "A timed-out grandchild survived and wrote its marker.");
    }
    scenarios.push({
      id: scenario.id,
      outcome: receipt.outcome,
      expected_exit_code: receipt.expected_exit_code,
      observed_exit_code: scenario.id === "success" || scenario.id === "nonzero_llm_claim"
        ? receipt.exit_code
        : null,
      process_tree_terminated: receipt.process_tree_terminated,
      output_limit_exceeded: receipt.output_limit_exceeded,
      result: "PASS",
    });
  }
  return {
    schema_version: 1,
    slice_id: "S05",
    scenarios,
    result: "PASS",
  };
}

function runtimeContract(checks, expectedArtifacts = [], ownedPaths = ["owned/**"]) {
  return {
    slice_id: "S05-evidence",
    contract_version: 1,
    objective: "Produce deterministic S05 evidence.",
    exclusions: ["No commit."],
    owned_paths: ownedPaths,
    checks,
    expected_artifacts: expectedArtifacts,
  };
}

async function verifyScenario(root, id, rawContract) {
  const workspaceRoot = path.join(root, `verification-${id}`);
  const storageRoot = path.join(root, `lease-${id}`);
  initializeRepository(workspaceRoot);
  const leaseGuard = unwrap(FileWorkspaceGuard.open(storageRoot, {
    now: () => new Date(fixedTime),
    leaseIdFactory: () => `s05-evidence-lease-${id}`,
    leaseDurationMs: 60_000,
  }));
  const lease = unwrap(leaseGuard.acquire(createWorkspaceIdentity(workspaceRoot), `run-s05-${id}`));
  const contract = unwrap(parseSliceContractV1(rawContract));
  const changeGuard = new GitChangeGuard(() => new Date(fixedTime));
  const executor = new SliceExecutor({
    changeGuard,
    executionIdFactory: () => `execution-s05-${id}`,
    leaseGuard,
    now: () => new Date(fixedTime),
  });
  const executionId = unwrap(executor.start(contract, lease, developmentDecision));
  const execution = unwrap(await executor.collect(executionId));
  const verifier = new SliceVerifier(changeGuard);
  const receipt = verifier.verify(contract, execution, lease.workspace_identity);
  const repeated = verifier.verify(contract, execution, lease.workspace_identity);
  requireCondition(JSON.stringify(repeated) === JSON.stringify(receipt), `${id} verification was not repeatable.`);
  return { execution, receipt };
}

async function verificationEvidence(root) {
  const contents = "artifact-v1\n";
  const expectedDigest = sha256Bytes(contents);
  const matched = await verifyScenario(
    root,
    "match",
    runtimeContract(
      [check("write", "write-file", ["owned/result.txt", contents])],
      [{ path: "owned/result.txt", kind: "evidence", digest: expectedDigest }],
    ),
  );
  const missing = await verifyScenario(
    root,
    "missing",
    runtimeContract(
      [check("success", "success")],
      [{ path: "owned/missing.txt", kind: "evidence" }],
    ),
  );
  const mismatch = await verifyScenario(
    root,
    "mismatch",
    runtimeContract(
      [check("write", "write-file", ["owned/result.txt", "actual\n"])],
      [{ path: "owned/result.txt", kind: "evidence", digest: expectedDigest }],
    ),
  );
  const unowned = await verifyScenario(
    root,
    "unowned",
    runtimeContract([check("outside", "write-file", ["outside.txt", "not-owned\n"])]),
  );
  const llmClaim = await verifyScenario(
    root,
    "llm-claim",
    runtimeContract([check("nonzero", "claim-pass-nonzero")]),
  );
  const expected = [
    [matched.receipt, "PASS", null],
    [missing.receipt, "FAIL", "artifact_missing"],
    [mismatch.receipt, "FAIL", "artifact_digest_mismatch"],
    [unowned.receipt, "FAIL", "unowned_change_detected"],
    [llmClaim.receipt, "FAIL", "check_nonzero_exit"],
  ];
  for (const [receipt, result, failureCode] of expected) {
    requireCondition(receipt.result === result, `Expected ${result} verification result.`);
    requireCondition((receipt.failure_code ?? null) === failureCode, `Expected failure code ${String(failureCode)}.`);
  }
  const artifactDigestFixture = {
    schema_version: 1,
    slice_id: "S05",
    expected_digest: expectedDigest,
    scenarios: [
      { id: "match", result: matched.receipt.result, failure_code: null },
      { id: "missing", result: missing.receipt.result, failure_code: missing.receipt.failure_code },
      { id: "mismatch", result: mismatch.receipt.result, failure_code: mismatch.receipt.failure_code },
      { id: "unowned_write", result: unowned.receipt.result, failure_code: unowned.receipt.failure_code },
      { id: "llm_claim_runner_failure", result: llmClaim.receipt.result, failure_code: llmClaim.receipt.failure_code },
    ],
    result: "PASS",
  };
  const { receipt_digest: receiptDigest, ...receiptMaterial } = matched.receipt;
  requireCondition(receiptDigest === sha256Json(receiptMaterial), "VerificationReceipt digest is invalid.");
  const verificationReceiptSample = {
    schema_version: matched.receipt.schema_version,
    slice_id: matched.receipt.slice_id,
    execution_id: matched.receipt.execution_id,
    contract_digest: matched.receipt.contract_digest,
    run_id: matched.receipt.run_id,
    result: matched.receipt.result,
    check_receipts: matched.receipt.check_receipts.map((entry) => ({
      check_id: entry.check_id,
      outcome: entry.outcome,
      expected_exit_code: entry.expected_exit_code,
      exit_code: entry.exit_code,
      stdout_digest: entry.stdout_digest,
      stderr_digest: entry.stderr_digest,
    })),
    artifact_digests: matched.receipt.artifact_digests,
    owned_diff_digest_present: matched.receipt.owned_diff_digest !== null,
    overlap_paths: matched.receipt.overlap_paths,
    unowned_paths: matched.receipt.unowned_paths,
    receipt_digest_valid: true,
    repeated_verification_equal: true,
  };
  return { artifactDigestFixture, verificationReceiptSample };
}

async function main() {
  const materializedContract = unwrap(parseSliceContractV1(JSON.parse(
    readFileSync(path.join(repoRoot, "contracts", "slices", "S05.json"), "utf8"),
  )));
  requireCondition(materializedContract.slice_id === "S05", "The materialized S05 SliceSpec is not runtime-parseable.");
  const root = mkdtempSync(path.join(os.tmpdir(), "auto-slice-s05-evidence-"));
  try {
    const processMatrix = await processScenarioMatrix(root);
    const { artifactDigestFixture, verificationReceiptSample } = await verificationEvidence(root);
    process.stdout.write(`${JSON.stringify({
      process_scenario_matrix: processMatrix,
      artifact_digest_fixture: artifactDigestFixture,
      verification_receipt_sample: verificationReceiptSample,
    })}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
