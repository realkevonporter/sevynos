import type { GenesisCompositor } from "../compositor";
import type { SceneNodeBounds } from "../scene";
import { GenesisWindowState, type GenesisWindow } from "./window-state";

export interface OpenWindowOptions {
  readonly id: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly bounds: SceneNodeBounds;
}

export class GenesisWindowManager {
  private readonly windows = new Map<string, GenesisWindow>();

  private readonly listeners = new Set<() => void>();

  private nextZIndex = 10;

  private version = 0;

  public constructor(private readonly compositor: GenesisCompositor) {}

  public openWindow(options: OpenWindowOptions): GenesisWindow {
    const existingWindow = this.windows.get(options.id);

    if (existingWindow !== undefined) {
      return this.focusWindow(existingWindow.id);
    }

    this.backgroundForegroundWindows();

    const window: GenesisWindow = {
      id: options.id,
      applicationId: options.applicationId,
      sessionId: options.sessionId,
      surfaceId: options.surfaceId,
      bounds: Object.freeze({ ...options.bounds }),
      state: GenesisWindowState.Foreground,
      zIndex: this.getNextZIndex(),
    };

    this.windows.set(window.id, window);

    this.compositor.mountApplicationSurface({
      surface: {
        id: window.surfaceId,
        applicationId: window.applicationId,
        sessionId: window.sessionId,
      },
      bounds: window.bounds,
      zIndex: window.zIndex,
    });

    this.notify();

    return window;
  }

  public closeWindow(windowId: string): GenesisWindow | undefined {
    const window = this.windows.get(windowId);

    if (window === undefined) {
      return undefined;
    }

    this.windows.delete(windowId);

    this.compositor.unmountApplicationSurface(window.surfaceId);

    if (window.state === GenesisWindowState.Foreground) {
      this.focusHighestWindow(windowId);
    }

    this.notify();

    return window;
  }

  public focusWindow(windowId: string): GenesisWindow {
    const focusedWindow = this.focusWindowInternal(windowId);

    this.notify();

    return focusedWindow;
  }

  public minimizeWindow(windowId: string): GenesisWindow {
    const window = this.requireWindow(windowId);

    const minimizedWindow: GenesisWindow = {
      ...window,
      state: GenesisWindowState.Minimized,
    };

    this.windows.set(windowId, minimizedWindow);

    if (window.state === GenesisWindowState.Foreground) {
      this.focusHighestWindow(windowId);
    }

    this.notify();

    return minimizedWindow;
  }

  public setWindowBounds(windowId: string, bounds: SceneNodeBounds): GenesisWindow {
    const window = this.requireWindow(windowId);
    const updated = { ...window, bounds: Object.freeze({ ...bounds }) };
    this.windows.set(windowId, updated);
    this.compositor.updateSurfaceBounds(updated.surfaceId, updated.bounds);
    this.notify();
    return updated;
  }

  public getWindows(): readonly GenesisWindow[] {
    return [...this.windows.values()].sort((left, right) => left.zIndex - right.zIndex);
  }

  public getWindow(windowId: string): GenesisWindow | undefined {
    return this.windows.get(windowId);
  }

  public getFocusedWindow(): GenesisWindow | undefined {
    return this.getWindows().findLast(
      (window) => window.state === GenesisWindowState.Foreground,
    );
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public getSnapshot(): number {
    return this.version;
  }

  private focusWindowInternal(windowId: string): GenesisWindow {
    const window = this.requireWindow(windowId);

    this.backgroundForegroundWindows(windowId);

    const focusedWindow: GenesisWindow = {
      ...window,
      state: GenesisWindowState.Foreground,
      zIndex: this.getNextZIndex(),
    };

    this.windows.set(windowId, focusedWindow);

    this.compositor.updateApplicationSurface({
      surfaceId: focusedWindow.surfaceId,
      zIndex: focusedWindow.zIndex,
    });

    return focusedWindow;
  }

  private backgroundForegroundWindows(excludedWindowId?: string): void {
    for (const [windowId, window] of this.windows) {
      if (
        windowId === excludedWindowId ||
        window.state !== GenesisWindowState.Foreground
      ) {
        continue;
      }

      this.windows.set(windowId, {
        ...window,
        state: GenesisWindowState.Background,
      });
    }
  }

  private focusHighestWindow(excludedWindowId?: string): GenesisWindow | undefined {
    const candidate = this.getWindows()
      .filter(
        (window) =>
          window.id !== excludedWindowId && window.state !== GenesisWindowState.Minimized,
      )
      .at(-1);

    if (candidate === undefined) {
      return undefined;
    }

    return this.focusWindowInternal(candidate.id);
  }

  private requireWindow(windowId: string): GenesisWindow {
    const window = this.windows.get(windowId);

    if (window === undefined) {
      throw new Error(`Genesis window "${windowId}" does not exist.`);
    }

    return window;
  }

  private getNextZIndex(): number {
    const zIndex = this.nextZIndex;

    this.nextZIndex += 1;

    return zIndex;
  }

  private notify(): void {
    this.version += 1;

    for (const listener of this.listeners) {
      listener();
    }
  }
}
