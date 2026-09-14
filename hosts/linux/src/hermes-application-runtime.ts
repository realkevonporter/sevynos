import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactNative from "@sevynos/react-native";
import { NotesApplication } from "@sevynos/example-notes";
import {
  SevynApplicationRuntime,
  isStructuredValue,
  validateHostWorkerMessage,
  type SevynApplicationSdk,
  type StructuredValue,
  type WorkerHostMessage,
  type WorkerServiceName,
  installNativeAdapters,
  type BrowserEngineSnapshot,
  type SevynBrowserEngine,
} from "@sevynos/react-native/internal";

declare const __sevynPostMessage: (message: string) => void;
declare const __sevynSetTimer: (
  callback: () => void,
  delay: number,
  repeat: boolean,
) => number;
declare const __sevynClearTimer: (id: number) => void;
declare const __sevynTerminate: () => void;
declare const __sevynReadBinaryFile: (path: string) => ArrayBuffer;
const host = globalThis as unknown as Record<string, unknown>;
host["setTimeout"] = (callback: () => void, delay = 0) =>
  __sevynSetTimer(callback, delay, false);
host["clearTimeout"] = (id: number) => {
  __sevynClearTimer(id);
};
host["setInterval"] = (callback: () => void, delay = 0) =>
  __sevynSetTimer(callback, delay, true);
host["clearInterval"] = (id: number) => {
  __sevynClearTimer(id);
};
host["setImmediate"] = (callback: () => void) => __sevynSetTimer(callback, 0, false);
host["clearImmediate"] = (id: number) => {
  __sevynClearTimer(id);
};
host["queueMicrotask"] = (callback: () => void) => Promise.resolve().then(callback);
host["performance"] = Object.freeze({ now: () => Date.now() });
host["console"] = Object.freeze({
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (...values: unknown[]) => {
    throw new Error(values.map(String).join(" "));
  },
});
host["__SEVYN_MODULES__"] = Object.freeze({
  react: React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react-native": ReactNative,
  "@sevynos/example-notes": Object.freeze({ NotesApplication }),
});

let applicationId = "";
let sessionId = "";
let applicationKey = "";
let sequence = 0;
let requestSequence = 0;
let lifecycle: "starting" | "running" | "suspended" = "starting";
let runtime: SevynApplicationRuntime | undefined;
const pending = new Map<
  string,
  { resolve: (value: StructuredValue) => void; reject: () => void }
>();
type Payload = WorkerHostMessage extends infer Message
  ? Message extends WorkerHostMessage
    ? Omit<Message, "protocolVersion" | "applicationId" | "sessionId" | "sequence">
    : never
  : never;
