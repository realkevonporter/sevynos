import { appendFileSync, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Log uncaught errors before the process exits so boot failures are diagnosable.
process.on("uncaughtException", (error) => {
  console.error("SEVYN_GENESIS_UNCAUGHT_EXCEPTION", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("SEVYN_GENESIS_UNHANDLED_REJECTION", reason);
  process.exit(1);
});

// Protect the Genesis session host from the OOM killer (Ubuntu 26.10 model:
// session-critical processes die last, applications die first). Gated on
// SEVYN_WAYLAND_BRIDGE so test runners importing this module don't touch
// /proc. Best-effort: boot continues when the write fails.
if (
  process.env["SEVYN_WAYLAND_BRIDGE"] !== undefined &&
  process.env["SEVYN_WAYLAND_BRIDGE"] !== ""
) {
  if (!protectCurrentProcessFromOomKiller()) {
    console.error("SEVYN_GENESIS_OOM_PROTECT_FAILED");
  }
}
import { DisplayRenderPlanner, GenesisFrameExecutor } from "@sevynos/graphics";
import { createWheelInputEvent, type PointerInputEvent } from "@sevynos/input";
import {
  loadTrustedUpdateKeys,
  markSessionReady,
  OsUpdateService,
  resolveCurrentVersion,
  type TrustedUpdateKey,
} from "@sevynos/os-update";
import {
  createDesktopRuntime,
  DesktopIsolatedApplicationCoordinator,
  DesktopPersistenceController,
  DesktopSceneComposer,
  hitTestDesktopSceneControl,
  restoreDesktopSession,
  validateDesktopSettings,
  type DesktopPersistenceAdapter,
  type DesktopRuntime,
  type DesktopScene,
  type DesktopWindowSceneNode,
} from "@sevynos/desktop-shell";

import {
  installNativeAdapters,
  WebSocket as SevynWebSocket,
  type ApplicationWorkerExecutor,
} from "@sevynos/react-native/internal";
import { createOnboardingRecord, isOnboardingComplete } from "./onboarding.js";
import type {
  SevynPowerService,
  SevynBrowserEngine,
  SevynWirelessNetworkService,
  SevynBatteryService,
  SevynAudioService,
  SevynTimeService,
  SevynSystemService,
  SevynProcessService,
  SevynFileSystem,
  FileSystemEntry,
  SevynApplicationPackage,
  StructuredValue,
  WirelessNetworkSnapshot,
} from "@sevynos/react-native/internal";
import { LinuxWirelessNetworkService } from "./linux-wireless-network-service.js";
import { LinuxBatteryService } from "./linux-battery-service.js";
import { LinuxAudioService } from "./linux-audio-service.js";
import { LinuxTimeService } from "./linux-time-service.js";
import { LinuxNativeModuleServices } from "./linux-native-module-services.js";
import { LinuxPowerService } from "./linux-power-service.js";
import { protectCurrentProcessFromOomKiller } from "./oom-score.js";
import { LinuxSystemService } from "./linux-system-service.js";
import { LinuxProcessService } from "./linux-process-service.js";
import { LinuxFileSystem } from "./linux-file-system.js";
import { FileArchiveService } from "@sevynos/file-archives";
import { ChromiumBrowserEngine } from "./chromium-browser-engine.js";
import { LinuxSevynCodeService } from "./linux-sevyn-code-service.js";
import { HermesLinuxProcessApplicationExecutor } from "./linux-process-application-executor.js";
import { NativeProcessBridgeTransport } from "./native-process-bridge-transport.js";
import type { NativeBridgeMessage } from "./native-ipc-protocol.js";
import type { NativeBridgeTransport } from "./wayland-bridge.js";
import { PointerEventCoalescer } from "./pointer-event-coalescer.js";
import { PresentationFrameScheduler } from "./presentation-frame-scheduler.js";
import { CARET_BLINK_PERIOD_MS } from "./software-frame-renderer.js";
import { FrameMetrics } from "./frame-metrics.js";
import { RustFramePresenter } from "./rust-frame-presenter.js";
import {
  WaylandBridgeConnection,
  WaylandClipboardAdapter,
  WaylandDisplayAdapter,
  WaylandFramePresenter,
  WaylandKeyboardAdapter,
  WaylandPointerAdapter,
  WaylandShutdownAdapter,
  FileLinuxPersistenceAdapter,
  FileLinuxApplicationStorage,
} from "./wayland-bridge.js";

export interface RunningWaylandHost {
  readonly runtime: DesktopRuntime;
  readonly clipboard: WaylandClipboardAdapter;
  readonly frameCount: () => number;
  shutdown(): Promise<void>;
}

export interface WaylandHostOptions {
  readonly persistence?: FileLinuxPersistenceAdapter;
  readonly marker?: (value: string) => void;
  readonly isolatedExecutor?: ApplicationWorkerExecutor;
  readonly network?: SevynWirelessNetworkService;
  readonly power?: SevynPowerService;
  readonly battery?: SevynBatteryService;
  readonly audio?: SevynAudioService;
  readonly time?: SevynTimeService;
  readonly system?: SevynSystemService;
  readonly processes?: SevynProcessService;
  readonly filesystem?: SevynFileSystem;
  readonly createBrowserEngine?: () => SevynBrowserEngine;
  readonly createSevynCodeEngine?: () => SevynBrowserEngine | undefined;
  /**
   * OS update service (versioned feed check + download + stage). When
   * provided, it is wired into the desktop surfaces so Settings can drive
   * check/download/install.
   */
  readonly update?: OsUpdateService | undefined;
  /**
   * Host state directory (SEVYN_STATE_DIRECTORY). When provided, the first
   * presented compositor frame writes the boot-health session-ready
   * marker and resets the boot-attempt counter, telling the next boot's
   * init that this boot reached a healthy desktop.
   */
  readonly stateDirectory?: string | undefined;
}

// Phase 2 (c): lid-close sleep + battery charge limits. Module-level so both
// startWaylandHost (adapter install) and the main entry (lid watch wiring)
// share one instance. The constructor performs no I/O.
const powerService = new LinuxPowerService();

/**
 * Where Chromium puts finished downloads when no explicit downloadDirectory
 * is configured (mirrors ChromiumBrowserEngine's default). The desktop
 * shell resolves browser download actions against the same directory.
 */
function defaultBrowserDownloadDirectory(): string | undefined {
  const stateDirectory = process.env["SEVYN_STATE_DIRECTORY"];
  return stateDirectory === undefined ? undefined : join(stateDirectory, "Downloads");
}

export async function startWaylandHost(
  transport: NativeBridgeTransport,
  options: WaylandHostOptions = {},
): Promise<RunningWaylandHost> {
  const marker = options.marker ?? (() => undefined);
  const connection = new WaylandBridgeConnection(transport);
  const displays = new WaylandDisplayAdapter(connection);
  const pointer = new WaylandPointerAdapter(connection);
  const keyboard = new WaylandKeyboardAdapter(connection);
  const clipboard = new WaylandClipboardAdapter(connection);
  const shutdownAdapter = new WaylandShutdownAdapter(connection);
  const nativeModules = new LinuxNativeModuleServices();
  const emittedNativeMarkers = new Set<string>();
  const unsubscribeNativeMarkers = connection.subscribe((message) => {
    if (message.type !== "diagnostic") return;
    const nativeMarker =
      message.event === "input-devices-initialized"
        ? "SEVYN_GENESIS_INPUT_DEVICES_INITIALIZED"
        : message.event === "visible-surface-configured"
          ? "SEVYN_GENESIS_VISIBLE_SURFACE_CONFIGURED"
          : message.event === "pointer-input-received"
            ? "SEVYN_GENESIS_POINTER_INPUT_RECEIVED"
            : message.event === "keyboard-input-received"
              ? "SEVYN_GENESIS_KEYBOARD_INPUT_RECEIVED"
              : undefined;
    if (nativeMarker === undefined || emittedNativeMarkers.has(nativeMarker)) return;
    emittedNativeMarkers.add(nativeMarker);
    marker(nativeMarker);
  });
  type DisplayConfiguredMessage = Extract<
    NativeBridgeMessage,
    { readonly type: "display-configured" }
  >;
  let pendingDisplayConfiguration: DisplayConfiguredMessage | undefined;
  const displayConfigurationHandler: {
    apply?: (message: DisplayConfiguredMessage) => void;
  } = {};
  const unsubscribeDisplays = connection.subscribe((message) => {
    if (message.type !== "display-configured") return;
    if (displayConfigurationHandler.apply === undefined)
      pendingDisplayConfiguration = message;
    else displayConfigurationHandler.apply(message);
  });
  connection.send({ type: "initialize", applicationName: "SevynOS Genesis" });
  const discovered = await displays.discover();
  const primary = discovered.find((display) => display.primary) ?? discovered[0];
  if (primary === undefined) throw new Error("Wayland did not expose a display.");
  marker("SEVYN_GENESIS_RUST_BRIDGE_CONNECTED");
  const loadedSettings =
    options.persistence === undefined
      ? undefined
      : validateDesktopSettings(await options.persistence.load("desktop-settings"));
  const network = options.network ?? new LinuxWirelessNetworkService();
  const battery = options.battery ?? new LinuxBatteryService();
  const audio = options.audio ?? new LinuxAudioService();
  const time = options.time ?? new LinuxTimeService();
  const system = options.system ?? new LinuxSystemService();
  const processes = options.processes ?? new LinuxProcessService();
  const filesystem = options.filesystem ?? new LinuxFileSystem();

  // Sync the system clock as soon as Wi-Fi connects; NTP needs the network.
  network.subscribe(() => {
    void network
      .snapshot()
      .then((snapshot) => {
        if (snapshot.state === "connected" && time instanceof LinuxTimeService) {
          time.notifyNetworkAvailable();
        }
      })
      .catch(() => undefined);
  });

  // Reconnect to a saved Wi-Fi network at boot. The persisted
  // wpa_supplicant configuration is the source of truth, so an installed
  // system comes back online without the QEMU init script's help.
  // Fire-and-forget: boot must not wait on or fail because of the network.
  void (async () => {
    try {
      if ((await network.reconnectToSavedNetwork?.()) === true)
        marker("SEVYN_WIFI_RECONNECTED_ON_BOOT");
    } catch {
      // Best effort only.
    }
  })();

  const runtime = await createDesktopRuntime({
    launchDefaults: false,
    ...(loadedSettings === undefined ? {} : { settings: loadedSettings }),
    hitTestProbe: process.env["SEVYN_HITTEST_PROBE"] === "1",
    network,
    ...(options.power === undefined ? {} : { power: options.power }),
    battery,
    audio,
    time,
    system,
    processes,
    filesystem,
    ...(options.createBrowserEngine === undefined
      ? {}
      : { createBrowserEngine: options.createBrowserEngine }),
    ...(options.createSevynCodeEngine === undefined
      ? {}
      : { createSevynCodeEngine: options.createSevynCodeEngine }),
  });
  const openApplicationUrl = async (url: string): Promise<void> => {
    if (!/^(https?|sevyn):\/\//.test(url))
      throw new Error("SevynOS can only open HTTP, HTTPS, and sevyn URLs.");
    const browser = await runtime.applications.launch("org.sevynos.browser");
    await runtime.surfaces.navigateBrowser(browser.windowId, url);
  };
  installNativeAdapters({
    accessibility: {
      getState: () => nativeModules.accessibilityState(),
      subscribe: (listener) => nativeModules.subscribeAccessibility(listener),
      announce: (message) => nativeModules.announceAccessibility(message),
    },
    linking: {
      openURL: openApplicationUrl,
      canOpenURL: (url) => Promise.resolve(/^(https?|sevyn):\/\//.test(url)),
      getInitialURL: () => Promise.resolve(null),
    },
    networkInfo: {
      getState: async () => networkInfoSnapshot(await network.snapshot()),
      subscribe: (listener) => network.subscribe(listener),
    },
    webSocket: {
      open: async (url, protocols) => {
        const value = await nativeModules.request("websocket.open", {
          id: `desktop-websocket-${String(Date.now())}-${Math.random().toString(16).slice(2)}`,
          url,
          protocols: protocols ?? null,
        });
        return websocketOpenResult(value);
      },
      send: async (id, data) => {
        await nativeModules.request("websocket.send", {
          id,
          text: data.text ?? null,
          base64: data.base64 ?? null,
        });
      },
      receive: async (id) =>
        websocketEvent(await nativeModules.request("websocket.receive", id)),
      close: async (id, code, reason) => {
        await nativeModules.request("websocket.close", {
          id,
          code: code ?? null,
          reason: reason ?? null,
        });
      },
    },
    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    },
    image: {
      load: async (uri) => {
        const value = await nativeModules.request("image.load", uri);
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Image descriptor is malformed.");
        const descriptor = value as Readonly<Record<string, StructuredValue>>;
        const path = descriptor["path"];
        const width = descriptor["width"];
        const height = descriptor["height"];
        if (
          typeof path !== "string" ||
          typeof width !== "number" ||
          typeof height !== "number"
        )
          throw new Error("Image descriptor is incomplete.");
        return { width, height, pixels: new Uint8Array(await readFile(path)) };
      },
    },
    camera: {
      capture: (options) =>
        nativeModules.request("camera.capture", (options ?? null) as StructuredValue),
      recordStart: (options) =>
        nativeModules.request("camera.recordStart", (options ?? null) as StructuredValue),
      recordStop: () => nativeModules.request("camera.recordStop", null),
      preview: async () => {
        const result = await nativeModules.request("camera.preview", null);
        if (typeof result !== "object" || result === null || Array.isArray(result))
          return { width: 640, height: 360, available: false };
        const frame = result as Readonly<Record<string, StructuredValue>>;
        const width = typeof frame["width"] === "number" ? frame["width"] : 640;
        const height = typeof frame["height"] === "number" ? frame["height"] : 360;
        const timestamp =
          typeof frame["timestamp"] === "number" ? frame["timestamp"] : Date.now();
        if (frame["available"] === false || typeof frame["path"] !== "string")
          return { width, height, available: false, timestamp };
        const pixels = new Uint8Array(await readFile(frame["path"]));
        if (pixels.byteLength !== width * height * 4)
          throw new Error("Camera preview returned an invalid pixel buffer.");
        return {
          width,
          height,
          pixels,
          available: true,
          path: frame["path"],
          timestamp,
        };
      },
      status: () => nativeModules.request("camera.status", null),
      setTorch: (enabled) => nativeModules.request("camera.torch", enabled),
      readImage: async (path: string) => {
        const result = await nativeModules.request("camera.readImage", path);
        if (typeof result !== "object" || result === null || Array.isArray(result))
          return { width: 0, height: 0, available: false };
        const frame = result as Readonly<Record<string, StructuredValue>>;
        const width = typeof frame["width"] === "number" ? frame["width"] : 0;
        const height = typeof frame["height"] === "number" ? frame["height"] : 0;
        const timestamp =
          typeof frame["timestamp"] === "number" ? frame["timestamp"] : Date.now();
        if (frame["available"] === false || typeof frame["path"] !== "string")
          return { width, height, available: false, timestamp };
        const pixels = new Uint8Array(await readFile(frame["path"]));
        if (pixels.byteLength !== width * height * 4)
          throw new Error("Camera readImage returned an invalid pixel buffer.");
        return {
          width,
          height,
          pixels,
          available: true,
          path: frame["path"],
          timestamp,
        };
      },
      playVideo: async (path: string, options?: { startSec?: number }) => {
        const result = await nativeModules.request("camera.playVideo", {
          path,
          startSec: options?.startSec ?? 0,
        });
        if (typeof result !== "object" || result === null || Array.isArray(result))
          return { width: 0, height: 0, durationSec: 0, fps: 0, available: false };
        const info = result as Readonly<Record<string, StructuredValue>>;
        return {
          width: typeof info["width"] === "number" ? info["width"] : 0,
          height: typeof info["height"] === "number" ? info["height"] : 0,
          durationSec: typeof info["durationSec"] === "number" ? info["durationSec"] : 0,
          fps: typeof info["fps"] === "number" ? info["fps"] : 0,
          available: info["available"] !== false,
        };
      },
      videoFrame: async () => {
        const result = await nativeModules.request("camera.videoFrame", null);
        if (typeof result !== "object" || result === null || Array.isArray(result))
          return { width: 0, height: 0, available: false };
        const frame = result as Readonly<Record<string, StructuredValue>>;
        const width = typeof frame["width"] === "number" ? frame["width"] : 0;
        const height = typeof frame["height"] === "number" ? frame["height"] : 0;
        const frameIndex =
          typeof frame["frameIndex"] === "number" ? frame["frameIndex"] : 0;
        const ended = frame["ended"] === true;
        const timestamp =
          typeof frame["timestamp"] === "number" ? frame["timestamp"] : Date.now();
        if (frame["available"] === false || typeof frame["path"] !== "string")
          return { width, height, available: false, frameIndex, ended, timestamp };
        const pixels = new Uint8Array(await readFile(frame["path"]));
        if (pixels.byteLength !== width * height * 4)
          return { width, height, available: false, frameIndex, ended, timestamp };
        return {
          width,
          height,
          pixels,
          available: true,
          path: frame["path"],
          frameIndex,
          ended,
          timestamp,
        };
      },
      stopVideo: () => nativeModules.request("camera.stopVideo", null),
    },
    microphone: {
      start: async (options) => {
        await nativeModules.request(
          "microphone.start",
          (options ?? null) as StructuredValue,
        );
      },
      stop: async () => {
        await nativeModules.request("microphone.stop", null);
      },
    },
    location: {
      getCurrentPosition: () => nativeModules.request("location.current", null),
    },
    bluetooth: {
      scan: async (): Promise<readonly unknown[]> => {
        const value = await nativeModules.request("bluetooth.scan", null);
        return Array.isArray(value) ? (value as readonly unknown[]) : [];
      },
      getState: () => nativeModules.request("bluetooth.state", null),
      setPowered: (enabled: boolean) =>
        nativeModules.request("bluetooth.power.set", { enabled }),
      listDevices: async () => {
        const value = await nativeModules.request("bluetooth.devices", null);
        return Array.isArray(value) ? (value as readonly unknown[]) : [];
      },
      pair: (address: string) => nativeModules.request("bluetooth.pair", { address }),
      respondToPairing: (accept: boolean, pin?: string) =>
        nativeModules.request("bluetooth.pairRespond", {
          accept,
          pin: pin ?? null,
        }),
      cancelPairing: () =>
        nativeModules
          .request("bluetooth.pairRespond", { accept: false })
          .then(() => undefined),
      connect: (address: string) =>
        nativeModules.request("bluetooth.connect", { address }),
      disconnect: (address: string) =>
        nativeModules.request("bluetooth.disconnect", { address }),
      remove: (address: string) => nativeModules.request("bluetooth.remove", { address }),
      setTrusted: (address: string, trusted: boolean) =>
        nativeModules.request("bluetooth.trust", { address, trusted }),
    },
    display: {
      getBrightness: async () => {
        const value = await nativeModules.request("display.brightness.get", null);
        return typeof value === "number" ? value : 1;
      },
      setBrightness: (val: number) =>
        nativeModules.request("display.brightness.set", val).then(() => undefined),
      getOutputs: async () => {
        const value = await nativeModules.request("display.outputs.get", null);
        return Array.isArray(value) ? (value as readonly unknown[]) : [];
      },
      setMode: (
        outputId: string,
        mode: { width: number; height: number; refreshHz?: number },
      ) =>
        nativeModules.request("display.mode.set", {
          outputId,
          width: mode.width,
          height: mode.height,
          refreshHz: mode.refreshHz ?? null,
        }),
      setRotation: (outputId: string, degrees: 0 | 90 | 180 | 270) =>
        nativeModules.request("display.rotation.set", { outputId, degrees }),
    },
    power: {
      getChargeLimit: () => powerService.getChargeLimit(),
      setChargeLimit: (limit: { startPct?: number; endPct?: number }) =>
        powerService.setChargeLimit(limit),
      getLidAction: () => powerService.getLidAction(),
      setLidAction: (action: "sleep" | "nothing") => powerService.setLidAction(action),
      getLidState: () => powerService.getLidState(),
    },
    sensors: { read: (sensor) => nativeModules.request("sensors.read", sensor) },
    biometrics: {
      authenticate: async () => {
        const value = await nativeModules.request("biometrics.authenticate", null);
        return (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          (value as Readonly<Record<string, StructuredValue>>)["authenticated"] === true
        );
      },
      enroll: (type, label) =>
        nativeModules.request("biometrics.enroll", { type, label: label ?? "" }),
      deleteEnrolled: (type, id) =>
        nativeModules.request("biometrics.delete", { type, id }),
      listEnrolled: async () => {
        const value = await nativeModules.request("biometrics.list", null);
        return Array.isArray(value) ? (value as readonly unknown[]) : [];
      },
      verifyPin: async (pin) => {
        const value = (await nativeModules.request("biometrics.pin.verify", {
          pin,
        })) as Record<string, StructuredValue>;
        return value["verified"] === true;
      },
    },
    media: {
      play: async (source) => {
        await nativeModules.request("media.play", source);
      },
      pause: () => nativeModules.request("media.pause", null),
      resume: () => nativeModules.request("media.resume", null),
      stop: async () => {
        await nativeModules.request("media.stop", null);
      },
      seek: (seconds) => nativeModules.request("media.seek", seconds),
      setVolume: (volume) => nativeModules.request("media.volume", volume),
      status: () => nativeModules.request("media.status", null),
      scan: async (directory) => {
        const value = await nativeModules.request("media.scan", directory ?? null);
        return Array.isArray(value) ? (value as readonly unknown[]) : [];
      },
    },
    notifications: {
      schedule: async (payload) => {
        const value = await nativeModules.request(
          "notifications.show",
          payload as StructuredValue,
        );
        const id =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Readonly<Record<string, StructuredValue>>)["id"]
            : undefined;
        return typeof id === "string" ? id : `notification-${String(Date.now())}`;
      },
    },
    nativeModules: {
      invoke: (module, method, argumentsValue) =>
        nativeModules.request("native.invoke", {
          module,
          method,
          arguments: (argumentsValue ?? null) as StructuredValue,
        }),
    },
    webview: {
      createEngine: options.createBrowserEngine ?? (() => new ChromiumBrowserEngine()),
    },
  });
  (globalThis as unknown as { WebSocket?: typeof SevynWebSocket }).WebSocket =
    SevynWebSocket;
  marker("SEVYN_GENESIS_TYPESCRIPT_RUNTIME_INITIALIZED");
  let viewport = {
    width: primary.bounds.width,
    height: primary.bounds.height,
    scaleFactor: primary.scaleFactor,
  };
  marker(
    `TYPESCRIPT DISPLAY SIZE width=${String(viewport.width)} height=${String(viewport.height)} scale=${String(viewport.scaleFactor)} reason=initial`,
  );
  runtime.layout.configureHostDisplays(
    discovered.map((display) => ({
      id: `display-${display.id}`,
      name: display.id,
      bounds: display.bounds,
      pixelWidth: Math.round(display.bounds.width * display.scaleFactor),
      pixelHeight: Math.round(display.bounds.height * display.scaleFactor),
      scaleFactor: display.scaleFactor,
      refreshRate: display.refreshRate,
      primary: display.primary,
    })),
  );
  connection.send({
    type: "configure",
    width: viewport.width,
    height: viewport.height,
    scaleFactor: viewport.scaleFactor,
  });
  marker("SEVYN_GENESIS_DISPLAY_REGISTERED");
  const persistenceAdapter = options.persistence;
  const sessionAdapter: DesktopPersistenceAdapter | undefined =
    persistenceAdapter === undefined
      ? undefined
      : {
          load: () => persistenceAdapter.load("desktop-session"),
          save: (session) => persistenceAdapter.save("desktop-session", session),
          clear: () => persistenceAdapter.clear("desktop-session"),
        };
  if (sessionAdapter !== undefined && loadedSettings?.restorePreviousSession === true) {
    await restoreDesktopSession(runtime, await sessionAdapter.load(), viewport);
  }
  // Wire the OS update service into the desktop so Settings can drive
  // check / download / install. Auto-check runs on its own timer.
  if (options.update !== undefined) {
    runtime.surfaces.configureUpdateService(options.update);
    marker("SEVYN_GENESIS_UPDATE_SERVICE_READY");
  }
  // Phase 2 integration: the Files app's archive Extract UI stays hidden
  // unless a backend is injected. Root it at the user-data directory — the
  // same root the Files app's filesystem sees.
  if (filesystem instanceof LinuxFileSystem) {
    runtime.surfaces.configureArchiveService(
      new FileArchiveService({ rootDirectory: filesystem.rootDirectory }),
    );
  }
  // Phase 2 integration: the browser's Open / Show in Files / Install
  // download actions resolve downloadDirectory/filename. Keep the shell's
  // directory in sync with the Chromium engine default
  // (SEVYN_STATE_DIRECTORY/Downloads).
  const browserDownloadDirectory = defaultBrowserDownloadDirectory();
  if (browserDownloadDirectory !== undefined) {
    runtime.surfaces.configureBrowserDownloadDirectory(browserDownloadDirectory);
  }
  // Fresh boot starts with a clean desktop (no auto-launched apps).
  // resetToDefaults() is reserved for explicit user-initiated reset
  // via persistence.reset().
  // First-run setup: before the desktop becomes interactive, run the setup
  // wizard exactly once per state directory. The completion flag lives in the
  // host persistence; without persistence the wizard is skipped so a
  // stateless session can never nag on every boot.
  if (persistenceAdapter !== undefined) {
    const onboardingRecord = await persistenceAdapter
      .load("onboarding")
      .catch(() => undefined);
    if (!isOnboardingComplete(onboardingRecord)) {
      marker("SEVYN_GENESIS_FIRST_RUN_SETUP_STARTED");
      await runtime.runFirstRunSetup();
      await persistenceAdapter.save("onboarding", createOnboardingRecord());
      marker("SEVYN_GENESIS_FIRST_RUN_SETUP_COMPLETE");
    }
  }
  marker("SEVYN_GENESIS_SYSTEM_APPLICATIONS_LAUNCHED");
  const isolatedApplications =
    options.isolatedExecutor === undefined
      ? undefined
      : await DesktopIsolatedApplicationCoordinator.create({
          runtime,
          executor: options.isolatedExecutor,
          ...(persistenceAdapter === undefined
            ? {}
            : { storage: await FileLinuxApplicationStorage.create(persistenceAdapter) }),
          onProcessLaunched: (applicationId) => {
            marker(`SEVYN_GENESIS_ISOLATED_PROCESS_LAUNCHED id=${applicationId}`);
            if (applicationId === "org.sevynos.notes")
              marker("SEVYN_GENESIS_NOTES_ISOLATED_PROCESS_LAUNCHED");
          },
          services: {
            request: async (_applicationId, service, argumentsValue) => {
              if (service === "clipboard.read") return clipboard.readText();
              if (service === "clipboard.write") {
                if (typeof argumentsValue !== "string")
                  throw new Error("Clipboard writes require text.");
                await clipboard.writeText(argumentsValue);
                return null;
              }
              if (service === "filesystem.list" || service === "filesystem.read") {
                if (typeof argumentsValue !== "string")
                  throw new Error(`Service ${service} requires a path.`);
                if (service === "filesystem.list")
                  return (await filesystem.list(argumentsValue)).map(
                    filesystemEntrySnapshot,
                  );
                return filesystem.read(argumentsValue);
              }
              if (service === "filesystem.write") {
                const target = filesystemWriteTarget(argumentsValue);
                if (target === undefined)
                  throw new Error(
                    "Service filesystem.write requires a path and content.",
                  );
                await filesystem.write(target.path, target.content);
                return null;
              }
              if (service === "notifications.show") {
                runtime.diagnostics.record({
                  severity: "info",
                  subsystem: "application-worker",
                  event: "notification.requested",
                  message: "An isolated application requested a notification.",
                });
                return nativeModules.request(service, argumentsValue);
              }
              if (service === "linking.open") {
                if (typeof argumentsValue !== "string")
                  throw new Error("Linking requires a URL.");
                await openApplicationUrl(argumentsValue);
                return null;
              }
              if (service === "network.info")
                return networkInfoSnapshot(await network.snapshot());
              if (nativeModules.supports(service))
                return nativeModules.request(service, argumentsValue);
              throw new Error(`Service ${service} has no Linux provider.`);
            },
          },
        });
  if (isolatedApplications !== undefined) {
    const packagePaths = new Set<string>();
    const configuredPackage = process.env["SEVYN_DEV_APPLICATION_PACKAGE"];
    if (configuredPackage !== undefined && configuredPackage !== "")
      packagePaths.add(configuredPackage);
    const preinstalledDirectory = "/opt/sevynos/applications";
    for (const entry of await readdir(preinstalledDirectory).catch(() => []))
      if (entry.endsWith(".sevynapp"))
        packagePaths.add(resolve(preinstalledDirectory, entry));
    for (const packagePath of packagePaths) {
      try {
        const candidate = JSON.parse(
          await readFile(packagePath, "utf8"),
        ) as SevynApplicationPackage;
        await isolatedApplications.installDevelopmentPackage(candidate, {
          launch: false,
        });
        marker(`SEVYN_APPLICATION_PACKAGE_READY id=${candidate.manifest.id}`);
      } catch (error: unknown) {
        runtime.diagnostics.record({
          severity: "error",
          subsystem: "application-package",
          event: "preinstall.failed",
          message:
            error instanceof Error ? error.message : `Unable to load ${packagePath}.`,
        });
      }
    }
  }
  await isolatedApplications?.attachRunningApplications();
  const persistence =
    sessionAdapter === undefined
      ? undefined
      : new DesktopPersistenceController({ runtime, adapter: sessionAdapter });
  persistence?.connect();
  const unsubscribeSettings = runtime.settings.subscribe((settings) => {
    if (persistenceAdapter !== undefined)
      void persistenceAdapter.save("desktop-settings", settings);
  });
  let invalidate = (): void => undefined;
  // Load RN shell components dynamically. In unit tests (vitest), the
  // `react-native` npm package cannot be parsed, so fall back to the legacy
  // native renderers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shellComponents: ReadonlyMap<string, any> = new Map();
  try {
    const { createShellComponentRegistry } =
      await import("@sevynos/desktop-shell/shell-component-registry");
    shellComponents = createShellComponentRegistry();
    console.log(
      `[SevynOS] RN shell components loaded: ${String(shellComponents.size)} components`,
    );
  } catch (error) {
    // Tests or environments without react-native: use legacy renderers.
    console.error(
      `[SevynOS] Failed to load RN shell components, using legacy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const composer = new DesktopSceneComposer(
    runtime,
    undefined,
    () => {
      invalidate();
    },
    shellComponents,
  );
  // Debug-gated frame pipeline instrumentation (Phase 1). When enabled,
  // the presenter records per-frame raster/damage/submit samples and a
  // 1/sec SEVYN_PROBE_FRAMES line reports rolling fps, frame intervals,
  // raster cost, damage area, pipe latency, and scheduler coalescing.
  const frameMetrics =
    process.env["SEVYN_FRAME_METRICS"] === "1" ? new FrameMetrics() : undefined;
  // Rust compositor flag: when SEVYN_RUST_COMPOSITOR=1, delegate rasterization
  // to the Rust compositor instead of the Node.js software renderer.
  // This keeps pixel buffers out of the V8 heap.
  const useRustCompositor = process.env["SEVYN_RUST_COMPOSITOR"] === "1";
  const presenter = useRustCompositor
    ? new RustFramePresenter(connection, marker)
    : new WaylandFramePresenter(connection, marker, frameMetrics);
  presenter.initialize();
  presenter.setHardwareCursor(true);
  const planner = new DisplayRenderPlanner({
    displays: runtime.environment.displays,
    now: () => new Date(),
  });
  let frames = 0;
  let latestScene: DesktopScene | undefined;
  let latestSceneHasBlinkCommands = false;
  let firstFramePresented = false;
  let lastLayoutDiagnosticSignature: string | undefined;
  let lastLayoutViewportSignature: string | undefined;
  let firstRenderRequested = false;
  let currentInputTraceId: string | undefined;
  const traceStarted = new Map<string, number>();
  const traceRenderRequests = new Map<string, number>();
  const traceFrames = new Map<string, number>();
  const emitLayoutDiagnostics = (scene: DesktopScene): void => {
    const windows = scene.nodes.filter(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    const signature = JSON.stringify({
      displays: runtime.environment.listDisplays().map((display) => ({
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      })),
      windows: windows.map((window) => ({
        bounds: window.base.bounds,
        contentBounds: window.contentBounds,
        commands: window.nativeSurface?.commands.map((command) => ({
          kind: command.kind,
          bounds: command.bounds,
        })),
      })),
    });
    if (signature === lastLayoutDiagnosticSignature) return;
    const viewportSignature = JSON.stringify(viewport);
    const reason =
      lastLayoutDiagnosticSignature === undefined
        ? "initial"
        : viewportSignature === lastLayoutViewportSignature
          ? "surface-sync"
          : "resize";
    for (const display of runtime.environment.listDisplays()) {
      marker(
        `GENESIS_DISPLAY_BOUNDS reason=${reason} id=${display.id} ${formatBounds(display.bounds)} scale=${String(display.scaleFactor)}`,
      );
      marker(
        `GENESIS_WORKSPACE_BOUNDS reason=${reason} id=${display.id} ${formatBounds(display.workArea)}`,
      );
    }
    for (const window of windows) {
      marker(
        `GENESIS_WINDOW_BOUNDS reason=${reason} windowId=${window.windowId} ${formatBounds(window.base.bounds)}`,
      );
      marker(
        `GENESIS_WINDOW_CONTENT_BOUNDS reason=${reason} windowId=${window.windowId} coordinateSpace=desktop-logical ${formatBounds(window.contentBounds)}`,
      );
      const surfaceBounds = runtime.surfaces.getNativeSurfaceBounds(window.windowId);
      if (surfaceBounds !== undefined)
        marker(
          `GENESIS_SURFACE_BOUNDS reason=${reason} windowId=${window.windowId} coordinateSpace=desktop-logical ${formatBounds(surfaceBounds)}`,
        );
      const commands = window.nativeSurface?.commands ?? [];
      if (commands.length === 0)
        marker(
          `GENESIS_NATIVE_COMMAND_BOUNDS reason=${reason} windowId=${window.windowId} coordinateSpace=window-content-local count=0`,
        );
      commands.forEach((command, index) => {
        marker(
          `GENESIS_NATIVE_COMMAND_BOUNDS reason=${reason} windowId=${window.windowId} coordinateSpace=window-content-local index=${String(index)} kind=${command.kind} ${formatBounds(command.bounds)}`,
        );
      });
    }
    lastLayoutDiagnosticSignature = signature;
    lastLayoutViewportSignature = viewportSignature;
  };
  const executor = new GenesisFrameExecutor<DesktopScene>({
    createRenderPlans: () => {
      latestScene = composer.compose(viewport);
      latestSceneHasBlinkCommands = sceneHasBlinkCommands(latestScene);
      emitLayoutDiagnostics(latestScene);
      return planner.createRenderPlans(latestScene);
    },
    renderer: presenter,
    now: () => new Date(),
  });
  const frameScheduler = new PresentationFrameScheduler({
    executeFrame: (traceId) => {
      if (!firstRenderRequested) {
        firstRenderRequested = true;
        marker("GENESIS_FRAME_RENDER_REQUESTED");
      }
      if (traceId !== undefined)
        traceFrames.set(traceId, (traceFrames.get(traceId) ?? 0) + 1);
      if (traceId !== undefined)
        marker(
          `TS_FRAME_STARTED traceId=${traceId} timestampMs=${performance.now().toFixed(3)}`,
        );
      presenter.traceNextFrame(traceId);
      const result = executor.executeFrame();
      frames += result.renderResults.length;
      if (!result.hadWork)
        console.error("GENESIS_FRAME_RENDER_FAILED reason=no-display-render-plans");
      for (const failure of result.failures)
        console.error(
          `GENESIS_FRAME_RENDER_FAILED displayId=${failure.displayId} error=${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
        );
      return result.renderResults.length > 0 && presenter.lastFrameSubmitted;
    },
  });
  const unsubscribeFrames = connection.subscribe((message) => {
    if (message.type !== "frame-presented") return;
    frameMetrics?.recordPresented(message.frameId, performance.now());
    frameScheduler.framePresented();
    if (!firstFramePresented) {
      firstFramePresented = true;
      marker("SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED");
      // Boot health: the desktop is up. Persist the session-ready marker
      // and reset the boot-attempt counter so the next boot's init knows
      // this boot was healthy. Best-effort — a failure here must never
      // break the session.
      if (options.stateDirectory !== undefined) {
        markSessionReady(options.stateDirectory).catch((error: unknown) => {
          console.error("Failed to write the session-ready marker:", error);
        });
      }
    }
    if (message.traceId !== undefined) {
      const started = traceStarted.get(message.traceId);
      const renderRequests = traceRenderRequests.get(message.traceId) ?? 0;
      const tracedFrames = traceFrames.get(message.traceId) ?? 0;
      marker(
        `TS_FOCUS_FRAME_ACKNOWLEDGED traceId=${message.traceId} frameId=${String(message.frameId)} renderRequests=${String(renderRequests)} frames=${String(tracedFrames)}${started === undefined ? "" : ` totalDurationMs=${(performance.now() - started).toFixed(3)}`}`,
      );
      traceStarted.delete(message.traceId);
      traceRenderRequests.delete(message.traceId);
      traceFrames.delete(message.traceId);
    }
  });
  if (frameMetrics !== undefined) {
    const frameMetricsTimer = setInterval(() => {
      const schedulerSnapshot = frameScheduler.snapshot;
      console.log(
        `SEVYN_PROBE_FRAMES ${JSON.stringify(
          frameMetrics.summarize({
            invalidationCount: schedulerSnapshot.invalidationCount,
            submittedFrameCount: schedulerSnapshot.submittedFrameCount,
          }),
        )}`,
      );
    }, 1000);
    frameMetricsTimer.unref();
  }
  // Defensive: the global performance entry buffer can accumulate
  // measure/mark entries from bundled code without ever being cleared,
  // leading to unbounded heap growth and OOM. Clear it periodically.
  // This does not affect performance.now() timestamps used elsewhere.
  const perfBufferTimer = setInterval(() => {
    try {
      performance.clearMarks();
      performance.clearMeasures();
    } catch {
      // performance API may be unavailable in some environments; ignore.
    }
  }, 30000);
  perfBufferTimer.unref();
  invalidate = (): void => {
    if (currentInputTraceId !== undefined) {
      traceRenderRequests.set(
        currentInputTraceId,
        (traceRenderRequests.get(currentInputTraceId) ?? 0) + 1,
      );
      marker(
        `TS_RENDER_REQUESTED traceId=${currentInputTraceId} timestampMs=${performance.now().toFixed(3)}`,
      );
    }
    frameScheduler.invalidate(currentInputTraceId);
  };
  const unsubscribeRuntime = runtime.subscribe(invalidate);
  invalidate();
  // Caret blink driver (Phase 2 audit). The software rasterizer toggles
  // `blink` material commands on a CARET_BLINK_PERIOD_MS phase grid anchored
  // to the Unix epoch; this timer wakes the frame pipeline on every phase
  // boundary while the composed scene contains a blink command, so a focused
  // text caret visibly blinks even when nothing else invalidates the scene.
  // The incremental renderer adds the caret regions to the frame damage on
  // the phase flip. The timer is unref'd so it never keeps the host alive.
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  const armBlinkTimer = (): void => {
    const now = Date.now();
    const delay = Math.max(1, CARET_BLINK_PERIOD_MS - (now % CARET_BLINK_PERIOD_MS));
    blinkTimer = setTimeout(() => {
      blinkTimer = undefined;
      if (latestSceneHasBlinkCommands) invalidate();
      armBlinkTimer();
    }, delay);
    blinkTimer.unref();
  };
  armBlinkTimer();
  let nativePointerState: NativePointerDispatchState = NO_NATIVE_POINTER_TARGET;
  // Track which shell surface received pointer-down, so pointer-up can
  // complete the press (the RN runtime fires onPress on pointer-up).
  let pressedShellSurface:
    | {
        readonly applicationId: string;
        readonly bounds: { readonly x: number; readonly y: number };
      }
    | undefined;

  const handlePointerEvent = (event: PointerInputEvent): void => {
    // On pointer-up, complete any press that started on a shell surface.
    // The RN runtime fires onPress when pointer-up matches the pointer-down target.
    if (event.type === "pointer-up" || event.type === "pointer-cancel") {
      if (pressedShellSurface !== undefined) {
        const surface = pressedShellSurface;
        pressedShellSurface = undefined;
        const localX = event.position.x - surface.bounds.x;
        const localY = event.position.y - surface.bounds.y;
        composer.dispatchShellPointer(
          surface.applicationId,
          event.type === "pointer-up" ? "up" : "cancel",
          localX,
          localY,
        );
        // Don't return — let the event also flow to the generic handlers below.
      }
    }
    if (event.type === "pointer-down") {
      const shellControl = hitTestDesktopSceneControl(
        latestScene,
        event.position.x,
        event.position.y,
      );
      if (shellControl !== undefined) {
        switch (shellControl.kind) {
          case "desktop-launcher-button":
            runtime.applications.toggleLauncher();
            return;
          case "desktop-launcher-entry":
            if (shellControl.applicationId === "org.sevynos.installer") {
              launchInstallerTerminal();
              runtime.applications.toggleLauncher();
              return;
            }
            if (isolatedApplications === undefined)
              void runtime.applications.launch(shellControl.applicationId);
            else void isolatedApplications.launch(shellControl.applicationId);
            return;
          case "desktop-taskbar-application":
            if (shellControl.applicationId === "org.sevynos.installer") {
              launchInstallerTerminal();
              return;
            }
            runtime.applications.activateTaskbarApplication(shellControl.applicationId);
            return;
          case "desktop-window-switcher-entry":
            runtime.applications.selectSwitcherApplication(shellControl.applicationId);
            return;
          case "desktop-lock-screen-unlock":
            runtime.applications.unlock();
            return;
          case "desktop-reset-action":
            void persistence?.reset();
            return;
          case "desktop-workspace-control":
            runtime.environment.switchWorkspace(shellControl.workspaceId);
            runtime.applications.synchronizeKeyboardFocus();
            return;
          case "desktop-shell-surface": {
            // React Native shell component: dispatch pointer-down to the RN runtime.
            // The component handles its own press actions via onPress handlers.
            // Shell surfaces sit below windows in z-order. If the click lands
            // inside a window's bounds, the window gets it, not the shell.
            if (isPointInsideAnyWindow(latestScene, event.position.x, event.position.y)) {
              break;
            }
            const surface = shellControl as unknown as {
              readonly applicationId: string;
              readonly bounds: { readonly x: number; readonly y: number };
            };
            const localX = event.position.x - surface.bounds.x;
            const localY = event.position.y - surface.bounds.y;
            // Remember this surface so pointer-up can complete the press.
            pressedShellSurface = {
              applicationId: surface.applicationId,
              bounds: { x: surface.bounds.x, y: surface.bounds.y },
            };
            composer.dispatchShellPointer(surface.applicationId, "down", localX, localY);
            return;
          }
          case "desktop-workspace-action":
            // Desktop background actions sit below windows. If the click is
            // inside a window, the window gets it, not the background.
            if (isPointInsideAnyWindow(latestScene, event.position.x, event.position.y)) {
              break;
            }
            void (
              shellControl.action === "new-folder"
                ? runtime.createDesktopFolder()
                : runtime.createDesktopFile()
            ).catch((error: unknown) => {
              runtime.diagnostics.record({
                severity: "error",
                subsystem: "desktop",
                event: "desktop-item.create-failed",
                message: String(error),
              });
            });
            return;
          case "desktop-workspace-item":
            // Desktop icons sit below windows in z-order. If the click lands
            // inside a window's bounds, the window gets it, not the icon.
            if (
              !isPointInsideAnyWindow(latestScene, event.position.x, event.position.y)
            ) {
              void runtime.applications.launch("org.sevynos.files");
              return;
            }
            break;
          case "desktop-settings-control":
            applySettingsAction(runtime, shellControl.action);
            return;
          case "desktop-diagnostics-control":
          case "desktop-recovery-control":
            break;
        }
      }
      const windowControl = findWindowControl(
        latestScene,
        event.position.x,
        event.position.y,
      );
      if (windowControl !== undefined) {
        void runtime.activateWindowControl(
          windowControl.windowId,
          windowControl.control,
          primary.bounds,
        );
        return;
      }
    }
    runtime.dispatchPointerEvent({
      type: event.type.replace("pointer-", "pointer"),
      pointerId: event.pointerId,
      timeStamp: event.timestamp,
      clientX: event.position.x,
      clientY: event.position.y,
      button: buttonNumber(event.button),
      buttons: buttonMask(event.buttons),
      pressure: event.pressure,
    });
    nativePointerState = dispatchNativePointer(
      runtime,
      latestScene,
      event,
      nativePointerState,
    );
    if (event.type === "pointer-down")
      connection.send({
        type: "capture-pointer",
        pointerId: event.pointerId,
        captured: true,
      });
    if (event.type === "pointer-up" || event.type === "pointer-cancel")
      connection.send({
        type: "capture-pointer",
        pointerId: event.pointerId,
        captured: false,
      });
  };
  const dispatchPointerEvent = (event: PointerInputEvent): void => {
    const traceId = (event as PointerInputEvent & { readonly traceId?: string }).traceId;
    const target =
      event.type === "pointer-down"
        ? findWindowAt(latestScene, event.position.x, event.position.y)
        : undefined;
    const focusedBefore = focusedWindowId(runtime);
    if (traceId !== undefined) {
      const timestamp = performance.now();
      traceStarted.set(traceId, timestamp);
      marker(
        `TS_POINTER_EVENT_RECEIVED traceId=${traceId} timestampMs=${timestamp.toFixed(3)}`,
      );
      marker(
        `TS_HIT_TEST_COMPLETE traceId=${traceId} windowId=${target?.windowId ?? "none"} timestampMs=${performance.now().toFixed(3)}`,
      );
      if (target !== undefined && target.windowId !== focusedBefore)
        marker(
          `TS_FOCUS_REQUESTED traceId=${traceId} windowId=${target.windowId} timestampMs=${performance.now().toFixed(3)}`,
        );
    }
    currentInputTraceId = traceId;
    try {
      handlePointerEvent(event);
    } finally {
      if (traceId !== undefined)
        marker(
          `TS_FOCUS_STATE_UPDATED traceId=${traceId} windowId=${focusedWindowId(runtime) ?? "none"} timestampMs=${performance.now().toFixed(3)}`,
        );
      currentInputTraceId = undefined;
    }
  };
  const pointerCoalescer = new PointerEventCoalescer({
    dispatch: dispatchPointerEvent,
  });
  const unsubscribePointer = pointer.subscribe((event) => {
    pointerCoalescer.push(event);
  });
  const unsubscribeWheel = connection.subscribe((message) => {
    if (message.type !== "wheel") return;
    const targetWindowId = findTargetWindowForWheel(latestScene, message.x, message.y);
    if (targetWindowId !== undefined) {
      runtime.surfaces.handleInput(
        targetWindowId,
        createWheelInputEvent({
          eventId: `linux-wheel-${String(message.sequence)}`,
          deviceId: "linux-wayland-pointer",
          deviceKind: "mouse",
          timestamp: message.timestamp,
          position: { x: message.x, y: message.y },
          deltaX: message.deltaX,
          deltaY: message.deltaY,
        }),
      );
    }
  });
  const unsubscribeKeyboard = keyboard.subscribe((event) => {
    if (
      event.modifiers.control &&
      event.modifiers.alt &&
      (/^F([1-9]|1[0-2])$/.test(event.key) ||
        /^Keycode(59|6[0-8]|87|88)$/.test(event.code))
    ) {
      // Inhibit Linux VT console switching in SevynOS appliance mode
      return;
    }
    runtime.dispatchKeyboardEvent({
      type: event.type === "key-down" ? "keydown" : "keyup",
      timeStamp: event.timestamp,
      code: event.code,
      key: event.key,
      repeat: event.repeat,
      isComposing: event.composing,
      shiftKey: event.modifiers.shift,
      altKey: event.modifiers.alt,
      ctrlKey: event.modifiers.control,
      metaKey: event.modifiers.meta,
    });
  });
  marker("SEVYN_GENESIS_INPUT_PATH_INITIALIZED");
  marker("SEVYN_GENESIS_CLIPBOARD_INITIALIZED");
  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    runtime.beginShutdown();
    persistence?.disconnect();
    await persistence?.flush();
    await isolatedApplications?.shutdown();
    pointerCoalescer.close();
    if (blinkTimer !== undefined) {
      clearTimeout(blinkTimer);
      blinkTimer = undefined;
    }
    frameScheduler.stop();
    unsubscribePointer();
    unsubscribeWheel();
    unsubscribeKeyboard();
    unsubscribeRuntime();
    unsubscribeFrames();
    unsubscribeNativeMarkers();
    unsubscribeSettings();
    unsubscribeShutdown();
    unsubscribeDisplays();
    composer.dispose();
    if ("close" in network && typeof network.close === "function")
      (network as { close: () => void }).close();
    if ("close" in battery && typeof battery.close === "function")
      (battery as { close: () => void }).close();
    if ("close" in system && typeof system.close === "function")
      (system as { close: () => void }).close();
    if ("close" in processes && typeof processes.close === "function")
      (processes as { close: () => void }).close();
    nativeModules.close();
    await runtime.closeForShutdown();
    presenter.shutdown();
    connection.send({ type: "shutdown-complete" });
    await connection.close();
  };
  const unsubscribeShutdown = shutdownAdapter.subscribe(() => {
    void shutdown();
  });
  displayConfigurationHandler.apply = (message) => {
    const display =
      message.displays.find((candidate) => candidate.primary) ?? message.displays[0];
    if (display === undefined) return;
    const previousViewport = viewport;
    viewport = {
      width: display.width,
      height: display.height,
      scaleFactor: display.scaleFactor,
    };
    if (
      viewport.width !== previousViewport.width ||
      viewport.height !== previousViewport.height ||
      viewport.scaleFactor !== previousViewport.scaleFactor
    )
      marker(
        `TYPESCRIPT DISPLAY SIZE width=${String(viewport.width)} height=${String(viewport.height)} scale=${String(viewport.scaleFactor)} reason=resize`,
      );
    runtime.layout.configureHostDisplays(
      message.displays.map((candidate) => ({
        id: `display-${candidate.id}`,
        name: candidate.id,
        bounds: {
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
        },
        pixelWidth: candidate.pixelWidth,
        pixelHeight: candidate.pixelHeight,
        scaleFactor: candidate.scaleFactor,
        refreshRate: candidate.refreshRate,
        primary: candidate.primary,
      })),
    );
    connection.send({
      type: "configure",
      width: viewport.width,
      height: viewport.height,
      scaleFactor: viewport.scaleFactor,
    });
    invalidate();
  };
  if (pendingDisplayConfiguration !== undefined) {
    const pending = pendingDisplayConfiguration;
    pendingDisplayConfiguration = undefined;
    displayConfigurationHandler.apply(pending);
  }
  return { runtime, clipboard, frameCount: () => frames, shutdown };
}

