import { RuntimeError } from "./runtime-error.js";

export class CapabilityDeniedError extends RuntimeError {
  public override readonly code = "CAPABILITY_DENIED";

  public constructor(
    public readonly applicationId: string,
    public readonly capability: string,
    message?: string,
  ) {
    super(
      message ?? `Application '${applicationId}' was denied capability '${capability}'.`,
    );
  }
}
