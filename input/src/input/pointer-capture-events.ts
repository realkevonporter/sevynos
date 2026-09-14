import type { FocusTargetId } from "./focus-state.js";
import type {
  PointerCapture,
  PointerCaptureId,
  PointerCaptureReleaseReason,
} from "./pointer-capture.js";
import type { PointerInputEvent } from "./pointer-input-event.js";

export interface PointerCapturedEvent {
  readonly type: "pointer-captured";

  readonly capture: PointerCapture;
}

export interface PointerCaptureReleasedEvent {
  readonly type: "pointer-capture-released";

  readonly capture: PointerCapture;

  readonly reason: PointerCaptureReleaseReason;
}

export interface PointerCaptureTargetReleasedEvent {
  readonly type: "pointer-capture-target-released";

  readonly targetId: FocusTargetId;

  readonly pointerIds: readonly PointerCaptureId[];

  readonly reason: "target-removed";
}

export interface PointerCaptureEventObservedEvent {
  readonly type: "pointer-capture-event-observed";

  readonly event: PointerInputEvent;

  readonly capture: PointerCapture | undefined;
}

export type PointerCaptureManagerEvent =
  | PointerCapturedEvent
  | PointerCaptureReleasedEvent
  | PointerCaptureTargetReleasedEvent
  | PointerCaptureEventObservedEvent;

export type PointerCaptureManagerEventListener = (
  event: PointerCaptureManagerEvent,
) => void;
