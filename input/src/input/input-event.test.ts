import { describe, expect, it } from "vitest";

import { createInputModifiers, NO_INPUT_MODIFIERS } from "./input-modifiers.js";
import { createKeyboardInputEvent } from "./keyboard-input-event.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { createTouchInputEvent } from "./touch-input-event.js";
import { createWheelInputEvent } from "./wheel-input-event.js";

describe("input events", () => {
  it("creates default input modifiers", () => {
    expect(NO_INPUT_MODIFIERS).toEqual({
      alt: false,
      control: false,
      meta: false,
      shift: false,
    });
  });

  it("creates partial input modifiers", () => {
    const modifiers = createInputModifiers({
      control: true,
      shift: true,
    });

    expect(modifiers).toEqual({
      alt: false,
      control: true,
      meta: false,
      shift: true,
    });
  });

  it("creates an immutable pointer event", () => {
    const event = createPointerInputEvent({
      type: "pointer-down",

      eventId: "event-1",

      deviceId: "mouse-1",

      deviceKind: "mouse",

      timestamp: 100,

      pointerId: 1,

      position: {
        x: 25,
        y: 50,
      },

      button: "primary",

      buttons: ["primary"],

      pressure: 0.5,
    });

    expect(event).toEqual({
      type: "pointer-down",

      eventId: "event-1",

      deviceId: "mouse-1",

      deviceKind: "mouse",

      timestamp: 100,

      modifiers: {
        alt: false,
        control: false,
        meta: false,
        shift: false,
      },

      pointerId: 1,

      position: {
        x: 25,
        y: 50,
      },

      button: "primary",

      buttons: ["primary"],

      pressure: 0.5,
    });

    expect(Object.isFrozen(event)).toBe(true);

    expect(Object.isFrozen(event.position)).toBe(true);

    expect(Object.isFrozen(event.buttons)).toBe(true);
  });

  it("creates a keyboard event", () => {
    const event = createKeyboardInputEvent({
      type: "key-down",

      eventId: "event-2",

      deviceId: "keyboard-1",

      deviceKind: "keyboard",

      timestamp: 200,

      code: "KeyA",

      key: "a",

      modifiers: {
        shift: true,
        alt: false,
        control: false,
        meta: false,
      },
    });

    expect(event.type).toBe("key-down");

    expect(event.code).toBe("KeyA");

    expect(event.key).toBe("a");

    expect(event.repeat).toBe(false);

    expect(event.composing).toBe(false);

    expect(event.modifiers.shift).toBe(true);
  });

  it("creates a wheel event with defaults", () => {
    const event = createWheelInputEvent({
      eventId: "event-3",

      deviceId: "mouse-1",

      deviceKind: "mouse",

      timestamp: 300,

      position: { x: 100, y: 200 },

      deltaX: 4,

      deltaY: 12,
    });

    expect(event).toMatchObject({
      type: "wheel",

      deltaX: 4,

      deltaY: 12,

      deltaZ: 0,

      deltaMode: "pixel",
    });
  });

  it("creates immutable touch collections", () => {
    const event = createTouchInputEvent({
      type: "touch-start",

      eventId: "event-4",

      deviceId: "touchscreen-1",

      deviceKind: "touchscreen",

      timestamp: 400,

      changedTouches: [
        {
          touchId: 1,

          x: 10,

          y: 20,

          pressure: 0.75,
        },
      ],

      activeTouches: [
        {
          touchId: 1,

          x: 10,

          y: 20,

          pressure: 0.75,
        },
      ],
    });

    expect(event.changedTouches).toEqual([
      {
        touchId: 1,

        x: 10,

        y: 20,

        pressure: 0.75,

        radiusX: 0,

        radiusY: 0,
      },
    ]);

    expect(Object.isFrozen(event.changedTouches)).toBe(true);

    expect(Object.isFrozen(event.changedTouches[0])).toBe(true);
  });

  it("copies caller-owned arrays", () => {
    const buttons = ["primary"] as const;

    const event = createPointerInputEvent({
      type: "pointer-down",

      eventId: "event-5",

      deviceId: "mouse-1",

      deviceKind: "mouse",

      timestamp: 500,

      pointerId: 1,

      position: {
        x: 0,
        y: 0,
      },

      buttons,
    });

    expect(event.buttons).not.toBe(buttons);
  });
});
