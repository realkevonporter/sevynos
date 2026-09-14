import type { ApplicationSessionId } from "../application-session-id.js";
import { GenesisWindow, type GenesisWindowId } from "./genesis-window.js";
import type { WindowState } from "./window-state.js";
import { WindowNotFoundError } from "../errors/window-not-found-error.js";
import type {
  WindowRegistryEvent,
  WindowRegistryEventListener,
} from "./window-registry-events.js";

export interface WindowRegistryDependencies {
  readonly onEvent?: WindowRegistryEventListener;
}

export class WindowRegistry {
  readonly #windows = new Map<GenesisWindowId, GenesisWindow>();

  readonly #onEvent: WindowRegistryEventListener | undefined;

  public constructor(dependencies: WindowRegistryDependencies = {}) {
    this.#onEvent = dependencies.onEvent;
  }

  public add(window: GenesisWindow): void {
    if (this.#windows.has(window.id)) {
      throw new Error(`Window "${window.id}" is already registered.`);
    }

    this.#windows.set(window.id, window);

    this.#emit({
      type: "window-registry-changed",
      operation: "added",
      windowId: window.id,
      window,
    });
  }

  public update(window: GenesisWindow): void {
    if (!this.#windows.has(window.id)) {
      throw new WindowNotFoundError(window.id);
    }

    this.#windows.set(window.id, window);

    this.#emit({
      type: "window-registry-changed",
      operation: "updated",
      windowId: window.id,
      window,
    });
  }

  public transition(windowId: GenesisWindowId, targetState: WindowState): GenesisWindow {
    const window = this.#windows.get(windowId);

    if (!window) {
      throw new WindowNotFoundError(windowId);
    }

    const nextWindow = window.transitionTo(targetState);

    this.#windows.set(windowId, nextWindow);

    this.#emit({
      type: "window-registry-changed",
      operation: "transitioned",
      windowId,
      window: nextWindow,
    });

    return nextWindow;
  }

  public get(windowId: GenesisWindowId): GenesisWindow | undefined {
    return this.#windows.get(windowId);
  }

  public has(windowId: GenesisWindowId): boolean {
    return this.#windows.has(windowId);
  }

  public list(): readonly GenesisWindow[] {
    return Array.from(this.#windows.values());
  }

  public listBySession(sessionId: ApplicationSessionId): readonly GenesisWindow[] {
    return this.list().filter((window) => window.sessionId === sessionId);
  }

  public getFocusedWindow(): GenesisWindow | undefined {
    return this.list().find((window) => window.state === "focused");
  }

  public remove(windowId: GenesisWindowId): boolean {
    const removed = this.#windows.delete(windowId);

    if (removed) {
      this.#emit({
        type: "window-registry-changed",
        operation: "removed",
        windowId,
        window: undefined,
      });
    }

    return removed;
  }

  public clear(): void {
    const windowIds = Object.freeze([...this.#windows.keys()]);

    this.#windows.clear();

    if (windowIds.length > 0) {
      this.#emit({ type: "window-registry-cleared", windowIds });
    }
  }

  public getTopWindow(): GenesisWindow | undefined {
    return this.list().reduce<GenesisWindow | undefined>((topWindow, window) => {
      if (!topWindow || window.zIndex > topWindow.zIndex) {
        return window;
      }

      return topWindow;
    }, undefined);
  }

  public getHighestZIndex(): number {
    return this.getTopWindow()?.zIndex ?? 0;
  }

  #emit(event: WindowRegistryEvent): void {
    this.#onEvent?.(event);
  }
}
