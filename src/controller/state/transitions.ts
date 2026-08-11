import {
  RUN_STATUSES,
  type RunStatus,
  type RunTransitionMatrixEntry,
} from "./types.js";

const OPERATIONAL_STATUSES = [
  "PREPARING",
  "SLICE_RUNNING",
  "COMPACTION_WAIT",
  "SOURCE_INTERRUPTING",
  "HANDOFF_EXPORTING",
  "CONTINUATION_STARTING",
] as const satisfies readonly RunStatus[];

const LEGACY_ACCEPTANCE_STATUSES = new Set<RunStatus>([
  "VERIFYING",
  "COMMITTING",
  "CHECKPOINTING",
]);

const FORWARD_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  IDLE: ["PREPARING"],
  PREPARING: ["SLICE_RUNNING"],
  SLICE_RUNNING: ["PREPARING", "DONE", "COMPACTION_WAIT"],
  VERIFYING: [],
  COMMITTING: [],
  CHECKPOINTING: [],
  COMPACTION_WAIT: ["SLICE_RUNNING", "SOURCE_INTERRUPTING"],
  SOURCE_INTERRUPTING: ["HANDOFF_EXPORTING"],
  HANDOFF_EXPORTING: ["CONTINUATION_STARTING"],
  CONTINUATION_STARTING: ["SLICE_RUNNING"],
  PAUSED: OPERATIONAL_STATUSES,
  NEEDS_USER: OPERATIONAL_STATUSES,
  DONE: [],
  ABORTED: [],
};

const TERMINAL_STATUSES = new Set<RunStatus>(["DONE", "ABORTED"]);

const LEGACY_REPLAY_TRANSITIONS: Readonly<Partial<Record<RunStatus, readonly RunStatus[]>>> = {
  SLICE_RUNNING: ["VERIFYING"],
  VERIFYING: ["COMMITTING", "CHECKPOINTING", "PAUSED", "NEEDS_USER"],
  COMMITTING: ["CHECKPOINTING", "PAUSED", "NEEDS_USER"],
  CHECKPOINTING: ["SLICE_RUNNING", "DONE", "PAUSED", "NEEDS_USER"],
  PAUSED: ["VERIFYING", "COMMITTING", "CHECKPOINTING"],
  NEEDS_USER: ["VERIFYING", "COMMITTING", "CHECKPOINTING"],
};

export function isLegacyAcceptanceStatus(status: RunStatus): boolean {
  return LEGACY_ACCEPTANCE_STATUSES.has(status);
}

export function isRunTransitionAllowed(
  from: RunStatus,
  to: RunStatus,
  action?: string,
): boolean {
  if (from === to) {
    return (from === "HANDOFF_EXPORTING" && action === "mark_handoff_attempted") ||
      (!TERMINAL_STATUSES.has(from) &&
        !isLegacyAcceptanceStatus(from) &&
        action === "override_slice_commit_mode");
  }
  if (TERMINAL_STATUSES.has(from)) {
    return false;
  }
  if (isLegacyAcceptanceStatus(from)) {
    return to === "ABORTED";
  }
  if (FORWARD_TRANSITIONS[from].includes(to)) {
    return true;
  }
  if (to === "ABORTED") {
    return true;
  }
  if (to === "NEEDS_USER") {
    return from !== "NEEDS_USER";
  }
  if (to === "PAUSED") {
    return from !== "PAUSED" && from !== "NEEDS_USER";
  }
  return false;
}

export function isRunTransitionReplayCompatible(
  from: RunStatus,
  to: RunStatus,
  action?: string,
): boolean {
  if (isRunTransitionAllowed(from, to, action)) {
    return true;
  }
  return LEGACY_REPLAY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function buildRunTransitionMatrix(): readonly RunTransitionMatrixEntry[] {
  return RUN_STATUSES.flatMap((from) =>
    RUN_STATUSES.map((to) => ({
      from,
      to,
      allowed: isRunTransitionAllowed(from, to),
    })),
  );
}
