import type { CommitCoordinatorFailureCode } from "./types.js";

export interface CommitFailureContext {
  readonly commit_created: boolean;
  readonly start_head: string | null;
  readonly actual_head: string | null;
  readonly checkpoint_path: "SESSION_CHECKPOINT.md";
}

export class CommitCoordinatorError extends Error {
  public constructor(
    public readonly code: CommitCoordinatorFailureCode,
    message: string,
    public readonly context: CommitFailureContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommitCoordinatorError";
  }

  public toJSON(): {
    readonly code: CommitCoordinatorFailureCode;
    readonly message: string;
    readonly context: CommitFailureContext;
  } {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
    };
  }
}

export class CheckpointWriteError extends Error {
  public constructor(
    public readonly code: "checkpoint_invalid" | "checkpoint_refresh_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CheckpointWriteError";
  }
}
