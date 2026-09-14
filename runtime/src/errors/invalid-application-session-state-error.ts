import type { ApplicationSessionId } from "../application/application-session.js";
import type { ApplicationSessionState } from "../application/application-session-state.js";

export class InvalidApplicationSessionStateError extends Error {
  public readonly code = "INVALID_APPLICATION_SESSION_STATE";

  public constructor(
    sessionId: ApplicationSessionId,
    state: ApplicationSessionState,
    operation: string,
  ) {
    super(
      `Application session "${sessionId}" cannot ${operation} from state "${state}".`,
    );

    this.name = "InvalidApplicationSessionStateError";
  }
}
