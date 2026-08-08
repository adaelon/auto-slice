import type { StateStoreFailureCode } from "./types.js";

export class StateStoreError extends Error {
  public constructor(
    public readonly code: StateStoreFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StateStoreError";
  }

  public toJSON(): {
    readonly code: StateStoreFailureCode;
    readonly message: string;
  } {
    return {
      code: this.code,
      message: this.message,
    };
  }
}
