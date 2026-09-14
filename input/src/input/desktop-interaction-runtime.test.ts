import { describe, expect, it, vi } from "vitest";

import type { DesktopInteractionRuntimeEvent } from "./desktop-interaction-runtime-events.js";
import { DesktopInteractionRuntime } from "./desktop-interaction-runtime.js";
import { InputDeviceRegistry } from "./input-device-registry.js";
import { InputDispatcher } from "./input-dispatcher.js";
import { createPointerInputEvent } from "./pointer-input-event.js";

function createPointerEvent(
  type: "pointer-down" | "pointer-move" | "pointer-up" | "pointer-cancel",
) {
  return createPointerInputEvent({
    type,

    eventId: `event-${type}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 100,

    pointerId: 1,

    position: {
      x: 100,
      y: 100,
    },

    button: type === "pointer-down" ? "primary" : "none",

    buttons: type === "pointer-down" || type === "pointer-move" ? ["primary"] : [],

    pressure: 0,
  });
}

function createFixture(
  options: {
    readonly resizing?: boolean;

    readonly dragging?: boolean;

    readonly beginResize?: boolean;

    readonly beginDrag?: boolean;

    readonly onEvent?: (event: DesktopInteractionRuntimeEvent) => void;
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

  let resizing = options.resizing ?? false;

  let dragging = options.dragging ?? false;

  const pointerFocusController = {
    handlePointerEvent: vi.fn(),
  };

  const resizeRuntime = {
    isResizing: vi.fn(() => resizing),

    handlePointerEvent: vi.fn((event: ReturnType<typeof createPointerEvent>) => {
      if (event.type === "pointer-down" && options.beginResize === true) {
        resizing = true;
      }

      if (event.type === "pointer-up" || event.type === "pointer-cancel") {
        resizing = false;
      }
    }),

    cancelAll: vi.fn(() => []),
  };

  const dragRuntime = {
    isDragging: vi.fn(() => dragging),

    handlePointerEvent: vi.fn((event: ReturnType<typeof createPointerEvent>) => {
      if (event.type === "pointer-down" && options.beginDrag === true) {
        dragging = true;
      }

      if (event.type === "pointer-up" || event.type === "pointer-cancel") {
        dragging = false;
      }
    }),

    cancelAll: vi.fn(() => []),
  };

  const cursorRuntime = {
    handlePointerEvent: vi.fn(),
  };

  const runtime = new DesktopInteractionRuntime({
    dispatcher,

    pointerFocusController,

    resizeRuntime,

    dragRuntime,

    cursorRuntime,

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });

  return {
    dispatcher,
    runtime,
    pointerFocusController,
    resizeRuntime,
    dragRuntime,
    cursorRuntime,
  };
}

describe("DesktopInteractionRuntime", () => {
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

  it("forwards events to an active resize first", () => {
    const { runtime, pointerFocusController, resizeRuntime, dragRuntime, cursorRuntime } =
      createFixture({
        resizing: true,
      });

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(interaction).toBe("resize");

    expect(resizeRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(dragRuntime.handlePointerEvent).not.toHaveBeenCalled();

    expect(pointerFocusController.handlePointerEvent).not.toHaveBeenCalled();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("forwards events to an active drag", () => {
    const { runtime, pointerFocusController, resizeRuntime, dragRuntime, cursorRuntime } =
      createFixture({
        dragging: true,
      });

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(interaction).toBe("drag");

    expect(dragRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(resizeRuntime.handlePointerEvent).not.toHaveBeenCalled();

    expect(pointerFocusController.handlePointerEvent).not.toHaveBeenCalled();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("prioritizes resize over drag on pointer down", () => {
    const { runtime, resizeRuntime, dragRuntime, cursorRuntime } = createFixture({
      beginResize: true,

      beginDrag: true,
    });

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(interaction).toBe("resize");

    expect(resizeRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(dragRuntime.handlePointerEvent).not.toHaveBeenCalled();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("tries dragging when resize does not begin", () => {
    const { runtime, resizeRuntime, dragRuntime, cursorRuntime } = createFixture({
      beginResize: false,

      beginDrag: true,
    });

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(interaction).toBe("drag");

    expect(resizeRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(dragRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("uses normal focus when no resize or drag begins", () => {
    const { runtime, pointerFocusController, cursorRuntime } = createFixture();

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(interaction).toBe("focus");

    expect(pointerFocusController.handlePointerEvent).toHaveBeenCalledOnce();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("handles ordinary pointer movement through focus", () => {
    const { runtime, pointerFocusController, resizeRuntime, dragRuntime, cursorRuntime } =
      createFixture();

    const interaction = runtime.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(interaction).toBe("focus");

    expect(pointerFocusController.handlePointerEvent).toHaveBeenCalledOnce();

    expect(resizeRuntime.handlePointerEvent).not.toHaveBeenCalled();

    expect(dragRuntime.handlePointerEvent).not.toHaveBeenCalled();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("updates the cursor after routing the interaction", () => {
    const { runtime, dragRuntime, cursorRuntime } = createFixture({
      beginDrag: true,
    });

    runtime.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(dragRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    const dragCallOrder = dragRuntime.handlePointerEvent.mock.invocationCallOrder[0];
    const cursorCallOrder = cursorRuntime.handlePointerEvent.mock.invocationCallOrder[0];

    expect(dragCallOrder).toBeDefined();
    expect(cursorCallOrder).toBeDefined();

    expect(dragCallOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(
      cursorCallOrder ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("updates the cursor after an active resize ends", () => {
    const { runtime, resizeRuntime, cursorRuntime } = createFixture({
      resizing: true,
    });

    runtime.handlePointerEvent(createPointerEvent("pointer-up"));

    expect(resizeRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();

    const resizeCallOrder = resizeRuntime.handlePointerEvent.mock.invocationCallOrder[0];
    const cursorCallOrder = cursorRuntime.handlePointerEvent.mock.invocationCallOrder[0];

    expect(resizeCallOrder).toBeDefined();
    expect(cursorCallOrder).toBeDefined();

    expect(resizeCallOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(
      cursorCallOrder ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("updates pointer focus on cancel after an active resize", () => {
    const { runtime, pointerFocusController, resizeRuntime, cursorRuntime } =
      createFixture({
        resizing: true,
      });

    const event = createPointerEvent("pointer-cancel");

    const interaction = runtime.handlePointerEvent(event);

    expect(interaction).toBe("resize");

    expect(resizeRuntime.handlePointerEvent).toHaveBeenCalledWith(event);

    expect(pointerFocusController.handlePointerEvent).toHaveBeenCalledWith(event);

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledWith(event);
  });

  it("updates pointer focus on cancel after an active drag", () => {
    const { runtime, pointerFocusController, dragRuntime, cursorRuntime } = createFixture(
      {
        dragging: true,
      },
    );

    const event = createPointerEvent("pointer-cancel");

    const interaction = runtime.handlePointerEvent(event);

    expect(interaction).toBe("drag");

    expect(dragRuntime.handlePointerEvent).toHaveBeenCalledWith(event);

    expect(pointerFocusController.handlePointerEvent).toHaveBeenCalledWith(event);

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledWith(event);
  });

  it("receives validated events through the dispatcher", () => {
    const { dispatcher, runtime, pointerFocusController, cursorRuntime } =
      createFixture();

    runtime.connect();

    dispatcher.dispatch(createPointerEvent("pointer-move"));

    expect(pointerFocusController.handlePointerEvent).toHaveBeenCalledOnce();

    expect(cursorRuntime.handlePointerEvent).toHaveBeenCalledOnce();
  });

  it("cancels drag and resize interactions when disconnected", () => {
    const { runtime, resizeRuntime, dragRuntime } = createFixture();

    runtime.connect();
    runtime.disconnect();

    expect(resizeRuntime.cancelAll).toHaveBeenCalledOnce();

    expect(dragRuntime.cancelAll).toHaveBeenCalledOnce();
  });

  it("emits deterministic lifecycle and routing events", () => {
    const events: DesktopInteractionRuntimeEvent[] = [];

    const { runtime } = createFixture({
      onEvent: (event) => {
        events.push(event);
      },
    });

    runtime.connect();

    runtime.handlePointerEvent(createPointerEvent("pointer-move"));

    runtime.disconnect();

    expect(events.map((event) => event.type)).toEqual([
      "desktop-interaction-runtime-connected",
      "desktop-interaction-handled",
      "desktop-interaction-runtime-disconnected",
    ]);
  });

  it("does not emit a handled event when routing fails", () => {
    const events: DesktopInteractionRuntimeEvent[] = [];

    const { runtime, pointerFocusController } = createFixture({
      onEvent: (event) => {
        events.push(event);
      },
    });

    pointerFocusController.handlePointerEvent.mockImplementationOnce(() => {
      throw new Error("Focus failed.");
    });

    expect(() => {
      runtime.handlePointerEvent(createPointerEvent("pointer-move"));
    }).toThrow("Focus failed.");

    expect(events.map((event) => event.type)).toEqual(["desktop-interaction-failed"]);
  });
});
