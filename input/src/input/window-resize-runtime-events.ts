import type { GenesisWindowId } from "@sevynos/graphics";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { WindowResizeEdge } from "./window-resize-edge.js";
import type { ActiveWindowResize } from "./window-resize-state.js";
import type { WindowHitTestResult } from "./window-hit-test-result.js";

export interface WindowResizeRuntimeConnectedEvent {
  readonly type: "window-resize-runtime-connected";
}

export interface WindowResizeRuntimeDisconnectedEvent {
  readonly type: "window-resize-runtime-disconnected";
}

export interface WindowResizeRuntimeHitEvent {
  readonly type: "window-resize-runtime-hit";

  readonly event: PointerInputEvent;

  readonly hit: WindowHitTestResult;

  readonly edge: WindowResizeEdge;
}

export interface WindowResizeRuntimeIgnoredEvent {
  readonly type: "window-resize-runtime-ignored";

  readonly event: PointerInputEvent;

  readonly windowId: GenesisWindowId | null;

  readonly reason: "no-window-hit" | "not-resize-border";
}

export interface WindowResizeRuntimeStartedEvent {
  readonly type: "window-resize-runtime-started";

  readonly event: PointerInputEvent;

  readonly resize: ActiveWindowResize;
}

export interface WindowResizeRuntimeEventForwardedEvent {
  readonly type: "window-resize-runtime-event-forwarded";

  readonly event: PointerInputEvent;

  readonly resize: ActiveWindowResize;
}

export interface WindowResizeRuntimeFailedEvent {
  readonly type: "window-resize-runtime-failed";

  readonly event: PointerInputEvent;

  readonly error: Error;
}

export type WindowResizeRuntimeEvent =
  | WindowResizeRuntimeConnectedEvent
  | WindowResizeRuntimeDisconnectedEvent
  | WindowResizeRuntimeHitEvent
  | WindowResizeRuntimeIgnoredEvent
  | WindowResizeRuntimeStartedEvent
  | WindowResizeRuntimeEventForwardedEvent
  | WindowResizeRuntimeFailedEvent;

export type WindowResizeRuntimeEventListener = (event: WindowResizeRuntimeEvent) => void;
