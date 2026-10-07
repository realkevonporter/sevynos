import {
  GenesisCompositor,
  GenesisWindowManager,
  WindowRegistry,
  WindowZOrderManager,
  type GenesisWindow,
  type WindowBounds,
} from "@sevynos/graphics";
import {
  CursorManager,
  DesktopCursorRuntime,
  DesktopInteractionRuntime,
  FocusManager,
  FocusedInputRouter,
  InputDeviceRegistry,
  InputDispatcher,
  KeyboardShortcutRegistry,
  PointerCaptureManager,
  PointerFocusController,
  WindowDragController,
  WindowDragRuntime,
  WindowHitTester,
  WindowResizeController,
  WindowResizeEdgeDetector,
  WindowResizeRuntime,
  createKeyboardInputEvent,
  createPointerInputEvent,
  type PointerFocusControllerEventListener,
  type PointerInputEvent,
} from "@sevynos/input";

import type { ApplicationLifecycleController } from "@sevynos/runtime";
import {
  ApplicationInstaller,
  ApplicationPackageRegistry,
  SevynRuntime,
  type InstalledApplicationRecord,
} from "@sevynos/runtime";
import type { TerminalAppRecord } from "@sevynos/app-terminal";
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
} from "@sevynos/react-native/internal";
import {
  SystemApplicationRuntime,
  type DeviceDescriptor,
  type DeviceProfile,
} from "@sevynos/shell-core";
import {
  BUILTIN_SYSTEM_APPLICATIONS,
  selectDeviceProfile,
} from "@sevynos/system-applications";
import { ApplicationSurfaceRegistry } from "./application-surfaces.js";
import {
  DesktopApplicationCoordinator,
  createDesktopApplicationHost,
  createDesktopApplicationPackages,
} from "./desktop-application-coordinator.js";
import { isPointInWindowControlRegion } from "./window-controls.js";
import type { WindowControlKind } from "./window-controls.js";
import { DesktopEnvironment } from "./desktop-environment.js";
import { DesktopSettingsService, type DesktopSettings } from "./desktop-settings.js";
import { RuntimeDiagnosticsService } from "./runtime-diagnostics.js";
import { DesktopRecoveryController } from "./desktop-recovery.js";
import {
  DesktopWindowLayoutManager,
  calculateSnapBounds,
  detectSnapTargetFromPoint,
  type WindowSnapTarget,
} from "./desktop-window-layout.js";
import { WindowAnimationController } from "./window-animation-controller.js";

export interface DesktopRuntime {
  readonly windows: GenesisWindowManager;

  readonly cursor: CursorManager;

  readonly dispatcher: InputDispatcher;

  readonly surfaces: ApplicationSurfaceRegistry;

  readonly focusedInput: FocusedInputRouter;

  readonly compositor: GenesisCompositor;

  readonly platformRuntime: SevynRuntime;

  readonly shell: SystemApplicationRuntime;

  readonly profile: DeviceProfile;

  readonly applications: DesktopApplicationCoordinator;

  readonly network?: SevynWirelessNetworkService | undefined;
  readonly power?: SevynPowerService | undefined;
  readonly battery?: SevynBatteryService | undefined;
  readonly audio?: SevynAudioService | undefined;
  readonly time?: SevynTimeService | undefined;
  readonly system?: SevynSystemService | undefined;
  readonly processes?: SevynProcessService | undefined;
  readonly filesystem?: SevynFileSystem | undefined;
  readonly environment: DesktopEnvironment;
  readonly layout: DesktopWindowLayoutManager;
  readonly settings: DesktopSettingsService;
  readonly diagnostics: RuntimeDiagnosticsService;
  readonly recovery: DesktopRecoveryController;
  readonly windowAnimations: WindowAnimationController;
  readonly shortcuts: KeyboardShortcutRegistry;
  readonly activePointerCaptureCount: () => number;
  readonly registeredInputDeviceCount: () => number;

  readonly dispatchPointerEvent: (event: BrowserPointerEvent) => void;

  readonly dispatchKeyboardEvent: (event: BrowserKeyboardEvent) => void;

  readonly activateWindowControl: (
    windowId: GenesisWindow["id"],
    control: WindowControlKind,
    _maximizeBounds: WindowBounds,
  ) => Promise<void>;

  readonly isMaximized: (windowId: GenesisWindow["id"]) => boolean;

  readonly getRestoreBounds: (windowId: GenesisWindow["id"]) => WindowBounds | undefined;

  readonly subscribe: (listener: DesktopRuntimeListener) => () => void;

  readonly beginShutdown: () => void;

  readonly closeForShutdown: () => Promise<void>;

  readonly listDesktopItems: () => Promise<
    readonly import("@sevynos/react-native/internal").FileSystemEntry[]
  >;

  readonly createDesktopFolder: () => Promise<string>;

  readonly createDesktopFile: () => Promise<string>;

