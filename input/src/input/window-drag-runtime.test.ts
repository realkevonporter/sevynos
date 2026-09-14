import { describe, expect, it, vi } from "vitest";

import { GenesisWindow } from "@sevynos/graphics";
import { InputDeviceRegistry } from "./input-device-registry.js";
import { InputDispatcher } from "./input-dispatcher.js";
import { PointerCaptureManager } from "./pointer-capture-manager.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { WindowDragController } from "./window-drag-controller.js";
import type { WindowDragRuntimeEvent } from "./window-drag-runtime-events.js";
import { WindowDragRuntime } from "./window-drag-runtime.js";
import { WindowHitTester } from "./window-hit-tester.js";

const CREATED_AT = new Date("2026-08-01T18:30:00.000Z");

function createWindow(): GenesisWindow {
  return new GenesisWindow({
    id: "window-1",

    sessionId: "session-1",

    title: "Draggable Window",

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
  x = 150,
  y = 75,
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
    readonly titleBarHeight?: number;

    readonly onEvent?: (event: WindowDragRuntimeEvent) => void;
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

  let currentWindow = createWindow();

  const captures = new PointerCaptureManager({
    now: () => 100,
  });

  const dragController = new WindowDragController({
    windows: {
      getWindow: (windowId) =>
        currentWindow.id === windowId ? currentWindow : undefined,

      moveWindow: (moveOptions) => {
        currentWindow = currentWindow.withBounds(
          {
            ...currentWindow.bounds,

            x: moveOptions.x,

            y: moveOptions.y,
          },
          CREATED_AT,
        );

        return currentWindow;
      },
    },

    pointerCaptureManager: captures,

    now: () => 200,
  });

  const hitTester = new WindowHitTester({
    listWindows: () => [currentWindow],
  });

  const titleBarHeight = options.titleBarHeight ?? 40;

  const runtime = new WindowDragRuntime({
    dispatcher,

    hitTester,

    dragController,

    isDraggableRegion: (_event, hit) =>
      hit.localPoint.y >= 0 && hit.localPoint.y < titleBarHeight,

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });

  return {
    dispatcher,
    captures,
    dragController,
    runtime,

    getCurrentWindow: () => currentWindow,
  };
}

describe("WindowDragRuntime", () => {
  it("starts disconnected", () => {
    const { runtime } = createFixture();

    expect(runtime.connected).toBe(false);
  });

  it("connects and disconnects safely", () => {
    const { runtime } = createFixture();

    runtime.connect();
    runtime.connect();

    expect(runtime.connected).toBe(true);

    runtime.disconnect();
    runtime.disconnect();

    expect(runtime.connected).toBe(false);
  });

  it("starts dragging from the title bar", () => {
    const { captures, dragController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 150, 75));

    expect(dragController.isDragging(1)).toBe(true);

    expect(captures.isCapturedBy(1, "window-1")).toBe(true);
  });

  it("does not start dragging from window content", () => {
    const { dragController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 150, 200));

    expect(dragController.isDragging(1)).toBe(false);
  });

  it("does not start dragging when no window is hit", () => {
    const { dragController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 2000, 2000));

    expect(dragController.isDragging(1)).toBe(false);
  });

  it("moves an actively dragged window", () => {
    const { runtime, getCurrentWindow } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 150, 75));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 250, 175));

    expect(getCurrentWindow().bounds).toEqual({
      x: 200,
      y: 150,
      width: 800,
      height: 600,
    });
  });

  it("continues dragging outside the original window bounds", () => {
    const { runtime, getCurrentWindow } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down", 150, 75));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 1500, 900));

    expect(getCurrentWindow().bounds.x).toBe(1450);

    expect(getCurrentWindow().bounds.y).toBe(875);
  });

  it("ends dragging on pointer up", () => {
    const { captures, dragController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    runtime.handlePointerEvent(createPointerEvent("pointer-up"));

    expect(dragController.isDragging(1)).toBe(false);

    expect(captures.has(1)).toBe(false);
  });

  it("ends dragging on pointer cancel", () => {
    const { captures, dragController, runtime } = createFixture();

    runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    runtime.handlePointerEvent(createPointerEvent("pointer-cancel"));

    expect(dragController.isDragging(1)).toBe(false);

    expect(captures.has(1)).toBe(false);
  });

  it("receives validated pointer events through the dispatcher", () => {
    const { dispatcher, dragController, runtime } = createFixture();

    runtime.connect();

    dispatcher.dispatch(createPointerEvent("pointer-down"));

    expect(dragController.isDragging(1)).toBe(true);
  });

  it("cancels active drags when disconnected", () => {
    const { captures, dragController, runtime } = createFixture();

    runtime.connect();

    runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    runtime.disconnect();

    expect(dragController.activeDragCount).toBe(0);

    expect(captures.size).toBe(0);
  });

  it("emits deterministic runtime events", () => {
    const events: WindowDragRuntimeEvent[] = [];

    const { runtime } = createFixture({
      onEvent: (event) => {
        events.push(event);
      },
    });

    runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    runtime.handlePointerEvent(createPointerEvent("pointer-move", 200, 125));

    runtime.handlePointerEvent(createPointerEvent("pointer-up", 200, 125));

    expect(events.map((event) => event.type)).toEqual([
      "window-drag-runtime-hit",
      "window-drag-runtime-started",
      "window-drag-runtime-event-forwarded",
      "window-drag-runtime-event-forwarded",
    ]);
  });

  it("does not invoke drag movement for unrelated pointer movement", () => {
    const { dragController, runtime } = createFixture();

    const moveSpy = vi.spyOn(dragController, "move");

    runtime.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(moveSpy).not.toHaveBeenCalled();
  });
});
