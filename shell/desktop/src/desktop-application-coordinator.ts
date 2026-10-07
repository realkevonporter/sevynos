import type {
  ApplicationHost,
  ApplicationPackage,
  ApplicationSessionId,
  SevynRuntime,
} from "@sevynos/runtime";
import type { GenesisWindowId, GenesisWindowManager } from "@sevynos/graphics";
import type { FocusManager, FocusedInputRouter } from "@sevynos/input";
import type { ApplicationSurfaceRegistry } from "./application-surfaces.js";
import type { DesktopEnvironment, DesktopWorkspaceId } from "./desktop-environment.js";
import type {
  DesktopWindowLayoutManager,
  DesktopWindowLayoutPreferences,
} from "./desktop-window-layout.js";
import {
  matchesLauncherSearch,
  type DesktopShellApplicationSummary,
} from "@sevynos/system-applications/desktop";

export type DesktopApplicationKind =
  | "welcome"
  | "installer"
  | "console"
  | "system-monitor"
  | "settings"
  | "gallery"
  | "files"
  | "browser"
  | "text-editor"
  | "app-manager"
  | "notes"
  | "ide"
  | "camera"
  | "music"
  | "calculator";
export type DesktopApplicationId = string;

export interface DesktopApplicationDefinition {
  readonly id: DesktopApplicationId;
  readonly name: string;
  readonly kind: DesktopApplicationKind;
  readonly title: string;
  readonly layout: DesktopWindowLayoutPreferences;
  /**
   * Manifest icon path (e.g. "icons/browser.svg"). Rendered by
   * ApplicationIcon as the app's custom vector glyph.
   */
  readonly icon?: string | undefined;
}

export interface RunningDesktopApplication {
  readonly definition: DesktopApplicationDefinition;
  readonly sessionId: ApplicationSessionId;
  readonly windowId: GenesisWindowId;
}

const DESKTOP_HOST_ID = "sevyn.host.desktop";

export const DESKTOP_APPLICATION_CATALOG: readonly DesktopApplicationDefinition[] =
  Object.freeze([
    Object.freeze({
      id: "org.sevynos.installer",
      name: "Install SevynOS",
      kind: "installer",
      title: "Install SevynOS",
      layout: windowLayout(620, 420, 440, 280),
    }),
    Object.freeze({
      id: "org.sevynos.welcome",
      name: "Welcome",
      kind: "welcome",
      icon: "icons/welcome.svg",
      title: "Welcome to SevynOS",
      layout: windowLayout(620, 420, 480, 320),
    }),
    Object.freeze({
      id: "org.sevynos.console",
      name: "Genesis Console",
      kind: "console",
      icon: "icons/terminal.svg",
      title: "Genesis Console",
      layout: windowLayout(620, 420, 440, 280),
    }),
    Object.freeze({
      id: "org.sevynos.system-monitor",
      name: "System Monitor",
      kind: "system-monitor",
      icon: "icons/system-monitor.svg",
      title: "System Monitor",
      layout: windowLayout(560, 390, 480, 320),
    }),
    Object.freeze({
      id: "org.sevynos.settings",
      name: "Settings",
      kind: "settings",
      icon: "icons/settings.svg",
      title: "Desktop Settings",
      layout: windowLayout(820, 640, 640, 420),
    }),
    Object.freeze({
      id: "org.sevynos.gallery",
      name: "Component Gallery",
      kind: "gallery",
      title: "Sevyn Design Gallery",
      layout: windowLayout(620, 470, 520, 360),
    }),
    Object.freeze({
      id: "org.sevynos.files",
      name: "Files",
      kind: "files",
      icon: "icons/files.svg",
      title: "Files",
      layout: windowLayout(760, 560, 600, 400),
    }),
    Object.freeze({
      id: "org.sevynos.camera",
      name: "Camera",
      kind: "camera",
      icon: "icons/camera.svg",
      title: "Camera",
      layout: windowLayout(800, 580, 640, 480),
    }),
    Object.freeze({
      id: "org.sevynos.browser",
      name: "Browser",
      kind: "browser",
      icon: "icons/browser.svg",
      title: "SevynOS Browser",
      layout: windowLayout(900, 640, 680, 440),
    }),
    Object.freeze({
      id: "org.sevynos.ide",
      name: "Sevyn Code",
      kind: "ide",
      icon: "icons/sevyn-code.svg",
      title: "Sevyn Code · IDE",
      layout: windowLayout(1040, 700, 720, 480),
    }),
    Object.freeze({
      id: "org.sevynos.text-editor",
      name: "Text Editor",
      kind: "text-editor",
      icon: "icons/text-editor.svg",
      title: "Text Editor",
      layout: windowLayout(860, 620, 640, 420),
    }),
    Object.freeze({
      id: "org.sevynos.app-manager",
      name: "App Manager",
      kind: "app-manager",
      title: "App Manager",
      layout: windowLayout(780, 560, 600, 400),
    }),
    Object.freeze({
      id: "org.sevynos.notes",
      name: "Notes",
      kind: "notes",
      icon: "icons/notes.svg",
      title: "Notes",
      layout: windowLayout(760, 540, 600, 400),
    }),
    Object.freeze({
      id: "org.sevynos.music",
      name: "Music",
      kind: "music",
      icon: "icons/music.svg",
      title: "Music",
      layout: windowLayout(840, 600, 640, 440),
    }),
    Object.freeze({
      id: "org.sevynos.calculator",
      name: "Calculator",
      kind: "calculator",
      icon: "icons/calculator.svg",
      title: "Calculator",
      layout: windowLayout(400, 640, 320, 480),
    }),
  ]);