function post(message: Payload): void {
  __sevynPostMessage(
    JSON.stringify({
      protocolVersion: 1,
      applicationId,
      sessionId,
      sequence: ++sequence,
      ...message,
    }),
  );
}
function request(
  service: WorkerServiceName,
  args: StructuredValue,
): Promise<StructuredValue> {
  const requestId = `hermes-request-${String(++requestSequence)}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, {
      resolve,
      reject: () => {
        reject(new Error("Service request denied."));
      },
    });
    post({ type: "service-request", requestId, service, arguments: args });
  });
}

type SevynHeaderInit =
  | Readonly<Record<string, string>>
  | readonly (readonly [string, string])[]
  | SevynHeaders;
interface SevynFetchInit {
  readonly method?: string;
  readonly headers?: SevynHeaderInit;
  readonly body?: string | null;
  readonly signal?: { readonly aborted?: boolean };
}
class SevynHeaders {
  readonly #values = new Map<string, string>();
  public constructor(init?: SevynHeaderInit) {
    if (init instanceof SevynHeaders) {
      init.forEach((value, name) => {
        this.set(name, value);
      });
    } else if (Array.isArray(init)) {
      for (const pair of init as readonly (readonly [string, string])[]) {
        this.append(pair[0], pair[1]);
      }
    } else if (init !== undefined) {
      for (const [name, value] of Object.entries(
        init as Readonly<Record<string, string>>,
      )) {
        this.set(name, value);
      }
    }
  }
  public append(name: string, value: string): void {
    const key = normalizeHeaderName(name);
    const previous = this.#values.get(key);
    this.#values.set(key, previous === undefined ? value : `${previous}, ${value}`);
  }
  public delete(name: string): void {
    this.#values.delete(normalizeHeaderName(name));
  }
  public get(name: string): string | null {
    return this.#values.get(normalizeHeaderName(name)) ?? null;
  }
  public has(name: string): boolean {
    return this.#values.has(normalizeHeaderName(name));
  }
  public set(name: string, value: string): void {
    this.#values.set(normalizeHeaderName(name), value);
  }
  public entries(): IterableIterator<[string, string]> {
    return this.#values.entries();
  }
  public keys(): IterableIterator<string> {
    return this.#values.keys();
  }
  public values(): IterableIterator<string> {
    return this.#values.values();
  }
  public forEach(callback: (value: string, name: string) => void): void {
    this.#values.forEach((value, name) => {
      callback(value, name);
    });
  }
  public [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
  public toRecord(): Record<string, string> {
    return Object.fromEntries(this.#values);
  }
}
class SevynRequest {
  public readonly url: string;
  public readonly method: string;
  public readonly headers: SevynHeaders;
  public readonly body: string | null;
  public readonly signal: { readonly aborted?: boolean } | undefined;
  public constructor(input: string | SevynRequest, init: SevynFetchInit = {}) {
    this.url = input instanceof SevynRequest ? input.url : input;
    this.method = (
      init.method ?? (input instanceof SevynRequest ? input.method : "GET")
    ).toUpperCase();
    this.headers = new SevynHeaders(
      init.headers ?? (input instanceof SevynRequest ? input.headers : undefined),
    );
    this.body =
      init.body === undefined
        ? input instanceof SevynRequest
          ? input.body
          : null
        : init.body;
    this.signal =
      init.signal ?? (input instanceof SevynRequest ? input.signal : undefined);
  }
  public clone(): SevynRequest {
    return new SevynRequest(this);
  }
}
class SevynResponse {
  public readonly status: number;
  public readonly statusText: string;
  public readonly url: string;
  public readonly redirected: boolean;
  public readonly headers: SevynHeaders;
  public bodyUsed = false;
  readonly #bytes: Uint8Array;
  public constructor(
    bytes: Uint8Array,
    init: {
      status: number;
      statusText: string;
      url: string;
      redirected: boolean;
      headers: Record<string, string>;
    },
  ) {
    this.#bytes = bytes;
    this.status = init.status;
    this.statusText = init.statusText;
    this.url = init.url;
    this.redirected = init.redirected;
    this.headers = new SevynHeaders(init.headers);
  }
  public get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  public text(): Promise<string> {
    this.#consume();
    return Promise.resolve(decodeUtf8(this.#bytes));
  }
  public async json(): Promise<unknown> {
    return JSON.parse(await this.text()) as unknown;
  }
  public arrayBuffer(): Promise<ArrayBuffer> {
    this.#consume();
    return Promise.resolve(this.#bytes.slice().buffer);
  }
  public clone(): SevynResponse {
    if (this.bodyUsed) throw new TypeError("Cannot clone a consumed response.");
    return new SevynResponse(this.#bytes.slice(), {
      status: this.status,
      statusText: this.statusText,
      url: this.url,
      redirected: this.redirected,
      headers: this.headers.toRecord(),
    });
  }
  #consume(): void {
    if (this.bodyUsed) throw new TypeError("Response body has already been consumed.");
    this.bodyUsed = true;
  }
}
async function sevynFetch(
  input: string | SevynRequest,
  init: SevynFetchInit = {},
): Promise<SevynResponse> {
  const requestValue = new SevynRequest(input, init);
  if (requestValue.signal?.aborted === true)
    throw new Error("The operation was aborted.");
  const result = await request("network.request", {
    url: requestValue.url,
    method: requestValue.method,
    headers: requestValue.headers.toRecord(),
    body: requestValue.body,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error("Network response is malformed.");
  const record = result as Record<string, StructuredValue>;
  if (typeof record["status"] !== "number" || typeof record["bodyBase64"] !== "string")
    throw new Error("Network response is incomplete.");
  const responseHeaders: Record<string, string> = {};
  const headersValue = record["headers"];
  if (
    typeof headersValue === "object" &&
    headersValue !== null &&
    !Array.isArray(headersValue)
  )
    for (const [name, value] of Object.entries(headersValue))
      if (typeof value === "string") responseHeaders[name] = value;
  return new SevynResponse(decodeBase64(record["bodyBase64"]), {
    status: record["status"],
    statusText: typeof record["statusText"] === "string" ? record["statusText"] : "",
    url: typeof record["url"] === "string" ? record["url"] : requestValue.url,
    redirected: record["redirected"] === true,
    headers: responseHeaders,
  });
}
host["Headers"] = SevynHeaders;
host["Request"] = SevynRequest;
host["Response"] = SevynResponse;
host["fetch"] = sevynFetch;

function normalizeHeaderName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized))
    throw new TypeError("Invalid header name.");
  return normalized;
}
function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/=+$/, "");
  const output = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const character of clean) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Network response contains invalid base64.");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[index++] = (buffer >> bits) & 0xff;
    }
  }
  return output;
}
function decodeUtf8(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, "0")}`;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}
function createRemoteWebViewEngine(): SevynBrowserEngine {
  const id = `webview-${String(++requestSequence)}`;
  let current: BrowserEngineSnapshot = Object.freeze({
    ready: false,
    loading: false,
    url: "",
    title: "New Tab",
    width: 878,
    height: 501,
  });
  const listeners = new Set<() => void>();
  const decode = (value: StructuredValue): BrowserEngineSnapshot => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error("WebView frame descriptor is malformed.");
    const record = value as Record<string, StructuredValue>;
    if (
      typeof record["width"] !== "number" ||
      typeof record["height"] !== "number" ||
      typeof record["path"] !== "string"
    )
      throw new Error("WebView frame descriptor is incomplete.");
    const pixels = new Uint8Array(__sevynReadBinaryFile(record["path"]));
    if (pixels.byteLength !== record["width"] * record["height"] * 4)
      throw new Error("WebView framebuffer size is invalid.");
    current = Object.freeze({
      ready: record["ready"] === true,
      loading: record["loading"] === true,
      url: typeof record["url"] === "string" ? record["url"] : "",
      title: typeof record["title"] === "string" ? record["title"] : "",
      width: record["width"],
      height: record["height"],
      pixels,
      ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
    });
    for (const listener of listeners) listener();
    return current;
  };
  const action = (name: string, values: Record<string, StructuredValue> = {}) =>
    request("webview.action", { id, action: name, ...values }).then(decode);
  return {
    snapshot: () => current,
    navigate: (url) =>
      current.ready
        ? action("navigate", { url })
        : request("webview.open", {
            id,
            url,
            width: current.width,
            height: current.height,
          }).then(decode),
    back: () => action("back"),
    forward: () => action("forward"),
    reload: () => action("reload"),
    resize: (width, height) => action("resize", { width, height }),
    click: async (x, y) => {
      await action("pointerDown", { x, y });
      return action("pointerUp", { x, y });
    },
    pointerDown: (x, y, button = 0) => action("pointerDown", { x, y, button }),
    pointerUp: (x, y, button = 0) => action("pointerUp", { x, y, button }),
    scroll: (deltaY) => action("scroll", { deltaY }),
    key: (key, code) => action("key", { key, code }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      await request("webview.close", id);
      listeners.clear();
    },
  };
}
installNativeAdapters({
  accessibility: {
    getState: async () => {
      const value = await request("accessibility.state", null);
      return accessibilityState(value);
    },
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
      const id = `hermes-websocket-${String(++requestSequence)}`;
      const value = await request("websocket.open", {
        id,
        url,
        protocols: protocols ?? null,
      });
      const record = structuredRecord(value);
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
      const value = await request("image.load", uri);
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Image descriptor is malformed.");
      const descriptor = value as Record<string, StructuredValue>;
      if (
        typeof descriptor["path"] !== "string" ||
        typeof descriptor["width"] !== "number" ||
        typeof descriptor["height"] !== "number"
      )
        throw new Error("Image descriptor is incomplete.");
      const pixels = new Uint8Array(__sevynReadBinaryFile(descriptor["path"]));
      if (pixels.byteLength !== descriptor["width"] * descriptor["height"] * 4)
        throw new Error("Image pixel buffer is invalid.");
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
          const pixels = new Uint8Array(__sevynReadBinaryFile(record["path"]));
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
  sensors: { read: (sensor) => request("sensors.read", sensor) },
  biometrics: {
    authenticate: async (reason) => {
      const result = await request("biometrics.authenticate", reason ?? null);
      const record = result as Record<string, StructuredValue>;
      return (
        typeof result === "object" &&
        result !== null &&
        !Array.isArray(result) &&
        record["authenticated"] === true
      );
    },
  },
  media: {
    play: async (source) => {
      await request("media.play", source);
    },
    stop: async () => {
      await request("media.stop", null);
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
  notifications: {
    schedule: async (payload: unknown) => {
      const value = await request("notifications.show", payload as StructuredValue);
      const record = value as Record<string, StructuredValue>;
      return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof record["id"] === "string"
        ? record["id"]
        : `hermes-notification-${String(requestSequence)}`;
    },
  },
  webview: { createEngine: createRemoteWebViewEngine },
});
host["WebSocket"] = ReactNative.WebSocket;

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
function structuredRecord(
  value: StructuredValue,
): Record<string, StructuredValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, StructuredValue>)
    : undefined;
}
function webSocketEvent(value: StructuredValue): WebSocketAdapterEvent {
  const record = structuredRecord(value);
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
    application: {
      id: applicationId,
      sessionId,
      state: lifecycle === "suspended" ? "background" : "running",
    },
    windows: {
      requestWindow: () =>
        Promise.reject(new Error("Window request requires broker approval.")),
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
          message: notification.message,
        });
        return Object.freeze({
          ...notification,
          id: `hermes-notification-${String(requestSequence)}`,
          createdAt: Date.now(),
        });
      },
    },
    workspace: { id: "workspace-1" },
    display: { id: "display-primary", scaleFactor: 1 },
  };
}
function submit(): void {
  if (!runtime) return;
  const encoded: unknown = JSON.parse(JSON.stringify(runtime.snapshot));
  if (
    !isStructuredValue(encoded) ||
    typeof encoded !== "object" ||
    encoded === null ||
    Array.isArray(encoded)
  )
    throw new Error("Application surface is malformed.");
  const snapshot = encoded as Record<string, StructuredValue>;
  if (
    typeof snapshot["revision"] !== "number" ||
    !Array.isArray(snapshot["commands"]) ||
    !Array.isArray(snapshot["accessibility"])
  )
    throw new Error("Application surface is malformed.");
  post({
    type: "surface",
    revision: snapshot["revision"],
    commands: snapshot["commands"],
    accessibility: snapshot["accessibility"],
  });
}
function deliver(event: StructuredValue): void {
  if (!runtime || typeof event !== "object" || event === null || Array.isArray(event))
    return;
  const value = event as Record<string, StructuredValue>;
  if (
    value["kind"] === "viewport" &&
    typeof value["width"] === "number" &&
    typeof value["height"] === "number"
  )
    runtime.configure({
      bounds: { x: 0, y: 0, width: value["width"], height: value["height"] },
    });
  else if (
    value["kind"] === "pointer" &&
    (value["type"] === "enter" ||
      value["type"] === "leave" ||
      value["type"] === "move" ||
      value["type"] === "down" ||
      value["type"] === "up" ||
      value["type"] === "cancel") &&
    typeof value["x"] === "number" &&
    typeof value["y"] === "number" &&
    typeof value["pointerId"] === "number" &&
    typeof value["button"] === "number"
  )
    runtime.dispatchPointer(value["type"], {
      x: value["x"],
      y: value["y"],
      pointerId: value["pointerId"],
      button: value["button"],
    });
  else if (
    value["kind"] === "keyboard" &&
    (value["type"] === "down" || value["type"] === "up") &&
    typeof value["key"] === "string"
  )
    runtime.dispatchKeyboard(value["type"], {
      key: value["key"],
      code: typeof value["code"] === "string" ? value["code"] : value["key"],
      shift: value["shift"] === true,
      alt: value["alt"] === true,
      control: value["control"] === true,
      meta: value["meta"] === true,
    });
  else if (
    value["kind"] === "wheel" &&
    typeof value["x"] === "number" &&
    typeof value["y"] === "number" &&
    typeof value["deltaX"] === "number" &&
    typeof value["deltaY"] === "number"
  )
    runtime.dispatchWheel({
      x: value["x"],
      y: value["y"],
      deltaX: value["deltaX"],
      deltaY: value["deltaY"],
    });
}
host["__sevynReceiveHostMessage"] = (line: string) => {
  const message = validateHostWorkerMessage(JSON.parse(line));
  if (
    applicationId &&
    (message.applicationId !== applicationId || message.sessionId !== sessionId)
  )
    throw new Error("Process identity mismatch.");
  applicationId = message.applicationId;
  sessionId = message.sessionId;
  switch (message.type) {
    case "initialize":
      applicationKey = message.applicationKey;
      lifecycle = "starting";
      post({ type: "ready" });
      return;
    case "mount": {
      const runnable = ReactNative.AppRegistry.getRunnable(applicationKey);
      if (!runnable) throw new Error(`Application did not register "${applicationKey}".`);
      runtime = new SevynApplicationRuntime({
        bounds: { x: 0, y: 0, width: 760, height: 494 },
        onInvalidate: submit,
      });
      runtime.mount(
        React.createElement(
          ReactNative.SevynApplicationSdkProvider,
          { sdk: sdk() },
          runnable.run({ initialProps: { applicationId, sessionId } }),
        ),
      );
      lifecycle = "running";
      return;
    }
    case "event": {
      const started = Date.now();
      deliver(message.event);
      post({
        type: "event-complete",
        eventId: message.eventId,
        durationMs: Date.now() - started,
      });
      return;
    }
    case "service-response": {
      const active = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (message.ok) {
        active?.resolve(message.value);
      } else {
        active?.reject();
      }
      return;
    }
    case "lifecycle":
      lifecycle = message.state;
      return;
    case "reload":
      throw new Error("Hermes reload requires process restart.");
    case "shutdown":
      runtime?.unmount();
      post({ type: "shutdown-complete" });
      __sevynTerminate();
  }
};
