import { createElement } from "react";
import type { GenesisWindowId } from "@sevynos/graphics";
import type { KeyboardInputEvent, SevynInputEvent } from "@sevynos/input";
import { BrowserApplication } from "@sevynos/app-browser";
import { SettingsApplication } from "@sevynos/app-settings";
import { FilesApplication } from "@sevynos/app-files";
import { TerminalApplication, type TerminalAppRecord } from "@sevynos/app-terminal";
import { SystemMonitorApplication } from "@sevynos/app-system-monitor";
import { WelcomeApplication } from "@sevynos/app-welcome";
import { CameraApplication } from "@sevynos/app-camera";
import { MusicApplication } from "@sevynos/app-music";
import type { DiagnosticEntry } from "./runtime-diagnostics.js";
import {
  InMemoryFileSystem,
  SevynApplicationRuntime,
  SystemNotificationService,
  UnavailablePowerService,
  UnavailableWirelessNetworkService,
  UnavailableBatteryService,
  UnavailableAudioService,
  UnavailableSystemService,
  type NativeBounds,
  type AccessibilityNode,
  type NativeRuntimeSnapshot,
  type ApplicationWorkerSnapshot,
  type StructuredValue,
  type SevynBrowserEngine,
  type SevynPowerService,
  type SevynWirelessNetworkService,
  type SevynBatteryService,
  type SevynAudioService,
  type SevynSystemService,
  type SevynFileSystem,
  type SevynStorageService,
} from "@sevynos/react-native/internal";
import { LinuxVolumeService } from "./volume-service.js";
import {
  createCoreSystemApplication,
  type AppManagerEntry,
} from "@sevynos/core-applications";
import type { DesktopSettings } from "./desktop-settings.js";

export interface WelcomeApplicationSurface {
  readonly kind: "welcome";
  readonly heading: string;
  readonly body: readonly string[];
  readonly runtimeStatus: string;
}
export interface InstallerApplicationSurface {
  readonly kind: "installer";
  readonly heading: string;
}

export interface ConsoleApplicationSurface {
  readonly kind: "console";
  readonly history: readonly string[];
  readonly input: string;
  readonly prompt: string;
}

export interface SystemMonitorSnapshot {
  readonly runningApplicationSessions: number;
  readonly openWindows: number;
  readonly focusedWindow: string | undefined;
  readonly cursorKind: string;
  readonly frameExecutionCount: number;
  readonly activeWorkspace: string;
  readonly averageFrameDuration: number;
  readonly latestFrameDuration: number;
  readonly failedFrames: number;
  readonly activePointerCaptures: number;
  readonly registeredInputDevices: number;
  readonly displayCount: number;
  readonly workspaceCount: number;
  readonly recentDiagnostics: readonly DiagnosticEntry[];
  readonly applicationWorkers: readonly ApplicationWorkerSnapshot[];
}

export interface SystemMonitorApplicationSurface {
  readonly kind: "system-monitor";
  readonly heading: string;
}
export interface SettingsApplicationSurface {
  readonly kind: "settings";
  readonly heading: string;
}
export interface GalleryApplicationSurface {
  readonly kind: "gallery";
  readonly heading: string;
}
export interface FilesApplicationSurface {
  readonly kind: "files";
  readonly heading: string;
}
export interface CameraApplicationSurface {
  readonly kind: "camera";
  readonly heading: string;
}
export interface MusicApplicationSurface {
  readonly kind: "music";
  readonly heading: string;
}
export interface BrowserApplicationSurface {
  readonly kind: "browser";
  readonly heading: string;
}
export interface TextEditorApplicationSurface {
  readonly kind: "text-editor";
  readonly heading: string;
}
export interface AppManagerApplicationSurface {
  readonly kind: "app-manager";
  readonly heading: string;
}
export interface NotesApplicationSurface {
  readonly kind: "notes";
  readonly heading: string;
}
export interface IdeApplicationSurface {
  readonly kind: "ide";
  readonly heading: string;
}

export type DesktopApplicationSurface =
  | WelcomeApplicationSurface
  | InstallerApplicationSurface
  | ConsoleApplicationSurface
  | SystemMonitorApplicationSurface
  | SettingsApplicationSurface
  | GalleryApplicationSurface
  | FilesApplicationSurface
  | CameraApplicationSurface
  | MusicApplicationSurface
  | BrowserApplicationSurface
  | TextEditorApplicationSurface
  | AppManagerApplicationSurface
  | NotesApplicationSurface
  | IdeApplicationSurface;

