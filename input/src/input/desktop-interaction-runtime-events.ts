import type { PointerInputEvent } from "./pointer-input-event.js";

export type DesktopInteractionKind = "focus" | "drag" | "resize" | "none";

export interface DesktopInteractionRuntimeConnectedEvent {
  readonly type: "desktop-interaction-runtime-connected";
}

export interface DesktopInteractionRuntimeDisconnectedEvent {
  readonly type: "desktop-interaction-runtime-disconnected";
}

export interface DesktopInteractionHandledEvent {
  readonly type: "desktop-interaction-handled";

  readonly event: PointerInputEvent;

  readonly interaction: DesktopInteractionKind;
}

export interface DesktopInteractionFailedEvent {
  readonly type: "desktop-interaction-failed";

  readonly event: PointerInputEvent;

  readonly error: Error;
}

export type DesktopInteractionRuntimeEvent =
  | DesktopInteractionRuntimeConnectedEvent
  | DesktopInteractionRuntimeDisconnectedEvent
  | DesktopInteractionHandledEvent
  | DesktopInteractionFailedEvent;

export type DesktopInteractionRuntimeEventListener = (
  event: DesktopInteractionRuntimeEvent,
) => void;
