import type { ApplicationSessionId } from "../application-session-id.js";
import { WindowNotFoundError } from "../errors/window-not-found-error.js";
import type { ApplicationLifecycleController } from "./application-lifecycle-controller.js";
import type { GenesisWindow, GenesisWindowId } from "./genesis-window.js";
import { GenesisWindow as GenesisWindowModel } from "./genesis-window.js";
import type { WindowBounds } from "./window-bounds.js";
import type { WindowRegistry } from "./window-registry.js";
import type { WindowZOrderController } from "./window-z-order-controller.js";

export interface GenesisWindowManagerDependencies {
  readonly windows: WindowRegistry;

  readonly applications: ApplicationLifecycleController;

  readonly zOrder: WindowZOrderController;

  readonly createWindowId: () => GenesisWindowId;

  readonly now: () => Date;
}

export interface CreateWindowOptions {
  readonly sessionId: ApplicationSessionId;

  readonly title: string;

  readonly bounds: WindowBounds;

  readonly focus?: boolean;
}

export interface MoveWindowOptions {
  readonly windowId: GenesisWindowId;

  readonly x: number;

  readonly y: number;
}

export interface ResizeWindowOptions {
  readonly windowId: GenesisWindowId;

  readonly bounds: WindowBounds;

  readonly minimumWidth?: number;

  readonly minimumHeight?: number;
}

export class GenesisWindowManager {
  readonly #windows: WindowRegistry;

  readonly #applications: ApplicationLifecycleController;

  readonly #zOrder: WindowZOrderController;

  readonly #createWindowId: () => GenesisWindowId;

  readonly #now: () => Date;

  public constructor(dependencies: GenesisWindowManagerDependencies) {
    this.#windows = dependencies.windows;

    this.#applications = dependencies.applications;

    this.#zOrder = dependencies.zOrder;

    this.#createWindowId = dependencies.createWindowId;

    this.#now = dependencies.now;
  }

  public createWindow(options: CreateWindowOptions): GenesisWindow {
    const createdWindow = new GenesisWindowModel({
      id: this.#createWindowId(),

      sessionId: options.sessionId,

      title: options.title,

      bounds: options.bounds,

      createdAt: this.#now(),
    });

    this.#windows.add(createdWindow);

    const visibleWindow = this.#windows.transition(createdWindow.id, "visible");

    this.#zOrder.bringToFront(visibleWindow.id);

    if (options.focus === false) {
      return this.#getWindow(visibleWindow.id);
    }

    return this.focusWindow(visibleWindow.id);
  }

  public focusWindow(windowId: GenesisWindowId): GenesisWindow {
    return this.#focusWindow(windowId, this.#windows.getFocusedWindow());
  }