export type ApplicationSurfaceListener = () => void;

export interface ApplicationManagementController {
  list(): readonly AppManagerEntry[];
  launch(applicationId: string): Promise<void> | void;
  terminate(applicationId: string): Promise<void> | void;
  /**
   * Reads the installed-application catalog from the real application
   * registry (ApplicationInstaller, backed by /var/lib/sevyn/apps/registry.json).
   */
  listInstalledApps(): Promise<readonly TerminalAppRecord[]>;
  /**
   * Installs a `.sevyn` bundle path (or an app id resolved from the pristine
   * store) into the real application registry.
   */
  installApp(target: string): Promise<TerminalAppRecord>;
  /**
   * Terminates running sessions, then removes the app from the real
   * application registry. Protected system apps are rejected by the registry.
   */
  uninstallApp(applicationId: string): Promise<void>;
  /**
   * Reinstalls a stock app from the pristine bundle store into the real
   * application registry.
   */
  restoreApp(applicationId: string): Promise<TerminalAppRecord>;
}

export class ApplicationSurfaceRegistry {
  readonly #surfaces = new Map<GenesisWindowId, DesktopApplicationSurface>();

  readonly #onChange: ApplicationSurfaceListener;
  readonly #network: SevynWirelessNetworkService;
  readonly #power: SevynPowerService;
  readonly #createBrowserEngine: (() => SevynBrowserEngine) | undefined;
  readonly #browserEngines = new Map<GenesisWindowId, SevynBrowserEngine>();
  readonly #createSevynCodeEngine: (() => SevynBrowserEngine | undefined) | undefined;
  readonly #sevynCodeEngines = new Map<GenesisWindowId, SevynBrowserEngine>();
  readonly #nativeRuntimes = new Map<GenesisWindowId, SevynApplicationRuntime>();
  readonly #nativeSignatures = new Map<GenesisWindowId, string>();
  readonly #nativeBounds = new Map<GenesisWindowId, NativeBounds>();
  readonly #filesystem: SevynFileSystem;
  readonly #storage: SevynStorageService;
  readonly #battery: SevynBatteryService;
  readonly #audio: SevynAudioService;
  readonly #system: SevynSystemService;
  readonly #notifications = new SystemNotificationService();
  readonly #isolatedSnapshots = new Map<GenesisWindowId, NativeRuntimeSnapshot>();
  readonly #isolatedDispatchers = new Map<
    GenesisWindowId,
    (event: StructuredValue) => void
  >();
  readonly #isolatedBounds = new Map<GenesisWindowId, NativeBounds>();
  readonly #isolatedTeardowns = new Map<GenesisWindowId, () => void>();
  #workerSnapshots: readonly ApplicationWorkerSnapshot[] = Object.freeze([]);
  #applicationManagement: ApplicationManagementController | undefined;
  #onUpdateSetting: ((key: string, value: unknown) => void) | undefined;

  public constructor(
    onChange: ApplicationSurfaceListener,
    network: SevynWirelessNetworkService = new UnavailableWirelessNetworkService(),
    power: SevynPowerService = new UnavailablePowerService(),
    createBrowserEngine?: () => SevynBrowserEngine,
    filesystem?: SevynFileSystem,
    battery?: SevynBatteryService,
    audio?: SevynAudioService,
    system?: SevynSystemService,
    createSevynCodeEngine?: () => SevynBrowserEngine | undefined,
  ) {
    this.#onChange = onChange;
    this.#network = network;
    this.#power = power;
    this.#createBrowserEngine = createBrowserEngine;
    this.#createSevynCodeEngine = createSevynCodeEngine;
    // Volume service for USB/removable drives. Starts polling /proc/mounts.
    const volumeService = new LinuxVolumeService();
    volumeService.start();
    this.#storage = volumeService;
    this.#filesystem =
      filesystem ??
      new InMemoryFileSystem({
        "/Welcome.txt": "Welcome to the SevynOS virtual filesystem.",
        "/Documents/Welcome.txt": "Welcome to SevynOS desktop workspace.",
        "/Pictures/Read Me.txt":
          "Welcome to Pictures. Select any image to inspect its resolution and format.",
        "/Pictures/Wallpaper.png":
          "SEVYN_IMAGE_DATA:1920x1080:PNG:iOS Deep Purple Aurora",
        "/Pictures/SevynLogo.png": "SEVYN_IMAGE_DATA:512x512:PNG:Sevyn Gold Emblem",
        "/Pictures/Landscape.png": "SEVYN_IMAGE_DATA:1280x720:PNG:Mountain Lake Sunrise",
        "/Applications/Projects/App.tsx":
          "import { View, NativeText } from '@sevynos/react-native';\nexport default function App() {\n  return <View><NativeText>Hello SevynOS</NativeText></View>;\n}",
        "/Applications/Projects/manifest.json":
          '{\n  "id": "org.sevynos.user.custom-app",\n  "name": "Custom Sevyn App",\n  "version": "1.0.0"\n}',
        "/Documents/QuickStart.txt":
          "SevynOS Quick Start Guide:\n1. Launch Sevyn Studio to build React Native apps.\n2. Open Browser for offline docs & web.\n3. Use Files to manage documents.\n4. Use Genesis Console for shell commands.",
      });
    this.#battery = battery ?? new UnavailableBatteryService();
    this.#audio = audio ?? new UnavailableAudioService();
    this.#system = system ?? new UnavailableSystemService();
  }

