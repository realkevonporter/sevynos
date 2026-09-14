import { describe, expect, it, vi } from "vitest";

import {
  FocusedInputTargetAlreadyRegisteredError,
  FocusedInputTargetHandlerError,
  FocusedInputTargetNotFoundError,
} from "../errors/focused-input-router-errors.js";
import type { FocusedInputRouterEvent } from "./focused-input-router-events.js";
import { FocusedInputRouter } from "./focused-input-router.js";
import { FocusManager } from "./focus-manager.js";
import { InputDeviceRegistry } from "./input-device-registry.js";
import { InputDispatcher } from "./input-dispatcher.js";
import { createKeyboardInputEvent } from "./keyboard-input-event.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { PointerCaptureManager } from "./pointer-capture-manager.js";

function createFixture(): {
  readonly registry: InputDeviceRegistry;

  readonly dispatcher: InputDispatcher;

  readonly focusManager: FocusManager;

  readonly pointerCaptureManager: PointerCaptureManager;

  readonly router: FocusedInputRouter;
} {
  const registry = new InputDeviceRegistry();

  registry.register(
    {
      id: "keyboard-1",

      name: "Test Keyboard",

      kind: "keyboard",

      capabilities: ["keyboard"],

      virtual: true,
    },
    1,
  );

  registry.register(
    {
      id: "mouse-1",

      name: "Test Mouse",

      kind: "mouse",

      capabilities: ["pointer", "wheel"],

      virtual: true,
    },
    1,
  );

  const dispatcher = new InputDispatcher({
    deviceRegistry: registry,
  });

  const focusManager = new FocusManager();

  const pointerCaptureManager = new PointerCaptureManager({
    now: () => 100,
  });

  const router = new FocusedInputRouter({
    dispatcher,

    focusManager,

    pointerCaptureManager,
  });

  return {
    registry,

    dispatcher,

    focusManager,

    pointerCaptureManager,

    router,
  };
}

function createKeyboardEvent() {
  return createKeyboardInputEvent({
    type: "key-down",

    eventId: "keyboard-event-1",

    deviceId: "keyboard-1",

    deviceKind: "keyboard",

    timestamp: 1,

    code: "KeyA",

    key: "a",

    repeat: false,

    composing: false,
  });
}

