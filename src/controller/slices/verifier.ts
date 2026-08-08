import { readFileSync } from "node:fs";

import type { WorkspaceIdentity } from "../../contracts/index.js";
import { canonicalJson, sha256Bytes, sha256Json } from "../state/index.js";
import { GitChangeGuard, WorkspaceGuardError } from "../workspace/index.js";
import { parseSliceContractV1 } from "./contract-parser.js";
import { SliceExecutionError } from "./errors.js";
import { resolveWorkspaceArtifact } from "./path-utils.js";
import {
  SLICE_EXECUTION_SCHEMA_VERSION,
  type ArtifactDigest,
  type CheckExecutionReceipt,
  type ExecutionReceipt,
  type SliceContractV1,
  type SliceFailureCode,
  type VerificationReceipt,
} from "./types.js";

interface VerificationMaterial {
  readonly checkReceipts: readonly CheckExecutionReceipt[];
  readonly artifactDigests: readonly ArtifactDigest[];
  readonly ownedDiffDigest: `sha256:${string}` | null;
  readonly overlapPaths: readonly string[];
  readonly unownedPaths: readonly string[];
  readonly failureCode: SliceFailureCode | undefined;
}

function executionMaterial(receipt: ExecutionReceipt): Omit<ExecutionReceipt, "receipt_digest"> {
  return {
    schema_version: receipt.schema_version,
    execution_id: receipt.execution_id,
    slice_id: receipt.slice_id,
    contract_digest: receipt.contract_digest,
    run_id: receipt.run_id,
    lease_id: receipt.lease_id,
    write_epoch: receipt.write_epoch,
    workspace_identity: receipt.workspace_identity,
    model_decision: receipt.model_decision,
    started_at: receipt.started_at,
    completed_at: receipt.completed_at,
    check_receipts: receipt.check_receipts,
    protected_baseline: receipt.protected_baseline,
    workspace_snapshot: receipt.workspace_snapshot,
  };
}

function checkFailure(receipts: readonly CheckExecutionReceipt[]): SliceFailureCode | undefined {
  for (const receipt of receipts) {
    switch (receipt.outcome) {
      case "PASS":
        break;
      case "CHECK_PATH_OUTSIDE_WORKSPACE":
        return "path_outside_workspace";
      case "CHECK_SPAWN_FAILED":
        return "check_spawn_failed";
      case "CHECK_TIMEOUT":
        return "check_timeout";
      case "CHECK_NONZERO_EXIT":
        return "check_nonzero_exit";
      case "CHECK_OUTPUT_LIMIT_EXCEEDED":
        return "check_output_limit_exceeded";
    }
  }
  return undefined;
}

function receiptMatchesContract(
  contract: SliceContractV1,
  receipt: ExecutionReceipt,
): boolean {
  if (
    receipt.slice_id !== contract.slice_id ||
    receipt.contract_digest !== sha256Json(contract) ||
    receipt.receipt_digest !== sha256Json(executionMaterial(receipt)) ||
    receipt.check_receipts.length !== contract.checks.length
  ) {
    return false;
  }
  return receipt.check_receipts.every((observed, index) => {
    const expected = contract.checks[index];
    return expected !== undefined &&
      observed.check_id === expected.id &&
      canonicalJson(observed.argv) === canonicalJson(expected.argv) &&
      observed.cwd === expected.cwd &&
      observed.expected_exit_code === expected.expected_exit_code &&
      (observed.outcome !== "PASS" || observed.exit_code === expected.expected_exit_code);
  });
}

function finalize(
  contract: SliceContractV1,
  execution: ExecutionReceipt,
  material: VerificationMaterial,
): VerificationReceipt {
  const base = {
    schema_version: SLICE_EXECUTION_SCHEMA_VERSION,
    slice_id: contract.slice_id,
    execution_id: execution.execution_id,
    contract_digest: execution.contract_digest,
    result: material.failureCode === undefined ? "PASS" as const : "FAIL" as const,
    check_receipts: material.checkReceipts,
    artifact_digests: material.artifactDigests,
    owned_diff_digest: material.ownedDiffDigest,
    overlap_paths: material.overlapPaths,
    unowned_paths: material.unownedPaths,
  };
  const withFailure = material.failureCode === undefined
    ? base
    : { ...base, failure_code: material.failureCode };
  return {
    ...withFailure,
    receipt_digest: sha256Json(withFailure),
  };
}

export class SliceVerifier {
  public constructor(private readonly changeGuard: GitChangeGuard = new GitChangeGuard()) {}

