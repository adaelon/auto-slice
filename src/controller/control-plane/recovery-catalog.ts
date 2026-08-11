import type { RecoveryResolution } from "./types.js";

export const NEEDS_USER_ERROR_CODES = [
  "model_policy_unavailable",
  "project_lock_unavailable",
  "compaction_observability_unavailable",
  "compaction_probe_failed",
  "source_interrupt_failed",
  "handoff_export_failed",
  "handoff_integrity_failed",
  "continuation_start_failed",
  "protected_change_overlap",
  "verification_failed",
  "checkpoint_refresh_failed",
  "state_persist_failed",
  "state_corrupt",
  "unsupported_state_schema",
] as const;

export type NeedsUserErrorCode = (typeof NEEDS_USER_ERROR_CODES)[number];

const ABORT_ONLY = Object.freeze(["abort_run"] as const satisfies readonly RecoveryResolution[]);

export const RECOVERY_CATALOG: Readonly<Record<NeedsUserErrorCode, readonly RecoveryResolution[]>> = Object.freeze({
  model_policy_unavailable: ["supply_model_policy", "abort_run"],
  project_lock_unavailable: ["release_stale_project_lock", "abort_run"],
  compaction_observability_unavailable: ABORT_ONLY,
  compaction_probe_failed: ABORT_ONLY,
  source_interrupt_failed: ABORT_ONLY,
  handoff_export_failed: ABORT_ONLY,
  handoff_integrity_failed: ABORT_ONLY,
  continuation_start_failed: ["retry_continuation_start", "abort_run"],
  protected_change_overlap: ["resolve_protected_changes", "abort_run"],
  verification_failed: ABORT_ONLY,
  checkpoint_refresh_failed: ABORT_ONLY,
  state_persist_failed: ABORT_ONLY,
  state_corrupt: ABORT_ONLY,
  unsupported_state_schema: ABORT_ONLY,
});

export function recoveryOptionsFor(errorCode: string): readonly RecoveryResolution[] {
  return Object.prototype.hasOwnProperty.call(RECOVERY_CATALOG, errorCode)
    ? RECOVERY_CATALOG[errorCode as NeedsUserErrorCode]
    : ABORT_ONLY;
}