function websocketOpenResult(value: StructuredValue): {
  readonly id: string;
  readonly protocol: string;
  readonly extensions?: string;
} {
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
}

function websocketEvent(value: StructuredValue): WebSocketAdapterEvent {
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

function structuredRecord(
  value: StructuredValue,
): Record<string, StructuredValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, StructuredValue>)
    : undefined;
}

/**
 * Converts a filesystem entry into a structured value for worker service
 * responses. Optional fields are omitted when unset so the payload always
 * satisfies the worker protocol (which has no `undefined`).
 */
function filesystemEntrySnapshot(entry: FileSystemEntry): StructuredValue {
  return {
    name: entry.name,
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    ...(entry.modified === undefined ? {} : { modified: entry.modified }),
    ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
  };
}

function filesystemWriteTarget(
  value: StructuredValue,
): { readonly path: string; readonly content: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["path"] !== "string" || typeof record["content"] !== "string")
    return undefined;
  return { path: record["path"], content: record["content"] };
}

function networkInfoSnapshot(snapshot: WirelessNetworkSnapshot): {
  readonly type: "wifi" | "none" | "unknown";
  readonly isConnected: boolean;
  readonly isInternetReachable: boolean;
  readonly details: Readonly<Record<string, string | null>>;
} {
  const connected = snapshot.state === "connected";
  return {
    type: connected ? "wifi" : snapshot.available ? "none" : "unknown",
    isConnected: connected,
    isInternetReachable: connected,
    details: {
      ssid: snapshot.connectedSsid ?? null,
      ipAddress: snapshot.ipAddress ?? null,
    },
  };
}

