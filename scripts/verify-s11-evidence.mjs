#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildControlMatrix,
  CONTROL_COMMAND_DTO_SCHEMA,
  NEEDS_USER_ERROR_CODES,
  RECOVERY_CATALOG,
  projectRunSnapshot,
} from "../dist/src/controller/control-plane/index.js";
import { sha256Bytes } from "../dist/src/controller/state/index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readSource(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function buildMatrixEvidence() {
  const entries = buildControlMatrix();
  invariant(entries.length === 70, "Control matrix must cover five existing-Run commands across 14 statuses.");
  invariant(
    new Set(entries.map((entry) => `${entry.command}:${entry.status}`)).size === entries.length,
    "Control matrix contains duplicate cells.",
  );
  return {
    schema_version: 1,
    result: "PASS",
    start_precondition: "no_active_run_for_workspace",
    entries,
  };
}

function buildRecoveryEvidence() {
  const entries = NEEDS_USER_ERROR_CODES.map((errorCode) => ({
    error_code: errorCode,
    resolutions: RECOVERY_CATALOG[errorCode],
    classification: RECOVERY_CATALOG[errorCode].length === 1 ? "ABORT_ONLY" : "RECOVERABLE",
  }));
  invariant(entries.every((entry) => entry.resolutions.includes("abort_run")), "Every NEEDS_USER error needs abort closure.");
  invariant(entries.every((entry) => entry.resolutions.length > 0), "Every NEEDS_USER error needs a resolution classification.");
  return {
    schema_version: 1,
    result: "PASS",
    entries,
    unknown_error_policy: ["abort_run"],
  };
}

function buildInvariantReport() {
  const executablePaths = [
    "src/controller/control-plane/control-plane.ts",
    "src/controller/control-plane/runtime.ts",
    "src/controller/main.ts",
  ];
  const executable = executablePaths.map(readSource).join("\n");
  const secret = "raw-secret-provider-output";
  const projected = projectRunSnapshot({
    schema_version: 1,
    run_id: "evidence-run",
    state_version: 7,
    workspace_identity: {
      canonical_root: "E:\\evidence-workspace",
      filesystem_identity: "evidence:workspace",
    },
    plan_digest: sha256Bytes("plan"),
    status: "NEEDS_USER",
    commit_mode: "after_slice",
    current_slice_id: "S11",
    protected_baseline_digest: sha256Bytes("baseline"),
    project_lock_owner: "lease-evidence",
    write_epoch: 3,
    source_thread_id: "source-task-id",
    handoff: {
      compression_task_id: "compression-task-id",
      continuation_task_id: "continuation-task-id",
      markdown_path: "handoff.md",
      evidence_index_path: "handoff.evidence.json",
      artifact_digest: sha256Bytes("handoff"),
    },
    last_error: {
      code: "continuation_start_failed",
      message: secret,
      occurred_at: "2026-08-09T10:00:00.000Z",
      last_successful_status: "CONTINUATION_STARTING",
      details: {
        evidence_path: "artifacts/continuation-diagnostic.json",
        raw_output: secret,
      },
    },
  });
  const serializedProjection = JSON.stringify(projected);
  const report = {
    schema_version: 1,
    result: "PASS",
    executable_paths: executablePaths,
    no_push_path: !/\bpush\b/iu.test(executable),
    no_model_fallback_path: !/model-policy|gpt-|fallback_model|fallbackModel/iu.test(executable),
    status_omits_raw_error_message: !serializedProjection.includes(secret),
    status_includes_task_ids: Object.values(projected.task_ids).every((value) => typeof value === "string"),
    status_includes_evidence_path: projected.error?.evidence_paths.includes("artifacts/continuation-diagnostic.json") === true,
    deterministic_test_anchors: [
      "test/control-plane.test.ts",
      "test/controller.test.ts",
      "test/run-store.test.ts",
    ],
  };
  invariant(Object.entries(report).filter(([, value]) => typeof value === "boolean").every(([, value]) => value), "A control invariant failed.");
  return report;
}

const commands = CONTROL_COMMAND_DTO_SCHEMA.properties.command.enum;
invariant(commands.length === 6 && new Set(commands).size === 6, "DTO schema must expose six unique commands.");

process.stdout.write(`${JSON.stringify({
  control_matrix: buildMatrixEvidence(),
  command_dto_schema: CONTROL_COMMAND_DTO_SCHEMA,
  recovery_catalog: buildRecoveryEvidence(),
  invariant_report: buildInvariantReport(),
}, null, 2)}\n`);
