import { RuntimeError } from "./runtime-error.js";

export class DuplicateApplicationError extends RuntimeError {
  public readonly code = "DUPLICATE_APPLICATION" as const;

  public constructor(applicationId: string) {
    super(`Application "${applicationId}" is already registered.`);
  }
}
