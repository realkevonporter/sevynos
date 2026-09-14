import type { InputDeviceKind } from "./input-event-types.js";
import type { InputDeviceState } from "./input-device-state.js";

export type InputDeviceCapability =
  "pointer" | "keyboard" | "wheel" | "touch" | "pressure" | "hover" | "multi-touch";

export interface InputDeviceDescriptor {
  readonly id: string;

  readonly name: string;

  readonly kind: InputDeviceKind;

  readonly capabilities: readonly InputDeviceCapability[];

  readonly vendorId?: string;

  readonly productId?: string;

  readonly virtual: boolean;
}

export interface InputDevice {
  readonly descriptor: InputDeviceDescriptor;

  readonly state: InputDeviceState;

  readonly connectedAt: number;

  readonly disconnectedAt?: number;
}

export interface CreateInputDeviceDescriptorOptions {
  readonly id: string;

  readonly name: string;

  readonly kind: InputDeviceKind;

  readonly capabilities?: readonly InputDeviceCapability[];

  readonly vendorId?: string;

  readonly productId?: string;

  readonly virtual?: boolean;
}

export function createInputDeviceDescriptor(
  options: CreateInputDeviceDescriptorOptions,
): InputDeviceDescriptor {
  return Object.freeze({
    id: options.id,

    name: options.name,

    kind: options.kind,

    capabilities: Object.freeze([...(options.capabilities ?? [])]),

    virtual: options.virtual ?? false,

    ...(options.vendorId !== undefined
      ? {
          vendorId: options.vendorId,
        }
      : {}),

    ...(options.productId !== undefined
      ? {
          productId: options.productId,
        }
      : {}),
  });
}

export function createConnectedInputDevice(
  descriptor: InputDeviceDescriptor,
  connectedAt: number,
): InputDevice {
  return Object.freeze({
    descriptor,

    state: "connected",

    connectedAt,
  });
}

export function createDisconnectedInputDevice(
  device: InputDevice,
  disconnectedAt: number,
): InputDevice {
  return Object.freeze({
    descriptor: device.descriptor,

    state: "disconnected",

    connectedAt: device.connectedAt,

    disconnectedAt,
  });
}