export function createDesktopApplicationHost(): ApplicationHost {
  return {
    id: DESKTOP_HOST_ID,
    start: (session) => Promise.resolve({ instanceId: `desktop-${session.id}` }),
    stop: () => Promise.resolve(),
  };
}

export function createDesktopApplicationPackages(): readonly ApplicationPackage[] {
  return DESKTOP_APPLICATION_CATALOG.map((definition) => ({
    manifest: {
      manifestVersion: 1,
      id: definition.id,
      name: definition.name,
      version: "0.1.0",
      hostId: DESKTOP_HOST_ID,
      entrypoint: "desktop",
    },
    files: { desktop: "" },
  }));
}

export class DesktopApplicationCoordinator {
  readonly #runtime: SevynRuntime;
  readonly #windows: GenesisWindowManager;
  readonly #focus: FocusManager;
  readonly #focusedInput: FocusedInputRouter;
  readonly #surfaces: ApplicationSurfaceRegistry;
  readonly #environment: DesktopEnvironment;
  readonly #layout: DesktopWindowLayoutManager;
  readonly #notify: () => void;
  readonly #running = new Map<DesktopApplicationId, RunningDesktopApplication>();
  readonly #catalog: DesktopApplicationDefinition[] = [...DESKTOP_APPLICATION_CATALOG];
  readonly #byWindow = new Map<GenesisWindowId, RunningDesktopApplication>();
  readonly #mruWindowIds: GenesisWindowId[] = [];
  #launcherOpen = false;
  #launcherSearchQuery = "";
  #switcherOpen = false;
  #switcherIndex = 0;
  #isLocked = false;
  #acceptingLaunches = true;

  public constructor(options: {
    readonly runtime: SevynRuntime;
    readonly windows: GenesisWindowManager;
    readonly focus: FocusManager;
    readonly focusedInput: FocusedInputRouter;
    readonly surfaces: ApplicationSurfaceRegistry;
    readonly environment: DesktopEnvironment;
    readonly layout: DesktopWindowLayoutManager;
    readonly notify: () => void;
  }) {
    this.#runtime = options.runtime;
    this.#windows = options.windows;
    this.#focus = options.focus;
    this.#focusedInput = options.focusedInput;
    this.#surfaces = options.surfaces;
    this.#environment = options.environment;
    this.#layout = options.layout;
    this.#notify = options.notify;
  }

  public get launcherOpen(): boolean {
    return this.#launcherOpen;
  }

  public get launcherSearchQuery(): string {
    return this.#launcherSearchQuery;
  }

  public setLauncherSearchQuery(query: string): void {
    this.#launcherSearchQuery = query;
    this.#notify();
  }