function applySettingsAction(
  runtime: DesktopRuntime,
  action:
    | "installer-launch"
    | "theme"
    | "accent"
    | "taskbar-position"
    | "taskbar-behavior"
    | "display-layout"
    | "workspace-count"
    | "cursor-size"
    | "reduced-motion"
    | "restore-session",
): void {
  if (action === "installer-launch") {
    launchInstallerTerminal();
    return;
  }
  const settings = runtime.settings.snapshot;
  const next = <T>(values: readonly T[], current: T): T =>
    values[(values.indexOf(current) + 1) % values.length] ?? current;
  switch (action) {
    case "theme":
      runtime.settings.update({
        theme: next(["dark", "light", "system"] as const, settings.theme),
      });
      return;
    case "accent":
      runtime.settings.update({
        accentColor: next(
          ["#d5aa4e", "#6ea8fe", "#77d6a3", "#e879a9"] as const,
          settings.accentColor,
        ),
      });
      return;
    case "taskbar-position":
      runtime.settings.update({
        taskbarPosition: next(
          ["bottom", "top", "left", "right"] as const,
          settings.taskbarPosition,
        ),
      });
      return;
    case "taskbar-behavior":
      runtime.settings.update({
        taskbarBehavior:
          settings.taskbarBehavior === "always-visible" ? "auto-hide" : "always-visible",
      });
      return;
    case "display-layout":
      runtime.settings.update({
        displayLayout: next(
          ["side-by-side", "vertical", "offset"] as const,
          settings.displayLayout,
        ),
      });
      return;
    case "workspace-count":
      runtime.settings.update({
        workspaceCount: settings.workspaceCount === 8 ? 1 : settings.workspaceCount + 1,
      });
      return;
    case "cursor-size":
      runtime.settings.update({
        cursorSize: next([0.75, 1, 1.5, 2] as const, settings.cursorSize),
      });
      return;
    case "reduced-motion":
      runtime.settings.update({ reducedMotion: !settings.reducedMotion });
      return;
    case "restore-session":
      runtime.settings.update({
        restorePreviousSession: !settings.restorePreviousSession,
      });
  }
}

