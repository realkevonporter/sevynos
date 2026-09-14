import type { CursorState } from "./cursor-state.js";

export interface CursorStateChangedEvent {
  readonly type: "cursor-state-changed";

  readonly previousState: CursorState;

  readonly state: CursorState;
}

export type CursorManagerEvent = CursorStateChangedEvent;

export type CursorManagerEventListener = (event: CursorManagerEvent) => void;
