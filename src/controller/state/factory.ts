import {
  RUN_STATE_SCHEMA_VERSION,
  type InitialRunStateInput,
  type RunState,
} from "./types.js";

export function createInitialRunState(input: InitialRunStateInput): RunState {
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    run_id: input.run_id,
    state_version: 0,
    workspace_identity: input.workspace_identity,
    plan_digest: input.plan_digest,
    status: "IDLE",
    commit_mode: input.commit_mode,
    current_slice_id: input.current_slice_id ?? null,
    protected_baseline_digest: input.protected_baseline_digest,
    project_lock_owner: null,
    write_epoch: 0,
    source_thread_id: null,
  };
}
