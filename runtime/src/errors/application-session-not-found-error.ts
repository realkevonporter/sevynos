import { RuntimeError } from "./runtime-error.js";

export class ApplicationSessionNotFoundError extends RuntimeError {
  public readonly code = "APPLICATION_SESSION_NOT_FOUND" as const;

  public constructor(sessionId: string) {
    super(`Application session "${sessionId}" is not registered.`);
  }
}
