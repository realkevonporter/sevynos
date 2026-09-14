import {
  DisplayRegistry,
  GenesisDisplay,
  GenesisDisplayManager,
  type DisplayId,
  type GenesisWindowId,
  type GenesisWindowManager,
  type WindowBounds,
} from "@sevynos/graphics";
import { constrainToWorkspace, getWorkspaceBounds } from "./desktop-window-layout.js";

export type DesktopDisplayLayoutMode = "side-by-side" | "vertical" | "offset";
export type DesktopWorkspaceId = string;

export const DESKTOP_WORKSPACES: readonly DesktopWorkspaceId[] = Object.freeze([
  "workspace-1",
  "workspace-2",
  "workspace-3",
  "workspace-4",
]);

export interface DesktopDisplaySnapshot {
  readonly id: DisplayId;
  readonly bounds: WindowBounds;
  readonly workArea: WindowBounds;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scaleFactor: number;
  readonly refreshRate: number;
  readonly primary: boolean;
}
export interface DesktopHostDisplayConfiguration {
  readonly id: DisplayId;
  readonly name: string;
  readonly bounds: WindowBounds;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly scaleFactor: number;
  readonly refreshRate: number;
  readonly primary: boolean;
}

export class DesktopEnvironment {
  public readonly displays = new DisplayRegistry();
  public readonly displayManager: GenesisDisplayManager;
  readonly #windows: GenesisWindowManager;
  readonly #notify: () => void;
  readonly #workspaces = new Map<GenesisWindowId, DesktopWorkspaceId>();
  #layoutMode: DesktopDisplayLayoutMode = "side-by-side";
  #activeWorkspace: DesktopWorkspaceId = "workspace-1";
  #workspaceCount = 4;
  #taskbarPosition: "bottom" | "top" | "left" | "right" = "bottom";
  #hostDisplaysConfigured = false;

  public constructor(windows: GenesisWindowManager, notify: () => void) {
    this.#windows = windows;
    this.#notify = notify;
    let nextDisplay = 0;
    this.displayManager = new GenesisDisplayManager({
      displays: this.displays,
      createDisplayId: () => {
        nextDisplay += 1;
        return `display-simulated-${String(nextDisplay)}`;
      },
      now: () => new Date(),
    });
  }

