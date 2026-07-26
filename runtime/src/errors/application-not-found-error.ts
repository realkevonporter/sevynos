import { RuntimeError } from "./runtime-error.js";

export class ApplicationNotFoundError extends RuntimeError {
  public readonly code = "APPLICATION_NOT_FOUND" as const;

  public constructor(applicationId: string) {
    super(`Application "${applicationId}" is not registered.`);
  }
}
