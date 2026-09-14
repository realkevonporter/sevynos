import { describe, expect, it } from "vitest";

import { createInputDeviceDescriptor } from "./input-device.js";
import {
  InputDeviceAlreadyDisconnectedError,
  InputDeviceAlreadyRegisteredError,
  InputDeviceNotFoundError,
} from "../errors/input-device-errors.js";
import type { InputDeviceRegistryEvent } from "./input-device-events.js";
import { InputDeviceRegistry } from "./input-device-registry.js";

function createMouseDescriptor() {
  return createInputDeviceDescriptor({
    id: "mouse-1",

    name: "Sevyn Mouse",

    kind: "mouse",

    capabilities: ["pointer", "wheel", "hover"],

    vendorId: "sevyn",

    productId: "mouse-001",
  });
}

describe("InputDeviceRegistry", () => {
  it("starts empty", () => {
    const registry = new InputDeviceRegistry();

    expect(registry.size).toBe(0);

    expect(registry.list()).toEqual([]);
  });

  it("registers a connected input device", () => {
    const registry = new InputDeviceRegistry();

    const descriptor = createMouseDescriptor();

    const device = registry.register(descriptor, 100);

    expect(device).toEqual({
      descriptor,

      state: "connected",

      connectedAt: 100,
    });

    expect(registry.size).toBe(1);

    expect(registry.get("mouse-1")).toBe(device);
  });

  it("rejects duplicate device IDs", () => {
    const registry = new InputDeviceRegistry();

    const descriptor = createMouseDescriptor();

    registry.register(descriptor, 100);

    expect(() => {
      registry.register(descriptor, 200);
    }).toThrow(InputDeviceAlreadyRegisteredError);
  });

  it("requires an existing device", () => {
    const registry = new InputDeviceRegistry();

    expect(() => {
      registry.require("missing-device");
    }).toThrow(InputDeviceNotFoundError);
  });

  it("checks whether a device exists", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    expect(registry.has("mouse-1")).toBe(true);

    expect(registry.has("keyboard-1")).toBe(false);
  });

  it("disconnects a device", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    const device = registry.disconnect("mouse-1", 250);

    expect(device.state).toBe("disconnected");

    expect(device.connectedAt).toBe(100);

    expect(device.disconnectedAt).toBe(250);

    expect(registry.require("mouse-1")).toBe(device);
  });

  it("rejects disconnecting a missing device", () => {
    const registry = new InputDeviceRegistry();

    expect(() => {
      registry.disconnect("missing-device", 100);
    }).toThrow(InputDeviceNotFoundError);
  });

  it("rejects disconnecting an already disconnected device", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    registry.disconnect("mouse-1", 200);

    expect(() => {
      registry.disconnect("mouse-1", 300);
    }).toThrow(InputDeviceAlreadyDisconnectedError);
  });

  it("lists connected and disconnected devices separately", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    registry.register(
      createInputDeviceDescriptor({
        id: "keyboard-1",

        name: "Sevyn Keyboard",

        kind: "keyboard",

        capabilities: ["keyboard"],
      }),
      110,
    );

    registry.disconnect("mouse-1", 200);

    expect(registry.listConnected().map((device) => device.descriptor.id)).toEqual([
      "keyboard-1",
    ]);

    expect(registry.listDisconnected().map((device) => device.descriptor.id)).toEqual([
      "mouse-1",
    ]);
  });

  it("removes a device", () => {
    const registry = new InputDeviceRegistry();

    const registered = registry.register(createMouseDescriptor(), 100);

    const removed = registry.remove("mouse-1");

    expect(removed).toBe(registered);

    expect(registry.size).toBe(0);

    expect(registry.has("mouse-1")).toBe(false);
  });

  it("rejects removing a missing device", () => {
    const registry = new InputDeviceRegistry();

    expect(() => {
      registry.remove("missing-device");
    }).toThrow(InputDeviceNotFoundError);
  });

  it("clears every registered device", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    registry.register(
      createInputDeviceDescriptor({
        id: "keyboard-1",

        name: "Sevyn Keyboard",

        kind: "keyboard",

        capabilities: ["keyboard"],
      }),
      110,
    );

    const removed = registry.clear();

    expect(removed).toHaveLength(2);

    expect(registry.size).toBe(0);
  });

  it("returns immutable list snapshots", () => {
    const registry = new InputDeviceRegistry();

    registry.register(createMouseDescriptor(), 100);

    const devices = registry.list();

    expect(Object.isFrozen(devices)).toBe(true);
  });

  it("creates immutable descriptors and capabilities", () => {
    const capabilities = ["pointer", "wheel"] as const;

    const descriptor = createInputDeviceDescriptor({
      id: "mouse-1",

      name: "Sevyn Mouse",

      kind: "mouse",

      capabilities,
    });

    expect(Object.isFrozen(descriptor)).toBe(true);

    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);

    expect(descriptor.capabilities).not.toBe(capabilities);
  });

  it("emits registration events", () => {
    const events: InputDeviceRegistryEvent[] = [];

    const registry = new InputDeviceRegistry({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const device = registry.register(createMouseDescriptor(), 100);

    expect(events).toEqual([
      {
        type: "device-registered",

        device,
      },
    ]);
  });

  it("emits disconnection events", () => {
    const events: InputDeviceRegistryEvent[] = [];

    const registry = new InputDeviceRegistry({
      onEvent: (event) => {
        events.push(event);
      },
    });

    registry.register(createMouseDescriptor(), 100);

    events.length = 0;

    const device = registry.disconnect("mouse-1", 200);

    expect(events).toEqual([
      {
        type: "device-disconnected",

        device,
      },
    ]);
  });

  it("emits removal events", () => {
    const events: InputDeviceRegistryEvent[] = [];

    const registry = new InputDeviceRegistry({
      onEvent: (event) => {
        events.push(event);
      },
    });

    const device = registry.register(createMouseDescriptor(), 100);

    events.length = 0;

    registry.remove("mouse-1");

    expect(events).toEqual([
      {
        type: "device-removed",

        device,
      },
    ]);
  });

  it("emits one removal event per device when cleared", () => {
    const events: InputDeviceRegistryEvent[] = [];

    const registry = new InputDeviceRegistry({
      onEvent: (event) => {
        events.push(event);
      },
    });

    registry.register(createMouseDescriptor(), 100);

    registry.register(
      createInputDeviceDescriptor({
        id: "keyboard-1",

        name: "Sevyn Keyboard",

        kind: "keyboard",

        capabilities: ["keyboard"],
      }),
      110,
    );

    events.length = 0;

    registry.clear();

    expect(events.map((event) => event.type)).toEqual([
      "device-removed",
      "device-removed",
    ]);
  });
});