function findWindowAt(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): DesktopWindowSceneNode | undefined {
  return scene?.nodes
    .filter((node): node is DesktopWindowSceneNode => node.kind === "desktop-window")
    .sort((first, second) => second.order - first.order)
    .find(
      (window) =>
        x >= window.base.bounds.x &&
        x < window.base.bounds.x + window.base.bounds.width &&
        y >= window.base.bounds.y &&
        y < window.base.bounds.y + window.base.bounds.height,
    );
}

/**
 * Returns true if the point lies inside any window's bounds.
 * Desktop icons and background actions sit below windows in z-order,
 * so clicks inside a window must not trigger them.
 */
function isPointInsideAnyWindow(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): boolean {
  const windows =
    scene?.nodes.filter(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    ) ?? [];
  return windows.some(
    (window) =>
      x >= window.base.bounds.x &&
      x < window.base.bounds.x + window.base.bounds.width &&
      y >= window.base.bounds.y &&
      y < window.base.bounds.y + window.base.bounds.height,
  );
}

function focusedWindowId(runtime: DesktopRuntime): string | undefined {
  return runtime.windows.listWindows().find((window) => window.state === "focused")?.id;
}

function findWindowControl(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
):
  | {
      readonly windowId: DesktopWindowSceneNode["windowId"];
      readonly control: "close" | "minimize" | "maximize" | "restore";
    }
  | undefined {
  const windows =
    scene?.nodes
      .filter((node): node is DesktopWindowSceneNode => node.kind === "desktop-window")
      .sort((first, second) => second.order - first.order) ?? [];
  for (const window of windows)
    for (const control of window.controls)
      if (
        x >= control.x &&
        x < control.x + control.width &&
        y >= control.y &&
        y < control.y + control.height
      )
        return { windowId: window.windowId, control: control.kind };
  return undefined;
}

