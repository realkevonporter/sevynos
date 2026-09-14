import type { GenesisWindowId } from "./genesis-window.js";

export type WindowZOrderOperation =
  "bring-to-front" | "send-to-back" | "raise-above" | "lower-below" | "normalize";

export interface WindowZOrderChangedEvent {
  readonly type: "window-z-order-changed";

  readonly operation: WindowZOrderOperation;

  readonly windowId: GenesisWindowId | null;

  readonly relativeWindowId: GenesisWindowId | null;

  readonly orderedWindowIds: readonly GenesisWindowId[];
}

export type WindowZOrderManagerEvent = WindowZOrderChangedEvent;

export type WindowZOrderManagerEventListener = (event: WindowZOrderManagerEvent) => void;
