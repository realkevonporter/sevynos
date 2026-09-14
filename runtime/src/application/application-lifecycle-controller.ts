import type { ApplicationSession, ApplicationSessionId } from "./application-session.js";

/** Runtime-facing lifecycle contract used by coordinating subsystems. */
export interface ApplicationLifecycleController {
  foregroundApplication(sessionId: ApplicationSessionId): ApplicationSession;

  backgroundApplication(sessionId: ApplicationSessionId): ApplicationSession;
}