/**
 * Height of the compositor-drawn title bar in desktop-logical pixels. Must
 * match DESKTOP_VISUAL_METRICS.titleBarHeight in
 * shell/desktop/src/desktop-appearance.ts: a window's native surface covers
 * only the content area below the title bar.
 */
const NATIVE_SURFACE_TITLE_BAR_HEIGHT = 46;

/**
 * Finds the window that should receive a native pointer/wheel event at the
 * given desktop-logical point. The topmost window is selected by its full
 * bounds (matching the desktop focus hit test), then the point must fall
 * inside that window's content area below the title bar.
 *
 * A point on the title bar is window chrome: the desktop runtime handles it
 * (focus/drag/window controls) and no native event is dispatched. It must
 * NOT fall through to a window underneath — that fall-through was the
 * bare-metal click-through bug (a title-bar click on the top window was
 * delivered to the app below it).
 */
export function findNativePointerTarget(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): DesktopWindowSceneNode | undefined {
  const topmost = scene?.nodes
    .filter(
      (node): node is DesktopWindowSceneNode =>
        node.kind === "desktop-window" && node.nativeSurface !== undefined,
    )
    .sort((first, second) => second.order - first.order)
    .find(
      (node) =>
        x >= node.base.bounds.x &&
        x < node.base.bounds.x + node.base.bounds.width &&
        y >= node.base.bounds.y &&
        y < node.base.bounds.y + node.base.bounds.height,
    );
  if (topmost === undefined) {
    return undefined;
  }
  if (y < topmost.base.bounds.y + NATIVE_SURFACE_TITLE_BAR_HEIGHT) {
    return undefined;
  }
  return topmost;
}