  public get layoutMode(): DesktopDisplayLayoutMode {
    return this.#layoutMode;
  }
  public get activeWorkspace(): DesktopWorkspaceId {
    return this.#activeWorkspace;
  }
  public get workspaceCount(): number {
    return this.#workspaceCount;
  }
  public listWorkspaces(): readonly DesktopWorkspaceId[] {
    return Object.freeze(
      Array.from(
        { length: this.#workspaceCount },
        (_, index) => `workspace-${String(index + 1)}`,
      ),
    );
  }
  public applyShellSettings(
    workspaceCount: number,
    taskbarPosition: "bottom" | "top" | "left" | "right",
  ): void {
    this.#workspaceCount = Math.min(8, Math.max(1, workspaceCount));
    this.#taskbarPosition = taskbarPosition;
    const fallback = `workspace-${String(this.#workspaceCount)}`;
    for (const [windowId, workspace] of this.#workspaces) {
      const index = Number(workspace.replace("workspace-", ""));
      if (!Number.isSafeInteger(index) || index > this.#workspaceCount)
        this.#workspaces.set(windowId, fallback);
    }
    const activeIndex = Number(this.#activeWorkspace.replace("workspace-", ""));
    if (activeIndex > this.#workspaceCount) this.switchWorkspace(fallback);
    this.#rehomeWindows();
    this.#notify();
  }

  public configure(
    width: number,
    height: number,
    scaleFactor: number,
    mode = this.#layoutMode,
  ): void {
    this.#layoutMode = mode;
    if (this.#hostDisplaysConfigured) {
      this.#notify();
      return;
    }
    const layouts = createDisplayBounds(width, height, mode);
    if (this.displayManager.listDisplays().length === 0) {
      layouts.forEach((bounds, index) => {
        const display = this.displayManager.connectDisplay({
          name: `Simulated Display ${String(index + 1)}`,
          bounds,
          mode: {
            width: Math.round(bounds.width * scaleFactor),
            height: Math.round(bounds.height * scaleFactor),
            refreshRate: index === 0 ? 60 : 75,
          },
          scaleFactor,
          orientation: "landscape",
        });
        this.displayManager.activateDisplay(display.id);
      });
    } else {
      this.displayManager.listDisplays().forEach((display, index) => {
        const bounds = layouts[index];
        if (bounds === undefined) return;
        this.displayManager.updateDisplayConfiguration(display.id, {
          bounds,
          mode: {
            width: Math.round(bounds.width * scaleFactor),
            height: Math.round(bounds.height * scaleFactor),
            refreshRate: display.mode.refreshRate,
          },
          scaleFactor,
        });
      });
    }
    this.#rehomeWindows();
    this.#notify();
  }

  public configureHostDisplays(
    configurations: readonly DesktopHostDisplayConfiguration[],
  ): void {
    if (configurations.length === 0) throw new Error("A host must expose a display.");
    this.#hostDisplaysConfigured = true;
    for (const display of this.displays.list()) this.displays.remove(display.id);
    const primaryIndex = Math.max(
      0,
      configurations.findIndex((configuration) => configuration.primary),
    );
    configurations.forEach((configuration, index) => {
      const now = new Date();
      this.displays.add(
        new GenesisDisplay({
          id: configuration.id,
          name: configuration.name,
          bounds: configuration.bounds,
          mode: {
            width: configuration.pixelWidth,
            height: configuration.pixelHeight,
            refreshRate: configuration.refreshRate,
          },
          scaleFactor: configuration.scaleFactor,
          orientation: "landscape",
          state: "active",
          primary: index === primaryIndex,
          createdAt: now,
        }),
      );
    });
    this.#rehomeWindows();
    this.#notify();
  }

  public listDisplays(): readonly DesktopDisplaySnapshot[] {
    return this.displayManager
      .listConnectedDisplays()
      .map((display) => this.#snapshot(display));
  }

  public getDisplayForBounds(bounds: WindowBounds): DesktopDisplaySnapshot {
    const displays = this.listDisplays();
    const primary = displays.find((display) => display.primary) ?? displays[0];
    if (primary === undefined) throw new Error("No desktop display is available.");
    return (
      [...displays].sort(
        (a, b) => intersectionArea(bounds, b.bounds) - intersectionArea(bounds, a.bounds),
      )[0] ?? primary
    );
  }

  public getDisplayAtPoint(x: number, y: number): DesktopDisplaySnapshot | undefined {
    return this.listDisplays().find((display) => contains(display.bounds, x, y));
  }

  public moveWindowToDisplay(windowId: GenesisWindowId, displayId: DisplayId): void {
    const window = this.#windows.getWindow(windowId);
    const destination = this.listDisplays().find((display) => display.id === displayId);
    if (window === undefined || destination === undefined) return;
    const source = this.getDisplayForBounds(window.bounds);
    const relativeX = window.bounds.x - source.workArea.x;
    const relativeY = window.bounds.y - source.workArea.y;
    this.#windows.resizeWindow({
      windowId,
      bounds: clampToWorkArea(
        {
          ...window.bounds,
          x: destination.workArea.x + relativeX,
          y: destination.workArea.y + relativeY,
        },
        destination.workArea,
      ),
    });
  }

  public registerWindow(
    windowId: GenesisWindowId,
    workspace = this.#activeWorkspace,
  ): void {
    this.#workspaces.set(windowId, workspace);
  }
  public unregisterWindow(windowId: GenesisWindowId): void {
    this.#workspaces.delete(windowId);
  }
  public getWindowWorkspace(windowId: GenesisWindowId): DesktopWorkspaceId {
    return this.#workspaces.get(windowId) ?? "workspace-1";
  }

  public switchWorkspace(workspace: DesktopWorkspaceId): void {
    if (workspace === this.#activeWorkspace) return;
    for (const window of this.#windows.listWindows()) {
      const belongsToNext = this.getWindowWorkspace(window.id) === workspace;
      if (!belongsToNext && (window.state === "visible" || window.state === "focused"))
        this.#windows.hideWindow(window.id);
      if (belongsToNext && window.state === "hidden")
        this.#windows.showWindow(window.id, false);
    }
    this.#activeWorkspace = workspace;
    const top = this.#windows
      .listWindows()
      .filter(
        (window) =>
          this.getWindowWorkspace(window.id) === workspace && window.state === "visible",
      )
      .sort((a, b) => b.zIndex - a.zIndex)[0];
    if (top !== undefined) this.#windows.focusWindow(top.id);
    this.#notify();
  }

  public moveWindowToWorkspace(
    windowId: GenesisWindowId,
    workspace: DesktopWorkspaceId,
  ): void {
    const window = this.#windows.getWindow(windowId);
    if (window === undefined) return;
    this.#workspaces.set(windowId, workspace);
    if (
      workspace !== this.#activeWorkspace &&
      (window.state === "visible" || window.state === "focused")
    )
      this.#windows.hideWindow(windowId);
    if (workspace === this.#activeWorkspace && window.state === "hidden")
      this.#windows.showWindow(windowId, true);
    this.#notify();
  }

  public setLayoutMode(mode: DesktopDisplayLayoutMode): void {
    this.#layoutMode = mode;
  }

  #snapshot(display: GenesisDisplay): DesktopDisplaySnapshot {
    const workArea = getWorkspaceBounds(display.bounds, this.#taskbarPosition);
    return Object.freeze({
      id: display.id,
      bounds: Object.freeze({ ...display.bounds }),
      workArea: Object.freeze(workArea),
      pixelWidth: display.mode.width,
      pixelHeight: display.mode.height,
      scaleFactor: display.scaleFactor,
      refreshRate: display.mode.refreshRate,
      primary: display.primary,
    });
  }

  #rehomeWindows(): void {
    for (const window of this.#windows.listWindows()) {
      if (window.state === "closed" || window.state === "closing") continue;
      const display = this.getDisplayForBounds(window.bounds);
      this.#windows.resizeWindow({
        windowId: window.id,
        bounds: clampToWorkArea(window.bounds, display.workArea),
      });
    }
  }
}

export function clampToWorkArea(
  bounds: WindowBounds,
  workArea: WindowBounds,
): WindowBounds {
  return constrainToWorkspace(bounds, workArea);
}

function createDisplayBounds(
  width: number,
  height: number,
  mode: DesktopDisplayLayoutMode,
): readonly WindowBounds[] {
  if (mode === "vertical") {
    const half = Math.floor(height / 2);
    return [
      { x: 0, y: 0, width, height: half },
      { x: 0, y: half, width, height: height - half },
    ];
  }
  if (mode === "offset") {
    const displayWidth = Math.floor(width * 0.62);
    const displayHeight = Math.floor(height * 0.68);
    return [
      { x: 0, y: 0, width: displayWidth, height: displayHeight },
      {
        x: width - displayWidth,
        y: height - displayHeight,
        width: displayWidth,
        height: displayHeight,
      },
    ];
  }
  const half = Math.floor(width / 2);
  return [
    { x: 0, y: 0, width: half, height },
    { x: half, y: 0, width: width - half, height },
  ];
}
function intersectionArea(a: WindowBounds, b: WindowBounds): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}
function contains(bounds: WindowBounds, x: number, y: number): boolean {
  return (
    x >= bounds.x &&
    x < bounds.x + bounds.width &&
    y >= bounds.y &&
    y < bounds.y + bounds.height
  );
}
