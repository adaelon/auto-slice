import {
  RUN_STATUSES,
  type RunStatus,
  type RunTransitionMatrixEntry,
} from "./types.js";

const OPERATIONAL_STATUSES = [
  "PREPARING",
  "SLICE_RUNNING",
  "VERIFYING",
  "COMMITTING",
  "CHECKPOINTING",
  "COMPACTION_WAIT",
  "SOURCE_INTERRUPTING",
  "HANDOFF_EXPORTING",
  "CONTINUATION_STARTING",
] as const satisfies readonly RunStatus[];

const FORWARD_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  IDLE: ["PREPARING"],
  PREPARING: ["SLICE_RUNNING"],
  SLICE_RUNNING: ["VERIFYING", "COMPACTION_WAIT"],
  VERIFYING: ["COMMITTING", "CHECKPOINTING"],
  COMMITTING: ["CHECKPOINTING"],
  CHECKPOINTING: ["SLICE_RUNNING", "DONE"],
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

export function isRunTransitionAllowed(from: RunStatus, to: RunStatus): boolean {
  if (from === to || TERMINAL_STATUSES.has(from)) {
    return false;
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

export function buildRunTransitionMatrix(): readonly RunTransitionMatrixEntry[] {
  return RUN_STATUSES.flatMap((from) =>
    RUN_STATUSES.map((to) => ({
      from,
      to,
      allowed: isRunTransitionAllowed(from, to),
    })),
  );
}