interface NativePointerDispatchState {
  /**
   * Window holding implicit pointer capture from pointer-down. While set,
   * motion and release events route to this window even when the cursor
   * leaves its bounds, so drags complete instead of sticking.
   */
  readonly capturedWindowId: string | undefined;
  /** Last fresh hit-test target, used for hover enter/leave transitions. */
  readonly hoveredWindowId: string | undefined;
}

const NO_NATIVE_POINTER_TARGET: NativePointerDispatchState = Object.freeze({
  capturedWindowId: undefined,
  hoveredWindowId: undefined,
});

function dispatchNativePointer(
  runtime: DesktopRuntime,
  scene: DesktopScene | undefined,
  event: PointerInputEvent,
  state: NativePointerDispatchState,
): NativePointerDispatchState {
  const windowNodes =
    scene?.nodes.filter(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    ) ?? [];
  const target = findNativePointerTarget(scene, event.position.x, event.position.y);
  if (process.env["SEVYN_HITTEST_PROBE"] === "1" && event.type === "pointer-down") {
    /*
     * Temporary diagnostic for the bare-metal click-through investigation.
     * The desktop-runtime probe logs the focus controller's hit decision;
     * this logs the Linux host's native pointer dispatch decision for the
     * same click, so the two can be compared directly.
     */
    console.log(
      `SEVYN_PROBE_HITTEST_NATIVE ${JSON.stringify({
        pointer: { x: event.position.x, y: event.position.y },
        target: target?.windowId ?? null,
        nodes: windowNodes.map((node) => ({
          id: node.windowId,
          x: node.base.bounds.x,
          y: node.base.bounds.y,
          width: node.base.bounds.width,
          height: node.base.bounds.height,
          order: node.order,
          nativeSurface: node.nativeSurface !== undefined,
          state: runtime.windows.getWindow(node.windowId)?.state ?? "unknown",
        })),
      })}`,
    );
  }
  const targetWindowId = target?.windowId;
  const pointer = {
    x: event.position.x,
    y: event.position.y,
    pointerId: event.pointerId,
    button: buttonNumber(event.button),
  };

  if (event.type === "pointer-cancel") {
    if (state.capturedWindowId !== undefined) {
      runtime.surfaces.dispatchNativePointer(state.capturedWindowId, "cancel", pointer);
      runtime.surfaces.dispatchNativePointer(state.capturedWindowId, "leave", pointer);
    }
    return NO_NATIVE_POINTER_TARGET;
  }

  if (event.type === "pointer-down") {
    // Native surface enter/leave events are boundary transitions, not motion
    // events. Re-dispatching `enter` for every pointer move invalidates the
    // application surface and forces its render commands to be rebuilt
    // continuously.
    if (state.hoveredWindowId !== undefined && state.hoveredWindowId !== targetWindowId)
      runtime.surfaces.dispatchNativePointer(state.hoveredWindowId, "leave", pointer);
    if (targetWindowId !== undefined) {
      if (targetWindowId !== state.hoveredWindowId)
        runtime.surfaces.dispatchNativePointer(targetWindowId, "enter", pointer);
      runtime.surfaces.dispatchNativePointer(targetWindowId, "down", pointer);
    }
    // Pressing down captures the pointer to the target window; the matching
    // release (or cancel) always returns here even if the cursor wandered off.
    return { capturedWindowId: targetWindowId, hoveredWindowId: targetWindowId };
  }

  if (state.capturedWindowId !== undefined) {
    if (event.type === "pointer-move") {
      runtime.surfaces.dispatchNativePointer(state.capturedWindowId, "move", pointer);
      return state;
    }
    // Pointer-down and pointer-cancel return above, so this is the release.
    runtime.surfaces.dispatchNativePointer(state.capturedWindowId, "up", pointer);
    // Release capture and settle hover where the cursor actually is.
    if (targetWindowId !== state.capturedWindowId) {
      runtime.surfaces.dispatchNativePointer(state.capturedWindowId, "leave", pointer);
      if (targetWindowId !== undefined)
        runtime.surfaces.dispatchNativePointer(targetWindowId, "enter", pointer);
    }
    return { capturedWindowId: undefined, hoveredWindowId: targetWindowId };
  }

  // No capture active: plain hover tracking.
  if (targetWindowId !== state.hoveredWindowId) {
    if (state.hoveredWindowId !== undefined)
      runtime.surfaces.dispatchNativePointer(state.hoveredWindowId, "leave", pointer);
    if (targetWindowId !== undefined)
      runtime.surfaces.dispatchNativePointer(targetWindowId, "enter", pointer);
  }

  if (targetWindowId !== undefined && event.type === "pointer-move")
    runtime.surfaces.dispatchNativePointer(targetWindowId, "move", pointer);

  return { capturedWindowId: undefined, hoveredWindowId: targetWindowId };
}

