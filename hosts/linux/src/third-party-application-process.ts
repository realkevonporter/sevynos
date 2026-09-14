import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { runInThisContext } from "node:vm";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { NotesApplication } from "@sevynos/example-notes";
import * as ReactNative from "@sevynos/react-native";
import * as ExpoCompat from "@sevynos/react-native/expo-compat";
import * as ExpoModulesCore from "@sevynos/react-native/expo-modules-core";
import * as CommunityCompat from "@sevynos/react-native/community-compat";
import * as VectorIcons from "@expo/vector-icons";
import {
  SevynApplicationRuntime,
  isStructuredValue,
  validateHostWorkerMessage,
  type SevynApplicationSdk,
  type StructuredValue,
  type WorkerHostMessage,
  type WorkerServiceName,
  installNativeAdapters,
} from "@sevynos/react-native/internal";

const hostProcess = process;
let applicationId = hostProcess.env["SEVYN_APPLICATION_ID"] ?? "";
let sessionId = hostProcess.env["SEVYN_SESSION_ID"] ?? "";
let sequence = 0;
let requestSequence = 0;
let runtime: SevynApplicationRuntime | undefined;
let applicationRoot: React.ReactElement | undefined;
const pending = new Map<
  string,
  { readonly resolve: (value: StructuredValue) => void; readonly reject: () => void }
>();
type ProcessPayload = WorkerHostMessage extends infer Message
  ? Message extends WorkerHostMessage
    ? Omit<Message, "protocolVersion" | "applicationId" | "sessionId" | "sequence">
    : never
  : never;