  public openLauncher(): void {
    if (this.#launcherOpen) return;
    this.#launcherOpen = true;
    this.#launcherSearchQuery = "";
    this.#notify();
  }

  public closeLauncher(): void {
    if (!this.#launcherOpen) return;
    this.#launcherOpen = false;
    this.#launcherSearchQuery = "";
    this.#notify();
  }

  public handleLauncherKey(key: string): boolean {
    if (!this.#launcherOpen) return false;

    if (key === "Escape") {
      this.closeLauncher();
      return true;
    }

    if (key === "Enter") {
      const query = this.#launcherSearchQuery.trim();
      const match = this.#catalog.find((entry) => {
        if (query.length === 0) return true;
        return matchesLauncherSearch(entry.name, entry.id, query);
      });
      if (match !== undefined) {
        void this.launch(match.id);
      }
      this.closeLauncher();
      return true;
    }

    if (key === "Backspace") {
      if (this.#launcherSearchQuery.length > 0) {
        this.#launcherSearchQuery = this.#launcherSearchQuery.slice(0, -1);
        this.#notify();
      }
      return true;
    }

    if (key.length === 1) {
      this.#launcherSearchQuery += key;
      this.#notify();
      return true;
    }

    return false;
  }

  public get switcherOpen(): boolean {
    return this.#switcherOpen;
  }

  public get switcherApplications(): readonly DesktopShellApplicationSummary[] {
    const list: DesktopShellApplicationSummary[] = [];
    for (const windowId of this.#mruWindowIds) {
      const running = this.#byWindow.get(windowId);
      if (running === undefined) continue;
      const window = this.#windows.getWindow(windowId);
      if (window === undefined || window.state === "closed" || window.state === "closing")
        continue;
      list.push(
        Object.freeze({
          applicationId: running.definition.id,
          label: running.definition.name,
          focused: window.state === "focused",
          minimized: window.state === "minimized",
          displayId: this.#environment.getDisplayForBounds(window.bounds).id,
          running: true,
          icon: running.definition.icon,
        }),
      );
    }
    return Object.freeze(list);
  }

  public get switcherSelectedApplicationId(): string | undefined {
    const apps = this.switcherApplications;
    if (apps.length === 0) return undefined;
    const clampedIndex = Math.max(0, Math.min(this.#switcherIndex, apps.length - 1));
    return apps[clampedIndex]?.applicationId;
  }

  public openSwitcher(): void {
    const apps = this.switcherApplications;
    if (apps.length === 0) return;
    this.#switcherOpen = true;
    this.#switcherIndex = apps.length > 1 ? 1 : 0;
    this.#notify();
  }

  public cycleSwitcher(direction: 1 | -1 = 1): void {
    const apps = this.switcherApplications;
    if (apps.length === 0) return;
    if (!this.#switcherOpen) {
      this.openSwitcher();
      return;
    }
    this.#switcherIndex = (this.#switcherIndex + direction + apps.length) % apps.length;
    this.#notify();
  }

  public closeSwitcher(commit = true): void {
    if (!this.#switcherOpen) return;
    if (commit) {
      const apps = this.switcherApplications;
      const target = apps[this.#switcherIndex];
      if (target !== undefined) {
        const running = this.#running.get(target.applicationId);
        if (running !== undefined) {
          this.#focusOrRestore(running.windowId);
        }
      }
    }
    this.#switcherOpen = false;
    this.#switcherIndex = 0;
    this.#notify();
  }

  public selectSwitcherApplication(applicationId: DesktopApplicationId): void {
    const running = this.#running.get(applicationId);
    if (running !== undefined) {
      this.#focusOrRestore(running.windowId);
    }
    this.closeSwitcher(false);
  }

  public get isLocked(): boolean {
    return this.#isLocked;
  }

  public lock(): void {
    if (this.#isLocked) return;
    this.#isLocked = true;
    this.#launcherOpen = false;
    this.#switcherOpen = false;
    this.#notify();
  }

  public unlock(): void {
    if (!this.#isLocked) return;
    this.#isLocked = false;
    this.#notify();
  }

  public moveFocusedWindowToWorkspace(workspaceId: DesktopWorkspaceId): void {
    const focused = this.#windows
      .listWindows()
      .find((window) => window.state === "focused");
    if (focused === undefined) return;
    this.#environment.moveWindowToWorkspace(focused.id, workspaceId);
    this.#notify();
  }

  public moveFocusedWindowToAdjacentWorkspace(direction: 1 | -1): void {
    const workspaces = this.#environment.listWorkspaces();
    const currentIndex = workspaces.indexOf(this.#environment.activeWorkspace);
    if (currentIndex === -1) return;
    const nextIndex = (currentIndex + direction + workspaces.length) % workspaces.length;
    const nextWorkspace = workspaces[nextIndex];
    if (nextWorkspace) {
      this.moveFocusedWindowToWorkspace(nextWorkspace);
    }
  }

  public get catalog(): readonly DesktopApplicationDefinition[] {
    return this.#catalog;
  }

  public listRunning(): readonly RunningDesktopApplication[] {
    return this.#catalog.flatMap((definition) => {
      const running = this.#running.get(definition.id);
      return running === undefined ? [] : [running];
    });
  }

  public getByApplicationId(
    applicationId: DesktopApplicationId,
  ): RunningDesktopApplication | undefined {
    return this.#running.get(applicationId);
  }

  public registerDevelopmentApplication(id: string, name: string): void {
    if (this.#catalog.some((application) => application.id === id)) return;
    const definition: DesktopApplicationDefinition = Object.freeze({
      id,
      name,
      kind: "notes",
      icon: "icons/notes.svg",
      title: name,
      layout: windowLayout(760, 540, 600, 400),
    });
    this.#runtime.registerApplication({
      manifest: {
        manifestVersion: 1,
        id,
        name,
        version: "0.1.0",
        hostId: DESKTOP_HOST_ID,
        entrypoint: "desktop",
      },
      files: { desktop: "" },
    });
    this.#catalog.push(definition);
    this.#notify();
  }

  public toggleLauncher(): void {
    this.#launcherOpen = !this.#launcherOpen;
    this.#launcherSearchQuery = "";
    this.#notify();
  }

  public async launch(
    applicationId: DesktopApplicationId,
  ): Promise<RunningDesktopApplication> {
    if (!this.#acceptingLaunches) {
      throw new Error("Desktop application launches are blocked during shutdown.");
    }
    const existing = this.#running.get(applicationId);
    this.#launcherOpen = false;

    if (existing !== undefined) {
      this.#focusOrRestore(existing.windowId);
      this.#notify();
      return existing;
    }

    const definition = this.#catalog.find((candidate) => candidate.id === applicationId);
    if (definition === undefined) {
      throw new Error(`Desktop application "${applicationId}" is not catalogued.`);
    }

    const started = await this.#runtime.startApplication(applicationId);
    const window = this.#windows.createWindow({
      sessionId: started.session.id,
      title: definition.title,
      bounds: this.#layout.initialBounds(definition.layout),
    });
    const running = Object.freeze({
      definition,
      sessionId: started.session.id,
      windowId: window.id,
    });
    this.#running.set(applicationId, running);
    this.#byWindow.set(window.id, running);
    this.#bringToFrontMru(window.id);
    this.#environment.registerWindow(window.id);
    this.#focus.registerTarget(window.id);
    this.#focusedInput.registerTarget({
      targetId: window.id,
      handler: (event) => {
        this.#surfaces.handleInput(window.id, event);
      },
    });
    this.#createSurface(definition.kind, window.id);
    this.#focusOrRestore(window.id);
    this.#notify();
    return running;
  }

  public activateTaskbarApplication(applicationId: DesktopApplicationId): void {
    const running = this.#running.get(applicationId);
    if (running === undefined) {
      void this.launch(applicationId);
      return;
    }
    const window = this.#windows.getWindow(running.windowId);
    if (window === undefined) return;

    if (window.state === "focused") {
      this.#windows.minimizeWindow(window.id);
      this.synchronizeKeyboardFocus();
    } else {
      this.#focusOrRestore(window.id);
    }
    this.#notify();
  }

  public async closeWindow(windowId: GenesisWindowId): Promise<void> {
    const running = this.#byWindow.get(windowId);
    this.#windows.closeWindow(windowId);
    this.#focusedInput.removeTarget(windowId);
    this.#focus.removeTarget(windowId);
    this.#surfaces.remove(windowId);
    this.#byWindow.delete(windowId);
    this.#removeFromMru(windowId);
    this.#environment.unregisterWindow(windowId);
    this.synchronizeKeyboardFocus();

    if (running !== undefined) {
      this.#running.delete(running.definition.id);
      await this.#runtime.stopApplication(running.sessionId);
    }
    this.#notify();
  }

  public blockLaunches(): void {
    this.#acceptingLaunches = false;
  }

  public allowLaunches(): void {
    this.#acceptingLaunches = true;
  }

  public async closeAll(): Promise<void> {
    for (const running of [...this.listRunning()].reverse()) {
      await this.closeWindow(running.windowId);
    }
  }

  public async resetToDefaults(): Promise<void> {
    this.blockLaunches();
    await this.closeAll();
    this.allowLaunches();
    await this.launch("org.sevynos.welcome");
    await this.launch("org.sevynos.console");
  }

  public synchronizeKeyboardFocus(): void {
    const focused = this.#windows
      .listWindows()
      .find((window) => window.state === "focused");
    if (focused === undefined) {
      this.#focus.clearKeyboardFocus("programmatic");
    } else {
      this.#focus.focusKeyboard(focused.id, "programmatic");
    }
  }

  #bringToFrontMru(windowId: GenesisWindowId): void {
    const index = this.#mruWindowIds.indexOf(windowId);
    if (index !== -1) {
      this.#mruWindowIds.splice(index, 1);
    }
    this.#mruWindowIds.unshift(windowId);
  }

