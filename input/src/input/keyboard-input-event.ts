import type { InputEvent, InputEventMetadata } from "./input-event.js";
import { createInputModifiers } from "./input-modifiers.js";

export type KeyboardEventType = "key-down" | "key-up";

export interface KeyboardInputEvent extends InputEvent {
  readonly type: KeyboardEventType;

  /**
   * Physical key position, such as "KeyA" or "Enter".
   */
  readonly code: string;

  /**
   * Logical key value, such as "a", "A", or "Enter".
   */
  readonly key: string;

  readonly repeat: boolean;

  readonly composing: boolean;
}

export interface CreateKeyboardInputEventOptions extends InputEventMetadata {
  readonly type: KeyboardEventType;

  readonly code: string;

  readonly key: string;

  readonly repeat?: boolean;

  readonly composing?: boolean;
}

export function createKeyboardInputEvent(
  options: CreateKeyboardInputEventOptions,
): KeyboardInputEvent {
  return Object.freeze({
    type: options.type,

    eventId: options.eventId,

    deviceId: options.deviceId,

    deviceKind: options.deviceKind,

    timestamp: options.timestamp,

    modifiers: createInputModifiers(options.modifiers),

    code: options.code,

    key: options.key,

    repeat: options.repeat ?? false,

    composing: options.composing ?? false,
  });
}
