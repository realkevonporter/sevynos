import type { PointerInputEvent } from "./pointer-input-event.js";
import type { FocusTargetId } from "./focus-state.js";
import type { WindowHitTestResult } from "./window-hit-test-result.js";

export interface PointerFocusHitEvent {
  readonly type: "pointer-focus-hit";

  readonly event: PointerInputEvent;

  readonly hit: WindowHitTestResult;
}

export interface PointerFocusMissEvent {
  readonly type: "pointer-focus-miss";

  readonly event: PointerInputEvent;
}

export interface PointerFocusUpdatedEvent {
  readonly type: "pointer-focus-updated";

  readonly event: PointerInputEvent;

  readonly previousTargetId: FocusTargetId | null;

  readonly targetId: FocusTargetId | null;
}

export interface PointerFocusWindowActivatedEvent {
  readonly type: "pointer-focus-window-activated";

  readonly event: PointerInputEvent;

  readonly targetId: FocusTargetId;
}

export interface PointerFocusRejectedEvent {
  readonly type: "pointer-focus-rejected";

  readonly event: PointerInputEvent;

  readonly error: Error;
}

export type PointerFocusControllerEvent =
  | PointerFocusHitEvent
  | PointerFocusMissEvent
  | PointerFocusUpdatedEvent
  | PointerFocusWindowActivatedEvent
  | PointerFocusRejectedEvent;

export type PointerFocusControllerEventListener = (
  event: PointerFocusControllerEvent,
) => void;
