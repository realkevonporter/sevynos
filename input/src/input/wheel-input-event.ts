import type { InputEvent, InputEventMetadata } from "./input-event.js";
import { createInputModifiers } from "./input-modifiers.js";

import type { PointerPosition } from "./pointer-input-event.js";

export type WheelDeltaMode = "pixel" | "line" | "page";

export interface WheelInputEvent extends InputEvent {
  readonly type: "wheel";

  readonly position: PointerPosition;

  readonly deltaX: number;

  readonly deltaY: number;

  readonly deltaZ: number;

  readonly deltaMode: WheelDeltaMode;
}

export interface CreateWheelInputEventOptions extends InputEventMetadata {
  readonly position: PointerPosition;

  readonly deltaX: number;

  readonly deltaY: number;

  readonly deltaZ?: number;

  readonly deltaMode?: WheelDeltaMode;
}

export function createWheelInputEvent(
  options: CreateWheelInputEventOptions,
): WheelInputEvent {
  return Object.freeze({
    type: "wheel",

    eventId: options.eventId,

    deviceId: options.deviceId,

    deviceKind: options.deviceKind,

    timestamp: options.timestamp,

    modifiers: createInputModifiers(options.modifiers),

    position: Object.freeze({
      x: options.position.x,
      y: options.position.y,
    }),

    deltaX: options.deltaX,

    deltaY: options.deltaY,

    deltaZ: options.deltaZ ?? 0,

    deltaMode: options.deltaMode ?? "pixel",
  });
}
