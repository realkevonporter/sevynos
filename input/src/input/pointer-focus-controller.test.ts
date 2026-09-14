import { describe, expect, it, vi } from "vitest";

import { PointerFocusTargetNotRegisteredError } from "../errors/pointer-focus-controller-errors.js";
import { PointerWindowActivationError } from "../errors/pointer-window-activation-error.js";
import { GenesisWindow } from "@sevynos/graphics";
import { FocusManager } from "./focus-manager.js";
import { InputDeviceRegistry } from "./input-device-registry.js";
import { InputDispatcher } from "./input-dispatcher.js";
import type { PointerFocusControllerEvent } from "./pointer-focus-controller-events.js";
import { PointerFocusController } from "./pointer-focus-controller.js";
import { createPointerInputEvent } from "./pointer-input-event.js";
import { WindowHitTester } from "./window-hit-tester.js";

const CREATED_AT = new Date("2026-07-31T16:00:00.000Z");

function createWindow(
  id: `window-${string}`,
  options: {
    readonly x?: number;
    readonly y?: number;
    readonly zIndex?: number;
  } = {},
): GenesisWindow {
  return new GenesisWindow({
    id,
    sessionId: `session-${id}`,
    title: id,

    bounds: {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: 400,
      height: 300,
    },

    state: "visible",
    zIndex: options.zIndex ?? 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function createPointerEvent(
  type: "pointer-move" | "pointer-down" | "pointer-up" | "pointer-cancel",
  x = 100,
  y = 100,
) {
  return createPointerInputEvent({
    type,
    eventId: `event-${type}`,
    deviceId: "mouse-1",
    deviceKind: "mouse",
    timestamp: 1,
    pointerId: 1,

    position: {
      x,
      y,
    },

    button: type === "pointer-down" ? "primary" : "none",
    buttons: type === "pointer-down" ? ["primary"] : [],
    pressure: 0,
  });
}

function createFixture(windows: readonly GenesisWindow[]) {
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

  const focusManager = new FocusManager();

  const hitTester = new WindowHitTester({
    listWindows: () => windows,
  });

  const focusedWindowIds: string[] = [];

  const windowController = {
    focusWindow: (windowId: GenesisWindow["id"]): GenesisWindow => {
      focusedWindowIds.push(windowId);

      const window = windows.find((candidate) => candidate.id === windowId);

      if (window === undefined) {
        throw new Error(`Window "${windowId}" was not found.`);
      }

      return window;
    },
  };

  const controller = new PointerFocusController({
    dispatcher,
    focusManager,
    hitTester,
    windowController,
  });

  return {
    dispatcher,
    focusManager,
    controller,
    focusedWindowIds,
  };
}

describe("PointerFocusController", () => {
  it("starts disconnected", () => {
    const { controller } = createFixture([]);

    expect(controller.connected).toBe(false);
  });

  it("connects and disconnects safely", () => {
    const { controller } = createFixture([]);

    controller.connect();
    controller.connect();

    expect(controller.connected).toBe(true);

    controller.disconnect();
    controller.disconnect();

    expect(controller.connected).toBe(false);
  });

  it("updates pointer focus from hit testing", () => {
    const window = createWindow("window-1");

    const { focusManager, controller } = createFixture([window]);

    focusManager.registerTarget(window.id);

    const result = controller.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(result.targetId).toBe(window.id);
    expect(result.hit).toBe(true);
    expect(focusManager.state.pointerFocus).toBe(window.id);
  });

  it("uses the top-most window", () => {
    const bottom = createWindow("window-1", {
      zIndex: 1,
    });

    const top = createWindow("window-2", {
      zIndex: 2,
    });

    const { focusManager, controller } = createFixture([bottom, top]);

    focusManager.registerTarget(bottom.id);
    focusManager.registerTarget(top.id);

    controller.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(focusManager.state.pointerFocus).toBe(top.id);
  });

  it("clears pointer focus when the pointer misses every window", () => {
    const window = createWindow("window-1");

    const { focusManager, controller } = createFixture([window]);

    focusManager.registerTarget(window.id);
    focusManager.focusPointer(window.id);

    const result = controller.handlePointerEvent(
      createPointerEvent("pointer-move", 1000, 1000),
    );

    expect(result.hit).toBe(false);
    expect(result.targetId).toBeNull();
    expect(focusManager.state.pointerFocus).toBeNull();
  });

  it("focuses the actual window and synchronizes logical focus on pointer down", () => {
    const window = createWindow("window-1");

    const { focusManager, controller, focusedWindowIds } = createFixture([window]);

    focusManager.registerTarget(window.id);

    const result = controller.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(focusedWindowIds).toEqual([window.id]);
    expect(result.activated).toBe(true);

    expect(focusManager.state).toEqual({
      pointerFocus: window.id,
      keyboardFocus: window.id,
      activeWindow: window.id,
    });
  });

  it("does not change keyboard focus on pointer move", () => {
    const first = createWindow("window-1");

    const second = createWindow("window-2", {
      x: 500,
    });

    const { focusManager, controller } = createFixture([first, second]);

    focusManager.registerTarget(first.id);
    focusManager.registerTarget(second.id);

    focusManager.focusKeyboard(first.id);

    controller.handlePointerEvent(createPointerEvent("pointer-move", 550, 100));

    expect(focusManager.state.pointerFocus).toBe(second.id);
    expect(focusManager.state.keyboardFocus).toBe(first.id);
  });

  it("clears pointer focus on pointer cancel", () => {
    const window = createWindow("window-1");

    const { focusManager, controller } = createFixture([window]);

    focusManager.registerTarget(window.id);
    focusManager.focusPointer(window.id);

    controller.handlePointerEvent(createPointerEvent("pointer-cancel"));

    expect(focusManager.state.pointerFocus).toBeNull();
  });

  it("rejects hit windows that are not focus targets", () => {
    const window = createWindow("window-1");

    const { controller } = createFixture([window]);

    expect(() => {
      controller.handlePointerEvent(createPointerEvent("pointer-move"));
    }).toThrow(PointerFocusTargetNotRegisteredError);
  });

  it("receives validated pointer events through the dispatcher", () => {
    const window = createWindow("window-1");

    const { dispatcher, focusManager, controller } = createFixture([window]);

    focusManager.registerTarget(window.id);

    controller.connect();

    dispatcher.dispatch(createPointerEvent("pointer-move"));

    expect(focusManager.state.pointerFocus).toBe(window.id);
  });

  it("ignores keyboard events received through the dispatcher", () => {
    const window = createWindow("window-1");

    const { focusManager, controller } = createFixture([window]);

    const spy = vi.spyOn(controller, "handlePointerEvent");

    focusManager.registerTarget(window.id);

    controller.connect();

    expect(spy).not.toHaveBeenCalled();
  });

  it("returns immutable results", () => {
    const window = createWindow("window-1");

    const { focusManager, controller } = createFixture([window]);

    focusManager.registerTarget(window.id);

    const result = controller.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not update active or keyboard focus when window activation fails", () => {
    const window = createWindow("window-1");

    const devices = new InputDeviceRegistry();

    const dispatcher = new InputDispatcher({
      deviceRegistry: devices,
    });

    const focusManager = new FocusManager();

    focusManager.registerTarget(window.id);

    const activationError = new Error("Window manager failed.");

    const controller = new PointerFocusController({
      dispatcher,
      focusManager,

      hitTester: new WindowHitTester({
        listWindows: () => [window],
      }),

      windowController: {
        focusWindow: () => {
          throw activationError;
        },
      },
    });

    expect(() => {
      controller.handlePointerEvent(createPointerEvent("pointer-down"));
    }).toThrow(PointerWindowActivationError);

    expect(focusManager.state.pointerFocus).toBe(window.id);
    expect(focusManager.state.keyboardFocus).toBeNull();
    expect(focusManager.state.activeWindow).toBeNull();
  });

  it("emits deterministic pointer focus events", () => {
    const events: PointerFocusControllerEvent[] = [];

    const window = createWindow("window-1");

    const devices = new InputDeviceRegistry();

    const dispatcher = new InputDispatcher({
      deviceRegistry: devices,
    });

    const focusManager = new FocusManager();

    focusManager.registerTarget(window.id);

    const controller = new PointerFocusController({
      dispatcher,
      focusManager,

      hitTester: new WindowHitTester({
        listWindows: () => [window],
      }),

      windowController: {
        focusWindow: (windowId): GenesisWindow => {
          if (windowId !== window.id) {
            throw new Error(`Window "${windowId}" was not found.`);
          }

          return window;
        },
      },

      onEvent: (event) => {
        events.push(event);
      },
    });

    controller.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(events.map((event) => event.type)).toEqual([
      "pointer-focus-hit",
      "pointer-focus-updated",
      "pointer-focus-window-activated",
    ]);
  });
});
