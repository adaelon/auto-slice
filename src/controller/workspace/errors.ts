import type { WorkspaceGuardFailureCode } from "./types.js";

export class WorkspaceGuardError extends Error {
  public constructor(
    public readonly code: WorkspaceGuardFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceGuardError";
  }

  public toJSON(): {
    readonly code: WorkspaceGuardFailureCode;
    readonly message: string;
  } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}