function createPointerEvent(
  type:
    "pointer-move" | "pointer-down" | "pointer-up" | "pointer-cancel" = "pointer-move",
) {
  return createPointerInputEvent({
    type,

    eventId: `pointer-event-${type}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 1,

    pointerId: 1,

    position: {
      x: 100,

      y: 200,
    },

    button: type === "pointer-down" ? "primary" : "none",

    buttons: type === "pointer-down" ? ["primary"] : [],

    pressure: 0,
  });
}

describe("FocusedInputRouter", () => {
  it("starts disconnected", () => {
    const { router } = createFixture();

    expect(router.connected).toBe(false);

    expect(router.targetCount).toBe(0);
  });

  it("connects to the dispatcher", () => {
    const { router } = createFixture();

    router.connect();

    expect(router.connected).toBe(true);
  });

  it("can be connected more than once safely", () => {
    const { router } = createFixture();

    router.connect();
    router.connect();

    expect(router.connected).toBe(true);
  });

  it("disconnects from the dispatcher", () => {
    const { router } = createFixture();

    router.connect();
    router.disconnect();

    expect(router.connected).toBe(false);
  });

  it("registers target handlers", () => {
    const { router } = createFixture();

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    expect(router.hasTarget("window-1")).toBe(true);

    expect(router.listTargetIds()).toEqual(["window-1"]);
  });

  it("rejects duplicate target handlers", () => {
    const { router } = createFixture();

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    expect(() => {
      router.registerTarget({
        targetId: "window-1",

        handler: vi.fn(),
      });
    }).toThrow(FocusedInputTargetAlreadyRegisteredError);
  });

  it("removes target handlers", () => {
    const { router } = createFixture();

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    router.removeTarget("window-1");

    expect(router.hasTarget("window-1")).toBe(false);
  });

  it("rejects removing an unknown target", () => {
    const { router } = createFixture();

    expect(() => {
      router.removeTarget("missing-window");
    }).toThrow(FocusedInputTargetNotFoundError);
  });

  it("routes keyboard input to keyboard focus", () => {
    const { dispatcher, focusManager, router } = createFixture();

    const windowOneHandler = vi.fn();

    const windowTwoHandler = vi.fn();

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: windowOneHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: windowTwoHandler,
    });

    focusManager.focusKeyboard("window-1");

    focusManager.focusPointer("window-2");

    router.connect();

    const event = createKeyboardEvent();

    dispatcher.dispatch(event);

    expect(windowOneHandler).toHaveBeenCalledOnce();

    expect(windowOneHandler).toHaveBeenCalledWith(event);

    expect(windowTwoHandler).not.toHaveBeenCalled();
  });

  it("routes pointer input to pointer focus", () => {
    const { dispatcher, focusManager, router } = createFixture();

    const windowOneHandler = vi.fn();

    const windowTwoHandler = vi.fn();

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: windowOneHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: windowTwoHandler,
    });

    focusManager.focusKeyboard("window-1");

    focusManager.focusPointer("window-2");

    router.connect();

    const event = createPointerEvent();

    dispatcher.dispatch(event);

    expect(windowTwoHandler).toHaveBeenCalledOnce();

    expect(windowTwoHandler).toHaveBeenCalledWith(event);

    expect(windowOneHandler).not.toHaveBeenCalled();
  });

  it("resolves focus at dispatch time", () => {
    const { dispatcher, focusManager, router } = createFixture();

    const windowOneHandler = vi.fn();

    const windowTwoHandler = vi.fn();

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: windowOneHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: windowTwoHandler,
    });

    router.connect();

    focusManager.focusKeyboard("window-1");

    dispatcher.dispatch(createKeyboardEvent());

    focusManager.focusKeyboard("window-2");

    dispatcher.dispatch(createKeyboardEvent());

    expect(windowOneHandler).toHaveBeenCalledOnce();

    expect(windowTwoHandler).toHaveBeenCalledOnce();
  });

  it("does not deliver input without a focused target", () => {
    const { router } = createFixture();

    const handler = vi.fn();

    router.registerTarget({
      targetId: "window-1",

      handler,
    });

    const result = router.route(createKeyboardEvent());

    expect(result.delivered).toBe(false);

    expect(result.targetId).toBeNull();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not deliver when the focused target has no handler", () => {
    const { focusManager, router } = createFixture();

    focusManager.registerTarget("window-1");

    focusManager.focusKeyboard("window-1");

    const result = router.route(createKeyboardEvent());

    expect(result.delivered).toBe(false);

    expect(result.targetId).toBe("window-1");
  });

  it("wraps target handler failures", () => {
    const { focusManager, router } = createFixture();

    const cause = new Error("Target failed.");

    focusManager.registerTarget("window-1");

    focusManager.focusKeyboard("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler: () => {
        throw cause;
      },
    });

    expect(() => {
      router.route(createKeyboardEvent());
    }).toThrow(FocusedInputTargetHandlerError);
  });

  it("returns immutable route results", () => {
    const { focusManager, router } = createFixture();

    focusManager.registerTarget("window-1");

    focusManager.focusKeyboard("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    const result = router.route(createKeyboardEvent());

    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns immutable target ID snapshots", () => {
    const { router } = createFixture();

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    expect(Object.isFrozen(router.listTargetIds())).toBe(true);
  });

  it("clears all target handlers", () => {
    const { router } = createFixture();

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    router.registerTarget({
      targetId: "window-2",

      handler: vi.fn(),
    });

    router.clearTargets();

    expect(router.targetCount).toBe(0);
  });

  it("emits successful routing events", () => {
    const events: FocusedInputRouterEvent[] = [];

    const registry = new InputDeviceRegistry();

    const dispatcher = new InputDispatcher({
      deviceRegistry: registry,
    });

    const focusManager = new FocusManager();

    const router = new FocusedInputRouter({
      dispatcher,

      focusManager,

      onEvent: (event) => {
        events.push(event);
      },
      pointerCaptureManager: new PointerCaptureManager({
        now: () => 100,
      }),
    });

    focusManager.registerTarget("window-1");

    focusManager.focusKeyboard("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    events.length = 0;

    router.route(createKeyboardEvent());

    expect(events.map((event) => event.type)).toEqual([
      "focused-input-route-started",
      "focused-input-route-completed",
    ]);
  });

  it("emits unrouted events", () => {
    const events: FocusedInputRouterEvent[] = [];

    const registry = new InputDeviceRegistry();

    const dispatcher = new InputDispatcher({
      deviceRegistry: registry,
    });

    const focusManager = new FocusManager();

    const router = new FocusedInputRouter({
      dispatcher,

      focusManager,

      onEvent: (event) => {
        events.push(event);
      },
      pointerCaptureManager: new PointerCaptureManager({
        now: () => 100,
      }),
    });

    router.route(createKeyboardEvent());

    expect(events).toHaveLength(1);

    expect(events[0]?.type).toBe("focused-input-route-unrouted");
  });

  it("routes pointer input to the captured target before pointer focus", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    const capturedHandler = vi.fn();

    const focusedHandler = vi.fn();

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: capturedHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: focusedHandler,
    });

    focusManager.focusPointer("window-2");

    pointerCaptureManager.capture(1, "window-1");

    const event = createPointerEvent("pointer-move");

    const result = router.route(event);

    expect(result.targetId).toBe("window-1");

    expect(capturedHandler).toHaveBeenCalledWith(event);

    expect(focusedHandler).not.toHaveBeenCalled();

    expect(pointerCaptureManager.has(1)).toBe(true);
  });

  it("routes pointer up to the captured target before releasing capture", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    const capturedHandler = vi.fn(() => {
      expect(pointerCaptureManager.has(1)).toBe(true);
    });

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: capturedHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: vi.fn(),
    });

    focusManager.focusPointer("window-2");

    pointerCaptureManager.capture(1, "window-1");

    const event = createPointerEvent("pointer-up");

    const result = router.route(event);

    expect(result.targetId).toBe("window-1");

    expect(capturedHandler).toHaveBeenCalledWith(event);

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("routes pointer cancel to the captured target before releasing capture", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    const handler = vi.fn();

    focusManager.registerTarget("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler,
    });

    pointerCaptureManager.capture(1, "window-1");

    const event = createPointerEvent("pointer-cancel");

    router.route(event);

    expect(handler).toHaveBeenCalledWith(event);

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("releases capture after pointer up even when the target handler fails", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    focusManager.registerTarget("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler: () => {
        throw new Error("Target failed.");
      },
    });

    pointerCaptureManager.capture(1, "window-1");

    expect(() => {
      router.route(createPointerEvent("pointer-up"));
    }).toThrow(FocusedInputTargetHandlerError);

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("releases pointer captures when a target handler is removed", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    focusManager.registerTarget("window-1");

    router.registerTarget({
      targetId: "window-1",

      handler: vi.fn(),
    });

    pointerCaptureManager.capture(1, "window-1");

    router.removeTarget("window-1");

    expect(pointerCaptureManager.has(1)).toBe(false);
  });

  it("only applies capture belonging to the current pointer", () => {
    const { focusManager, pointerCaptureManager, router } = createFixture();

    const capturedHandler = vi.fn();

    const focusedHandler = vi.fn();

    focusManager.registerTarget("window-1");

    focusManager.registerTarget("window-2");

    router.registerTarget({
      targetId: "window-1",

      handler: capturedHandler,
    });

    router.registerTarget({
      targetId: "window-2",

      handler: focusedHandler,
    });

    focusManager.focusPointer("window-2");

    pointerCaptureManager.capture(2, "window-1");

    router.route(createPointerEvent("pointer-move"));

    expect(capturedHandler).not.toHaveBeenCalled();

    expect(focusedHandler).toHaveBeenCalledOnce();
  });
});
