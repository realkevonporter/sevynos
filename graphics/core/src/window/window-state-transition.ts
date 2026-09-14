import type { WindowState } from "./window-state.js";

const WINDOW_STATE_TRANSITIONS: Readonly<Record<WindowState, ReadonlySet<WindowState>>> =
  {
    created: new Set(["visible", "hidden", "closing"]),

    visible: new Set(["focused", "hidden", "minimized", "closing"]),

    focused: new Set(["visible", "hidden", "minimized", "closing"]),

    hidden: new Set(["visible", "focused", "minimized", "closing"]),

    minimized: new Set(["visible", "focused", "closing"]),

    closing: new Set(["closed"]),

    closed: new Set(),
  };

export function canTransitionWindowState(
  currentState: WindowState,
  targetState: WindowState,
): boolean {
  return WINDOW_STATE_TRANSITIONS[currentState].has(targetState);
}
