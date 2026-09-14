import type { InputEvent, InputEventMetadata } from "./input-event.js";
import { createInputModifiers } from "./input-modifiers.js";

export type TouchEventType = "touch-start" | "touch-move" | "touch-end" | "touch-cancel";

export interface TouchPoint {
  readonly touchId: number;

  readonly x: number;

  readonly y: number;

  readonly pressure: number;

  readonly radiusX: number;

  readonly radiusY: number;
}

export interface TouchInputEvent extends InputEvent {
  readonly type: TouchEventType;

  readonly changedTouches: readonly TouchPoint[];

  readonly activeTouches: readonly TouchPoint[];
}

export interface CreateTouchPointOptions {
  readonly touchId: number;

  readonly x: number;

  readonly y: number;

  readonly pressure?: number;

  readonly radiusX?: number;

  readonly radiusY?: number;
}

export interface CreateTouchInputEventOptions extends InputEventMetadata {
  readonly type: TouchEventType;

  readonly changedTouches: readonly CreateTouchPointOptions[];

  readonly activeTouches: readonly CreateTouchPointOptions[];
}

function createTouchPoint(options: CreateTouchPointOptions): TouchPoint {
  return Object.freeze({
    touchId: options.touchId,

    x: options.x,

    y: options.y,

    pressure: options.pressure ?? 0,

    radiusX: options.radiusX ?? 0,

    radiusY: options.radiusY ?? 0,
  });
}

export function createTouchInputEvent(
  options: CreateTouchInputEventOptions,
): TouchInputEvent {
  return Object.freeze({
    type: options.type,

    eventId: options.eventId,

    deviceId: options.deviceId,

    deviceKind: options.deviceKind,

    timestamp: options.timestamp,

    modifiers: createInputModifiers(options.modifiers),

    changedTouches: Object.freeze(options.changedTouches.map(createTouchPoint)),

    activeTouches: Object.freeze(options.activeTouches.map(createTouchPoint)),
  });
}
