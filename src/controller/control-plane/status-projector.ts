import type { RunState } from "../state/index.js";
import { recoveryOptionsFor } from "./recovery-catalog.js";
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  type ProjectedRunError,
  type RunSnapshot,
} from "./types.js";

const EVIDENCE_PATH_KEYS = new Set([
  "checkpoint_path",
  "diagnostic_path",
  "evidence_index_path",
  "evidence_path",
  "handoff_markdown_path",
  "retained_work_dir",
]);

function projectError(run: RunState): ProjectedRunError | undefined {
  if (run.last_error === undefined) {
    return undefined;
  }
  const evidencePaths = Object.entries(run.last_error.details ?? {})
    .filter(([key]) => EVIDENCE_PATH_KEYS.has(key))
    .map(([, value]) => value)
    .sort();
  return {
    code: run.last_error.code,
    occurred_at: run.last_error.occurred_at,
    last_successful_status: run.last_error.last_successful_status,
    evidence_paths: evidencePaths,
    recovery_options: recoveryOptionsFor(run.last_error.code),
  };
}

export function projectRunSnapshot(run: RunState): RunSnapshot {
  const overrides = run.slice_commit_mode_overrides ?? {};
  const currentOverride = run.current_slice_id === null
    ? undefined
    : overrides[run.current_slice_id];
  const error = projectError(run);
  const snapshot = {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    run_id: run.run_id,
    state_version: run.state_version,
    status: run.status,
    current_slice_id: run.current_slice_id,
    commit_mode: run.commit_mode,
    effective_commit_mode: currentOverride ?? run.commit_mode,
    slice_commit_mode_overrides: overrides,
    write_epoch: run.write_epoch,
    task_ids: {
      source_thread_id: run.source_thread_id,
      compression_task_id: run.handoff?.compression_task_id ?? null,
      continuation_task_id: run.handoff?.continuation_task_id ?? null,
    },
    last_successful_status: run.last_error?.last_successful_status ?? run.status,
    ...(error === undefined ? {} : { error }),
  } satisfies RunSnapshot;
  return snapshot;
}
