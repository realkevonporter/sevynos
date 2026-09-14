import type { KeyboardInputEvent } from "./keyboard-input-event.js";
import type { InputDeviceKind, InputEventType } from "./input-event-types.js";
import { createInputModifiers, type InputModifiers } from "./input-modifiers.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { TouchInputEvent } from "./touch-input-event.js";
import type { WheelInputEvent } from "./wheel-input-event.js";

export interface InputEventMetadata {
  readonly eventId: string;

  readonly deviceId: string;

  readonly deviceKind: InputDeviceKind;

  readonly timestamp: number;

  readonly modifiers?: InputModifiers;
}

export interface InputEvent {
  readonly type: InputEventType;

  readonly eventId: string;

  readonly deviceId: string;

  readonly deviceKind: InputDeviceKind;

  readonly timestamp: number;

  readonly modifiers: InputModifiers;
}

export interface CreateInputEventBaseOptions extends InputEventMetadata {
  readonly type: InputEventType;
}

export function createInputEventBase(options: CreateInputEventBaseOptions): InputEvent {
  return Object.freeze({
    type: options.type,

    eventId: options.eventId,

    deviceId: options.deviceId,

    deviceKind: options.deviceKind,

    timestamp: options.timestamp,

    modifiers: createInputModifiers(options.modifiers),
  });
}

export type SevynInputEvent =
  PointerInputEvent | KeyboardInputEvent | WheelInputEvent | TouchInputEvent;