  readonly requestRender: () => void;
}

export interface CreateDesktopRuntimeOptions {
  readonly launchDefaults?: boolean | undefined;
  readonly settings?: DesktopSettings | undefined;
  readonly profileId?: string | undefined;
  readonly device?: DeviceDescriptor | undefined;
  readonly network?: SevynWirelessNetworkService | undefined;
  readonly power?: SevynPowerService | undefined;
  readonly battery?: SevynBatteryService | undefined;
  readonly audio?: SevynAudioService | undefined;
  readonly time?: SevynTimeService | undefined;
  readonly system?: SevynSystemService | undefined;
  readonly processes?: SevynProcessService | undefined;
  readonly filesystem?: SevynFileSystem | undefined;
  readonly createBrowserEngine?: (() => SevynBrowserEngine) | undefined;
  readonly createSevynCodeEngine?: (() => SevynBrowserEngine | undefined) | undefined;
  /**
   * Temporary diagnostic: when true, every pointer-down logs a
   * SEVYN_PROBE_HITTEST line with the pointer position, the selected
   * hit-test window, and every known window's bounds/z-index/state.
   * Enable on bare metal with SEVYN_HITTEST_PROBE=1.
   */
  readonly hitTestProbe?: boolean | undefined;
}

export type DesktopRuntimeListener = () => void;

export interface BrowserPointerEvent {
  readonly type: string;

  readonly pointerId: number;

  readonly timeStamp: number;

  readonly clientX: number;

  readonly clientY: number;

  readonly button: number;

  readonly buttons: number;

  readonly pressure: number;
}

export interface BrowserKeyboardEvent {
  readonly type: string;

  readonly timeStamp: number;

  readonly code: string;

  readonly key: string;

  readonly repeat: boolean;

  readonly isComposing: boolean;

  readonly altKey: boolean;

  readonly ctrlKey: boolean;

  readonly metaKey: boolean;

  readonly shiftKey: boolean;
}