  #removeFromMru(windowId: GenesisWindowId): void {
    const index = this.#mruWindowIds.indexOf(windowId);
    if (index !== -1) {
      this.#mruWindowIds.splice(index, 1);
    }
  }

  #focusOrRestore(windowId: GenesisWindowId): void {
    const window = this.#windows.getWindow(windowId);
    if (window === undefined) return;
    this.#bringToFrontMru(windowId);
    if (window.state === "minimized" || window.state === "hidden") {
      this.#windows.restoreWindow(windowId, true);
    } else {
      this.#windows.focusWindow(windowId);
    }
    this.synchronizeKeyboardFocus();
  }

  #createSurface(kind: DesktopApplicationKind, windowId: GenesisWindowId): void {
    switch (kind) {
      case "welcome":
        this.#surfaces.createWelcome(windowId);
        return;
      case "installer":
        this.#surfaces.createInstaller(windowId);
        return;
      case "console":
        this.#surfaces.createConsole(windowId);
        return;
      case "system-monitor":
        this.#surfaces.createSystemMonitor(windowId);
        return;
      case "settings":
        this.#surfaces.createSettings(windowId);
        return;
      case "gallery":
        this.#surfaces.createGallery(windowId);
        return;
      case "files":
        this.#surfaces.createFiles(windowId);
        return;
      case "camera":
        this.#surfaces.createCamera(windowId);
        return;
      case "browser":
        this.#surfaces.createBrowser(windowId);
        return;
      case "text-editor":
        this.#surfaces.createTextEditor(windowId);
        return;
      case "app-manager":
        this.#surfaces.createAppManager(windowId);
        return;
      case "notes":
        this.#surfaces.createNotes(windowId);
        return;
      case "calculator":
        this.#surfaces.createCalculator(windowId);
        return;
      case "music":
        this.#surfaces.createMusic(windowId);
        return;
      case "ide":
        this.#surfaces.createIde(windowId);
        return;
    }
  }
}

function windowLayout(
  preferredWidth: number,
  preferredHeight: number,
  minimumWidth: number,
  minimumHeight: number,
): DesktopWindowLayoutPreferences {
  return Object.freeze({
    preferredWidth,
    preferredHeight,
    minimumWidth,
    minimumHeight,
    maximumWidthRatio: 0.76,
    maximumHeightRatio: 0.82,
  });
}
