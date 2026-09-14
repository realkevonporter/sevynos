import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { ActiveWindowDrag } from "./window-drag-state.js";

export type WindowDragEndReason = "pointer-up" | "pointer-cancel" | "explicit";

export interface WindowDragStartedEvent {
  readonly type: "window-drag-started";

  readonly drag: ActiveWindowDrag;

  readonly event: PointerInputEvent;
}

export interface WindowDragMovedEvent {
  readonly type: "window-drag-moved";

  readonly drag: ActiveWindowDrag;

  readonly event: PointerInputEvent;

  readonly window: GenesisWindow;

  readonly deltaX: number;

  readonly deltaY: number;
}

export interface WindowDragEndedEvent {
  readonly type: "window-drag-ended";

  readonly drag: ActiveWindowDrag;

  readonly event: PointerInputEvent | undefined;

  readonly reason: WindowDragEndReason;
}

export interface WindowDragRejectedEvent {
  readonly type: "window-drag-rejected";

  readonly pointerId: number;

  readonly windowId: GenesisWindowId;

  readonly event: PointerInputEvent;

  readonly error: Error;
}

export type WindowDragControllerEvent =
  | WindowDragStartedEvent
  | WindowDragMovedEvent
  | WindowDragEndedEvent
  | WindowDragRejectedEvent;

export type WindowDragControllerEventListener = (
  event: WindowDragControllerEvent,
) => void;
