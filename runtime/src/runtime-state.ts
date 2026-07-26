export type RuntimeState =
  "created" | "starting" | "running" | "stopping" | "stopped" | "failed";

const transitions: Readonly<Record<RuntimeState, ReadonlySet<RuntimeState>>> = {
  created: new Set(["starting"]),
  starting: new Set(["running", "failed"]),
  running: new Set(["stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  stopped: new Set(),
  failed: new Set(),
};

export class InvalidRuntimeTransitionError extends Error {
  public constructor(
    public readonly currentState: RuntimeState,
    public readonly requestedState: RuntimeState,
  ) {
    super(`Invalid Runtime transition: ${currentState} -> ${requestedState}`);

    this.name = "InvalidRuntimeTransitionError";
  }
}

export function canTransitionRuntime(
  currentState: RuntimeState,
  requestedState: RuntimeState,
): boolean {
  return transitions[currentState].has(requestedState);
}

export function assertRuntimeTransition(
  currentState: RuntimeState,
  requestedState: RuntimeState,
): void {
  if (!canTransitionRuntime(currentState, requestedState)) {
    throw new InvalidRuntimeTransitionError(currentState, requestedState);
  }
}
