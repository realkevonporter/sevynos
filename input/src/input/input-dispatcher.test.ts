import { describe, expect, it, vi } from "vitest";

import { createInputDeviceDescriptor } from "./input-device.js";
import { InputDeviceRegistry } from "./input-device-registry.js";
import {
  InputDispatchDeviceKindMismatchError,
  InputDispatchDisconnectedDeviceError,
  InputDispatchListenerError,
  InputDispatchUnknownDeviceError,
  InputListenerAlreadyRegisteredError,
  InputListenerNotFoundError,
} from "../errors/input-dispatcher-errors.js";
import type { InputDispatcherEvent } from "./input-dispatcher-events.js";
import { InputDispatcher } from "./input-dispatcher.js";
import { createKeyboardInputEvent } from "./keyboard-input-event.js";
import { createPointerInputEvent } from "./pointer-input-event.js";

const noopInputListener = vi.fn();

function createMouseRegistry(): InputDeviceRegistry {
  const registry = new InputDeviceRegistry();

  registry.register(
    createInputDeviceDescriptor({
      id: "mouse-1",

      name: "Sevyn Mouse",

      kind: "mouse",

      capabilities: ["pointer", "wheel", "hover"],
    }),
    100,
  );

  return registry;
}

function createPointerEvent() {
  return createPointerInputEvent({
    type: "pointer-down",

    eventId: "event-1",

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 200,

    pointerId: 1,

    position: {
      x: 25,

      y: 50,
    },

    button: "primary",

    buttons: ["primary"],
  });
}

