export type ApplicationSessionState =
  | "created"
  | "starting"
  | "foreground"
  | "background"
  | "suspended"
  | "stopping"
  | "stopped"
  | "failed";

const VALID_APPLICATION_SESSION_TRANSITIONS: Readonly<
  Record<ApplicationSessionState, readonly ApplicationSessionState[]>
> = {
  created: ["starting", "failed"],

  starting: ["foreground", "stopping", "failed"],

  foreground: ["background", "stopping", "failed"],

  background: ["foreground", "suspended", "stopping", "failed"],

  suspended: ["foreground", "background", "stopping", "failed"],

  stopping: ["stopped", "failed"],

  stopped: [],

  failed: [],
};

export function canTransitionApplicationSession(
  currentState: ApplicationSessionState,
  requestedState: ApplicationSessionState,
): boolean {
  if (currentState === requestedState) {
    return false;
  }

  return VALID_APPLICATION_SESSION_TRANSITIONS[currentState].includes(requestedState);
}

export function assertApplicationSessionTransition(
  currentState: ApplicationSessionState,
  requestedState: ApplicationSessionState,
): void {
  if (!canTransitionApplicationSession(currentState, requestedState)) {
    throw new Error(
      `Invalid application session transition: ` +
        `"${currentState}" → "${requestedState}".`,
    );
  }
}
