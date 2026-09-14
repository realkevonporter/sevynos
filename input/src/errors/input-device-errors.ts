export class InputDeviceAlreadyRegisteredError extends Error {
  public readonly deviceId: string;

  public constructor(deviceId: string) {
    super(`Input device "${deviceId}" is already registered.`);

    this.name = "InputDeviceAlreadyRegisteredError";

    this.deviceId = deviceId;
  }
}

export class InputDeviceNotFoundError extends Error {
  public readonly deviceId: string;

  public constructor(deviceId: string) {
    super(`Input device "${deviceId}" was not found.`);

    this.name = "InputDeviceNotFoundError";

    this.deviceId = deviceId;
  }
}

export class InputDeviceAlreadyDisconnectedError extends Error {
  public readonly deviceId: string;

  public constructor(deviceId: string) {
    super(`Input device "${deviceId}" is already disconnected.`);

    this.name = "InputDeviceAlreadyDisconnectedError";

    this.deviceId = deviceId;
  }
}