/**
 * True when any window in the composed scene carries a `blink` material
 * command (e.g. a focused text input caret). The compositor's blink timer
 * uses this to decide whether a phase boundary needs a frame.
 */
function sceneHasBlinkCommands(scene: DesktopScene | undefined): boolean {
  if (scene === undefined) return false;
  return scene.nodes.some(
    (node) =>
      node.kind === "desktop-window" &&
      node.nativeSurface?.commands.some(
        (command) => command.kind === "material" && command.blink === true,
      ) === true,
  );
}

function findTargetWindowForWheel(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): string | undefined {
  return findNativePointerTarget(scene, x, y)?.windowId;
}

function buttonNumber(button: string): number {
  switch (button) {
    case "primary":
      return 0;
    case "middle":
      return 1;
    case "secondary":
      return 2;
    case "back":
      return 3;
    case "forward":
      return 4;
    default:
      return -1;
  }
}
function buttonMask(buttons: readonly string[]): number {
  return buttons.reduce(
    (mask, button) =>
      mask |
      (button === "primary"
        ? 1
        : button === "secondary"
          ? 2
          : button === "middle"
            ? 4
            : 0),
    0,
  );
}

function formatBounds(bounds: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): string {
  return `x=${String(bounds.x)} y=${String(bounds.y)} width=${String(bounds.width)} height=${String(bounds.height)}`;
}

