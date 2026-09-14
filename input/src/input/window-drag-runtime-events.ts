import type { GenesisWindowId } from "@sevynos/graphics";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { ActiveWindowDrag } from "./window-drag-state.js";
import type { WindowHitTestResult } from "./window-hit-test-result.js";

export interface WindowDragRuntimeConnectedEvent {
  readonly type: "window-drag-runtime-connected";
}

export interface WindowDragRuntimeDisconnectedEvent {
  readonly type: "window-drag-runtime-disconnected";
}

export interface WindowDragRuntimeHitEvent {
  readonly type: "window-drag-runtime-hit";

  readonly event: PointerInputEvent;

  readonly hit: WindowHitTestResult;
}

export interface WindowDragRuntimeIgnoredEvent {
  readonly type: "window-drag-runtime-ignored";

  readonly event: PointerInputEvent;

  readonly windowId: GenesisWindowId | null;

  readonly reason: "no-window-hit" | "non-draggable-region" | "drag-already-active";
}

export interface WindowDragRuntimeStartedEvent {
  readonly type: "window-drag-runtime-started";

  readonly event: PointerInputEvent;

  readonly drag: ActiveWindowDrag;
}

export interface WindowDragRuntimeEventForwardedEvent {
  readonly type: "window-drag-runtime-event-forwarded";

  readonly event: PointerInputEvent;

  readonly drag: ActiveWindowDrag;
}

export interface WindowDragRuntimeFailedEvent {
  readonly type: "window-drag-runtime-failed";

  readonly event: PointerInputEvent;

  readonly error: Error;
}

export type WindowDragRuntimeEvent =
  | WindowDragRuntimeConnectedEvent
  | WindowDragRuntimeDisconnectedEvent
  | WindowDragRuntimeHitEvent
  | WindowDragRuntimeIgnoredEvent
  | WindowDragRuntimeStartedEvent
  | WindowDragRuntimeEventForwardedEvent
  | WindowDragRuntimeFailedEvent;

export type WindowDragRuntimeEventListener = (event: WindowDragRuntimeEvent) => void;
