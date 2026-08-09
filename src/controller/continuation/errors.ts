import type {
  ContinuationFailureCode,
  ContinuationFailureReason,
} from "./types.js";

export class ContinuationError extends Error {
  public readonly reason: ContinuationFailureReason | undefined;
  public readonly diagnostic_code: string | undefined;

  public constructor(
    public readonly code: ContinuationFailureCode,
    message: string,
    options?: {
      readonly reason?: ContinuationFailureReason;
      readonly diagnostic_code?: string;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ContinuationError";
    this.reason = options?.reason;
    this.diagnostic_code = options?.diagnostic_code;
  }

  public toJSON(): {
    readonly code: ContinuationFailureCode;
    readonly message: string;
    readonly reason?: ContinuationFailureReason;
    readonly diagnostic_code?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.diagnostic_code === undefined
        ? {}
        : { diagnostic_code: this.diagnostic_code }),
    };
  }
}
