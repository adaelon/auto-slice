import type {
  CompressionHandoffFailureCode,
  CompressionHandoffFailureReason,
} from "./types.js";

export class CompressionHandoffError extends Error {
  public readonly reason: CompressionHandoffFailureReason | undefined;
  public readonly diagnostic_code: string | undefined;
  public readonly retained_work_dir: string | undefined;

  public constructor(
    public readonly code: CompressionHandoffFailureCode,
    message: string,
    options?: {
      readonly reason?: CompressionHandoffFailureReason;
      readonly diagnostic_code?: string;
      readonly retained_work_dir?: string;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "CompressionHandoffError";
    this.reason = options?.reason;
    this.diagnostic_code = options?.diagnostic_code;
    this.retained_work_dir = options?.retained_work_dir;
  }

  public toJSON(): {
    readonly code: CompressionHandoffFailureCode;
    readonly message: string;
    readonly reason?: CompressionHandoffFailureReason;
    readonly diagnostic_code?: string;
    readonly retained_work_dir?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.diagnostic_code === undefined
        ? {}
        : { diagnostic_code: this.diagnostic_code }),
      ...(this.retained_work_dir === undefined
        ? {}
        : { retained_work_dir: this.retained_work_dir }),
    };
  }
}