  #focusWindow(
    windowId: GenesisWindowId,
    previouslyFocusedWindow: GenesisWindow | undefined,
  ): GenesisWindow {
    const targetWindow = this.#getWindow(windowId);

    if (
      targetWindow.state === "created" ||
      targetWindow.state === "closing" ||
      targetWindow.state === "closed"
    ) {
      throw new Error(
        `Window "${windowId}" cannot be focused from state "${targetWindow.state}".`,
      );
    }

    const currentlyFocusedWindow = this.#windows.getFocusedWindow();

    if (
      currentlyFocusedWindow !== undefined &&
      currentlyFocusedWindow.id !== targetWindow.id
    ) {
      this.#windows.transition(currentlyFocusedWindow.id, "visible");
    }

    this.#zOrder.bringToFront(targetWindow.id);

    const latestTarget = this.#getWindow(targetWindow.id);

    const focusedTarget =
      latestTarget.state === "focused"
        ? latestTarget
        : this.#windows.transition(latestTarget.id, "focused");

    this.#transferFocus(previouslyFocusedWindow, focusedTarget);

    return focusedTarget;
  }

  public minimizeWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (window.state === "minimized") {
      return window;
    }

    const wasFocused = window.state === "focused";

    const minimizedWindow = this.#windows.transition(window.id, "minimized");

    this.#zOrder.normalize();

    if (wasFocused) {
      this.#focusTopVisibleWindow(window);
    }

    return minimizedWindow;
  }

  public restoreWindow(windowId: GenesisWindowId, focus = true): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (window.state !== "minimized" && window.state !== "hidden") {
      throw new Error(
        `Window "${windowId}" cannot be restored from state "${window.state}".`,
      );
    }

    if (focus) {
      return this.focusWindow(window.id);
    }

    const visibleWindow = this.#windows.transition(window.id, "visible");

    this.#zOrder.normalize();

    return this.#getWindow(visibleWindow.id);
  }

  public hideWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (window.state === "hidden") {
      return window;
    }

    const wasFocused = window.state === "focused";

    const hiddenWindow = this.#windows.transition(window.id, "hidden");

    this.#zOrder.normalize();

    if (wasFocused) {
      this.#focusTopVisibleWindow(window);
    }

    return hiddenWindow;
  }

  public showWindow(windowId: GenesisWindowId, focus = false): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (focus) {
      return this.focusWindow(window.id);
    }

    if (window.state === "visible") {
      return window;
    }

    if (window.state !== "hidden" && window.state !== "minimized") {
      throw new Error(
        `Window "${windowId}" cannot be shown from state "${window.state}".`,
      );
    }

    const visibleWindow = this.#windows.transition(window.id, "visible");

    this.#zOrder.normalize();

    return this.#getWindow(visibleWindow.id);
  }

  public moveWindow(options: MoveWindowOptions): GenesisWindow {
    const window = this.#getWindow(options.windowId);

    if (window.state === "closing" || window.state === "closed") {
      throw new Error(
        `Window "${window.id}" cannot be moved from state "${window.state}".`,
      );
    }

    if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
      throw new RangeError("Window coordinates must be finite numbers.");
    }

    if (window.bounds.x === options.x && window.bounds.y === options.y) {
      return window;
    }

    const movedWindow = window.withBounds(
      {
        ...window.bounds,

        x: options.x,

        y: options.y,
      },
      this.#now(),
    );

    this.#windows.update(movedWindow);

    return movedWindow;
  }

  public resizeWindow(options: ResizeWindowOptions): GenesisWindow {
    const window = this.#getWindow(options.windowId);

    if (window.state === "closing" || window.state === "closed") {
      throw new Error(
        `Window "${window.id}" cannot be resized from state "${window.state}".`,
      );
    }

    const minimumWidth = options.minimumWidth ?? 1;

    const minimumHeight = options.minimumHeight ?? 1;

    const values = [
      options.bounds.x,
      options.bounds.y,
      options.bounds.width,
      options.bounds.height,
      minimumWidth,
      minimumHeight,
    ];

    if (values.some((value) => !Number.isFinite(value))) {
      throw new RangeError(
        "Window bounds and minimum dimensions must be finite numbers.",
      );
    }

    if (minimumWidth <= 0 || minimumHeight <= 0) {
      throw new RangeError("Window minimum dimensions must be greater than zero.");
    }

    if (options.bounds.width < minimumWidth || options.bounds.height < minimumHeight) {
      throw new RangeError(
        `Window dimensions must be at least ${String(minimumWidth)} × ${String(minimumHeight)}.`,
      );
    }

    if (
      window.bounds.x === options.bounds.x &&
      window.bounds.y === options.bounds.y &&
      window.bounds.width === options.bounds.width &&
      window.bounds.height === options.bounds.height
    ) {
      return window;
    }

    const resizedWindow: GenesisWindow = window.withBounds(options.bounds, this.#now());

    this.#windows.update(resizedWindow);

    return resizedWindow;
  }

  public closeWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (window.state === "closed") {
      return window;
    }

    const wasFocused = window.state === "focused";

    const closingWindow = this.#windows.transition(window.id, "closing");

    const closedWindow = this.#windows.transition(closingWindow.id, "closed");

    this.#zOrder.normalize();

    if (wasFocused) {
      this.#focusTopVisibleWindow(window);
    }

    return closedWindow;
  }

  public raiseWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#getWindow(windowId);

    if (window.state === "closing" || window.state === "closed") {
      throw new Error(
        `Window "${windowId}" cannot be raised from state "${window.state}".`,
      );
    }

    this.#zOrder.bringToFront(window.id);

    return this.#getWindow(window.id);
  }

  public getWindow(windowId: GenesisWindowId): GenesisWindow | undefined {
    return this.#windows.get(windowId);
  }

  public listWindows(): readonly GenesisWindow[] {
    return this.#windows.list();
  }

  public listSessionWindows(sessionId: ApplicationSessionId): readonly GenesisWindow[] {
    return this.#windows.listBySession(sessionId);
  }

  #transferFocus(
    previousWindow: GenesisWindow | undefined,
    nextWindow: GenesisWindow | undefined,
  ): void {
    const previousSessionId = previousWindow?.sessionId;

    const nextSessionId = nextWindow?.sessionId;

    if (previousSessionId === nextSessionId) {
      return;
    }

    if (previousSessionId !== undefined) {
      this.#applications.backgroundApplication(previousSessionId);
    }

    if (nextSessionId !== undefined) {
      this.#applications.foregroundApplication(nextSessionId);
    }
  }

  #getTopVisibleWindow(): GenesisWindow | undefined {
    return this.#getStackableWindows()
      .filter((window) => window.state === "visible")
      .reduce<GenesisWindow | undefined>((topWindow, window) => {
        if (topWindow === undefined || window.zIndex > topWindow.zIndex) {
          return window;
        }

        return topWindow;
      }, undefined);
  }

  #focusTopVisibleWindow(
    previousFocusedWindow: GenesisWindow,
  ): GenesisWindow | undefined {
    const topVisibleWindow = this.#getTopVisibleWindow();

    if (topVisibleWindow === undefined) {
      this.#transferFocus(previousFocusedWindow, undefined);

      return undefined;
    }

    return this.#focusWindow(topVisibleWindow.id, previousFocusedWindow);
  }

  #getWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#windows.get(windowId);

    if (window === undefined) {
      throw new WindowNotFoundError(windowId);
    }

    return window;
  }

  #getStackableWindows(): readonly GenesisWindow[] {
    return this.#windows
      .list()
      .filter((window) => window.state !== "closing" && window.state !== "closed");
  }
}
