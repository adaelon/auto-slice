import type {
  SourceInterruptionFailureCode,
  SourceInterruptionFailureReason,
} from "./types.js";

export class SourceInterruptionError extends Error {
  public readonly reason: SourceInterruptionFailureReason | undefined;

  public constructor(
    public readonly code: SourceInterruptionFailureCode,
    message: string,
    options?: {
      readonly reason?: SourceInterruptionFailureReason;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SourceInterruptionError";
    this.reason = options?.reason;
  }

  public toJSON(): {
    readonly code: SourceInterruptionFailureCode;
    readonly message: string;
    readonly reason?: SourceInterruptionFailureReason;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }
}