export async function createDesktopRuntime(
  options: CreateDesktopRuntimeOptions = {},
): Promise<DesktopRuntime> {
  const listeners = new Set<DesktopRuntimeListener>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const shellDevice =
    options.device ??
    Object.freeze({
      deviceClass: "desktop" as const,
      width: 1200,
      height: 800,
      pointer: "fine" as const,
      keyboard: true,
      touch: false,
    });
  const profile = selectDeviceProfile(shellDevice, options.profileId);
  const shell = new SystemApplicationRuntime();
  for (const application of BUILTIN_SYSTEM_APPLICATIONS) shell.register(application);
  await shell.activate(profile, shellDevice);
  shell.subscribe(notify);

  const windowRegistry = new WindowRegistry({ onEvent: notify });

  const restoreBounds = new Map<GenesisWindow["id"], WindowBounds>();

  const applicationsHolder: { current?: DesktopApplicationCoordinator } = {};
  const powerProxy: SevynPowerService | undefined = options.power
    ? {
        get available() {
          return options.power?.available ?? false;
        },
        shutdown: async () => {
          if (applicationsHolder.current !== undefined) {
            await applicationsHolder.current.closeAll();
          }
          await shell.shutdown();
          await options.power?.shutdown();
        },
        restart: async () => {
          if (applicationsHolder.current !== undefined) {
            await applicationsHolder.current.closeAll();
          }
          await shell.shutdown();
          await options.power?.restart?.();
        },
        lock: async () => {
          applicationsHolder.current?.lock();
          await options.power?.lock?.();
        },
        sleep: async () => {
          applicationsHolder.current?.lock();
          await options.power?.sleep?.();
        },
        logout: async () => {
          if (applicationsHolder.current !== undefined) {
            await applicationsHolder.current.closeAll();
            applicationsHolder.current.lock();
          }
          await options.power?.logout?.();
        },
      }
    : undefined;

  const surfaces = new ApplicationSurfaceRegistry(
    notify,
    options.network,
    powerProxy,
    options.createBrowserEngine,
    options.filesystem,
    options.battery,
    options.audio,
    options.system,
    options.createSevynCodeEngine,
    options.processes,
  );

  const nowDate = (): Date => new Date();

  const nowMilliseconds = (): number => performance.now();

  let nextSessionNumber = 0;
  const platformRuntime = new SevynRuntime({
    logger: { log: () => undefined },
    createSessionId: () => {
      nextSessionNumber += 1;
      return `session-${String(nextSessionNumber)}`;
    },
    now: nowDate,
  });
  platformRuntime.registerApplicationHost(createDesktopApplicationHost());
  for (const applicationPackage of createDesktopApplicationPackages()) {
    platformRuntime.registerApplication(applicationPackage);
  }
  await platformRuntime.start();
  platformRuntime.subscribe(notify);

  const lifecycle: ApplicationLifecycleController = {
    foregroundApplication: (sessionId) => {
      const session = platformRuntime.getApplicationSession(sessionId);
      if (session === undefined) throw new Error(`Session "${sessionId}" was not found.`);
      return session.state === "foreground"
        ? session
        : platformRuntime.foregroundApplication(sessionId);
    },
    backgroundApplication: (sessionId) => {
      const session = platformRuntime.getApplicationSession(sessionId);
      if (session === undefined) throw new Error(`Session "${sessionId}" was not found.`);
      return session.state === "background"
        ? session
        : platformRuntime.backgroundApplication(sessionId);
    },
  };

  const zOrder = new WindowZOrderManager({
    windows: windowRegistry,

    now: nowDate,
  });

  let nextSceneNumber = 0;
  let nextSceneNodeNumber = 0;

  const compositor = new GenesisCompositor({
    windows: windowRegistry,
    createSceneId: () => {
      nextSceneNumber += 1;
      return `scene-desktop-${String(nextSceneNumber)}`;
    },
    createSceneNodeId: () => {
      nextSceneNodeNumber += 1;
      return `scene-node-desktop-${String(nextSceneNodeNumber)}`;
    },
    now: nowDate,
  });

  let nextWindowNumber = 0;

  const windows = new GenesisWindowManager({
    windows: windowRegistry,

    applications: lifecycle,

    zOrder,

    createWindowId: () => {
      nextWindowNumber += 1;

      return `window-${String(nextWindowNumber)}`;
    },

    now: nowDate,
  });
  const environment = new DesktopEnvironment(windows, notify);
  const settings = new DesktopSettingsService(options.settings);
  const diagnostics = new RuntimeDiagnosticsService();
  const recovery = new DesktopRecoveryController(notify);
  const windowAnimations = new WindowAnimationController(settings.snapshot.reducedMotion);
  windowAnimations.subscribe(notify);

  const shortcuts = new KeyboardShortcutRegistry();

  // Wire real actions to default shortcut registrations.
  const getFocusedWindowId = (): string | undefined =>
    windows.listWindows().find((w) => w.state === "focused")?.id;
  const defaultMaximizeBounds = (): WindowBounds => {
    const focusedWindow = windows.listWindows().find((w) => w.state === "focused");
    if (focusedWindow)
      return environment.getDisplayForBounds(focusedWindow.bounds).workArea;
    return { x: 0, y: 0, width: 1200, height: 800 };
  };

  shortcuts.register({
    id: "window.close",
    label: "Close Window",
    category: "window",
    keys: { key: "F4", alt: true },
    action: () => {
      const id = getFocusedWindowId();
      if (id) void activateWindowControl(id, "close", defaultMaximizeBounds());
    },
  });
  shortcuts.register({
    id: "window.minimize",
    label: "Minimize Window",
    category: "window",
    keys: { key: "ArrowDown", meta: true },
    action: () => {
      const id = getFocusedWindowId();
      if (id) void activateWindowControl(id, "minimize", defaultMaximizeBounds());
    },
  });
  shortcuts.register({
    id: "window.maximize",
    label: "Maximize Window",
    category: "window",
    keys: { key: "ArrowUp", meta: true },
    action: () => {
      const id = getFocusedWindowId();
      if (id) void activateWindowControl(id, "maximize", defaultMaximizeBounds());
    },
  });
  const snapFocusedWindow = (target: WindowSnapTarget): void => {
    const id = getFocusedWindowId();
    if (!id) return;
    const focusedWindow = windows.getWindow(id);
    if (!focusedWindow) return;
    const workArea = environment.getDisplayForBounds(focusedWindow.bounds).workArea;
    const bounds = calculateSnapBounds(workArea, target);
    if (!restoreBounds.has(id)) restoreBounds.set(id, focusedWindow.bounds);
    windowAnimations.animateSnap(id);
    windows.resizeWindow({ windowId: id, bounds });
    windows.focusWindow(id);
    synchronizeKeyboardFocus();
  };

  shortcuts.register({
    id: "window.snap-left",
    label: "Snap Window Left",
    category: "window",
    keys: { key: "ArrowLeft", meta: true },
    action: () => {
      snapFocusedWindow("left");
    },
  });
  shortcuts.register({
    id: "window.snap-right",
    label: "Snap Window Right",
    category: "window",
    keys: { key: "ArrowRight", meta: true },
    action: () => {
      snapFocusedWindow("right");
    },
  });
  shortcuts.register({
    id: "window.snap-top-left",
    label: "Snap Window Top-Left",
    category: "window",
    keys: { key: "ArrowLeft", meta: true, alt: true },
    action: () => {
      snapFocusedWindow("top-left");
    },
  });
  shortcuts.register({
    id: "window.snap-top-right",
    label: "Snap Window Top-Right",
    category: "window",
    keys: { key: "ArrowRight", meta: true, alt: true },
    action: () => {
      snapFocusedWindow("top-right");
    },
  });
  shortcuts.register({
    id: "window.snap-bottom-left",
    label: "Snap Window Bottom-Left",
    category: "window",
    keys: { key: "ArrowDown", meta: true, alt: true },
    action: () => {
      snapFocusedWindow("bottom-left");
    },
  });
  shortcuts.register({
    id: "window.snap-bottom-right",
    label: "Snap Window Bottom-Right",
    category: "window",
    keys: { key: "ArrowUp", meta: true, alt: true },
    action: () => {
      snapFocusedWindow("bottom-right");
    },
  });
  shortcuts.register({
    id: "window.switcher",
    label: "Window Switcher",
    category: "window",
    keys: { key: "Tab", alt: true },
    action: () => {
      if (applicationsHolder.current === undefined) return;
      if (!applicationsHolder.current.switcherOpen) {
        applicationsHolder.current.openSwitcher();
      } else {
        applicationsHolder.current.cycleSwitcher(1);
      }
    },
  });
  shortcuts.register({
    id: "window.switcher-reverse",
    label: "Window Switcher (Reverse)",
    category: "window",
    keys: { key: "Tab", alt: true, shift: true },
    action: () => {
      if (applicationsHolder.current === undefined) return;
      if (!applicationsHolder.current.switcherOpen) {
        applicationsHolder.current.openSwitcher();
        applicationsHolder.current.cycleSwitcher(-1);
      } else {
        applicationsHolder.current.cycleSwitcher(-1);
      }
    },
  });
  shortcuts.register({
    id: "system.launcher",
    label: "Toggle App Launcher",
    category: "system",
    keys: { key: " ", meta: true },
    action: () => {
      applicationsHolder.current?.toggleLauncher();
    },
  });
  shortcuts.register({
    id: "system.lock",
    label: "Lock Screen",
    category: "system",
    keys: { key: "l", meta: true },
    action: () => {
      applicationsHolder.current?.lock();
    },
  });
  shortcuts.register({
    id: "workspace.move-window-left",
    label: "Move Window to Left Workspace",
    category: "window",
    keys: { key: "ArrowLeft", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToAdjacentWorkspace(-1);
    },
  });
  shortcuts.register({
    id: "workspace.move-window-right",
    label: "Move Window to Right Workspace",
    category: "window",
    keys: { key: "ArrowRight", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToAdjacentWorkspace(1);
    },
  });
  shortcuts.register({
    id: "workspace.move-1",
    label: "Move Window to Workspace 1",
    category: "window",
    keys: { key: "1", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToWorkspace("workspace-1");
    },
  });
  shortcuts.register({
    id: "workspace.move-2",
    label: "Move Window to Workspace 2",
    category: "window",
    keys: { key: "2", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToWorkspace("workspace-2");
    },
  });
  shortcuts.register({
    id: "workspace.move-3",
    label: "Move Window to Workspace 3",
    category: "window",
    keys: { key: "3", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToWorkspace("workspace-3");
    },
  });
  shortcuts.register({
    id: "workspace.move-4",
    label: "Move Window to Workspace 4",
    category: "window",
    keys: { key: "4", meta: true, shift: true },
    action: () => {
      applicationsHolder.current?.moveFocusedWindowToWorkspace("workspace-4");
    },
  });
  shortcuts.register({
    id: "workspace.switch-1",
    label: "Switch to Workspace 1",
    category: "navigation",
    keys: { key: "1", meta: true },
    action: () => {
      environment.switchWorkspace("workspace-1");
      synchronizeKeyboardFocus();
    },
  });
  shortcuts.register({
    id: "workspace.switch-2",
    label: "Switch to Workspace 2",
    category: "navigation",
    keys: { key: "2", meta: true },
    action: () => {
      environment.switchWorkspace("workspace-2");
      synchronizeKeyboardFocus();
    },
  });
  shortcuts.register({
    id: "workspace.switch-3",
    label: "Switch to Workspace 3",
    category: "navigation",
    keys: { key: "3", meta: true },
    action: () => {
      environment.switchWorkspace("workspace-3");
      synchronizeKeyboardFocus();
    },
  });
  shortcuts.register({
    id: "workspace.switch-4",
    label: "Switch to Workspace 4",
    category: "navigation",
    keys: { key: "4", meta: true },
    action: () => {
      environment.switchWorkspace("workspace-4");
      synchronizeKeyboardFocus();
    },
  });
  environment.configure(1200, 800, 1);
  environment.applyShellSettings(
    settings.snapshot.workspaceCount,
    settings.snapshot.taskbarPosition,
  );
  const layout = new DesktopWindowLayoutManager(
    windows,
    environment,
    (windowId) => restoreBounds.has(windowId),
    (windowId, bounds) => {
      restoreBounds.set(windowId, bounds);
    },
  );
  settings.subscribe((snapshot) => {
    const previousLayout = layout.capture();
    environment.applyShellSettings(snapshot.workspaceCount, snapshot.taskbarPosition);
    environment.configure(1200, 800, 1, snapshot.displayLayout);
    layout.reflow(previousLayout);
    windowAnimations.setReducedMotion(snapshot.reducedMotion);
    diagnostics.record({
      severity: "info",
      subsystem: "settings",
      event: "settings.changed",
      message: "Desktop settings changed.",
    });
    notify();
  });

  const inputDevices = new InputDeviceRegistry();

  inputDevices.register(
    {
      id: "desktop-mouse",

      name: "Electron Desktop Pointer",

      kind: "mouse",

      capabilities: ["pointer", "wheel"],

      virtual: false,
    },
    nowMilliseconds(),
  );

  inputDevices.register(
    {
      id: "desktop-keyboard",

      name: "Electron Desktop Keyboard",

      kind: "keyboard",

      capabilities: ["keyboard"],

      virtual: false,
    },
    nowMilliseconds(),
  );

  const dispatcher = new InputDispatcher({
    deviceRegistry: inputDevices,
  });

  const focus = new FocusManager();

  const hitTester = new WindowHitTester({
    listWindows: () => windows.listWindows(),
  });

  const pointerCapture = new PointerCaptureManager({
    now: nowMilliseconds,
  });

  const focusedInput = new FocusedInputRouter({
    dispatcher,

    focusManager: focus,

    pointerCaptureManager: pointerCapture,
  });

  dispatcher.addListener({
    id: "sevynos:desktop-keyboard-router",
    listener: (event) => {
      if (event.type === "key-down") {
        // Check global shortcuts first; if matched, consume the event.
        const handled = shortcuts.handleKeyDown({
          key: event.key,
          ctrlKey: event.modifiers.control,
          altKey: event.modifiers.alt,
          shiftKey: event.modifiers.shift,
          metaKey: event.modifiers.meta,
        });
        if (handled) return;
      }
      if (event.type === "key-down" || event.type === "key-up") {
        focusedInput.route(event);
      }
    },
  });

  const pointerFocus = new PointerFocusController({
    dispatcher,

    focusManager: focus,

    hitTester,

    windowController: windows,

    ...(options.hitTestProbe === true ? { onEvent: createHitTestProbe(windows) } : {}),
  });

  const dragController = new WindowDragController({
    windows,

    pointerCaptureManager: pointerCapture,

    now: nowMilliseconds,

    onEvent: (event) => {
      if (event.type === "window-drag-ended" && event.event !== undefined) {
        const window = windows.getWindow(event.drag.windowId);
        if (window !== undefined) {
          const workArea = environment.getDisplayForBounds(window.bounds).workArea;
          const snapTarget = detectSnapTargetFromPoint(event.event.position, workArea);
          if (snapTarget !== undefined) {
            const snapBounds =
              snapTarget === "maximize"
                ? workArea
                : calculateSnapBounds(workArea, snapTarget);
            if (!restoreBounds.has(event.drag.windowId)) {
              restoreBounds.set(event.drag.windowId, event.drag.initialWindowBounds);
            }
            windowAnimations.animateSnap(event.drag.windowId);
            windows.resizeWindow({ windowId: event.drag.windowId, bounds: snapBounds });
            windows.focusWindow(event.drag.windowId);
            synchronizeKeyboardFocus();
          }
        }
      }
    },
  });

  const dragRuntime = new WindowDragRuntime({
    dispatcher,

    hitTester,

    dragController,

    isDraggableRegion: (_event, hit) =>
      hit.localPoint.y >= 8 &&
      hit.localPoint.y < 46 &&
      !isPointInWindowControlRegion(hit.window, hit.localPoint),
  });

  const resizeEdgeDetector = new WindowResizeEdgeDetector({
    borderSize: 8,
  });

  const resizeController = new WindowResizeController({
    windows,

    pointerCaptureManager: pointerCapture,

    now: nowMilliseconds,

    minimumWidth: 320,

    minimumHeight: 200,
  });

  const resizeRuntime = new WindowResizeRuntime({
    dispatcher,

    hitTester,

    edgeDetector: resizeEdgeDetector,

    resizeController,
  });

  const cursor = new CursorManager({
    now: nowMilliseconds,

    onEvent: notify,
  });

  const cursorRuntime = new DesktopCursorRuntime({
    cursorManager: cursor,

    hitTester,

    edgeDetector: resizeEdgeDetector,

    dragRuntime,

    resizeRuntime,
  });

  const desktopInteraction = new DesktopInteractionRuntime({
    dispatcher,

    pointerFocusController: pointerFocus,

    dragRuntime,

    resizeRuntime,

    cursorRuntime,
  });

  desktopInteraction.connect();

  const applications = new DesktopApplicationCoordinator({
    runtime: platformRuntime,
    windows,
    focus,
    focusedInput,
    surfaces,
    environment,
    layout,
    notify,
  });
  applicationsHolder.current = applications;

  let lastActivityTime = Date.now();
  const resetActivity = (): void => {
    lastActivityTime = Date.now();
  };
  const idleInterval = setInterval(() => {
    const timeoutMinutes = settings.snapshot.idleLockTimeoutMinutes ?? 0;
    if (timeoutMinutes > 0 && !applications.isLocked) {
      const idleMs = Date.now() - lastActivityTime;
      if (idleMs >= timeoutMinutes * 60 * 1000) {
        applications.lock();
      }
    }
  }, 5000);

  // Real application registry backing `sevyn install/uninstall/restore/list`.
  // ApplicationInstaller persists to /var/lib/sevyn/apps/registry.json (with a
  // ~/.sevyn/apps fallback when the system path is not writable).
  const applicationPackages = new ApplicationPackageRegistry();
  const applicationInstaller = new ApplicationInstaller({
    packages: applicationPackages,
  });
  await applicationInstaller.init();

  const toTerminalAppRecord = (record: InstalledApplicationRecord): TerminalAppRecord =>
    Object.freeze({
      id: record.id,
      name: record.name,
      version: record.version,
      system: record.system,
      permissions: record.permissions,
    });

  surfaces.configureApplicationManagement({
    list: () =>
      applications.catalog.map((definition) => {
        const running = applications.getByApplicationId(definition.id);
        const window =
          running === undefined ? undefined : windows.getWindow(running.windowId);
        const worker = surfaces.workerSnapshots.find(
          (candidate) => candidate.applicationId === definition.id,
        );
        return Object.freeze({
          id: definition.id,
          name: definition.name,
          version: "0.1.0",
          developer: "SevynOS",
          permissions:
            definition.kind === "notes"
              ? Object.freeze(["notifications", "storage"])
              : Object.freeze([]),
          storageBytes: 0,
          status: worker?.status ?? window?.state ?? "terminated",
          ...(worker?.metrics === undefined ? {} : { metrics: worker.metrics }),
        });
      }),
    launch: async (applicationId) => {
      await applications.launch(applicationId);
    },
    terminate: async (applicationId) => {
      const running = applications.getByApplicationId(applicationId);
      if (running !== undefined) await applications.closeWindow(running.windowId);
    },
    listInstalledApps: async () => {
      const records = await applicationInstaller.listInstalled();
      return Object.freeze(records.map(toTerminalAppRecord));
    },
    installApp: async (target) => {
      // Bundle paths (or anything ending in .sevyn/.sevynapp) install from
      // the file; bare app ids resolve from the pristine bundle store.
      const looksLikeBundlePath =
        target.includes("/") || /\.(sevyn|sevynapp)$/i.test(target);
      const record = looksLikeBundlePath
        ? await applicationInstaller.install(target)
        : await applicationInstaller.installFromPristine(target);
      return toTerminalAppRecord(record);
    },
    uninstallApp: async (applicationId) => {
      const running = applications.getByApplicationId(applicationId);
      if (running !== undefined) await applications.closeWindow(running.windowId);
      // ApplicationInstaller enforces protected-system-app rejection.
      await applicationInstaller.uninstall(applicationId);
    },
    restoreApp: async (applicationId) => {
      const record = await applicationInstaller.installFromPristine(applicationId);
      return toTerminalAppRecord(record);
    },
  });
  surfaces.configureSettingsUpdate((key, value) => {
    settings.update({ [key]: value });
  });
  if (options.launchDefaults !== false) {
    await applications.launch("org.sevynos.welcome");
    await applications.launch("org.sevynos.console");
  }

  function dispatchPointerEvent(browserEvent: BrowserPointerEvent): void {
    resetActivity();
    if (applications.isLocked) {
      return;
    }
    const event = createHostPointerEvent(browserEvent);

    dispatcher.dispatch(event);
    if (browserEvent.type === "move" || browserEvent.type === "enter") {
      const hit = hitTester.hitTest(event.position);
      if (hit !== undefined) {
        const kind = surfaces.nativeCursorKindAt(
          hit.window.id,
          event.position.x,
          event.position.y,
        );
        cursor.update({ kind, position: event.position });
      }
    }
  }

  function dispatchKeyboardEvent(browserEvent: BrowserKeyboardEvent): void {
    resetActivity();
    if (applications.isLocked) {
      if (browserEvent.type === "keydown" && browserEvent.key === "Enter") {
        applications.unlock();
      }
      return;
    }

    if (applications.switcherOpen) {
      if (browserEvent.type === "keydown") {
        if (browserEvent.key === "Escape") {
          applications.closeSwitcher(false);
          return;
        }
        if (browserEvent.key === "Enter") {
          applications.closeSwitcher(true);
          return;
        }
      } else if (browserEvent.type === "keyup") {
        if (browserEvent.key === "Alt" || !browserEvent.altKey) {
          applications.closeSwitcher(true);
          return;
        }
      }
    }

    if (
      browserEvent.type === "keydown" &&
      applications.launcherOpen &&
      applications.handleLauncherKey(browserEvent.key)
    ) {
      return;
    }

    dispatcher.dispatch(
      createKeyboardInputEvent({
        type: mapKeyboardEventType(browserEvent.type),
        eventId: `desktop-${browserEvent.type}-${browserEvent.code}-${String(browserEvent.timeStamp)}`,
        deviceId: "desktop-keyboard",
        deviceKind: "keyboard",
        timestamp: browserEvent.timeStamp,
        code: browserEvent.code,
        key: browserEvent.key,
        repeat: browserEvent.repeat,
        composing: browserEvent.isComposing,
        modifiers: {
          alt: browserEvent.altKey,
          control: browserEvent.ctrlKey,
          meta: browserEvent.metaKey,
          shift: browserEvent.shiftKey,
        },
      }),
    );
  }

  function activateWindowControl(
    windowId: GenesisWindow["id"],
    control: WindowControlKind,
    maximizeBounds: WindowBounds,
  ): Promise<void> {
    void maximizeBounds;
    switch (control) {
      case "minimize": {
        const window = windows.getWindow(windowId);
        if (window === undefined) return Promise.resolve();
        const displayBounds = environment.getDisplayForBounds(window.bounds).bounds;
        const dockY = displayBounds.y + displayBounds.height - 60;
        windowAnimations.animateMinimize(windowId, window.bounds, dockY);
        windows.minimizeWindow(windowId);
        synchronizeKeyboardFocus();
        return Promise.resolve();
      }

      case "maximize": {
        const window = windows.getWindow(windowId);

        if (window === undefined) {
          return Promise.resolve();
        }

        if (!restoreBounds.has(windowId)) {
          restoreBounds.set(windowId, window.bounds);
        }

        const displayWorkArea = environment.getDisplayForBounds(window.bounds).workArea;
        windowAnimations.animateMaximize(windowId, window.bounds);
        windows.resizeWindow({ windowId, bounds: displayWorkArea });
        windows.focusWindow(windowId);
        synchronizeKeyboardFocus();
        return Promise.resolve();
      }

      case "restore": {
        const window = windows.getWindow(windowId);

        if (window === undefined) {
          return Promise.resolve();
        }

        if (window.state === "minimized" || window.state === "hidden") {
          windows.restoreWindow(windowId, true);
          windowAnimations.animateRestore(windowId);
          synchronizeKeyboardFocus();
          return Promise.resolve();
        }

        const previousBounds = restoreBounds.get(windowId);

        if (previousBounds !== undefined) {
          windowAnimations.animateMaximize(windowId, window.bounds);
          windows.resizeWindow({ windowId, bounds: previousBounds });
          restoreBounds.delete(windowId);
          windows.focusWindow(windowId);
          synchronizeKeyboardFocus();
        }
        return Promise.resolve();
      }

      case "close": {
        windowAnimations.animateClose(windowId);
        restoreBounds.delete(windowId);
        return applications.closeWindow(windowId);
      }
    }
  }

  function synchronizeKeyboardFocus(): void {
    const focusedWindow = windows
      .listWindows()
      .find((window) => window.state === "focused");

    if (focusedWindow === undefined) {
      focus.clearKeyboardFocus("programmatic");
      return;
    }

    focus.focusKeyboard(focusedWindow.id, "programmatic");
  }

  function subscribe(listener: DesktopRuntimeListener): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  async function listDesktopItems(): Promise<
    readonly import("@sevynos/react-native/internal").FileSystemEntry[]
  > {
    return surfaces.filesystem.list("/Desktop");
  }

  async function createDesktopEntry(kind: "file" | "directory"): Promise<string> {
    const entries = await listDesktopItems();
    const baseName = kind === "directory" ? "New Folder" : "New Text File";
    const extension = kind === "file" ? ".txt" : "";
    const names = new Set(entries.map((entry) => entry.name));
    let suffix = 0;
    let name = `${baseName}${extension}`;
    while (names.has(name)) {
      suffix += 1;
      name = `${baseName} ${String(suffix + 1)}${extension}`;
    }
    const path = `/Desktop/${name}`;
    if (kind === "directory") await surfaces.filesystem.createDirectory(path);
    else await surfaces.filesystem.write(path, "");
    notify();
    return path;
  }

  return {
    windows,
    cursor,
    dispatcher,
    surfaces,
    focusedInput,
    compositor,
    platformRuntime,
    shell,
    profile,
    applications,
    network: options.network,
    power: powerProxy,
    battery: options.battery,
    audio: options.audio,
    time: options.time,
    system: options.system,
    filesystem: surfaces.filesystem,
    environment,
    layout,
    settings,
    diagnostics,
    recovery,
    windowAnimations,
    shortcuts,
    activePointerCaptureCount: () => pointerCapture.list().length,
    registeredInputDeviceCount: () => inputDevices.list().length,
    dispatchPointerEvent,
    dispatchKeyboardEvent,
    activateWindowControl,
    isMaximized: (windowId) => restoreBounds.has(windowId),
    getRestoreBounds: (windowId) => restoreBounds.get(windowId),
    subscribe,
    beginShutdown: () => {
      applications.blockLaunches();
      desktopInteraction.disconnect();
    },
    closeForShutdown: async () => {
      clearInterval(idleInterval);
      await applications.closeAll();
      await shell.shutdown();
      await platformRuntime.stop("desktop-host-shutdown");
      listeners.clear();
    },
    listDesktopItems,
    createDesktopFolder: () => createDesktopEntry("directory"),
    createDesktopFile: () => createDesktopEntry("file"),
    requestRender: notify,
  };
}

