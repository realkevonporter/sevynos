export const SEVYN_LINUX_IPC_VERSION = 1 as const;

export interface NativeDisplayConfiguration {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scaleFactor: number;
  readonly refreshRate: number;
  readonly primary: boolean;
}

interface NativeEnvelope {
  readonly protocolVersion: typeof SEVYN_LINUX_IPC_VERSION;
  readonly sequence: number;
}

export type NativeBridgeMessage =
  | (NativeEnvelope & {
      readonly type: "ready";
      readonly displays: readonly NativeDisplayConfiguration[];
    })
  | (NativeEnvelope & {
      readonly type: "display-configured";
      readonly displays: readonly NativeDisplayConfiguration[];
    })
  | (NativeEnvelope & {
      readonly type: "pointer";
      readonly event: "move" | "down" | "up" | "cancel";
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      readonly button: number;
      readonly buttons: number;
      readonly timestamp: number;
      readonly traceId?: string;
    })
  | (NativeEnvelope & {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly timestamp: number;
    })
  | (NativeEnvelope & {
      readonly type: "keyboard";
      readonly event: "down" | "up";
      readonly key: string;
      readonly code: string;
      readonly repeat: boolean;
      readonly shift: boolean;
      readonly alt: boolean;
      readonly control: boolean;
      readonly meta: boolean;
      readonly timestamp: number;
    })
  | (NativeEnvelope & {
      readonly type: "clipboard-text";
      readonly requestId: string;
      readonly text: string;
    })
  | (NativeEnvelope & {
      readonly type: "frame-presented";
      readonly frameId: number;
      readonly displayId: string;
      readonly traceId?: string;
    })
  | (NativeEnvelope & { readonly type: "shutdown-requested"; readonly reason: string })
  | (NativeEnvelope & {
      readonly type: "diagnostic";
      readonly severity: "info" | "warning" | "error";
      readonly event: string;
      readonly message: string;
    });

export type LinuxHostMessage =
  | (NativeEnvelope & { readonly type: "initialize"; readonly applicationName: string })
  | (NativeEnvelope & {
      readonly type: "configure";
      readonly width: number;
      readonly height: number;
      readonly scaleFactor: number;
    })
  | (NativeEnvelope & {
      readonly type: "capture-pointer";
      readonly pointerId: number;
      readonly captured: boolean;
    })
  | (NativeEnvelope & { readonly type: "clipboard-read"; readonly requestId: string })
  | (NativeEnvelope & {
      readonly type: "clipboard-write";
      readonly requestId: string;
      readonly text: string;
    })
  | (NativeEnvelope & { readonly type: "shutdown-complete" });
export type LinuxHostPayload = LinuxHostMessage extends infer Message
  ? Message extends NativeEnvelope
    ? Omit<Message, "protocolVersion" | "sequence">
    : never
  : never;
export type NativeBridgePayload = NativeBridgeMessage extends infer Message
  ? Message extends NativeEnvelope
    ? Omit<Message, "protocolVersion" | "sequence">
    : never
  : never;

export function validateNativeBridgeMessage(value: unknown): NativeBridgeMessage {
  const item = record(value, "Native bridge message");
  envelope(item);
  const type = string(item, "type", 64);
  switch (type) {
    case "ready":
    case "display-configured":
      return { ...base(item), type, displays: displays(item["displays"]) };
    case "pointer": {
      const event = string(item, "event", 16);
      if (!isPointerEvent(event)) throw new Error("Native pointer event is invalid.");
      return {
        ...base(item),
        type,
        event,
        pointerId: integer(item, "pointerId"),
        x: finite(item, "x"),
        y: finite(item, "y"),
        button: integer(item, "button"),
        buttons: integer(item, "buttons"),
        timestamp: finite(item, "timestamp"),
        ...(item["traceId"] === undefined
          ? {}
          : { traceId: string(item, "traceId", 128) }),
      };
    }
    case "wheel":
      return {
        ...base(item),
        type,
        x: finite(item, "x"),
        y: finite(item, "y"),
        deltaX: finite(item, "deltaX"),
        deltaY: finite(item, "deltaY"),
        timestamp: finite(item, "timestamp"),
      };
    case "keyboard": {
      const event = string(item, "event", 16);
      if (event !== "down" && event !== "up")
        throw new Error("Native keyboard event is invalid.");
      return {
        ...base(item),
        type,
        event,
        key: string(item, "key", 128),
        code: string(item, "code", 128),
        repeat: boolean(item, "repeat"),
        shift: boolean(item, "shift"),
        alt: boolean(item, "alt"),
        control: boolean(item, "control"),
        meta: boolean(item, "meta"),
        timestamp: finite(item, "timestamp"),
      };
    }
    case "clipboard-text":
      return {
        ...base(item),
        type,
        requestId: string(item, "requestId", 128),
        text: string(item, "text", 1024 * 1024),
      };
    case "frame-presented":
      return {
        ...base(item),
        type,
        frameId: integer(item, "frameId"),
        displayId: string(item, "displayId", 128),
        ...(item["traceId"] === undefined
          ? {}
          : { traceId: string(item, "traceId", 128) }),
      };
    case "shutdown-requested":
      return { ...base(item), type, reason: string(item, "reason", 240) };
    case "diagnostic": {
      const severity = string(item, "severity", 16);
      if (severity !== "info" && severity !== "warning" && severity !== "error")
        throw new Error("Native diagnostic severity is invalid.");
      return {
        ...base(item),
        type,
        severity,
        event: string(item, "event", 80),
        message: string(item, "message", 240),
      };
    }
    default:
      throw new Error(`Native bridge message type "${type}" is unsupported.`);
  }
}

