import type { InputEvent, InputEventMetadata } from "./input-event.js";
import { createInputModifiers } from "./input-modifiers.js";

export type PointerEventType =
  "pointer-move" | "pointer-down" | "pointer-up" | "pointer-cancel";

export type PointerButton =
  "none" | "primary" | "secondary" | "middle" | "back" | "forward";

export interface PointerPosition {
  readonly x: number;

  readonly y: number;
}

export interface PointerInputEvent extends InputEvent {
  readonly type: PointerEventType;

  readonly pointerId: number;

  readonly position: PointerPosition;

  readonly button: PointerButton;

  readonly buttons: readonly PointerButton[];

  readonly pressure: number;
}

export interface CreatePointerInputEventOptions extends InputEventMetadata {
  readonly type: PointerEventType;

  readonly pointerId: number;

  readonly position: PointerPosition;

  readonly button?: PointerButton;

  readonly buttons?: readonly PointerButton[];

  readonly pressure?: number;
}

export function createPointerInputEvent(
  options: CreatePointerInputEventOptions,
): PointerInputEvent {
  return Object.freeze({
    type: options.type,

    eventId: options.eventId,

    deviceId: options.deviceId,

    deviceKind: options.deviceKind,

    timestamp: options.timestamp,

    modifiers: createInputModifiers(options.modifiers),

    pointerId: options.pointerId,

    position: Object.freeze({
      x: options.position.x,

      y: options.position.y,
    }),

    button: options.button ?? "none",

    buttons: Object.freeze([...(options.buttons ?? [])]),

    pressure: options.pressure ?? 0,
  });
}