/**
 * Temporary diagnostic for the bare-metal click-through investigation.
 * Logs one JSON line per pointer-down with the pointer position, the
 * window the hit tester selected, and every known window's
 * bounds/z-index/state, so a bad click can be compared against the
 * geometry the hit tester actually saw.
 */
function createHitTestProbe(windows: {
  listWindows: () => readonly GenesisWindow[];
}): PointerFocusControllerEventListener {
  return (probeEvent) => {
    if (
      probeEvent.type !== "pointer-focus-hit" &&
      probeEvent.type !== "pointer-focus-miss"
    ) {
      return;
    }
    if (probeEvent.event.type !== "pointer-down") {
      return;
    }
    const snapshot = windows.listWindows().map((window) => ({
      id: window.id,
      x: window.bounds.x,
      y: window.bounds.y,
      width: window.bounds.width,
      height: window.bounds.height,
      zIndex: window.zIndex,
      state: window.state,
    }));
    console.log(
      `SEVYN_PROBE_HITTEST ${JSON.stringify({
        pointer: {
          x: probeEvent.event.position.x,
          y: probeEvent.event.position.y,
        },
        hit:
          probeEvent.type === "pointer-focus-hit"
            ? {
                id: probeEvent.hit.windowId,
                localX: probeEvent.hit.localPoint.x,
                localY: probeEvent.hit.localPoint.y,
              }
            : null,
        windows: snapshot,
      })}`,
    );
  };
}

