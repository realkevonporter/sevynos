import { RuntimeError } from "./runtime-error.js";

export class ApplicationHostNotFoundError extends RuntimeError {
  public readonly code = "APPLICATION_HOST_NOT_FOUND" as const;

  public constructor(hostId: string) {
    super(`Application host "${hostId}" is not registered.`);
  }
}