  public configureApplicationManagement(
    controller: ApplicationManagementController,
  ): void {
    this.#applicationManagement = controller;
    for (const [windowId, surface] of this.#surfaces) {
      if (surface.kind === "app-manager") this.#nativeSignatures.delete(windowId);
    }
    this.#onChange();
  }

  public configureSettingsUpdate(
    onUpdateSetting: (key: string, value: unknown) => void,
  ): void {
    this.#onUpdateSetting = onUpdateSetting;
    this.#onChange();
  }

  public createWelcome(windowId: GenesisWindowId): WelcomeApplicationSurface {
    const surface: WelcomeApplicationSurface = Object.freeze({
      kind: "welcome",
      heading: "Welcome to SevynOS",
      body: Object.freeze([
        "Genesis is the first interactive SevynOS desktop prototype.",
        "Its windows, focus, input, and lifecycle are owned by the real runtime.",
      ]),
      runtimeStatus: "Runtime online · Input connected · Compositor ready",
    });

    this.#set(windowId, surface);
    return surface;
  }

  public createConsole(windowId: GenesisWindowId): ConsoleApplicationSurface {
    const surface: ConsoleApplicationSurface = Object.freeze({
      kind: "console",
      history: Object.freeze([
        "SevynOS Genesis Console",
        "Focused keyboard input is routed through the runtime.",
      ]),
      input: "",
      prompt: "sevyn> ",
    });

    this.#set(windowId, surface);
    return surface;
  }

