import { describe, expect, it } from "vitest";

import { GenesisWindow } from "@sevynos/graphics";
import { InputDeviceRegistry } from "./input-device-registry.js";
import { InputDispatcher } from "./input-dispatcher.js";
import { PointerCaptureManager } from "./pointer-capture-manager.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { WindowHitTester } from "./window-hit-tester.js";
import { WindowResizeController } from "./window-resize-controller.js";
import { WindowResizeEdgeDetector } from "./window-resize-edge-detector.js";
import type { WindowResizeRuntimeEvent } from "./window-resize-runtime-events.js";
import { WindowResizeRuntime } from "./window-resize-runtime.js";

const CREATED_AT = new Date("2026-08-01T19:00:00.000Z");

function createWindow(): GenesisWindow {
  return new GenesisWindow({
    id: "window-1",

    sessionId: "session-1",

    title: "Resizable",

    bounds: {
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    },

    state: "focused",

    zIndex: 1,

    createdAt: CREATED_AT,

    updatedAt: CREATED_AT,
  });
}

function createPointerEvent(
  type: "pointer-down" | "pointer-move" | "pointer-up" | "pointer-cancel",
  x: number,
  y: number,
) {
  return createPointerInputEvent({
    type,

    eventId: `event-${type}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 100,

    pointerId: 1,

    position: {
      x,
      y,
    },

    button: type === "pointer-down" ? "primary" : "none",

    buttons: type === "pointer-down" || type === "pointer-move" ? ["primary"] : [],

    pressure: 0,
  });
}

function createFixture(
  options: {
    readonly onEvent?: (event: WindowResizeRuntimeEvent) => void;
  } = {},
) {
  const devices = new InputDeviceRegistry();

  devices.register(
    {
      id: "mouse-1",

      name: "Test Mouse",

      kind: "mouse",

      capabilities: ["pointer"],

      virtual: true,
    },
    1,
  );

  const dispatcher = new InputDispatcher({
    deviceRegistry: devices,
  });

  const captures = new PointerCaptureManager({
    now: () => 100,
  });

  let currentWindow = createWindow();

  const resizeController = new WindowResizeController({
    windows: {
      getWindow: (windowId) =>
        currentWindow.id === windowId ? currentWindow : undefined,

      resizeWindow: (resizeOptions) => {
        currentWindow = currentWindow.withBounds(resizeOptions.bounds, CREATED_AT);

        return currentWindow;
      },
    },

    pointerCaptureManager: captures,

    now: () => 200,

    minimumWidth: 320,

    minimumHeight: 200,
  });

  const runtime = new WindowResizeRuntime({
    dispatcher,

    hitTester: new WindowHitTester({
      listWindows: () => [currentWindow],
    }),

    edgeDetector: new WindowResizeEdgeDetector({
      borderSize: 8,
    }),

    resizeController,

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });

  return {
    dispatcher,
    captures,
    resizeController,
    runtime,

    getCurrentWindow: () => currentWindow,
  };
}

describe("WindowResizeRuntime", () => {
  it("starts disconnected", () => {
    const { runtime } = createFixture();

    expect(runtime.connected).toBe(false);
  });

  it("starts resizing from the right edge", () => {
    const { captures, resizeController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 897, 300));

    expect(resizeController.getActiveResize(1)?.edge).toBe("right");

    expect(captures.isCapturedBy(1, "window-1")).toBe(true);
  });

  it("does not start resizing from window content", () => {
    const { resizeController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 500, 300));

    expect(resizeController.activeResizeCount).toBe(0);
  });

  it("resizes an active window", () => {
    const { runtime, getCurrentWindow } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 897, 300));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 997, 300));

    expect(getCurrentWindow().bounds).toEqual({
      x: 100,
      y: 50,
      width: 900,
      height: 600,
    });
  });

  it("resizes from the top-left corner", () => {
    const { runtime, getCurrentWindow } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 102, 52));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 52, 2));

    expect(getCurrentWindow().bounds).toEqual({
      x: 50,
      y: 0,
      width: 850,
      height: 650,
    });
  });

  it("ends resizing on pointer up", () => {
    const { captures, resizeController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 897, 300));

    runtime.handlePointerEvent(createPointerEvent("pointer-up", 997, 300));

    expect(resizeController.activeResizeCount).toBe(0);

    expect(captures.has(1)).toBe(false);
  });

  it("receives events through the dispatcher", () => {
    const { dispatcher, resizeController, runtime } = createFixture();

    runtime.connect();

    dispatcher.dispatch(createPointerEvent("pointer-down", 897, 300));

    expect(resizeController.activeResizeCount).toBe(1);
  });

  it("cancels active resizes when disconnected", () => {
    const { captures, resizeController, runtime } = createFixture();

    runtime.connect();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 897, 300));

    runtime.disconnect();

    expect(resizeController.activeResizeCount).toBe(0);

    expect(captures.size).toBe(0);
  });

  it("emits deterministic runtime events", () => {
    const events: WindowResizeRuntimeEvent[] = [];

    const { runtime } = createFixture({
      onEvent: (event) => {
        events.push(event);
      },
    });

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 897, 300));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 997, 300));

    runtime.handlePointerEvent(createPointerEvent("pointer-up", 997, 300));

    expect(events.map((event) => event.type)).toEqual([
      "window-resize-runtime-hit",
      "window-resize-runtime-started",
      "window-resize-runtime-event-forwarded",
      "window-resize-runtime-event-forwarded",
    ]);
  });
});