function post(message: ProcessPayload): void {
  sequence += 1;
  hostProcess.stdout.write(
    `${JSON.stringify({ protocolVersion: 1, applicationId, sessionId, sequence, ...message })}\n`,
  );
}
function request(
  service: WorkerServiceName,
  argumentsValue: StructuredValue,
): Promise<StructuredValue> {
  requestSequence += 1;
  const requestId = `process-request-${String(requestSequence)}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, {
      resolve,
      reject: () => {
        reject(new Error("Service request denied."));
      },
    });
    post({ type: "service-request", requestId, service, arguments: argumentsValue });
  });
}
const nodeHost = globalThis as unknown as Record<string, unknown>;
nodeHost["fetch"] = async (
  input: string | { readonly url: string },
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => {
  const url = typeof input === "string" ? input : input.url;
  const result = await request("network.request", {
    url,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: init?.body ?? null,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error("Network response is malformed.");
  const record = result as Record<string, StructuredValue>;
  const bytes =
    typeof record["bodyBase64"] === "string"
      ? Buffer.from(record["bodyBase64"], "base64")
      : Buffer.alloc(0);
  const headers =
    typeof record["headers"] === "object" &&
    record["headers"] !== null &&
    !Array.isArray(record["headers"])
      ? (record["headers"] as Record<string, string>)
      : {};
  return new Response(bytes, {
    status: typeof record["status"] === "number" ? record["status"] : 500,
    statusText: typeof record["statusText"] === "string" ? record["statusText"] : "",
    headers,
  });
};
installNativeAdapters({
  accessibility: {
    getState: async () => accessibilityState(await request("accessibility.state", null)),
    subscribe: (listener) => {
      const timer = setInterval(() => {
        void request("accessibility.state", null).then(() => {
          listener();
        });
      }, 2_000);
      return () => {
        clearInterval(timer);
      };
    },
    announce: async (message) => {
      await request("accessibility.announce", message);
    },
  },
  linking: {
    openURL: async (url) => {
      await request("linking.open", url);
    },
    canOpenURL: (url) => Promise.resolve(/^(https?|sevyn):\/\//.test(url)),
    getInitialURL: () => Promise.resolve(null),
  },
  networkInfo: {
    getState: async () => networkInfoState(await request("network.info", null)),
    subscribe: (listener) => {
      const timer = setInterval(() => {
        void request("network.info", null).then(() => {
          listener();
        });
      }, 10_000);
      return () => {
        clearInterval(timer);
      };
    },
  },
  webSocket: {
    open: async (url, protocols) => {
      const id = `process-websocket-${String(++requestSequence)}`;
      const value = await request("websocket.open", {
        id,
        url,
        protocols: protocols ?? null,
      });
      const record = webSocketRecord(value);
      if (
        record === undefined ||
        typeof record["id"] !== "string" ||
        typeof record["protocol"] !== "string"
      )
        throw new Error("WebSocket open response is malformed.");
      return {
        id: record["id"],
        protocol: record["protocol"],
        ...(typeof record["extensions"] === "string"
          ? { extensions: record["extensions"] }
          : {}),
      };
    },
    send: async (id, data) => {
      await request("websocket.send", {
        id,
        text: data.text ?? null,
        base64: data.base64 ?? null,
      });
    },
    receive: async (id) => webSocketEvent(await request("websocket.receive", id)),
    close: async (id, code, reason) => {
      await request("websocket.close", {
        id,
        code: code ?? null,
        reason: reason ?? null,
      });
    },
  },
  clipboard: {
    readText: async () => {
      const value = await request("clipboard.read", null);
      return typeof value === "string" ? value : "";
    },
    writeText: async (text) => {
      await request("clipboard.write", text);
    },
  },
  image: {
    load: async (uri) => {
      const result = await request("image.load", uri);
      if (typeof result !== "object" || result === null || Array.isArray(result))
        throw new Error("Image descriptor is malformed.");
      const descriptor = result as Record<string, StructuredValue>;
      if (
        typeof descriptor["path"] !== "string" ||
        typeof descriptor["width"] !== "number" ||
        typeof descriptor["height"] !== "number"
      )
        throw new Error("Image descriptor is incomplete.");
      const pixels = new Uint8Array(await readFile(descriptor["path"]));
      return { width: descriptor["width"], height: descriptor["height"], pixels };
    },
  },
  camera: {
    capture: (options) => request("camera.capture", (options ?? null) as StructuredValue),
    recordStart: (options) =>
      request("camera.recordStart", (options ?? null) as StructuredValue),
    recordStop: () => request("camera.recordStop", null),
    preview: async () => {
      const result = await request("camera.preview", null);
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        return { width: 640, height: 360, available: false };
      }
      const record = result as Record<string, StructuredValue>;
      if (record["available"] === false) {
        return {
          width: typeof record["width"] === "number" ? record["width"] : 640,
          height: typeof record["height"] === "number" ? record["height"] : 360,
          available: false,
          timestamp:
            typeof record["timestamp"] === "number" ? record["timestamp"] : Date.now(),
        };
      }
      if (typeof record["path"] === "string") {
        try {
          const pixels = new Uint8Array(await readFile(record["path"]));
          return {
            width: typeof record["width"] === "number" ? record["width"] : 640,
            height: typeof record["height"] === "number" ? record["height"] : 360,
            pixels,
            available: true,
            path: record["path"],
            timestamp:
              typeof record["timestamp"] === "number" ? record["timestamp"] : Date.now(),
          };
        } catch {
          return { width: 640, height: 360, available: false };
        }
      }
      return { width: 640, height: 360, available: false };
    },
    status: () => request("camera.status", null),
    setTorch: (enabled) => request("camera.torch", enabled),
  },
  microphone: {
    start: async (options) => {
      await request("microphone.start", (options ?? null) as StructuredValue);
    },
    stop: async () => {
      await request("microphone.stop", null);
    },
  },
  location: { getCurrentPosition: () => request("location.current", null) },
  bluetooth: {
    scan: () => request("bluetooth.scan", null) as Promise<readonly unknown[]>,
  },
  sensors: {
    read: (sensor) => request("sensors.read", sensor),
    subscribe: async (sensor, _listener, options) => {
      const sub = (await request("sensors.subscribe", {
        sensor,
        ...(typeof options === "object" && options !== null ? options : {}),
      })) as Record<string, StructuredValue>;
      const subscriptionId =
        typeof sub["subscriptionId"] === "string" ? sub["subscriptionId"] : "";
      return () => {
        if (subscriptionId) {
          void request("sensors.unsubscribe", { subscriptionId });
        }
      };
    },
  },
  biometrics: {
    authenticate: async (reason) => {
      const result = (await request("biometrics.authenticate", reason ?? null)) as Record<
        string,
        StructuredValue
      >;
      return result["authenticated"] === true;
    },
    enroll: (type, label) =>
      request("biometrics.enroll", { type, label: label ?? "Credential" }),
    deleteEnrolled: (type, id) => request("biometrics.delete", { type, id }),
    listEnrolled: () => request("biometrics.list", null) as Promise<readonly unknown[]>,
    verifyPin: async (pin) => {
      const result = (await request("biometrics.pin.verify", { pin })) as Record<
        string,
        StructuredValue
      >;
      return result["verified"] === true;
    },
    keystoreGet: async (key) => {
      const result = (await request("biometrics.keystore.get", { key })) as Record<
        string,
        StructuredValue
      >;
      return typeof result["value"] === "string" ? result["value"] : null;
    },
    keystoreSet: async (key, secret) => {
      await request("biometrics.keystore.set", { key, secret });
    },
    keystoreDelete: async (key) => {
      const result = (await request("biometrics.keystore.delete", { key })) as Record<
        string,
        StructuredValue
      >;
      return result["success"] === true;
    },
    keystoreList: async () => {
      const result = (await request("biometrics.keystore.list", null)) as Record<
        string,
        StructuredValue
      >;
      return Array.isArray(result["keys"]) ? (result["keys"] as readonly string[]) : [];
    },
  },
  media: {
    play: async (source) => {
      await request("media.play", source);
    },
    pause: async () => {
      await request("media.pause", null);
    },
    resume: async () => {
      await request("media.resume", null);
    },
    stop: async () => {
      await request("media.stop", null);
    },
    seek: async (seconds) => {
      await request("media.seek", seconds);
    },
    setVolume: async (volume) => {
      await request("media.volume", volume);
    },
    status: async () => request("media.status", null),
    scan: async (directory) =>
      (await request("media.scan", directory ?? null)) as readonly unknown[],
  },
  battery: {
    status: () => request("battery.status", null),
  },
  display: {
    getBrightness: async () => (await request("display.brightness.get", null)) as number,
    setBrightness: async (val) => {
      await request("display.brightness.set", val);
    },
    getAutoBrightness: async () => {
      const result = (await request("display.autoBrightness.get", null)) as Record<
        string,
        StructuredValue
      >;
      return result["enabled"] === true;
    },
    setAutoBrightness: async (enabled) => {
      await request("display.autoBrightness.set", { enabled });
    },
    getOrientation: async () => {
      const result = (await request("display.orientation.get", null)) as Record<
        string,
        StructuredValue
      >;
      const orientation = result["orientation"];
      return typeof orientation === "string" ? orientation : "portrait";
    },
    lockOrientation: async (orientation) => {
      await request("display.orientation.lock", { orientation });
    },
    acquireWakeLock: async () => {
      const result = (await request("display.wakeLock.acquire", null)) as Record<
        string,
        StructuredValue
      >;
      const lockId = typeof result["lockId"] === "string" ? result["lockId"] : "";
      return () => {
        if (lockId) {
          void request("display.wakeLock.release", { lockId });
        }
      };
    },
  },
  audio: {
    getOutputs: async () =>
      (await request("audio.outputs.get", null)) as readonly unknown[],
    setOutput: async (deviceId) => {
      await request("audio.output.set", deviceId);
    },
  },
  vibration: {
    vibrate: async (pattern) => {
      await request("vibration.vibrate", pattern ?? null);
    },
    cancel: async () => {
      await request("vibration.cancel", null);
    },
  },
  nfc: {
    isAvailable: async () =>
      Boolean(
        ((await request("nfc.status", null)) as Record<string, StructuredValue> | null)?.[
          "available"
        ],
      ),
    scan: () => request("nfc.scan", null),
    write: async (data) => {
      await request("nfc.write", data as StructuredValue);
    },
  },
  cellular: {
    getModemStatus: () => request("cellular.status", null),
    getSignal: () => request("cellular.signal", null),
    getBearer: () => request("cellular.bearer", null),
    dial: (number) => request("cellular.dial", number),
    answer: async () => {
      await request("cellular.answer", null);
    },
    hangup: async () => {
      await request("cellular.hangup", null);
    },
    sendSms: (recipient, message) => request("cellular.sms.send", { recipient, message }),
    listSms: () => request("cellular.sms.list", null) as Promise<readonly unknown[]>,
  },
  notifications: {
    schedule: async (payload) => {
      await request("notifications.show", payload as StructuredValue);
      return `process-notification-${String(requestSequence)}`;
    },
  },
  nativeModules: {
    invoke: (module, method, argumentsValue) =>
      request("native.invoke", {
        module,
        method,
        arguments: (argumentsValue ?? null) as StructuredValue,
      }),
  },
});
nodeHost["WebSocket"] = ReactNative.WebSocket;

function accessibilityState(value: StructuredValue) {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, StructuredValue>)
      : {};
  return {
    accessibilityServiceEnabled: record["accessibilityServiceEnabled"] === true,
    screenReaderEnabled: record["screenReaderEnabled"] === true,
    boldTextEnabled: record["boldTextEnabled"] === true,
    grayscaleEnabled: record["grayscaleEnabled"] === true,
    invertColorsEnabled: record["invertColorsEnabled"] === true,
    reduceMotionEnabled: record["reduceMotionEnabled"] === true,
    reduceTransparencyEnabled: record["reduceTransparencyEnabled"] === true,
  };
}
function networkInfoState(value: StructuredValue) {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, StructuredValue>)
      : {};
  const type: "wifi" | "none" | "unknown" =
    record["type"] === "wifi" || record["type"] === "none" ? record["type"] : "unknown";
  return {
    type,
    isConnected:
      typeof record["isConnected"] === "boolean" ? record["isConnected"] : null,
    isInternetReachable:
      typeof record["isInternetReachable"] === "boolean"
        ? record["isInternetReachable"]
        : null,
  };
}
function webSocketRecord(
  value: StructuredValue,
): Record<string, StructuredValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, StructuredValue>)
    : undefined;
}
function webSocketEvent(value: StructuredValue): WebSocketAdapterEvent {
  const record = webSocketRecord(value);
  if (
    record === undefined ||
    (record["type"] !== "message" &&
      record["type"] !== "error" &&
      record["type"] !== "close" &&
      record["type"] !== "timeout")
  )
    throw new Error("WebSocket event is malformed.");
  return {
    type: record["type"],
    ...(typeof record["text"] === "string" ? { text: record["text"] } : {}),
    ...(typeof record["base64"] === "string" ? { base64: record["base64"] } : {}),
    ...(typeof record["code"] === "number" ? { code: record["code"] } : {}),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
    ...(typeof record["message"] === "string" ? { message: record["message"] } : {}),
  };
}
interface WebSocketAdapterEvent {
  readonly type: "message" | "error" | "close" | "timeout";
  readonly text?: string;
  readonly base64?: string;
  readonly code?: number;
  readonly reason?: string;
  readonly message?: string;
}
function sdk(): SevynApplicationSdk {
  return {
    application: { id: applicationId, sessionId, state: "running" },
    windows: {
      requestWindow: () =>
        Promise.reject(new Error("Process window requests require broker approval.")),
    },
    theme: { appearance: "dark", accent: "#d5aa4e", reducedMotion: false },
    storage: {
      get: async (key) => {
        const value = await request("storage.get", key);
        return typeof value === "string" ? value : undefined;
      },
      set: async (key, value) => {
        await request("storage.set", { key, value });
      },
    },
    notifications: {
      show: (notification) => {
        void request("notifications.show", {
          title: notification.title,
          message: "Application notification",
        });
        return Object.freeze({
          ...notification,
          id: `process-notification-${String(requestSequence)}`,
          createdAt: Date.now(),
        });
      },
    },
    workspace: { id: "workspace-1" },
    display: { id: "display-primary", scaleFactor: 1 },
  };
}
const lines = createInterface({ input: hostProcess.stdin });
lines.on("line", (line) => {
  void handleLine(line);
});
async function handleLine(line: string): Promise<void> {
  try {
    if (Buffer.byteLength(line, "utf8") > 256 * 1024)
      throw new Error("Host message is oversized.");
    const message = validateHostWorkerMessage(JSON.parse(line));
    if (
      applicationId !== "" &&
      (message.applicationId !== applicationId || message.sessionId !== sessionId)
    )
      throw new Error("Process identity mismatch.");
    applicationId = message.applicationId;
    sessionId = message.sessionId;
    switch (message.type) {
      case "initialize":
        applicationRoot = await loadApplication();
        post({ type: "ready" });
        return;
      case "mount":
        mount();
        return;
      case "event": {
        const started = performance.now();
        deliver(message.event);
        post({
          type: "event-complete",
          eventId: message.eventId,
          durationMs: performance.now() - started,
        });
        return;
      }
      case "service-response": {
        const active = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (message.ok) active?.resolve(message.value);
        else active?.reject();
        return;
      }
      case "lifecycle":
        return;
      case "shutdown":
        runtime?.unmount();
        post({ type: "shutdown-complete" });
        hostProcess.exitCode = 0;
        lines.close();
    }
  } catch (error) {
    hostProcess.stderr.write(
      `[sevynos-application] ${error instanceof Error ? error.message : "Unknown application failure."}\n`,
    );
    hostProcess.exitCode = 1;
    lines.close();
  }
}
async function loadApplication(): Promise<React.ReactElement> {
  const bundlePath = hostProcess.env["SEVYN_APPLICATION_BUNDLE"];
  const applicationKey = hostProcess.env["SEVYN_APPLICATION_KEY"];
  if (bundlePath === undefined || applicationKey === undefined)
    throw new Error("Application bundle configuration is missing.");
  const bundle = await readFile(bundlePath, "utf8");
  ReactNative.AppRegistry.clear();
  const host = globalThis as typeof globalThis & {
    __SEVYN_MODULES__?: Readonly<Record<string, object>>;
  };
  host.__SEVYN_MODULES__ = Object.freeze({
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
    "react-native": ReactNative,
    "@sevynos/react-native": ReactNative,
    "@sevynos/react-native/expo-modules-core": ExpoModulesCore,
    "@sevynos/react-native/expo-compat": ExpoCompat,
    "@sevynos/react-native/community-compat": CommunityCompat,
    "expo-modules-core": ExpoModulesCore,
    "@expo/vector-icons": VectorIcons,
    "@sevynos/example-notes": Object.freeze({ NotesApplication }),
  });
  const safeProcess = Object.freeze({
    env: Object.freeze({
      NODE_ENV: "production",
      SEVYN_APPLICATION_ID: applicationId,
      SEVYN_SESSION_ID: sessionId,
      SEVYN_APPLICATION_KEY: applicationKey,
    }),
    nextTick: (callback: () => void) => {
      queueMicrotask(callback);
    },
    platform: "sevynos",
  });
  const hostRecord = globalThis as unknown as Record<string, unknown>;
  hostRecord["process"] = safeProcess;
  hostRecord["require"] = undefined;
  try {
    runInThisContext(bundle, {
      filename: bundlePath,
      displayErrors: true,
    });
  } finally {
    delete host.__SEVYN_MODULES__;
    hostRecord["process"] = safeProcess;
    hostRecord["require"] = undefined;
  }
  const runnable = ReactNative.AppRegistry.getRunnable(applicationKey);
  if (runnable === undefined)
    throw new Error(`Application bundle did not register "${applicationKey}".`);
  return React.createElement(
    ReactNative.SevynErrorBoundary,
    { title: applicationKey },
    React.createElement(
      ReactNative.SevynApplicationSdkProvider,
      { sdk: sdk() },
      runnable.run({ initialProps: { applicationId, sessionId } }),
    ),
  ) as React.ReactElement;
}
function mount(): void {
  if (applicationRoot === undefined) throw new Error("Application is not initialized.");
  runtime = new SevynApplicationRuntime({
    bounds: { x: 0, y: 0, width: 760, height: 494 },
    onInvalidate: submit,
  });
  runtime.mount(applicationRoot);
}
function submit(): void {
  if (runtime === undefined) return;
  const encoded: unknown = JSON.parse(JSON.stringify(runtime.snapshot));
  if (!isStructuredValue(encoded))
    throw new Error("Application surface is not structured data.");
  const snapshot = structuredRecord(encoded);
  const revision = snapshot?.["revision"];
  const commands = snapshot?.["commands"];
  const accessibility = snapshot?.["accessibility"];
  if (
    typeof revision !== "number" ||
    !Array.isArray(commands) ||
    !Array.isArray(accessibility)
  )
    throw new Error("Application surface is malformed.");
  post({ type: "surface", revision, commands, accessibility });
}
function deliver(event: StructuredValue): void {
  const values = structuredRecord(event);
  if (runtime === undefined || values === undefined) return;
  if (
    values["kind"] === "viewport" &&
    typeof values["width"] === "number" &&
    values["width"] > 0 &&
    typeof values["height"] === "number" &&
    values["height"] > 0
  ) {
    runtime.configure({
      bounds: { x: 0, y: 0, width: values["width"], height: values["height"] },
    });
    return;
  }
  if (
    values["kind"] === "pointer" &&
    (values["type"] === "enter" ||
      values["type"] === "leave" ||
      values["type"] === "move" ||
      values["type"] === "down" ||
      values["type"] === "up" ||
      values["type"] === "cancel") &&
    typeof values["x"] === "number" &&
    typeof values["y"] === "number" &&
    typeof values["pointerId"] === "number" &&
    typeof values["button"] === "number"
  ) {
    runtime.dispatchPointer(values["type"], {
      x: values["x"],
      y: values["y"],
      pointerId: values["pointerId"],
      button: values["button"],
    });
    return;
  }
  if (
    values["kind"] === "wheel" &&
    typeof values["x"] === "number" &&
    typeof values["y"] === "number" &&
    typeof values["deltaX"] === "number" &&
    typeof values["deltaY"] === "number"
  ) {
    runtime.dispatchWheel({
      x: values["x"],
      y: values["y"],
      deltaX: values["deltaX"],
      deltaY: values["deltaY"],
    });
    return;
  }
  if (
    values["kind"] === "keyboard" &&
    (values["type"] === "down" || values["type"] === "up") &&
    typeof values["key"] === "string"
  )
    runtime.dispatchKeyboard(values["type"], {
      key: values["key"],
      code: typeof values["code"] === "string" ? values["code"] : values["key"],
      shift: values["shift"] === true,
      alt: values["alt"] === true,
      control: values["control"] === true,
      meta: values["meta"] === true,
    });
}
function structuredRecord(
  value: StructuredValue,
): Readonly<Record<string, StructuredValue>> | undefined {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return undefined;
  const output: Record<string, StructuredValue> = {};
  for (const [key, item] of Object.entries(candidate)) {
    if (!isStructuredValue(item)) return undefined;
    output[key] = item;
  }
  return output;
}
