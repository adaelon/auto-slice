import type { ContractLoadFailureReason } from "./types.js";

export class ContractLoadError extends Error {
  public readonly code = "contract_load_failed" as const;

  public constructor(
    public readonly reason: ContractLoadFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContractLoadError";
  }

  public toJSON(): {
    readonly code: "contract_load_failed";
    readonly reason: ContractLoadFailureReason;
    readonly message: string;
  } {
    return {
      code: this.code,
      reason: this.reason,
      message: this.message,
    };
  }
}
