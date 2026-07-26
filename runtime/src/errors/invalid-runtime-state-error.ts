import type { RuntimeState } from "../runtime-state.js";
import { RuntimeError } from "./runtime-error.js";

export class InvalidRuntimeStateError extends RuntimeError {
  public readonly code = "INVALID_RUNTIME_STATE" as const;

  public constructor(
    operation: string,
    currentState: RuntimeState,
    allowedStates: readonly RuntimeState[],
  ) {
    super(
      `Cannot ${operation} while runtime is in state ` +
        `"${currentState}". Allowed states: ${allowedStates.join(", ")}.`,
    );
  }
}