  public verify(
    rawContract: unknown,
    execution: ExecutionReceipt,
    workspace: WorkspaceIdentity,
  ): VerificationReceipt {
    const contract = parseSliceContractV1(rawContract);
    if (contract instanceof SliceExecutionError) {
      const fallback: SliceContractV1 = {
        slice_id: typeof execution.slice_id === "string" ? execution.slice_id : "invalid-slice",
        contract_version: 1,
        objective: "Invalid Slice contract.",
        exclusions: [],
        owned_paths: ["invalid"],
        checks: [{
          id: "invalid",
          argv: ["invalid"],
          cwd: ".",
          timeout_ms: 1,
          env_allowlist: [],
          expected_exit_code: 0,
          expected_artifacts: [],
        }],
        expected_artifacts: [],
      };
      return finalize(fallback, execution, {
        checkReceipts: execution.check_receipts,
        artifactDigests: [],
        ownedDiffDigest: null,
        overlapPaths: [],
        unownedPaths: [],
        failureCode: contract.code,
      });
    }
    if (
      !receiptMatchesContract(contract, execution) ||
      canonicalJson(execution.workspace_identity) !== canonicalJson(workspace)
    ) {
      return finalize(contract, execution, {
        checkReceipts: execution.check_receipts,
        artifactDigests: [],
        ownedDiffDigest: null,
        overlapPaths: [],
        unownedPaths: [],
        failureCode: "verification_receipt_invalid",
      });
    }

    const liveSnapshot = this.changeGuard.captureCurrent(workspace);
    if (liveSnapshot instanceof WorkspaceGuardError) {
      return finalize(contract, execution, {
        checkReceipts: execution.check_receipts,
        artifactDigests: [],
        ownedDiffDigest: null,
        overlapPaths: [],
        unownedPaths: [],
        failureCode: "workspace_inspection_failed",
      });
    }
    if (liveSnapshot.snapshot_digest !== execution.workspace_snapshot.snapshot_digest) {
      return finalize(contract, execution, {
        checkReceipts: execution.check_receipts,
        artifactDigests: [],
        ownedDiffDigest: null,
        overlapPaths: [],
        unownedPaths: [],
        failureCode: "verification_receipt_invalid",
      });
    }

    const artifactExpectations = new Map(
      contract.expected_artifacts.map((artifact) => [artifact.path, artifact]),
    );
    for (const check of contract.checks) {
      for (const artifactPath of check.expected_artifacts) {
        if (!artifactExpectations.has(artifactPath)) {
          artifactExpectations.set(artifactPath, { path: artifactPath, kind: "check_artifact" });
        }
      }
    }
    const artifactDigests: ArtifactDigest[] = [];
    let artifactFailure: SliceFailureCode | undefined;
    for (const [artifactPath, expectation] of [...artifactExpectations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const resolved = resolveWorkspaceArtifact(workspace, artifactPath);
      if (resolved instanceof SliceExecutionError) {
        artifactFailure ??= resolved.code;
        continue;
      }
      const actualDigest = sha256Bytes(readFileSync(resolved));
      artifactDigests.push({ path: artifactPath, digest: actualDigest });
      if (expectation.digest !== undefined && expectation.digest !== actualDigest) {
        artifactFailure ??= "artifact_digest_mismatch";
      }
    }

    const changeSet = this.changeGuard.classify(
      execution.protected_baseline,
      liveSnapshot,
      contract.owned_paths,
    );
    if (changeSet instanceof WorkspaceGuardError) {
      return finalize(contract, execution, {
        checkReceipts: execution.check_receipts,
        artifactDigests,
        ownedDiffDigest: null,
        overlapPaths: [],
        unownedPaths: [],
        failureCode: "workspace_inspection_failed",
      });
    }
    const ownedPatch = this.changeGuard.assertCommittable(changeSet);
    let ownershipFailure: SliceFailureCode | undefined;
    let ownedDiffDigest: `sha256:${string}` | null = null;
    if (ownedPatch instanceof WorkspaceGuardError) {
      ownershipFailure = changeSet.unowned_paths.length > 0
        ? "unowned_change_detected"
        : "protected_change_overlap";
    } else {
      ownedDiffDigest = ownedPatch.patch_digest;
    }

    return finalize(contract, execution, {
      checkReceipts: execution.check_receipts,
      artifactDigests,
      ownedDiffDigest,
      overlapPaths: changeSet.overlap_paths,
      unownedPaths: changeSet.unowned_paths,
      failureCode: checkFailure(execution.check_receipts) ?? artifactFailure ?? ownershipFailure,
    });
  }
}
