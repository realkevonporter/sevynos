/// <reference lib="webworker" />
import { NotesApplication } from "@sevynos/example-notes";
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
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
  installNativeAdapters,
} from "@sevynos/react-native/internal";

const worker = self;
let applicationId = "";
let sessionId = "";
let sequence = 0;
let requestSequence = 0;
let initialized = false;
let runtime: SevynApplicationRuntime | undefined;
let applicationRoot: React.ReactElement | undefined;
const pendingServices = new Map<
  string,
  { readonly resolve: (value: StructuredValue) => void; readonly reject: () => void }
>();
type WorkerPayload = WorkerHostMessage extends infer Message
  ? Message extends WorkerHostMessage
    ? Omit<Message, "protocolVersion" | "applicationId" | "sessionId" | "sequence">
    : never
  : never;
const post = (message: WorkerPayload): void => {
  sequence += 1;
  worker.postMessage({
    protocolVersion: 1,
    applicationId,
    sessionId,
    sequence,
    ...message,
  });
};
const service = (
  name: "storage.get" | "storage.set" | "notifications.show",
  argumentsValue: StructuredValue,
): Promise<StructuredValue> => {
  requestSequence += 1;
  const requestId = `worker-request-${String(requestSequence)}`;
  return new Promise((resolve, reject) => {
    pendingServices.set(requestId, {
      resolve,
      reject: () => {
        reject(new Error("Service request was denied."));
      },
    });
    post({
      type: "service-request",
      requestId,
      service: name,
      arguments: argumentsValue,
    });
  });
};
const sdk = (): SevynApplicationSdk => ({
  application: { id: applicationId, sessionId, state: "running" },
  windows: {
    requestWindow: () =>
      Promise.reject(new Error("Worker window requests require broker approval.")),
  },
  theme: { appearance: "dark", accent: "#d5aa4e", reducedMotion: false },
  storage: {
    get: async (key) => {
      const value = await service("storage.get", key);
      return typeof value === "string" ? value : undefined;
    },
    set: async (key, value) => {
      await service("storage.set", { key, value });
    },
  },
  notifications: {
    show: (notification) => {
      void service("notifications.show", {
        title: notification.title,
        message: "Application notification",
        ...(notification.applicationId === undefined
          ? {}
          : { applicationId: notification.applicationId }),
      });
      return Object.freeze({
        ...notification,
        id: `worker-notification-${String(requestSequence)}`,
        createdAt: Date.now(),
      });
    },
  },
  workspace: { id: "workspace-1" },
  display: { id: "display-primary", scaleFactor: 1 },
});
worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  try {
    const message = validateHostWorkerMessage(event.data);
    if (
      initialized &&
      (message.applicationId !== applicationId || message.sessionId !== sessionId)
    )
      throw new Error("Host identity changed during the worker session.");
    switch (message.type) {
      case "initialize":
        applicationId = message.applicationId;
        sessionId = message.sessionId;
        initialized = true;
        applicationRoot = loadApplication(message.applicationKey, message.bundleSource);
        post({ type: "ready" });
        return;
      case "mount":
        mountApplication();
        return;
      case "reload": {
        try {
          const replacement = loadApplication(
            message.applicationKey,
            message.bundleSource,
          );
          runtime?.unmount();
          applicationRoot = replacement;
          mountApplication();
          post({
            type: "diagnostic",
            severity: "info",
            event: "bundle.reloaded",
            message: "Application bundle reloaded.",
          });
        } catch (error) {
          post({
            type: "diagnostic",
            severity: "error",
            event: "bundle.reload-failed",
            message:
              error instanceof Error
                ? (error.stack ?? error.message)
                : "Bundle reload failed.",
          });
        }
        return;
      }
      case "event": {
        const started = performance.now();
        deliverEvent(message.event);
        post({
          type: "event-complete",
          eventId: message.eventId,
          durationMs: performance.now() - started,
        });
        return;
      }
      case "service-response": {
        const pending = pendingServices.get(message.requestId);
        pendingServices.delete(message.requestId);
        if (message.ok) pending?.resolve(message.value);
        else pending?.reject();
        return;
      }
      case "lifecycle":
        return;
      case "shutdown":
        runtime?.unmount();
        post({ type: "shutdown-complete" });
        worker.close();
    }
  } catch {
    worker.close();
  }
});
function mountApplication(): void {
  if (applicationRoot === undefined) throw new Error("Application is not initialized.");
  runtime = new SevynApplicationRuntime({
    bounds: { x: 0, y: 0, width: 760, height: 494 },
    onInvalidate: submitSurface,
  });
  runtime.mount(applicationRoot);
}
installNativeAdapters({
  clipboard: {
    readText: () => Promise.resolve(""),
    writeText: () => Promise.resolve(),
  },
  linking: {
    openURL: (url) => {
      if (
        typeof worker !== "undefined" &&
        typeof (worker as unknown as Window).open === "function"
      ) {
        (worker as unknown as Window).open(url, "_blank");
      }
      return Promise.resolve();
    },
    canOpenURL: () => Promise.resolve(true),
    getInitialURL: () => Promise.resolve(null),
  },
  networkInfo: {
    getState: () =>
      Promise.resolve({
        type: "wifi",
        isConnected: true,
        isInternetReachable: true,
      }),
    subscribe: () => () => undefined,
  },
  notifications: {
    schedule: async (payload) => {
      const record = (payload ?? {}) as Record<string, unknown>;
      await service("notifications.show", {
        title: typeof record["title"] === "string" ? record["title"] : "Notification",
        message: typeof record["body"] === "string" ? record["body"] : "",
      });
      return `worker-notif-${String(Date.now())}`;
    },
  },
  vibration: {
    vibrate: () => Promise.resolve(),
  },
});

