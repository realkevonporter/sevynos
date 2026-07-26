import type { ApplicationSessionState } from "../application/application-session-state.js";
import { RuntimeError } from "./runtime-error.js";

export class InvalidApplicationSessionStateError extends RuntimeError {
  public readonly code = "INVALID_APPLICATION_SESSION_STATE" as const;

  public constructor(sessionId: string, state: ApplicationSessionState) {
    super(`Application session "${sessionId}" cannot be stopped from state "${state}".`);
  }
}