describe("InputDispatcher", () => {
  it("starts without listeners", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    expect(dispatcher.listenerCount).toBe(0);

    expect(dispatcher.listListenerIds()).toEqual([]);
  });

  it("registers a listener", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    expect(dispatcher.listenerCount).toBe(1);

    expect(dispatcher.hasListener("listener-1")).toBe(true);
  });

  it("rejects duplicate listener IDs", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    expect(() => {
      dispatcher.addListener({
        id: "listener-1",

        listener: noopInputListener,
      });
    }).toThrow(InputListenerAlreadyRegisteredError);
  });

  it("removes a listener", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    dispatcher.removeListener("listener-1");

    expect(dispatcher.listenerCount).toBe(0);

    expect(dispatcher.hasListener("listener-1")).toBe(false);
  });

  it("rejects removing an unknown listener", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    expect(() => {
      dispatcher.removeListener("missing-listener");
    }).toThrow(InputListenerNotFoundError);
  });

  it("dispatches events to listeners in registration order", () => {
    const received: string[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: () => {
        received.push("listener-1");
      },
    });

    dispatcher.addListener({
      id: "listener-2",

      listener: () => {
        received.push("listener-2");
      },
    });

    const result = dispatcher.dispatch(createPointerEvent());

    expect(received).toEqual(["listener-1", "listener-2"]);

    expect(result.deliveredTo).toEqual(["listener-1", "listener-2"]);
  });

  it("delivers the same immutable event instance", () => {
    const received: unknown[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: (event) => {
        received.push(event);
      },
    });

    const event = createPointerEvent();

    dispatcher.dispatch(event);

    expect(received[0]).toBe(event);

    expect(Object.isFrozen(event)).toBe(true);
  });

  it("dispatches successfully with no listeners", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    const result = dispatcher.dispatch(createPointerEvent());

    expect(result.deliveredTo).toEqual([]);
  });

  it("rejects events from unknown devices", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: new InputDeviceRegistry(),
    });

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchUnknownDeviceError);
  });

  it("rejects events from disconnected devices", () => {
    const registry = createMouseRegistry();

    registry.disconnect("mouse-1", 300);

    const dispatcher = new InputDispatcher({
      deviceRegistry: registry,
    });

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchDisconnectedDeviceError);
  });

  it("rejects device kind mismatches", () => {
    const registry = createMouseRegistry();

    const dispatcher = new InputDispatcher({
      deviceRegistry: registry,
    });

    const event = createKeyboardInputEvent({
      type: "key-down",

      eventId: "event-2",

      deviceId: "mouse-1",

      deviceKind: "keyboard",

      timestamp: 300,

      code: "KeyA",

      key: "a",
    });

    expect(() => {
      dispatcher.dispatch(event);
    }).toThrow(InputDispatchDeviceKindMismatchError);
  });

  it("wraps listener failures", () => {
    const cause = new Error("Listener failed.");

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "broken-listener",

      listener: () => {
        throw cause;
      },
    });

    let receivedError: unknown;

    try {
      dispatcher.dispatch(createPointerEvent());
    } catch (error: unknown) {
      receivedError = error;
    }

    expect(receivedError).toBeInstanceOf(InputDispatchListenerError);

    expect(receivedError).toMatchObject({
      listenerId: "broken-listener",

      cause,
    });
  });

  it("stops dispatch after a listener failure", () => {
    const secondListener = vi.fn();

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "broken-listener",

      listener: () => {
        throw new Error("Failure");
      },
    });

    dispatcher.addListener({
      id: "second-listener",

      listener: secondListener,
    });

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchListenerError);

    expect(secondListener).not.toHaveBeenCalled();
  });

  it("uses a listener snapshot during dispatch", () => {
    const received: string[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    let removedListenerTwo = false;

    dispatcher.addListener({
      id: "listener-1",

      listener: () => {
        received.push("listener-1");

        if (!removedListenerTwo) {
          dispatcher.removeListener("listener-2");

          removedListenerTwo = true;
        }
      },
    });

    dispatcher.addListener({
      id: "listener-2",

      listener: () => {
        received.push("listener-2");
      },
    });

    dispatcher.dispatch(createPointerEvent());

    expect(received).toEqual(["listener-1", "listener-2"]);

    received.length = 0;

    dispatcher.dispatch(createPointerEvent());

    expect(received).toEqual(["listener-1"]);
  });

  it("does not run listeners when validation fails", () => {
    const listener = vi.fn();

    const dispatcher = new InputDispatcher({
      deviceRegistry: new InputDeviceRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener,
    });

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchUnknownDeviceError);

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns immutable results", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    const result = dispatcher.dispatch(createPointerEvent());

    expect(Object.isFrozen(result)).toBe(true);

    expect(Object.isFrozen(result.deliveredTo)).toBe(true);
  });

  it("returns immutable listener ID snapshots", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    const listenerIds = dispatcher.listListenerIds();

    expect(Object.isFrozen(listenerIds)).toBe(true);
  });

  it("clears all listeners", () => {
    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    dispatcher.addListener({
      id: "listener-2",

      listener: noopInputListener,
    });

    const removed = dispatcher.clearListeners();

    expect(removed).toEqual(["listener-1", "listener-2"]);

    expect(dispatcher.listenerCount).toBe(0);
  });

  it("emits listener lifecycle events", () => {
    const events: InputDispatcherEvent[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),

      onEvent: (event) => {
        events.push(event);
      },
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    dispatcher.removeListener("listener-1");

    expect(events.map((event) => event.type)).toEqual([
      "input-listener-registered",
      "input-listener-removed",
    ]);
  });

  it("emits dispatch lifecycle events", () => {
    const events: InputDispatcherEvent[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),

      onEvent: (event) => {
        events.push(event);
      },
    });

    dispatcher.addListener({
      id: "listener-1",

      listener: noopInputListener,
    });

    events.length = 0;

    dispatcher.dispatch(createPointerEvent());

    expect(events.map((event) => event.type)).toEqual([
      "input-dispatch-started",
      "input-dispatch-completed",
    ]);
  });

  it("emits a rejection event when validation fails", () => {
    const events: InputDispatcherEvent[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: new InputDeviceRegistry(),

      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchUnknownDeviceError);

    expect(events).toHaveLength(1);

    expect(events[0]?.type).toBe("input-dispatch-rejected");
  });

  it("emits a failure event when a listener fails", () => {
    const events: InputDispatcherEvent[] = [];

    const dispatcher = new InputDispatcher({
      deviceRegistry: createMouseRegistry(),

      onEvent: (event) => {
        events.push(event);
      },
    });

    dispatcher.addListener({
      id: "broken-listener",

      listener: () => {
        throw new Error("Failure");
      },
    });

    events.length = 0;

    expect(() => {
      dispatcher.dispatch(createPointerEvent());
    }).toThrow(InputDispatchListenerError);

    expect(events.map((event) => event.type)).toEqual([
      "input-dispatch-started",
      "input-dispatch-failed",
    ]);
  });
});
