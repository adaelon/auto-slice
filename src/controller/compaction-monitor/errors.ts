import type {
  CompactionMonitorFailureCode,
  CompactionMonitorFailureReason,
} from "./types.js";

export class CompactionMonitorError extends Error {
  public readonly reason: CompactionMonitorFailureReason | undefined;

  public constructor(
    public readonly code: CompactionMonitorFailureCode,
    message: string,
    options: {
      readonly reason?: CompactionMonitorFailureReason;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CompactionMonitorError";
    this.reason = options.reason;
  }

  public toJSON(): {
    readonly code: CompactionMonitorFailureCode;
    readonly message: string;
    readonly reason?: CompactionMonitorFailureReason;
  } {
    return this.reason === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, reason: this.reason };
  }
}