export function validateLinuxHostMessage(value: unknown): LinuxHostMessage {
  const item = record(value, "Linux host message");
  envelope(item);
  const type = string(item, "type", 64);
  if (JSON.stringify(item).length > 96 * 1024 * 1024)
    throw new Error("Linux host message exceeds the IPC size limit.");
  switch (type) {
    case "initialize":
      return {
        ...base(item),
        type,
        applicationName: string(item, "applicationName", 128),
      };
    case "configure":
      return {
        ...base(item),
        type,
        width: positive(item, "width"),
        height: positive(item, "height"),
        scaleFactor: positive(item, "scaleFactor"),
      };
    case "capture-pointer":
      return {
        ...base(item),
        type,
        pointerId: integer(item, "pointerId"),
        captured: boolean(item, "captured"),
      };
    case "clipboard-read":
      return { ...base(item), type, requestId: string(item, "requestId", 128) };
    case "clipboard-write":
      return {
        ...base(item),
        type,
        requestId: string(item, "requestId", 128),
        text: string(item, "text", 1024 * 1024),
      };
    case "shutdown-complete":
      return { ...base(item), type };
    default:
      throw new Error(`Linux host message type "${type}" is unsupported.`);
  }
}

function displays(value: unknown): readonly NativeDisplayConfiguration[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    throw new Error("Native displays must be a non-empty bounded array.");
  return Object.freeze(
    value.map((candidate: unknown) => {
      const item = record(candidate, "Native display");
      const display = {
        id: string(item, "id", 128),
        x: finite(item, "x"),
        y: finite(item, "y"),
        width: positive(item, "width"),
        height: positive(item, "height"),
        pixelWidth: positive(item, "pixelWidth"),
        pixelHeight: positive(item, "pixelHeight"),
        scaleFactor: positive(item, "scaleFactor"),
        refreshRate: positive(item, "refreshRate"),
        primary: boolean(item, "primary"),
      };
      return Object.freeze(display);
    }),
  );
}
function base(item: Readonly<Record<string, unknown>>): NativeEnvelope {
  return { protocolVersion: 1, sequence: integer(item, "sequence") };
}
function envelope(item: Readonly<Record<string, unknown>>): void {
  if (item["protocolVersion"] !== 1)
    throw new Error("Native IPC protocol version is unsupported.");
  integer(item, "sequence");
}
function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}
function string(
  item: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): string {
  const value = item[key];
  if (typeof value !== "string" || value.length > maximum)
    throw new Error(`Native field "${key}" must be a bounded string.`);
  return value;
}
function finite(item: Readonly<Record<string, unknown>>, key: string): number {
  const value = item[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Native field "${key}" must be finite.`);
  return value;
}
function integer(item: Readonly<Record<string, unknown>>, key: string): number {
  const value = finite(item, key);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Native field "${key}" must be a non-negative integer.`);
  return value;
}
function positive(item: Readonly<Record<string, unknown>>, key: string): number {
  const value = finite(item, key);
  if (value <= 0) throw new Error(`Native field "${key}" must be positive.`);
  return value;
}
function boolean(item: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = item[key];
  if (typeof value !== "boolean")
    throw new Error(`Native field "${key}" must be boolean.`);
  return value;
}
function isPointerEvent(value: string): value is "move" | "down" | "up" | "cancel" {
  return value === "move" || value === "down" || value === "up" || value === "cancel";
}
