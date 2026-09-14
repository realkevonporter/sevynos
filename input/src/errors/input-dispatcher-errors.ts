import type { InputDeviceKind } from "../input/input-event-types.js";

export class InputDispatchUnknownDeviceError extends Error {
  public readonly deviceId: string;

  public constructor(deviceId: string) {
    super(`Cannot dispatch input from unknown device "${deviceId}".`);

    this.name = "InputDispatchUnknownDeviceError";

    this.deviceId = deviceId;
  }
}

export class InputDispatchDisconnectedDeviceError extends Error {
  public readonly deviceId: string;

  public constructor(deviceId: string) {
    super(`Cannot dispatch input from disconnected device "${deviceId}".`);

    this.name = "InputDispatchDisconnectedDeviceError";

    this.deviceId = deviceId;
  }
}

export class InputDispatchDeviceKindMismatchError extends Error {
  public readonly deviceId: string;

  public readonly expectedKind: InputDeviceKind;

  public readonly receivedKind: InputDeviceKind;

  public constructor(
    deviceId: string,
    expectedKind: InputDeviceKind,
    receivedKind: InputDeviceKind,
  ) {
    super(
      `Input device "${deviceId}" is registered as "${expectedKind}" but the event reported "${receivedKind}".`,
    );

    this.name = "InputDispatchDeviceKindMismatchError";

    this.deviceId = deviceId;

    this.expectedKind = expectedKind;

    this.receivedKind = receivedKind;
  }
}

export class InputListenerAlreadyRegisteredError extends Error {
  public readonly listenerId: string;

  public constructor(listenerId: string) {
    super(`Input listener "${listenerId}" is already registered.`);

    this.name = "InputListenerAlreadyRegisteredError";

    this.listenerId = listenerId;
  }
}

export class InputListenerNotFoundError extends Error {
  public readonly listenerId: string;

  public constructor(listenerId: string) {
    super(`Input listener "${listenerId}" was not found.`);

    this.name = "InputListenerNotFoundError";

    this.listenerId = listenerId;
  }
}

export class InputDispatchListenerError extends Error {
  public readonly listenerId: string;

  public override readonly cause: unknown;

  public constructor(listenerId: string, cause: unknown) {
    super(`Input listener "${listenerId}" failed while handling an event.`, {
      cause,
    });

    this.name = "InputDispatchListenerError";

    this.listenerId = listenerId;

    this.cause = cause;
  }
}