function mapKeyboardEventType(type: string): "key-down" | "key-up" {
  switch (type) {
    case "keydown":
      return "key-down";
    case "keyup":
      return "key-up";
    default:
      throw new Error(`Unsupported browser keyboard event "${type}".`);
  }
}

function createHostPointerEvent(event: BrowserPointerEvent): PointerInputEvent {
  return createPointerInputEvent({
    type: mapPointerEventType(event.type),

    eventId: `desktop-${event.type}-${String(event.pointerId)}-${String(event.timeStamp)}`,

    deviceId: "desktop-mouse",

    deviceKind: "mouse",

    timestamp: event.timeStamp,

    pointerId: event.pointerId,

    position: {
      x: event.clientX,

      y: event.clientY,
    },

    button: mapPointerButton(event.button),

    buttons: mapPressedButtons(event.buttons),

    pressure: event.pressure,
  });
}

function mapPointerEventType(
  type: string,
): "pointer-down" | "pointer-move" | "pointer-up" | "pointer-cancel" {
  switch (type) {
    case "pointerdown":
      return "pointer-down";

    case "pointermove":
      return "pointer-move";

    case "pointerup":
      return "pointer-up";

    case "pointercancel":
      return "pointer-cancel";

    default:
      throw new Error(`Unsupported browser pointer event "${type}".`);
  }
}

