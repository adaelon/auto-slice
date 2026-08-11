import {
  isLegacyAcceptanceStatus,
  RUN_STATUSES,
  type RunStatus,
} from "../state/index.js";
import type { ControlCommand } from "./types.js";

const TERMINAL = new Set<RunStatus>(["DONE", "ABORTED"]);

export interface ControlMatrixEntry {
  readonly command: Exclude<ControlCommand, "start">;
  readonly status: RunStatus;
  readonly allowed: boolean;
}

export function commandAllowedFromStatus(
  command: Exclude<ControlCommand, "start">,
  status: RunStatus,
): boolean {
  switch (command) {
    case "status":
      return true;
    case "pause":
      return !TERMINAL.has(status) &&
        !isLegacyAcceptanceStatus(status) &&
        status !== "PAUSED" &&
        status !== "NEEDS_USER";
    case "resume":
      return status === "PAUSED" || status === "NEEDS_USER";
    case "abort":
      return !TERMINAL.has(status);
    case "override":
      return !TERMINAL.has(status) && !isLegacyAcceptanceStatus(status);
  }
}

export function buildControlMatrix(): readonly ControlMatrixEntry[] {
  const commands = ["status", "pause", "resume", "abort", "override"] as const;
  return commands.flatMap((command) =>
    RUN_STATUSES.map((status) => ({
      command,
      status,
      allowed: commandAllowedFromStatus(command, status),
    })),
  );
}
