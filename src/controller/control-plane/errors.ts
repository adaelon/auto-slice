import type { ControlPlaneFailureCode } from "./types.js";

export class ControlPlaneError extends Error {
  public constructor(
    public readonly code: ControlPlaneFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlPlaneError";
  }

  public toJSON(): { readonly code: ControlPlaneFailureCode } {
    return { code: this.code };
  }
}
