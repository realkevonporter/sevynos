import type { InputDevice } from "./input-device.js";

export interface InputDeviceRegisteredEvent {
  readonly type: "device-registered";

  readonly device: InputDevice;
}

export interface InputDeviceDisconnectedEvent {
  readonly type: "device-disconnected";

  readonly device: InputDevice;
}

export interface InputDeviceRemovedEvent {
  readonly type: "device-removed";

  readonly device: InputDevice;
}

export type InputDeviceRegistryEvent =
  InputDeviceRegisteredEvent | InputDeviceDisconnectedEvent | InputDeviceRemovedEvent;

export type InputDeviceRegistryEventListener = (event: InputDeviceRegistryEvent) => void;
