import type { GenesisWindow, GenesisWindowId, WindowBounds } from "@sevynos/graphics";
import type { PointerCaptureManager } from "./pointer-capture-manager.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import {
  resizesFromBottom,
  resizesFromLeft,
  resizesFromRight,
  resizesFromTop,
  type WindowResizeEdge,
} from "./window-resize-edge.js";
import { ActiveWindowResize } from "./window-resize-state.js";
import type { WindowResizeWindowController } from "./window-resize-window-controller.js";

export interface WindowResizeControllerDependencies {
  readonly windows: WindowResizeWindowController;

  readonly pointerCaptureManager: PointerCaptureManager;

  readonly now: () => number;

  readonly minimumWidth?: number;

  readonly minimumHeight?: number;
}

export interface WindowResizeResult {
  readonly resize: ActiveWindowResize;

  readonly window: GenesisWindow;

  readonly bounds: WindowBounds;

  readonly deltaX: number;

  readonly deltaY: number;
}

export class WindowResizeController {
  readonly #windows: WindowResizeWindowController;

  readonly #pointerCaptureManager: PointerCaptureManager;

  readonly #now: () => number;

  readonly #minimumWidth: number;

  readonly #minimumHeight: number;

  readonly #activeResizes = new Map<number, ActiveWindowResize>();

  public constructor(dependencies: WindowResizeControllerDependencies) {
    this.#windows = dependencies.windows;

    this.#pointerCaptureManager = dependencies.pointerCaptureManager;

    this.#now = dependencies.now;

    this.#minimumWidth = dependencies.minimumWidth ?? 320;

    this.#minimumHeight = dependencies.minimumHeight ?? 200;
  }

  public get activeResizeCount(): number {
    return this.#activeResizes.size;
  }

  public beginResize(
    windowId: GenesisWindowId,
    edge: WindowResizeEdge,
    event: PointerInputEvent,
  ): ActiveWindowResize {
    if (event.type !== "pointer-down") {
      throw new Error(
        `Window resize must begin with a pointer-down event, not "${event.type}".`,
      );
    }

    if (this.#activeResizes.has(event.pointerId)) {
      throw new Error(
        `Pointer "${String(event.pointerId)}" is already resizing a window.`,
      );
    }

    const window = this.#windows.getWindow(windowId);

    if (window === undefined) {
      throw new Error(`Window "${windowId}" was not found while starting a resize.`);
    }

    this.#pointerCaptureManager.capture(event.pointerId, windowId);

    const resize = new ActiveWindowResize({
      pointerId: event.pointerId,

      windowId,

      edge,

      initialPointerPosition: event.position,

      initialWindowBounds: window.bounds,

      startedAt: this.#now(),
    });

    this.#activeResizes.set(event.pointerId, resize);

    return resize;
  }

  public resize(event: PointerInputEvent): WindowResizeResult {
    if (event.type !== "pointer-move") {
      throw new Error(
        `Window resizing requires a pointer-move event, not "${event.type}".`,
      );
    }

    const resize = this.requireActiveResize(event.pointerId);

    const deltaX = event.position.x - resize.initialPointerPosition.x;

    const deltaY = event.position.y - resize.initialPointerPosition.y;

    const bounds = this.#calculateBounds(resize, deltaX, deltaY);

    const window = this.#windows.resizeWindow({
      windowId: resize.windowId,

      bounds,

      minimumWidth: this.#minimumWidth,

      minimumHeight: this.#minimumHeight,
    });

    return Object.freeze({
      resize,
      window,
      bounds,
      deltaX,
      deltaY,
    });
  }

  public endResize(pointerId: number): ActiveWindowResize {
    const resize = this.requireActiveResize(pointerId);

    this.#activeResizes.delete(pointerId);

    if (this.#pointerCaptureManager.has(pointerId)) {
      this.#pointerCaptureManager.release(pointerId);
    }

    return resize;
  }

  public handlePointerEvent(
    event: PointerInputEvent,
  ): WindowResizeResult | ActiveWindowResize | undefined {
    if (!this.#activeResizes.has(event.pointerId)) {
      return undefined;
    }

    switch (event.type) {
      case "pointer-move":
        return this.resize(event);

      case "pointer-up":
      case "pointer-cancel":
        return this.endResize(event.pointerId);

      case "pointer-down":
        return undefined;
    }
  }

  public getActiveResize(pointerId: number): ActiveWindowResize | undefined {
    return this.#activeResizes.get(pointerId);
  }

  public requireActiveResize(pointerId: number): ActiveWindowResize {
    const resize = this.getActiveResize(pointerId);

    if (resize === undefined) {
      throw new Error(
        `No active window resize exists for pointer "${String(pointerId)}".`,
      );
    }

    return resize;
  }

  public cancelAll(): readonly ActiveWindowResize[] {
    const resizes = Object.freeze([...this.#activeResizes.values()]);

    for (const resize of resizes) {
      this.endResize(resize.pointerId);
    }

    return resizes;
  }

  #calculateBounds(
    resize: ActiveWindowResize,
    deltaX: number,
    deltaY: number,
  ): WindowBounds {
    const initial = resize.initialWindowBounds;

    let x = initial.x;

    let y = initial.y;

    let width = initial.width;

    let height = initial.height;

    if (resizesFromLeft(resize.edge)) {
      const proposedWidth = initial.width - deltaX;

      width = Math.max(this.#minimumWidth, proposedWidth);

      x = initial.x + initial.width - width;
    }

    if (resizesFromRight(resize.edge)) {
      width = Math.max(this.#minimumWidth, initial.width + deltaX);
    }

    if (resizesFromTop(resize.edge)) {
      const proposedHeight = initial.height - deltaY;

      height = Math.max(this.#minimumHeight, proposedHeight);

      y = initial.y + initial.height - height;
    }

    if (resizesFromBottom(resize.edge)) {
      height = Math.max(this.#minimumHeight, initial.height + deltaY);
    }

    return Object.freeze({
      x,
      y,
      width,
      height,
    });
  }
}
