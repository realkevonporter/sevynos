import { RuntimeError } from "./runtime-error.js";

export class InvalidSignatureError extends RuntimeError {
  public readonly code = "INVALID_SIGNATURE" as const;

  public constructor(applicationId: string, details?: string) {
    super(
      details ??
        `Application "${applicationId}" has an invalid or missing signature. Protected system applications must be signed with an official SevynOS release key.`,
    );
  }
}
