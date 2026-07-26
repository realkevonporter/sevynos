export type ApplicationSessionState =
  "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

const VALID_APPLICATION_SESSION_TRANSITIONS: Readonly<
  Record<ApplicationSessionState, readonly ApplicationSessionState[]>
> = {
  created: ["starting", "failed"],
  starting: ["running", "failed"],
  running: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: [],
  failed: [],
};

export function canTransitionApplicationSession(
  currentState: ApplicationSessionState,
  requestedState: ApplicationSessionState,
): boolean {
  return VALID_APPLICATION_SESSION_TRANSITIONS[currentState].includes(requestedState);
}

export function assertApplicationSessionTransition(
  currentState: ApplicationSessionState,
  requestedState: ApplicationSessionState,
): void {
  if (!canTransitionApplicationSession(currentState, requestedState)) {
    throw new Error(
      `Invalid application session transition: "${currentState}" → "${requestedState}".`,
    );
  }
}
