import { appendFileSync, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DisplayRenderPlanner, GenesisFrameExecutor } from "@sevynos/graphics";
import { createWheelInputEvent, type PointerInputEvent } from "@sevynos/input";
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
import type {
  SevynPowerService,
  SevynBrowserEngine,
  SevynWirelessNetworkService,
  SevynBatteryService,
  SevynAudioService,
  SevynSystemService,
  SevynFileSystem,
  SevynApplicationPackage,
  StructuredValue,
  WirelessNetworkSnapshot,
} from "@sevynos/react-native/internal";
import { LinuxWirelessNetworkService } from "./linux-wireless-network-service.js";
import { LinuxBatteryService } from "./linux-battery-service.js";
import { LinuxAudioService } from "./linux-audio-service.js";
import { LinuxNativeModuleServices } from "./linux-native-module-services.js";
import { LinuxSystemService } from "./linux-system-service.js";
import { LinuxFileSystem } from "./linux-file-system.js";
import { LinuxStudioBuildService } from "./linux-studio-service.js";
import { ChromiumBrowserEngine } from "./chromium-browser-engine.js";
import { HermesLinuxProcessApplicationExecutor } from "./linux-process-application-executor.js";
import { NativeProcessBridgeTransport } from "./native-process-bridge-transport.js";
import type { NativeBridgeMessage } from "./native-ipc-protocol.js";
import type { NativeBridgeTransport } from "./wayland-bridge.js";
import { PointerEventCoalescer } from "./pointer-event-coalescer.js";
import { PresentationFrameScheduler } from "./presentation-frame-scheduler.js";
import { FrameMetrics } from "./frame-metrics.js";
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
  readonly system?: SevynSystemService;
  readonly filesystem?: SevynFileSystem;
  readonly createBrowserEngine?: () => SevynBrowserEngine;
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
  const system = options.system ?? new LinuxSystemService();
  const filesystem = options.filesystem ?? new LinuxFileSystem();
  const studio = new LinuxStudioBuildService();

  const runtime = await createDesktopRuntime({
    launchDefaults: false,
    ...(loadedSettings === undefined ? {} : { settings: loadedSettings }),
    hitTestProbe: process.env["SEVYN_HITTEST_PROBE"] === "1",
    network,
    ...(options.power === undefined ? {} : { power: options.power }),
    battery,
    audio,
    system,
    filesystem,
    studio,
    ...(options.createBrowserEngine === undefined
      ? {}
      : { createBrowserEngine: options.createBrowserEngine }),
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
  if (sessionAdapter !== undefined) {
    const restored =
      loadedSettings?.restorePreviousSession === true
        ? await restoreDesktopSession(runtime, await sessionAdapter.load(), viewport)
        : false;
    if (!restored || runtime.applications.listRunning().length === 0)
      await runtime.applications.resetToDefaults();
  } else await runtime.applications.resetToDefaults();
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
  const composer = new DesktopSceneComposer(runtime, undefined, () => {
    invalidate();
  });
  // Debug-gated frame pipeline instrumentation (Phase 1). When enabled,
  // the presenter records per-frame raster/damage/submit samples and a
  // 1/sec SEVYN_PROBE_FRAMES line reports rolling fps, frame intervals,
  // raster cost, damage area, pipe latency, and scheduler coalescing.
  const frameMetrics =
    process.env["SEVYN_FRAME_METRICS"] === "1" ? new FrameMetrics() : undefined;
  const presenter = new WaylandFramePresenter(connection, marker, frameMetrics);
  presenter.initialize();
  presenter.setHardwareCursor(true);
  const planner = new DisplayRenderPlanner({
    displays: runtime.environment.displays,
    now: () => new Date(),
  });
  let frames = 0;
  let latestScene: DesktopScene | undefined;
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
  let nativePointerTargetWindowId: string | undefined;

  const handlePointerEvent = (event: PointerInputEvent): void => {
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
          case "desktop-workspace-action":
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
            void runtime.applications.launch("org.sevynos.files");
            return;
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
    nativePointerTargetWindowId = dispatchNativePointer(
      runtime,
      latestScene,
      event,
      nativePointerTargetWindowId,
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

function dispatchNativePointer(
  runtime: DesktopRuntime,
  scene: DesktopScene | undefined,
  event: PointerInputEvent,
  previousWindowId: string | undefined,
): string | undefined {
  const target = scene?.nodes
    .filter(
      (node): node is DesktopWindowSceneNode =>
        node.kind === "desktop-window" && node.nativeSurface !== undefined,
    )
    .sort((first, second) => second.order - first.order)
    .find(
      (node) =>
        event.position.x >= node.base.bounds.x &&
        event.position.x < node.base.bounds.x + node.base.bounds.width &&
        event.position.y >= node.base.bounds.y + 46 &&
        event.position.y < node.base.bounds.y + node.base.bounds.height,
    );
  const targetWindowId = target?.windowId;
  const pointer = {
    x: event.position.x,
    y: event.position.y,
    pointerId: event.pointerId,
    button: buttonNumber(event.button),
  };

  if (event.type === "pointer-cancel") {
    if (previousWindowId !== undefined) {
      runtime.surfaces.dispatchNativePointer(previousWindowId, "cancel", pointer);
      runtime.surfaces.dispatchNativePointer(previousWindowId, "leave", pointer);
    }
    return undefined;
  }

  // Native surface enter/leave events are boundary transitions, not motion events.
  // Re-dispatching `enter` for every pointer move invalidates the application
  // surface and forces its render commands to be rebuilt continuously.
  if (targetWindowId !== previousWindowId) {
    if (previousWindowId !== undefined)
      runtime.surfaces.dispatchNativePointer(previousWindowId, "leave", pointer);
    if (targetWindowId !== undefined)
      runtime.surfaces.dispatchNativePointer(targetWindowId, "enter", pointer);
  }

  if (targetWindowId !== undefined && event.type === "pointer-down")
    runtime.surfaces.dispatchNativePointer(targetWindowId, "down", pointer);
  else if (targetWindowId !== undefined && event.type === "pointer-up")
    runtime.surfaces.dispatchNativePointer(targetWindowId, "up", pointer);
  else if (targetWindowId !== undefined && event.type === "pointer-move")
    runtime.surfaces.dispatchNativePointer(targetWindowId, "move", pointer);

  return targetWindowId;
}

function findTargetWindowForWheel(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): string | undefined {
  const target = scene?.nodes
    .filter(
      (node): node is DesktopWindowSceneNode =>
        node.kind === "desktop-window" && node.nativeSurface !== undefined,
    )
    .sort((first, second) => second.order - first.order)
    .find(
      (node) =>
        x >= node.base.bounds.x &&
        x < node.base.bounds.x + node.base.bounds.width &&
        y >= node.base.bounds.y + 46 &&
        y < node.base.bounds.y + node.base.bounds.height,
    );
  return target?.windowId;
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
  const host = await startWaylandHost(new NativeProcessBridgeTransport(executable), {
    persistence: new FileLinuxPersistenceAdapter(stateDirectory),
    network: new LinuxWirelessNetworkService(),
    power,
    battery: new LinuxBatteryService(),
    audio: new LinuxAudioService(),
    system: new LinuxSystemService(),
    filesystem: new LinuxFileSystem(),
    createBrowserEngine: () => new ChromiumBrowserEngine(),
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
    await host.shutdown();
    console.log("SEVYN_GENESIS_CONTROLLED_SHUTDOWN_COMPLETE");
    process.exitCode = 0;
  };
  requestRestart = async () => {
    if (stopping) return;
    stopping = true;
    await host.shutdown();
    const { exec } = await import("child_process");
    exec("reboot");
  };
  requestLock = () => {
    // Emit lock event to stdout that shell can listen for
    console.log("SEVYN_LOCK_SCREEN");
    return Promise.resolve();
  };
  requestSleep = async () => {
    const { exec } = await import("child_process");
    exec("systemctl suspend");
  };
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
