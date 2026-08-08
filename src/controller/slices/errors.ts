import type { SliceFailureCode } from "./types.js";

export class SliceExecutionError extends Error {
  public constructor(
    public readonly code: SliceFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SliceExecutionError";
  }

  public toJSON(): {
    readonly code: SliceFailureCode;
    readonly message: string;
  } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}
