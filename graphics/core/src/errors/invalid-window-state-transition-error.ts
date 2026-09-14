import type { GenesisWindowId } from "../window/genesis-window.js";
import type { WindowState } from "../window/window-state.js";

export class InvalidWindowStateTransitionError extends Error {
  public readonly code = "INVALID_WINDOW_STATE_TRANSITION";

  public constructor(
    windowId: GenesisWindowId,
    currentState: WindowState,
    targetState: WindowState,
  ) {
    super(
      `Window "${windowId}" cannot transition from "${currentState}" to "${targetState}".`,
    );

    this.name = "InvalidWindowStateTransitionError";
  }
}
