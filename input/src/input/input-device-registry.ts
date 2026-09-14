import {
  createConnectedInputDevice,
  createDisconnectedInputDevice,
  type InputDevice,
  type InputDeviceDescriptor,
} from "./input-device.js";
import {
  InputDeviceAlreadyDisconnectedError,
  InputDeviceAlreadyRegisteredError,
  InputDeviceNotFoundError,
} from "../errors/input-device-errors.js";
import type {
  InputDeviceRegistryEvent,
  InputDeviceRegistryEventListener,
} from "./input-device-events.js";

export interface InputDeviceRegistryDependencies {
  readonly onEvent?: InputDeviceRegistryEventListener;
}

export class InputDeviceRegistry {
  readonly #devices = new Map<string, InputDevice>();

  readonly #onEvent: InputDeviceRegistryEventListener | undefined;

  public constructor(dependencies: InputDeviceRegistryDependencies = {}) {
    this.#onEvent = dependencies.onEvent;
  }

  public get size(): number {
    return this.#devices.size;
  }

  public register(descriptor: InputDeviceDescriptor, connectedAt: number): InputDevice {
    if (this.#devices.has(descriptor.id)) {
      throw new InputDeviceAlreadyRegisteredError(descriptor.id);
    }

    const device = createConnectedInputDevice(descriptor, connectedAt);

    this.#devices.set(descriptor.id, device);

    this.#emit({
      type: "device-registered",

      device,
    });

    return device;
  }

  public get(deviceId: string): InputDevice | undefined {
    return this.#devices.get(deviceId);
  }

  public require(deviceId: string): InputDevice {
    const device = this.get(deviceId);

    if (device === undefined) {
      throw new InputDeviceNotFoundError(deviceId);
    }

    return device;
  }

  public has(deviceId: string): boolean {
    return this.#devices.has(deviceId);
  }

  public list(): readonly InputDevice[] {
    return Object.freeze([...this.#devices.values()]);
  }

  public listConnected(): readonly InputDevice[] {
    return Object.freeze(this.list().filter((device) => device.state === "connected"));
  }

  public listDisconnected(): readonly InputDevice[] {
    return Object.freeze(this.list().filter((device) => device.state === "disconnected"));
  }

  public disconnect(deviceId: string, disconnectedAt: number): InputDevice {
    const device = this.require(deviceId);

    if (device.state === "disconnected") {
      throw new InputDeviceAlreadyDisconnectedError(deviceId);
    }

    const disconnectedDevice = createDisconnectedInputDevice(device, disconnectedAt);

    this.#devices.set(deviceId, disconnectedDevice);

    this.#emit({
      type: "device-disconnected",

      device: disconnectedDevice,
    });

    return disconnectedDevice;
  }

  public remove(deviceId: string): InputDevice {
    const device = this.require(deviceId);

    this.#devices.delete(deviceId);

    this.#emit({
      type: "device-removed",

      device,
    });

    return device;
  }

  public clear(): readonly InputDevice[] {
    const removedDevices = this.list();

    this.#devices.clear();

    for (const device of removedDevices) {
      this.#emit({
        type: "device-removed",

        device,
      });
    }

    return removedDevices;
  }

  #emit(event: InputDeviceRegistryEvent): void {
    this.#onEvent?.(event);
  }
}