function loadApplication(
  applicationKey: string,
  bundleSource: string,
): React.ReactElement {
  ReactNative.AppRegistry.clear();
  const host = globalThis as typeof globalThis & {
    __SEVYN_MODULES__?: Readonly<Record<string, object>>;
    __DEV__?: boolean;
    React?: typeof React;
  };
  host.__DEV__ = false;
  host.React = React;
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const evaluate = new Function(
    `${bundleSource}\n//# sourceURL=sevynapp://${applicationId}/index.js`,
  ) as () => void;
  evaluate();
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
function submitSurface(): void {
  if (runtime === undefined) return;
  const encoded: unknown = JSON.parse(JSON.stringify(runtime.snapshot));
  if (!isStructuredValue(encoded))
    throw new Error("Application produced a non-structured surface.");
  const snapshot = structuredRecord(encoded);
  if (snapshot === undefined)
    throw new Error("Application surface snapshot is malformed.");
  const revision = snapshot["revision"];
  const commands = snapshot["commands"];
  const accessibility = snapshot["accessibility"];
  if (
    typeof revision !== "number" ||
    !Array.isArray(commands) ||
    !Array.isArray(accessibility)
  )
    throw new Error("Application surface snapshot is malformed.");
  post({ type: "surface", revision, commands, accessibility });
}
function deliverEvent(event: StructuredValue): void {
  if (runtime === undefined) return;
  const values = structuredRecord(event);
  if (
    values?.["kind"] === "keyboard" &&
    (values["type"] === "down" || values["type"] === "up") &&
    typeof values["key"] === "string"
  ) {
    runtime.dispatchKeyboard(values["type"], {
      key: values["key"],
      code: typeof values["code"] === "string" ? values["code"] : values["key"],
      shift: values["shift"] === true,
      alt: values["alt"] === true,
      control: values["control"] === true,
      meta: values["meta"] === true,
    });
    return;
  }
  if (
    values?.["kind"] === "pointer" &&
    (values["type"] === "enter" ||
      values["type"] === "leave" ||
      values["type"] === "down" ||
      values["type"] === "up") &&
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
    values?.["kind"] === "wheel" &&
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
  }
}
function structuredRecord(
  value: StructuredValue,
): Readonly<Record<string, StructuredValue>> | undefined {
  const candidate: unknown = value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
    return undefined;
  const output: Record<string, StructuredValue> = {};
  for (const [key, item] of Object.entries(candidate))
    if (isStructuredValue(item)) output[key] = item;
    else return undefined;
  return output;
}
