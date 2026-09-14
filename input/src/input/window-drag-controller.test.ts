import { describe, expect, it } from "vitest";

import {
  WindowDragAlreadyActiveError,
  WindowDragMoveError,
  WindowDragNotFoundError,
  WindowDragPointerCaptureError,
  WindowDragWindowNotFoundError,
} from "../errors/window-drag-errors.js";
import { GenesisWindow } from "@sevynos/graphics";
import { PointerCaptureManager } from "./pointer-capture-manager.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { WindowDragController } from "./window-drag-controller.js";
import type { WindowDragControllerEvent } from "./window-drag-events.js";

const CREATED_AT = new Date("2026-08-01T18:00:00.000Z");

function createWindow(id: `window-${string}` = "window-1"): GenesisWindow {
  return new GenesisWindow({
    id,

    sessionId: `session-${id}`,

    title: id,

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
  y = 100,
  pointerId = 1,
) {
  return createPointerInputEvent({
    type,

    eventId: `event-${type}-${String(pointerId)}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 100,

    pointerId,

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
    readonly window?: GenesisWindow;

    readonly moveError?: Error;

    readonly capturePointerFirst?: boolean;

    readonly onEvent?: (event: WindowDragControllerEvent) => void;
  } = {},
) {
  const window = options.window ?? createWindow();

  let currentWindow = window;

  const pointerCaptureManager = new PointerCaptureManager({
    now: () => 100,
  });

  if (options.capturePointerFirst === true) {
    pointerCaptureManager.capture(1, "window-other");
  }

  const controller = new WindowDragController({
    windows: {
      getWindow: (windowId) =>
        currentWindow.id === windowId ? currentWindow : undefined,

      moveWindow: (moveOptions) => {
        if (options.moveError !== undefined) {
          throw options.moveError;
        }

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

    pointerCaptureManager,

    now: () => 200,

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });

  return {
    controller,
    pointerCaptureManager,

    getCurrentWindow: () => currentWindow,
  };
}

describe("WindowDragController", () => {
  it("starts without active drags", () => {
    const { controller } = createFixture();

    expect(controller.activeDragCount).toBe(0);
  });

  it("begins a window drag and captures the pointer", () => {
    const { controller, pointerCaptureManager } = createFixture();

    const event = createPointerEvent("pointer-down");

    const drag = controller.beginDrag("window-1", event);

    expect(drag.pointerId).toBe(1);

    expect(drag.windowId).toBe("window-1");

    expect(drag.initialPointerPosition).toEqual({
      x: 150,
      y: 100,
    });

    expect(drag.initialWindowBounds).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    });

    expect(drag.startedAt).toBe(200);

    expect(controller.isDragging(1)).toBe(true);

    expect(pointerCaptureManager.isCapturedBy(1, "window-1")).toBe(true);
  });

  it("moves the window using pointer delta from the original position", () => {
    const { controller, getCurrentWindow } = createFixture();

    controller.beginDrag("window-1", createPointerEvent("pointer-down", 150, 100));

    const result = controller.move(createPointerEvent("pointer-move", 250, 175));

    expect(result.deltaX).toBe(100);

    expect(result.deltaY).toBe(75);

    expect(result.window.bounds).toEqual({
      x: 200,
      y: 125,
      width: 800,
      height: 600,
    });

    expect(getCurrentWindow().bounds).toEqual(result.window.bounds);
  });

  it("does not accumulate movement error between pointer moves", () => {
    const { controller } = createFixture();

    controller.beginDrag("window-1", createPointerEvent("pointer-down", 150, 100));

    controller.move(createPointerEvent("pointer-move", 200, 150));

    const second = controller.move(createPointerEvent("pointer-move", 250, 200));

    expect(second.window.bounds.x).toBe(200);

    expect(second.window.bounds.y).toBe(150);
  });

  it("ends the drag and releases capture on pointer up", () => {
    const { controller, pointerCaptureManager } = createFixture();

    controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    controller.handlePointerEvent(createPointerEvent("pointer-up"));

    expect(controller.isDragging(1)).toBe(false);

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("ends the drag and releases capture on pointer cancel", () => {
    const { controller, pointerCaptureManager } = createFixture();

    controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    controller.handlePointerEvent(createPointerEvent("pointer-cancel"));

    expect(controller.isDragging(1)).toBe(false);

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("ignores pointer events without an active drag", () => {
    const { controller } = createFixture();

    expect(
      controller.handlePointerEvent(createPointerEvent("pointer-move")),
    ).toBeUndefined();
  });

  it("rejects beginning a drag with a non-down event", () => {
    const { controller } = createFixture();

    expect(() => {
      controller.beginDrag("window-1", createPointerEvent("pointer-move"));
    }).toThrow('Window drag must begin with a pointer-down event, not "pointer-move".');
  });

  it("rejects duplicate drags for one pointer", () => {
    const { controller } = createFixture();

    controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    expect(() => {
      controller.beginDrag("window-1", createPointerEvent("pointer-down"));
    }).toThrow(WindowDragAlreadyActiveError);
  });

  it("rejects dragging an unknown window", () => {
    const { controller } = createFixture();

    expect(() => {
      controller.beginDrag("window-missing", createPointerEvent("pointer-down"));
    }).toThrow(WindowDragWindowNotFoundError);
  });

  it("wraps pointer-capture failures", () => {
    const { controller } = createFixture({
      capturePointerFirst: true,
    });

    expect(() => {
      controller.beginDrag("window-1", createPointerEvent("pointer-down"));
    }).toThrow(WindowDragPointerCaptureError);

    expect(controller.activeDragCount).toBe(0);
  });

  it("wraps window movement failures", () => {
    const moveError = new Error("Window movement failed.");

    const { controller } = createFixture({
      moveError,
    });

    controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    expect(() => {
      controller.move(createPointerEvent("pointer-move", 250, 175));
    }).toThrow(WindowDragMoveError);
  });

  it("rejects requiring a missing drag", () => {
    const { controller } = createFixture();

    expect(() => {
      controller.requireActiveDrag(1);
    }).toThrow(WindowDragNotFoundError);
  });

  it("supports independent pointer drags", () => {
    const firstWindow = createWindow("window-1");

    const secondWindow = createWindow("window-2");

    const windows = new Map([
      [firstWindow.id, firstWindow],
      [secondWindow.id, secondWindow],
    ]);

    const captures = new PointerCaptureManager({
      now: () => 100,
    });

    const controller = new WindowDragController({
      windows: {
        getWindow: (windowId) => windows.get(windowId),

        moveWindow: (options) => {
          const window = windows.get(options.windowId);

          if (window === undefined) {
            throw new Error("Window missing.");
          }

          const moved = window.withBounds(
            {
              ...window.bounds,

              x: options.x,

              y: options.y,
            },
            CREATED_AT,
          );

          windows.set(window.id, moved);

          return moved;
        },
      },

      pointerCaptureManager: captures,

      now: () => 200,
    });

    controller.beginDrag(firstWindow.id, createPointerEvent("pointer-down", 100, 100, 1));

    controller.beginDrag(
      secondWindow.id,
      createPointerEvent("pointer-down", 100, 100, 2),
    );

    expect(controller.activeDragCount).toBe(2);

    expect(captures.isCapturedBy(1, firstWindow.id)).toBe(true);

    expect(captures.isCapturedBy(2, secondWindow.id)).toBe(true);
  });

  it("cancels every active drag", () => {
    const firstWindow = createWindow("window-1");

    const secondWindow = createWindow("window-2");

    const windows = new Map([
      [firstWindow.id, firstWindow],
      [secondWindow.id, secondWindow],
    ]);

    const captures = new PointerCaptureManager({
      now: () => 100,
    });

    const controller = new WindowDragController({
      windows: {
        getWindow: (windowId) => windows.get(windowId),

        moveWindow: () => firstWindow,
      },

      pointerCaptureManager: captures,

      now: () => 200,
    });

    controller.beginDrag(firstWindow.id, createPointerEvent("pointer-down", 100, 100, 1));

    controller.beginDrag(
      secondWindow.id,
      createPointerEvent("pointer-down", 100, 100, 2),
    );

    const cancelled = controller.cancelAll();

    expect(cancelled).toHaveLength(2);

    expect(controller.activeDragCount).toBe(0);

    expect(captures.size).toBe(0);
  });

  it("emits deterministic drag events", () => {
    const events: WindowDragControllerEvent[] = [];

    const { controller } = createFixture({
      onEvent: (event) => {
        events.push(event);
      },
    });

    controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    controller.move(createPointerEvent("pointer-move", 200, 150));

    controller.endDrag(1);

    expect(events.map((event) => event.type)).toEqual([
      "window-drag-started",
      "window-drag-moved",
      "window-drag-ended",
    ]);
  });

  it("creates immutable drag state and move results", () => {
    const { controller } = createFixture();

    const drag = controller.beginDrag("window-1", createPointerEvent("pointer-down"));

    const result = controller.move(createPointerEvent("pointer-move", 200, 150));

    expect(Object.isFrozen(drag)).toBe(true);

    expect(Object.isFrozen(drag.initialPointerPosition)).toBe(true);

    expect(Object.isFrozen(drag.initialWindowBounds)).toBe(true);

    expect(Object.isFrozen(result)).toBe(true);
  });
});
