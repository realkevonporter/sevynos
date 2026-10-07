import type { SevynPermission } from "./application-platform.js";

export const SEVYN_WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerLifecycleState =
  | "starting"
  | "running"
  | "suspended"
  | "unresponsive"
  | "crashed"
  | "terminated"
  | "disabled";
export type StructuredValue =
  | null
  | boolean
  | number
  | string
  | readonly StructuredValue[]
  | { readonly [key: string]: StructuredValue };

interface ProtocolMessage {
  readonly protocolVersion: typeof SEVYN_WORKER_PROTOCOL_VERSION;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly sequence: number;
}
export type HostWorkerMessage =
  | (ProtocolMessage & {
      readonly type: "initialize";
      readonly manifest: StructuredValue;
      readonly applicationKey: string;
      readonly bundleSource: string;
      readonly grantedPermissions: readonly SevynPermission[];
      readonly persistedState: StructuredValue;
    })
  | (ProtocolMessage & { readonly type: "mount"; readonly viewport: StructuredValue })
  | (ProtocolMessage & {
      readonly type: "reload";
      readonly applicationKey: string;
      readonly bundleSource: string;
    })
  | (ProtocolMessage & {
      readonly type: "event";
      readonly eventId: string;
      readonly event: StructuredValue;
    })
  | (ProtocolMessage & {
      readonly type: "service-response";
      readonly requestId: string;
      readonly ok: boolean;
      readonly value: StructuredValue;
    })
  | (ProtocolMessage & {
      readonly type: "lifecycle";
      readonly state: "running" | "suspended";
    })
  | (ProtocolMessage & { readonly type: "shutdown"; readonly reason: string });

export type WorkerServiceName =
  | "storage.get"
  | "storage.set"
  | "filesystem.list"
  | "filesystem.read"
  | "filesystem.write"
  | "clipboard.read"
  | "clipboard.write"
  | "notifications.show"
  | "accessibility.state"
  | "accessibility.announce"
  | "linking.open"
  | "network.info"
  | "network.request"
  | "websocket.open"
  | "websocket.send"
  | "websocket.receive"
  | "websocket.close"
  | "image.load"
  | "location.current"
  | "camera.capture"
  | "camera.recordStart"
  | "camera.recordStop"
  | "camera.preview"
  | "camera.readImage"
  | "camera.playVideo"
  | "camera.videoFrame"
  | "camera.stopVideo"
  | "camera.status"
  | "camera.torch"
  | "battery.status"
  | "display.brightness.get"
  | "display.brightness.set"
  | "display.orientation.get"
  | "display.orientation.lock"
  | "display.autoBrightness.get"
  | "display.autoBrightness.set"
  | "display.wakeLock.acquire"
  | "display.wakeLock.release"
  | "audio.outputs.get"
  | "audio.output.set"
  | "vibration.vibrate"
  | "vibration.cancel"
  | "nfc.status"
  | "nfc.scan"
  | "nfc.write"
  | "cellular.status"
  | "cellular.signal"
  | "cellular.bearer"
  | "cellular.dial"
  | "cellular.hangup"
  | "cellular.answer"
  | "cellular.sms.send"
  | "cellular.sms.list"
  | "microphone.record"
  | "microphone.start"
  | "microphone.stop"
  | "bluetooth.scan"
  | "sensors.read"
  | "sensors.subscribe"
  | "sensors.unsubscribe"
  | "biometrics.authenticate"
  | "biometrics.enroll"
  | "biometrics.delete"
  | "biometrics.list"
  | "biometrics.pin.verify"
  | "biometrics.keystore.get"
  | "biometrics.keystore.set"
  | "biometrics.keystore.delete"
  | "biometrics.keystore.list"
  | "media.play"
  | "media.pause"
  | "media.resume"
  | "media.stop"
  | "media.seek"
  | "media.volume"
  | "media.status"
  | "media.scan"
  | "native.invoke"
  | "webview.open"
  | "webview.action"
  | "webview.close";

