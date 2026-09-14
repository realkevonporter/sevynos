import type { ApplicationSessionId } from "../application-session-id.js";

export interface ApplicationLifecycleController {
  foregroundApplication(sessionId: ApplicationSessionId): void;

  backgroundApplication(sessionId: ApplicationSessionId): void;
}
