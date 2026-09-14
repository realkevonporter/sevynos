import {
  WindowDragAlreadyActiveError,
  WindowDragMoveError,
  WindowDragNotFoundError,
  WindowDragPointerCaptureError,
  WindowDragWindowNotFoundError,
} from "../errors/window-drag-errors.js";
import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";
import type { PointerCaptureManager } from "./pointer-capture-manager.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type {
  WindowDragControllerEvent,
  WindowDragControllerEventListener,
  WindowDragEndReason,
} from "./window-drag-events.js";
import { ActiveWindowDrag } from "./window-drag-state.js";
import type { WindowDragWindowController } from "./window-drag-window-controller.js";

export interface WindowDragControllerDependencies {
  readonly windows: WindowDragWindowController;

  readonly pointerCaptureManager: PointerCaptureManager;

  readonly now: () => number;

  readonly onEvent?: WindowDragControllerEventListener;
}

export interface WindowDragMoveResult {
  readonly drag: ActiveWindowDrag;

  readonly window: GenesisWindow;

  readonly deltaX: number;

  readonly deltaY: number;
}

export class WindowDragController {
  readonly #windows: WindowDragWindowController;

  readonly #pointerCaptureManager: PointerCaptureManager;

  readonly #now: () => number;

  readonly #onEvent: WindowDragControllerEventListener | undefined;

  readonly #activeDrags = new Map<number, ActiveWindowDrag>();

  public constructor(dependencies: WindowDragControllerDependencies) {
    this.#windows = dependencies.windows;

    this.#pointerCaptureManager = dependencies.pointerCaptureManager;

    this.#now = dependencies.now;

    this.#onEvent = dependencies.onEvent;
  }

  public get activeDragCount(): number {
    return this.#activeDrags.size;
  }

  public beginDrag(
    windowId: GenesisWindowId,
    event: PointerInputEvent,
  ): ActiveWindowDrag {
    if (event.type !== "pointer-down") {
      throw new Error(
        `Window drag must begin with a pointer-down event, not "${event.type}".`,
      );
    }

    const existing = this.#activeDrags.get(event.pointerId);

    if (existing !== undefined) {
      throw new WindowDragAlreadyActiveError(event.pointerId, existing.windowId);
    }

    const window = this.#windows.getWindow(windowId);

    if (window === undefined) {
      throw new WindowDragWindowNotFoundError(windowId);
    }

    const drag = new ActiveWindowDrag({
      pointerId: event.pointerId,

      windowId,

      initialPointerPosition: event.position,

      initialWindowBounds: window.bounds,

      startedAt: this.#now(),
    });

    try {
      this.#pointerCaptureManager.capture(event.pointerId, windowId);
    } catch (cause: unknown) {
      const error = new WindowDragPointerCaptureError(event.pointerId, windowId, cause);

      this.#emit({
        type: "window-drag-rejected",

        pointerId: event.pointerId,

        windowId,

        event,

        error,
      });

      throw error;
    }

    this.#activeDrags.set(event.pointerId, drag);

    this.#emit({
      type: "window-drag-started",

      drag,

      event,
    });

    return drag;
  }

  public move(event: PointerInputEvent): WindowDragMoveResult {
    if (event.type !== "pointer-move") {
      throw new Error(
        `Window drag movement requires a pointer-move event, not "${event.type}".`,
      );
    }

    const drag = this.requireActiveDrag(event.pointerId);

    const deltaX = event.position.x - drag.initialPointerPosition.x;

    const deltaY = event.position.y - drag.initialPointerPosition.y;

    let window: GenesisWindow;

    try {
      window = this.#windows.moveWindow({
        windowId: drag.windowId,

        x: drag.initialWindowBounds.x + deltaX,

        y: drag.initialWindowBounds.y + deltaY,
      });
    } catch (cause: unknown) {
      const error = new WindowDragMoveError(event.pointerId, drag.windowId, cause);

      this.#emit({
        type: "window-drag-rejected",

        pointerId: event.pointerId,

        windowId: drag.windowId,

        event,

        error,
      });

      throw error;
    }

    const result: WindowDragMoveResult = Object.freeze({
      drag,

      window,

      deltaX,

      deltaY,
    });

    this.#emit({
      type: "window-drag-moved",

      drag,

      event,

      window,

      deltaX,

      deltaY,
    });

    return result;
  }

  public endDrag(
    pointerId: number,
    reason: WindowDragEndReason = "explicit",
    event?: PointerInputEvent,
  ): ActiveWindowDrag {
    const drag = this.requireActiveDrag(pointerId);

    this.#activeDrags.delete(pointerId);

    if (this.#pointerCaptureManager.has(pointerId)) {
      this.#pointerCaptureManager.release(
        pointerId,
        reason === "pointer-up"
          ? "pointer-up"
          : reason === "pointer-cancel"
            ? "pointer-cancel"
            : "explicit",
      );
    }

    this.#emit({
      type: "window-drag-ended",

      drag,

      event,

      reason,
    });

    return drag;
  }

  public handlePointerEvent(
    event: PointerInputEvent,
  ): WindowDragMoveResult | ActiveWindowDrag | undefined {
    if (!this.#activeDrags.has(event.pointerId)) {
      return undefined;
    }

    switch (event.type) {
      case "pointer-move":
        return this.move(event);

      case "pointer-up":
        return this.endDrag(event.pointerId, "pointer-up", event);

      case "pointer-cancel":
        return this.endDrag(event.pointerId, "pointer-cancel", event);

      case "pointer-down":
        return undefined;
    }
  }

  public getActiveDrag(pointerId: number): ActiveWindowDrag | undefined {
    return this.#activeDrags.get(pointerId);
  }

  public requireActiveDrag(pointerId: number): ActiveWindowDrag {
    const drag = this.getActiveDrag(pointerId);

    if (drag === undefined) {
      throw new WindowDragNotFoundError(pointerId);
    }

    return drag;
  }

  public isDragging(pointerId: number): boolean {
    return this.#activeDrags.has(pointerId);
  }

  public cancelAll(): readonly ActiveWindowDrag[] {
    const drags = Object.freeze([...this.#activeDrags.values()]);

    for (const drag of drags) {
      this.endDrag(drag.pointerId, "explicit");
    }

    return drags;
  }

  #emit(event: WindowDragControllerEvent): void {
    this.#onEvent?.(event);
  }
}