export type WorkerHostMessage =
  | (ProtocolMessage & { readonly type: "ready" })
  | (ProtocolMessage & {
      readonly type: "surface";
      readonly revision: number;
      readonly commands: readonly StructuredValue[];
      readonly accessibility: readonly StructuredValue[];
    })
  | (ProtocolMessage & {
      readonly type: "service-request";
      readonly requestId: string;
      readonly service: WorkerServiceName;
      readonly arguments: StructuredValue;
    })
  | (ProtocolMessage & {
      readonly type: "diagnostic";
      readonly severity: "debug" | "info" | "warning" | "error";
      readonly event: string;
      readonly message: string;
    })
  | (ProtocolMessage & { readonly type: "heartbeat" })
  | (ProtocolMessage & {
      readonly type: "event-complete";
      readonly eventId: string;
      readonly durationMs: number;
    })
  | (ProtocolMessage & { readonly type: "shutdown-complete" });

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function isStructuredValue(value: unknown, depth = 0): value is StructuredValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item: unknown) => isStructuredValue(item, depth + 1));
  if (!record(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => key.length <= 256 && isStructuredValue(item, depth + 1),
  );
}
const workerTypes = new Set([
  "ready",
  "surface",
  "service-request",
  "diagnostic",
  "heartbeat",
  "event-complete",
  "shutdown-complete",
]);
export function validateWorkerHostMessage(value: unknown): WorkerHostMessage {
  if (!record(value)) throw new Error("Worker message must be an object.");
  if (value["protocolVersion"] !== 1)
    throw new Error("Worker protocol version is unsupported.");
  if (
    typeof value["applicationId"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["sequence"] !== "number" ||
    !Number.isSafeInteger(value["sequence"]) ||
    typeof value["type"] !== "string" ||
    !workerTypes.has(value["type"])
  )
    throw new Error("Worker message envelope is malformed.");
  if (!isStructuredValue(value))
    throw new Error("Worker message is not structured-clone safe.");
  const applicationId = value["applicationId"];
  const sessionId = value["sessionId"];
  const sequence = value["sequence"];
  const envelope = { protocolVersion: 1 as const, applicationId, sessionId, sequence };
  const type = value["type"];
  if (type === "surface") {
    if (
      typeof value["revision"] !== "number" ||
      !Number.isSafeInteger(value["revision"]) ||
      !Array.isArray(value["commands"]) ||
      !Array.isArray(value["accessibility"])
    )
      throw new Error("Worker surface message is malformed.");
    return {
      ...envelope,
      type,
      revision: value["revision"],
      commands: value["commands"],
      accessibility: value["accessibility"],
    };
  }
  if (type === "service-request") {
    if (
      typeof value["requestId"] !== "string" ||
      typeof value["service"] !== "string" ||
      !isWorkerServiceName(value["service"]) ||
      !isStructuredValue(value["arguments"])
    )
      throw new Error("Worker service request is malformed.");
    return {
      ...envelope,
      type,
      requestId: value["requestId"],
      service: value["service"],
      arguments: value["arguments"],
    };
  }
  if (type === "diagnostic") {
    if (
      !isSeverity(value["severity"]) ||
      typeof value["event"] !== "string" ||
      typeof value["message"] !== "string"
    )
      throw new Error("Worker diagnostic is malformed.");
    return {
      ...envelope,
      type,
      severity: value["severity"],
      event: value["event"],
      message: value["message"],
    };
  }
  if (type === "event-complete") {
    if (
      typeof value["eventId"] !== "string" ||
      typeof value["durationMs"] !== "number" ||
      !Number.isFinite(value["durationMs"])
    )
      throw new Error("Worker event completion is malformed.");
    return {
      ...envelope,
      type,
      eventId: value["eventId"],
      durationMs: value["durationMs"],
    };
  }
  if (type === "ready" || type === "heartbeat" || type === "shutdown-complete")
    return { ...envelope, type };
  throw new Error("Worker message type is unsupported.");
}
const hostTypes = new Set([
  "initialize",
  "mount",
  "reload",
  "event",
  "service-response",
  "lifecycle",
  "shutdown",
]);
export function validateHostWorkerMessage(value: unknown): HostWorkerMessage {
  if (!record(value) || !isStructuredValue(value))
    throw new Error("Host message must be structured-clone-safe data.");
  if (
    value["protocolVersion"] !== 1 ||
    typeof value["applicationId"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["sequence"] !== "number" ||
    !Number.isSafeInteger(value["sequence"]) ||
    typeof value["type"] !== "string" ||
    !hostTypes.has(value["type"])
  )
    throw new Error("Host worker message envelope is malformed.");
  const envelope = {
    protocolVersion: 1 as const,
    applicationId: value["applicationId"],
    sessionId: value["sessionId"],
    sequence: value["sequence"],
  };
  switch (value["type"]) {
    case "initialize":
      if (
        !isStructuredValue(value["manifest"]) ||
        typeof value["applicationKey"] !== "string" ||
        typeof value["bundleSource"] !== "string" ||
        !Array.isArray(value["grantedPermissions"]) ||
        !value["grantedPermissions"].every(
          (permission: unknown) => typeof permission === "string",
        ) ||
        !isStructuredValue(value["persistedState"])
      )
        throw new Error("Worker initialization is malformed.");
      return {
        ...envelope,
        type: "initialize",
        manifest: value["manifest"],
        applicationKey: value["applicationKey"],
        bundleSource: value["bundleSource"],
        grantedPermissions: value["grantedPermissions"].flatMap((permission: unknown) =>
          typeof permission === "string" && isPermission(permission) ? [permission] : [],
        ),
        persistedState: value["persistedState"],
      };
    case "mount":
      if (!isStructuredValue(value["viewport"]))
        throw new Error("Worker mount is malformed.");
      return { ...envelope, type: "mount", viewport: value["viewport"] };
    case "reload":
      if (
        typeof value["applicationKey"] !== "string" ||
        typeof value["bundleSource"] !== "string"
      )
        throw new Error("Worker reload is malformed.");
      return {
        ...envelope,
        type: "reload",
        applicationKey: value["applicationKey"],
        bundleSource: value["bundleSource"],
      };
    case "event":
      if (typeof value["eventId"] !== "string" || !isStructuredValue(value["event"]))
        throw new Error("Worker event is malformed.");
      return {
        ...envelope,
        type: "event",
        eventId: value["eventId"],
        event: value["event"],
      };
    case "service-response":
      if (
        typeof value["requestId"] !== "string" ||
        typeof value["ok"] !== "boolean" ||
        !isStructuredValue(value["value"])
      )
        throw new Error("Worker service response is malformed.");
      return {
        ...envelope,
        type: "service-response",
        requestId: value["requestId"],
        ok: value["ok"],
        value: value["value"],
      };
    case "lifecycle":
      if (value["state"] !== "running" && value["state"] !== "suspended")
        throw new Error("Worker lifecycle transition is malformed.");
      return { ...envelope, type: "lifecycle", state: value["state"] };
    case "shutdown":
      if (typeof value["reason"] !== "string")
        throw new Error("Worker shutdown is malformed.");
      return { ...envelope, type: "shutdown", reason: value["reason"] };
  }
  throw new Error("Host worker message type is unsupported.");
}
function isPermission(value: string): value is SevynPermission {
  switch (value) {
    case "filesystem.read":
    case "filesystem.write":
    case "clipboard.read":
    case "clipboard.write":
    case "notifications":
    case "network":
    case "location":
    case "camera":
    case "microphone":
    case "bluetooth":
    case "sensors":
    case "biometrics":
    case "media":
    case "native-modules":
      return true;
    default:
      return false;
  }
}
function isSeverity(value: unknown): value is "debug" | "info" | "warning" | "error" {
  return (
    value === "debug" || value === "info" || value === "warning" || value === "error"
  );
}
export function isWorkerServiceName(value: string): value is WorkerServiceName {
  switch (value) {
    case "storage.get":
    case "storage.set":
    case "filesystem.list":
    case "filesystem.read":
    case "filesystem.write":
    case "clipboard.read":
    case "clipboard.write":
    case "notifications.show":
    case "accessibility.state":
    case "accessibility.announce":
    case "linking.open":
    case "network.info":
    case "network.request":
    case "websocket.open":
    case "websocket.send":
    case "websocket.receive":
    case "websocket.close":
    case "image.load":
    case "location.current":
    case "camera.capture":
    case "camera.recordStart":
    case "camera.recordStop":
    case "camera.preview":
    case "camera.readImage":
    case "camera.playVideo":
    case "camera.videoFrame":
    case "camera.stopVideo":
    case "camera.status":
    case "camera.torch":
    case "battery.status":
    case "display.brightness.get":
    case "display.brightness.set":
    case "display.orientation.get":
    case "display.orientation.lock":
    case "display.autoBrightness.get":
    case "display.autoBrightness.set":
    case "display.wakeLock.acquire":
    case "display.wakeLock.release":
    case "audio.outputs.get":
    case "audio.output.set":
    case "vibration.vibrate":
    case "vibration.cancel":
    case "nfc.status":
    case "nfc.scan":
    case "nfc.write":
    case "cellular.status":
    case "cellular.signal":
    case "cellular.bearer":
    case "cellular.dial":
    case "cellular.hangup":
    case "cellular.answer":
    case "cellular.sms.send":
    case "cellular.sms.list":
    case "microphone.record":
    case "microphone.start":
    case "microphone.stop":
    case "bluetooth.scan":
    case "sensors.read":
    case "sensors.subscribe":
    case "sensors.unsubscribe":
    case "biometrics.authenticate":
    case "biometrics.enroll":
    case "biometrics.delete":
    case "biometrics.list":
    case "biometrics.pin.verify":
    case "biometrics.keystore.get":
    case "biometrics.keystore.set":
    case "biometrics.keystore.delete":
    case "biometrics.keystore.list":
    case "media.play":
    case "media.pause":
    case "media.resume":
    case "media.stop":
    case "media.seek":
    case "media.volume":
    case "media.status":
    case "media.scan":
    case "native.invoke":
    case "webview.open":
    case "webview.action":
    case "webview.close":
      return true;
    default:
      return false;
  }
}
export function protocolMessageSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
