import { RuntimeError } from "./runtime-error.js";

export class DuplicateApplicationError extends RuntimeError {
  public readonly code = "APPLICATION_ALREADY_REGISTERED";

  public constructor(applicationId: string) {
    super(`Application "${applicationId}" is already registered.`);
  }
}