  public restoreConsole(
    windowId: GenesisWindowId,
    history: readonly string[],
    input: string,
  ): ConsoleApplicationSurface | undefined {
    const current = this.#surfaces.get(windowId);
    if (current?.kind !== "console") return undefined;
    const surface: ConsoleApplicationSurface = Object.freeze({
      ...current,
      history: Object.freeze([...history]),
      input,
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createSystemMonitor(windowId: GenesisWindowId): SystemMonitorApplicationSurface {
    const surface: SystemMonitorApplicationSurface = Object.freeze({
      kind: "system-monitor",
      heading: "System Monitor",
    });

    this.#set(windowId, surface);
    return surface;
  }

  public createSettings(windowId: GenesisWindowId): SettingsApplicationSurface {
    const surface: SettingsApplicationSurface = Object.freeze({
      kind: "settings",
      heading: "Desktop Settings",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createInstaller(windowId: GenesisWindowId): InstallerApplicationSurface {
    const surface = { kind: "installer" as const, heading: "Install SevynOS" };
    this.#set(windowId, surface);
    return surface;
  }

  public createGallery(windowId: GenesisWindowId): GalleryApplicationSurface {
    const surface: GalleryApplicationSurface = Object.freeze({
      kind: "gallery",
      heading: "Sevyn Component Gallery",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createFiles(windowId: GenesisWindowId): FilesApplicationSurface {
    const surface: FilesApplicationSurface = Object.freeze({
      kind: "files",
      heading: "Files",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createCamera(windowId: GenesisWindowId): CameraApplicationSurface {
    const surface: CameraApplicationSurface = Object.freeze({
      kind: "camera",
      heading: "Camera",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createMusic(windowId: GenesisWindowId): MusicApplicationSurface {
    const surface: MusicApplicationSurface = Object.freeze({
      kind: "music",
      heading: "Music",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createBrowser(windowId: GenesisWindowId): BrowserApplicationSurface {
    const surface: BrowserApplicationSurface = Object.freeze({
      kind: "browser",
      heading: "SevynOS Browser",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public async navigateBrowser(windowId: GenesisWindowId, url: string): Promise<void> {
    const engine = this.#browserEngine(windowId);
    if (engine === undefined)
      throw new Error("The SevynOS browser engine is unavailable.");
    await engine.navigate(url);
  }

  public createTextEditor(windowId: GenesisWindowId): TextEditorApplicationSurface {
    const surface: TextEditorApplicationSurface = Object.freeze({
      kind: "text-editor",
      heading: "Text Editor",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createAppManager(windowId: GenesisWindowId): AppManagerApplicationSurface {
    const surface: AppManagerApplicationSurface = Object.freeze({
      kind: "app-manager",
      heading: "App Manager",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createNotes(windowId: GenesisWindowId): NotesApplicationSurface {
    const surface: NotesApplicationSurface = Object.freeze({
      kind: "notes",
      heading: "Notes",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public createIde(windowId: GenesisWindowId): IdeApplicationSurface {
    const surface: IdeApplicationSurface = Object.freeze({
      kind: "ide",
      heading: "Sevyn Code",
    });
    this.#set(windowId, surface);
    return surface;
  }

  public composeNativeSurface(
    windowId: GenesisWindowId,
    bounds: NativeBounds,
    settings: DesktopSettings,
    monitor: SystemMonitorSnapshot | undefined,
  ): NativeRuntimeSnapshot | undefined {
    const surface = this.#surfaces.get(windowId);
    if (surface === undefined) return undefined;
    this.#nativeBounds.set(windowId, Object.freeze({ ...bounds }));
    if (surface.kind === "notes" && this.#isolatedSnapshots.has(windowId)) {
      const previousBounds = this.#isolatedBounds.get(windowId);
      this.#isolatedBounds.set(windowId, bounds);
      if (
        previousBounds !== undefined &&
        (previousBounds.width !== bounds.width || previousBounds.height !== bounds.height)
      )
        this.#isolatedDispatchers.get(windowId)?.({
          kind: "viewport",
          width: bounds.width,
          height: bounds.height,
        });
      return this.#isolatedSnapshots.get(windowId);
    }
    const localBounds = Object.freeze({
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height,
    });
    if (surface.kind === "browser") {
      const browserEngine = this.#browserEngine(windowId);
      if (browserEngine !== undefined)
        void browserEngine.resize(
          Math.max(320, localBounds.width - 20),
          Math.max(240, localBounds.height - 92),
        );
    }
    let runtime = this.#nativeRuntimes.get(windowId);
    if (runtime === undefined) {
      runtime = new SevynApplicationRuntime({
        bounds: localBounds,
        appearance: settings.theme === "light" ? "light" : "dark",
        accent: settings.accentColor,
        reducedMotion: settings.reducedMotion,
        onInvalidate: this.#onChange,
      });
      this.#nativeRuntimes.set(windowId, runtime);
    }
    runtime.configure(
      {
        bounds: localBounds,
        appearance: settings.theme === "light" ? "light" : "dark",
        accent: settings.accentColor,
        reducedMotion: settings.reducedMotion,
      },
      false,
    );
    const monitorSignature =
      monitor === undefined
        ? undefined
        : {
            runningApplicationSessions: monitor.runningApplicationSessions,
            openWindows: monitor.openWindows,
            focusedWindow: monitor.focusedWindow,
            cursorKind: monitor.cursorKind,
            activeWorkspace: monitor.activeWorkspace,
          };
    const signature = JSON.stringify({
      kind: surface.kind,
      bounds: localBounds,
      settings,
      monitor: monitorSignature,
      applications:
        surface.kind === "app-manager" ? this.#applicationManagement?.list() : undefined,
    });
    if (signature !== this.#nativeSignatures.get(windowId)) {
      const tree = this.#applicationTree(windowId, surface.kind, settings, monitor);
      if (runtime.mounted) runtime.update(tree);
      else runtime.mount(tree);
      this.#nativeSignatures.set(windowId, signature);
    }
    return runtime.snapshot;
  }

  public dispatchNativePointer(
    windowId: GenesisWindowId,
    type: "enter" | "leave" | "move" | "down" | "up" | "cancel",
    event: {
      readonly x: number;
      readonly y: number;
      readonly pointerId: number;
      readonly button: number;
    },
  ): void {
    const bounds = this.#nativeBounds.get(windowId);
    const localEvent = {
      ...event,
      x: event.x - (bounds?.x ?? 0),
      y: event.y - (bounds?.y ?? 0),
    };
    const isolated = this.#isolatedDispatchers.get(windowId);
    if (isolated !== undefined) {
      isolated({
        kind: "pointer",
        type,
        ...localEvent,
      });
      return;
    }
    this.#nativeRuntimes.get(windowId)?.dispatchPointer(type, localEvent);
  }

  public nativeCursorKindAt(
    windowId: GenesisWindowId,
    x: number,
    y: number,
  ): "text" | "pointer" | "default" {
    const bounds = this.#nativeBounds.get(windowId);
    const runtime = this.#nativeRuntimes.get(windowId);
    const localX = x - (bounds?.x ?? 0);
    const localY = y - (bounds?.y ?? 0);
    if (runtime !== undefined) return runtime.cursorKindAt(localX, localY);
    const isolated = this.#isolatedSnapshots.get(windowId);
    if (isolated === undefined) return "default";
    const hit = deepestAccessibilityHit(isolated.accessibility, localX, localY);
    if (hit?.role === "textbox" && !hit.disabled) return "text";
    if (
      hit !== undefined &&
      !hit.disabled &&
      ["button", "checkbox", "menuitem", "slider", "tab"].includes(hit.role)
    )
      return "pointer";
    return "default";
  }

  public attachIsolatedSurface(
    windowId: GenesisWindowId,
    snapshot: NativeRuntimeSnapshot,
    dispatch: (event: StructuredValue) => void,
    teardown?: () => void,
  ): void {
    if (this.#surfaces.get(windowId)?.kind !== "notes")
      throw new Error("An isolated surface can only attach to a third-party window.");
    this.#isolatedSnapshots.set(windowId, snapshot);
    this.#isolatedDispatchers.set(windowId, dispatch);
    const bounds = this.#isolatedBounds.get(windowId);
    if (bounds !== undefined)
      dispatch({ kind: "viewport", width: bounds.width, height: bounds.height });
    if (teardown !== undefined) this.#isolatedTeardowns.set(windowId, teardown);
    this.#onChange();
  }

  public updateWorkerSnapshots(snapshots: readonly ApplicationWorkerSnapshot[]): void {
    this.#workerSnapshots = Object.freeze([...snapshots]);
    this.#onChange();
  }

  public get workerSnapshots(): readonly ApplicationWorkerSnapshot[] {
    return this.#workerSnapshots;
  }

  public get filesystem(): SevynFileSystem {
    return this.#filesystem;
  }

  public get battery(): SevynBatteryService {
    return this.#battery;
  }

  public get audio(): SevynAudioService {
    return this.#audio;
  }

  public get system(): SevynSystemService {
    return this.#system;
  }

  public get(windowId: GenesisWindowId): DesktopApplicationSurface | undefined {
    return this.#surfaces.get(windowId);
  }

  public has(windowId: GenesisWindowId): boolean {
    return this.#surfaces.has(windowId);
  }

  public getNativeSurfaceBounds(windowId: GenesisWindowId): NativeBounds | undefined {
    const bounds = this.#nativeBounds.get(windowId);
    return bounds === undefined ? undefined : Object.freeze({ ...bounds });
  }

  public remove(windowId: GenesisWindowId): boolean {
    this.#nativeRuntimes.get(windowId)?.unmount();
    this.#nativeRuntimes.delete(windowId);
    this.#nativeSignatures.delete(windowId);
    this.#nativeBounds.delete(windowId);
    const browserEngine = this.#browserEngines.get(windowId);
    this.#browserEngines.delete(windowId);
    if (browserEngine !== undefined) void browserEngine.close();
    this.#isolatedSnapshots.delete(windowId);
    this.#isolatedDispatchers.delete(windowId);
    this.#isolatedBounds.delete(windowId);
    this.#isolatedTeardowns.get(windowId)?.();
    this.#isolatedTeardowns.delete(windowId);
    const removed = this.#surfaces.delete(windowId);

    if (removed) {
      this.#onChange();
    }

    return removed;
  }

  public handleInput(windowId: GenesisWindowId, event: SevynInputEvent): void {
    const surface = this.#surfaces.get(windowId);

    if (event.type === "key-down" || event.type === "key-up") {
      const isolated = this.#isolatedDispatchers.get(windowId);
      if (isolated !== undefined) {
        isolated({
          kind: "keyboard",
          type: event.type === "key-down" ? "down" : "up",
          key: event.key,
          code: event.code,
          shift: event.modifiers.shift,
          alt: event.modifiers.alt,
          control: event.modifiers.control,
          meta: event.modifiers.meta,
        });
        return;
      }
      this.#nativeRuntimes
        .get(windowId)
        ?.dispatchKeyboard(event.type === "key-down" ? "down" : "up", {
          key: event.key,
          code: event.code,
          shift: event.modifiers.shift,
          alt: event.modifiers.alt,
          control: event.modifiers.control,
          meta: event.modifiers.meta,
        });
    }

    if (event.type === "wheel") {
      const bounds = this.#nativeBounds.get(windowId);
      const localEvent = {
        x: event.position.x - (bounds?.x ?? 0),
        y: event.position.y - (bounds?.y ?? 0),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      };
      const isolated = this.#isolatedDispatchers.get(windowId);
      if (isolated !== undefined) {
        isolated({
          kind: "wheel",
          ...localEvent,
        });
        return;
      }
      this.#nativeRuntimes.get(windowId)?.dispatchWheel(localEvent);
      return;
    }

    if (surface?.kind !== "console" || event.type !== "key-down") {
      return;
    }

    this.#handleConsoleKeyboardInput(windowId, surface, event);
  }

  #handleConsoleKeyboardInput(
    windowId: GenesisWindowId,
    surface: ConsoleApplicationSurface,
    event: KeyboardInputEvent,
  ): void {
    if (
      event.composing ||
      event.modifiers.control ||
      event.modifiers.meta ||
      event.modifiers.alt
    ) {
      return;
    }

    const key =
      event.key === "\r" || event.key === "\n"
        ? "Enter"
        : event.key === "\x08" || event.key === "\x7f"
          ? "Backspace"
          : event.key === "\x1b"
            ? "Escape"
            : event.key;

    switch (key) {
      case "Backspace":
        this.#updateConsole(
          windowId,
          surface,
          surface.input.slice(0, -1),
          surface.history,
        );
        return;

      case "Enter": {
        const submittedLine = `${surface.prompt}${surface.input}`;
        this.#updateConsole(
          windowId,
          surface,
          "",
          Object.freeze([...surface.history, submittedLine]),
        );
        return;
      }

      case "Escape":
        this.#updateConsole(windowId, surface, "", surface.history);
        return;
    }

    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      this.#updateConsole(windowId, surface, `${surface.input}${key}`, surface.history);
    }
  }

  #updateConsole(
    windowId: GenesisWindowId,
    surface: ConsoleApplicationSurface,
    input: string,
    history: readonly string[],
  ): void {
    if (surface.input === input && surface.history === history) {
      return;
    }

    this.#set(
      windowId,
      Object.freeze({
        ...surface,
        input,
        history,
      }),
    );
  }

  #set(windowId: GenesisWindowId, surface: DesktopApplicationSurface): void {
    this.#surfaces.set(windowId, surface);
    this.#onChange();
  }

  #applicationTree(
    windowId: GenesisWindowId,
    kind: DesktopApplicationSurface["kind"],
    settings: DesktopSettings,
    monitor: SystemMonitorSnapshot | undefined,
  ) {
    switch (kind) {
      case "welcome":
        return createElement(WelcomeApplication, {
          onLaunch: (appId: string) => void this.#applicationManagement?.launch(appId),
        });
      case "installer":
        return createCoreSystemApplication({ kind: "installer" });
      case "console":
        return createElement(TerminalApplication, {
          filesystem: this.#filesystem,
          // Seed the terminal's catalog from the desktop's app list; the
          // terminal re-syncs from the real registry on mount via onRefreshApps.
          installedApps: (this.#applicationManagement?.list() ?? []).map((entry) => ({
            id: entry.id,
            name: entry.name,
            version: entry.version,
            permissions: entry.permissions,
            system:
              entry.id === "org.sevynos.shell" || entry.id === "org.sevynos.terminal",
          })),
          onRefreshApps: () =>
            this.#applicationManagement?.listInstalledApps() ?? Promise.resolve([]),
          onInstallApp: (target: string) =>
            this.#applicationManagement?.installApp(target) ??
            Promise.reject(new Error("Application management is unavailable.")),
          onUninstallApp: (appId: string) =>
            this.#applicationManagement?.uninstallApp(appId) ??
            Promise.reject(new Error("Application management is unavailable.")),
          onRestoreApp: (appId: string) =>
            this.#applicationManagement?.restoreApp(appId) ??
            Promise.reject(new Error("Application management is unavailable.")),
        });
      case "settings":
        return createElement(SettingsApplication, {
          settings,
          network: this.#network,
          power: this.#power,
          battery: this.#battery,
          audio: this.#audio,
          system: this.#system,
          onUpdateSetting: this.#onUpdateSetting,
          onUninstallApp: (appId: string) => {
            void this.#applicationManagement?.terminate(appId);
          },
        });
      case "system-monitor":
        return createElement(SystemMonitorApplication, {
          model: monitor ?? {
            runningApplicationSessions: 0,
            openWindows: 0,
            focusedWindow: undefined,
            cursorKind: "default",
            frameExecutionCount: 0,
            activeWorkspace: "workspace-1",
            applicationWorkers: Object.freeze([]),
          },
        });
      case "gallery":
        return createCoreSystemApplication({ kind: "gallery" });
      case "files":
        return createElement(FilesApplication, {
          filesystem: this.#filesystem,
          storage: this.#storage,
          notifications: this.#notifications,
        });
      case "camera":
        return createElement(CameraApplication, {
          initialPermissionGranted: true,
        });
      case "music":
        return createElement(MusicApplication, {
          filesystem: this.#filesystem,
        });
      case "browser": {
        const engine = this.#browserEngine(windowId);
        return createElement(BrowserApplication, {
          ...(engine === undefined ? {} : { engine }),
          createEngine: () => this.#createBrowserEngine?.(),
        });
      }
      case "ide": {
        const sevynCodeEngine = this.#sevynCodeEngine(windowId);
        if (sevynCodeEngine) {
          return createCoreSystemApplication({
            kind: "ide",
            browserEngine: sevynCodeEngine,
          });
        }
        // Sevyn Code engine not available — fall back to the browser engine
        // if the host provides one, otherwise render the unavailable state.
        const fallbackEngine = this.#createBrowserEngine?.();
        return createCoreSystemApplication({
          kind: "ide",
          ...(fallbackEngine ? { browserEngine: fallbackEngine } : {}),
        });
      }
      case "text-editor":
        return createCoreSystemApplication({
          kind: "text-editor",
          filesystem: this.#filesystem,
          notifications: this.#notifications,
        });
      case "app-manager":
        return createCoreSystemApplication({
          kind: "app-manager",
          applications: this.#applicationManagement?.list() ?? [],
          ...(this.#applicationManagement === undefined
            ? {}
            : {
                onLaunch: (applicationId: string) =>
                  this.#applicationManagement?.launch(applicationId),
                onTerminate: (applicationId: string) =>
                  this.#applicationManagement?.terminate(applicationId),
              }),
        });
      case "notes":
        return createCoreSystemApplication({
          kind: "notes",
          filesystem: this.#filesystem,
          notifications: this.#notifications,
        });
    }
  }

  #browserEngine(windowId: GenesisWindowId): SevynBrowserEngine | undefined {
    const existing = this.#browserEngines.get(windowId);
    if (existing !== undefined) return existing;
    const created = this.#createBrowserEngine?.();
    if (created !== undefined) this.#browserEngines.set(windowId, created);
    return created;
  }

  #sevynCodeEngine(windowId: GenesisWindowId): SevynBrowserEngine | undefined {
    const existing = this.#sevynCodeEngines.get(windowId);
    if (existing !== undefined) return existing;
    const created = this.#createSevynCodeEngine?.();
    if (created !== undefined) this.#sevynCodeEngines.set(windowId, created);
    return created;
  }
}

function deepestAccessibilityHit(
  nodes: readonly AccessibilityNode[],
  x: number,
  y: number,
): AccessibilityNode | undefined {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node === undefined) continue;
    const bounds = node.bounds;
    if (
      x < bounds.x ||
      y < bounds.y ||
      x >= bounds.x + bounds.width ||
      y >= bounds.y + bounds.height
    )
      continue;
    return deepestAccessibilityHit(node.children, x, y) ?? node;
  }
  return undefined;
}