function launchInstallerTerminal(): void {
  const terminal = spawn(
    "/usr/bin/weston-terminal",
    ["--shell=/usr/local/bin/sevyn-installer"],
    { detached: true, stdio: "ignore", env: process.env },
  );
  terminal.unref();
  terminal.on("error", (error) => {
    console.error(`SEVYN_INSTALLER_LAUNCH_FAILED error=${error.message}`);
  });
  console.log("SEVYN_INSTALLER_LAUNCHED_FROM_DESKTOP");
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.platform !== "linux")
    throw new Error("The native Wayland host requires Linux.");
  const executable =
    process.env["SEVYN_WAYLAND_BRIDGE"] ??
    resolve(
      fileURLToPath(
        new URL("../native/target/release/sevyn-wayland-bridge", import.meta.url),
      ),
    );
  const stateDirectory =
    process.env["SEVYN_STATE_DIRECTORY"] ??
    resolve(process.env["XDG_STATE_HOME"] ?? "/var/lib/sevynos", "genesis");
  let requestPoweroff = (): Promise<void> =>
    Promise.reject(new Error("The desktop is still starting."));
  let requestRestart = (): Promise<void> =>
    Promise.reject(new Error("The desktop is still starting."));
  let requestLock = (): Promise<void> =>
    Promise.reject(new Error("The desktop is still starting."));
  let requestSleep = (): Promise<void> =>
    Promise.reject(new Error("The desktop is still starting."));
  let requestLogout = (): Promise<void> =>
    Promise.reject(new Error("The desktop is still starting."));
  const power: SevynPowerService = Object.freeze({
    available: true,
    shutdown: () => requestPoweroff(),
    restart: () => requestRestart(),
    lock: () => requestLock(),
    sleep: () => requestSleep(),
    logout: () => requestLogout(),
  });
  // Start the Sevyn Code backend (code-server + Chromium screencast).
  // If it fails (e.g. code-server not installed in dev), the IDE will
  // show an error instead of crashing the host.
  const sevynCodeService = new LinuxSevynCodeService();
  try {
    await sevynCodeService.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Sevyn Code service failed to start:", message);
    // Mirror to serial so the failure is visible in QEMU logs
    try {
      const { existsSync, appendFileSync } = await import("node:fs");
      if (existsSync("/dev/ttyS0")) {
        appendFileSync("/dev/ttyS0", `SEVYN_CODE_SERVICE_FAILED: ${message}\n`);
      }
    } catch {
      // Ignore errors writing to serial port
    }
  }
  // OS update service: versioned feed check + download + stage. The feed URL
  // The trust anchor (/etc/sevynos/trusted-update-keys.json, baked into the
  // image) is loaded explicitly: when it is missing or empty the service
  // fails closed and every check reports "no trusted update keys" in the
  // Software Update UI instead of silently trusting an unsigned feed.
  let trustedKeys: TrustedUpdateKey[] = [];
  try {
    trustedKeys = await loadTrustedUpdateKeys();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`No trusted update keys loaded: ${message}`);
  }
  // Installed systems default to the stable channel; a channel the user
  // previously chose in Settings → Software Update is restored here.
  const persistedChannel = await OsUpdateService.readPersistedChannel(
    stateDirectory,
  ).catch(() => undefined);
  // The update service is best-effort: a bad version must disable updates,
  // never prevent the desktop from booting.
  let updateService: OsUpdateService | undefined;
  try {
    updateService = new OsUpdateService({
      currentVersion: await resolveCurrentVersion().catch(() => "0.0.0-dev"),
      feedUrl: process.env["SEVYN_UPDATE_FEED_URL"],
      channel: persistedChannel ?? "stable",
      stateDirectory,
      trustedKeys,
    });
    updateService.startAutoCheck();
  } catch (error) {
    console.error(
      `[sevyn] OS update service disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const host = await startWaylandHost(new NativeProcessBridgeTransport(executable), {
    persistence: new FileLinuxPersistenceAdapter(stateDirectory),
    network: new LinuxWirelessNetworkService(),
    power,
    battery: new LinuxBatteryService(),
    audio: new LinuxAudioService(),
    system: new LinuxSystemService(),
    filesystem: new LinuxFileSystem(),
    update: updateService,
    stateDirectory,
    createBrowserEngine: () => {
      // The browser keeps a persistent profile; every other engine
      // (Sevyn Code, webviews) gets an isolated temp profile so two
      // Chromium processes never contend for one profile lock.
      const browserStateDirectory = process.env["SEVYN_STATE_DIRECTORY"];
      return new ChromiumBrowserEngine(
        browserStateDirectory === undefined
          ? {}
          : {
              userDataDirectory: join(browserStateDirectory, "browser-profile"),
              // Explicit so the shell's download actions resolve the exact
              // directory Chromium writes to (see
              // configureBrowserDownloadDirectory).
              downloadDirectory: join(browserStateDirectory, "Downloads"),
            },
      );
    },
    createSevynCodeEngine: () => {
      const engine = sevynCodeService.engine;
      if (!engine) {
        console.error(
          "Sevyn Code service is not running; IDE will show unavailable state.",
        );
        return undefined;
      }
      return engine;
    },
    isolatedExecutor: new HermesLinuxProcessApplicationExecutor(),
    marker: (value) => {
      console.log(value);
      try {
        if (
          existsSync("/dev/ttyS0") &&
          shouldMirrorMarkerToSerial(value, process.env["SEVYN_FOCUS_TRACE"] === "1")
        ) {
          appendFileSync("/dev/ttyS0", value + "\n");
        }
      } catch {
        // Ignore errors writing to serial port
      }
    },
  });
  let stopping = false;
  requestPoweroff = async () => {
    if (stopping) return;
    stopping = true;
    await sevynCodeService.stop().catch(() => undefined);
    await host.shutdown();
    console.log("SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE");
    process.exitCode = 0;
  };
  requestRestart = async () => {
    if (stopping) return;
    stopping = true;
    await sevynCodeService.stop().catch(() => undefined);
    // The desktop runs as an unprivileged user, so it cannot reboot(2)
    // directly. Write the reboot marker the same way `sevyn system power
    // restart` does; installed-init reboots when the marker is present after
    // the desktop exits, and powers off otherwise. Refuse to shut down when
    // the marker cannot be written so a restart never silently degrades to
    // a poweroff.
    const fs = await import("node:fs/promises");
    try {
      await fs.mkdir("/run/sevynos", { recursive: true });
      await fs.writeFile("/run/sevynos/reboot-requested", "", "utf8");
    } catch (error) {
      stopping = false;
      throw new Error(
        `Could not request reboot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await host.shutdown();
    console.log("SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE");
    process.exitCode = 0;
  };
  requestLock = () => {
    // Emit lock event to stdout that shell can listen for
    console.log("SEVYN_LOCK_SCREEN");
    return Promise.resolve();
  };
  requestSleep = async () => {
    // SevynOS images boot without systemd (PID 1 is /init), so systemctl is
    // unavailable there; suspend via the kernel sysfs interface instead.
    const fs = await import("node:fs/promises");
    const hasSystemd = await fs
      .access("/run/systemd/system")
      .then(() => true)
      .catch(() => false);
    if (hasSystemd) {
      const { execFile } = await import("node:child_process");
      execFile("systemctl", ["suspend"]);
      return;
    }
    const states = await fs.readFile("/sys/power/state", "utf8").catch(() => "");
    const target = /\bmem\b/.test(states)
      ? "mem"
      : /\bstandby\b/.test(states)
        ? "standby"
        : null;
    if (target === null) {
      throw new Error(
        "Suspend is not supported: /sys/power/state offers no sleep state.",
      );
    }
    await fs.writeFile("/sys/power/state", target, "utf8");
  };
  // Phase 2 (c): lid-close sleep. The ACPI button interface is polled by
  // LinuxPowerService (no logind on SevynOS); closing the lid invokes the
  // orderly sleep() above when the lid action is "sleep".
  powerService.startLidWatch(() => {
    requestSleep().catch((error: unknown) => {
      console.error(
        "lid-close sleep failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  });
  requestLogout = async () => {
    if (stopping) return;
    stopping = true;
    await host.shutdown();
    console.log("SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE");
    process.exitCode = 0;
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void host.shutdown().then(() => {
      console.log("SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE");
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function shouldMirrorMarkerToSerial(value: string, focusTrace: boolean): boolean {
  if (!focusTrace) return true;
  return (
    value === "SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED" ||
    value === "SEVYN_GENESIS_POINTER_INPUT_RECEIVED" ||
    value.startsWith("GENESIS_WINDOW_BOUNDS reason=initial windowId=window-1 ") ||
    value.startsWith("GENESIS_WINDOW_BOUNDS reason=initial windowId=window-2 ") ||
    value.startsWith("TS_FOCUS_STATE_UPDATED ") ||
    value.startsWith("TS_FRAME_STARTED ") ||
    value.startsWith("TS_FRAME_RASTERIZED ") ||
    value.startsWith("TS_FOCUS_FRAME_ACKNOWLEDGED ")
  );
}