function mapPointerButton(
  button: number,
): "none" | "primary" | "secondary" | "middle" | "back" | "forward" {
  switch (button) {
    case 0:
      return "primary";

    case 1:
      return "middle";

    case 2:
      return "secondary";

    case 3:
      return "back";

    case 4:
      return "forward";

    default:
      return "none";
  }
}

function mapPressedButtons(
  buttons: number,
): readonly ("primary" | "secondary" | "middle" | "back" | "forward")[] {
  const pressed: ("primary" | "secondary" | "middle" | "back" | "forward")[] = [];

  if ((buttons & 1) !== 0) {
    pressed.push("primary");
  }

  if ((buttons & 2) !== 0) {
    pressed.push("secondary");
  }

  if ((buttons & 4) !== 0) {
    pressed.push("middle");
  }

  if ((buttons & 8) !== 0) {
    pressed.push("back");
  }

  if ((buttons & 16) !== 0) {
    pressed.push("forward");
  }

  return Object.freeze(pressed);
}

export function getRenderableWindows(runtime: DesktopRuntime): readonly GenesisWindow[] {
  return runtime.windows
    .listWindows()
    .filter(
      (desktopWindow) =>
        desktopWindow.state === "visible" || desktopWindow.state === "focused",
    )
    .sort((first, second) => first.zIndex - second.zIndex);
}
