import { describe, expect, it, vi } from "vitest";

import { GenesisWindow } from "@sevynos/graphics";
import { CursorManager } from "./cursor-manager.js";
import { DesktopCursorRuntime } from "./desktop-cursor-runtime.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { WindowHitTester } from "./window-hit-tester.js";
import { WindowResizeEdgeDetector } from "./window-resize-edge-detector.js";

const CREATED_AT = new Date("2026-08-01T20:00:00.000Z");

function createWindow(): GenesisWindow {
  return new GenesisWindow({
    id: "window-1",

    sessionId: "session-1",

    title: "Window",

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

function createPointerEvent(x: number, y: number) {
  return createPointerInputEvent({
    type: "pointer-move",

    eventId: `event-${String(x)}-${String(y)}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 100,

    pointerId: 1,

    position: {
      x,
      y,
    },

    button: "none",

    buttons: [],

    pressure: 0,
  });
}

function createFixture(
  options: {
    readonly dragging?: boolean;

    readonly resizing?: boolean;

    readonly resizeEdge?:
      | "top"
      | "right"
      | "bottom"
      | "left"
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right";
  } = {},
) {
  const window = createWindow();

  const cursorManager = new CursorManager({
    now: () => 100,
  });

  const dragRuntime = {
    isDragging: vi.fn(() => options.dragging ?? false),
  };

  const resizeRuntime = {
    isResizing: vi.fn(() => options.resizing ?? false),

    getResizeEdge: vi.fn(() => options.resizeEdge),
  };

  const runtime = new DesktopCursorRuntime({
    cursorManager,

    hitTester: new WindowHitTester({
      listWindows: () => [window],
    }),

    edgeDetector: new WindowResizeEdgeDetector({
      borderSize: 8,
    }),

    dragRuntime,

    resizeRuntime,
  });

  return {
    runtime,
    cursorManager,
  };
}

describe("DesktopCursorRuntime", () => {
  it("uses the default cursor over window content", () => {
    const { runtime } = createFixture();

    expect(runtime.handlePointerEvent(createPointerEvent(500, 300))).toBe("default");
  });

  it("uses horizontal resize cursor on left and right edges", () => {
    const { runtime } = createFixture();

    expect(runtime.handlePointerEvent(createPointerEvent(102, 300))).toBe("resize-ew");

    expect(runtime.handlePointerEvent(createPointerEvent(897, 300))).toBe("resize-ew");
  });

  it("uses vertical resize cursor on top and bottom edges", () => {
    const { runtime } = createFixture();

    expect(runtime.handlePointerEvent(createPointerEvent(500, 52))).toBe("resize-ns");

    expect(runtime.handlePointerEvent(createPointerEvent(500, 647))).toBe("resize-ns");
  });

  it("uses diagonal resize cursors", () => {
    const { runtime } = createFixture();

    expect(runtime.handlePointerEvent(createPointerEvent(102, 52))).toBe("resize-nwse");

    expect(runtime.handlePointerEvent(createPointerEvent(897, 52))).toBe("resize-nesw");
  });

  it("uses move cursor while dragging", () => {
    const { runtime } = createFixture({
      dragging: true,
    });

    expect(runtime.handlePointerEvent(createPointerEvent(1500, 900))).toBe("move");
  });

  it("preserves active resize cursor outside the window", () => {
    const { runtime } = createFixture({
      resizing: true,

      resizeEdge: "bottom-right",
    });

    expect(runtime.handlePointerEvent(createPointerEvent(1500, 900))).toBe("resize-nwse");
  });

  it("updates cursor position", () => {
    const { runtime, cursorManager } = createFixture();

    runtime.handlePointerEvent(createPointerEvent(250, 175));

    expect(cursorManager.state.position).toEqual({
      x: 250,
      y: 175,
    });
  });

  it("returns default outside every window", () => {
    const { runtime } = createFixture();

    expect(runtime.handlePointerEvent(createPointerEvent(2000, 2000))).toBe("default");
  });
});
