import type { InputDispatcher } from "./input-dispatcher.js";
import type { SevynInputEvent } from "./input-event.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { WindowDragController } from "./window-drag-controller.js";
import type {
  WindowDragRuntimeEvent,
  WindowDragRuntimeEventListener,
} from "./window-drag-runtime-events.js";
import type { WindowHitTester } from "./window-hit-tester.js";
import type { WindowHitTestResult } from "./window-hit-test-result.js";
import type { ActiveWindowDrag } from "./window-drag-state.js";

export type WindowDragRegionPolicy = (
  event: PointerInputEvent,
  hit: WindowHitTestResult,
) => boolean;

export interface WindowDragRuntimeDependencies {
  readonly dispatcher: InputDispatcher;

  readonly hitTester: WindowHitTester;

  readonly dragController: WindowDragController;

  readonly isDraggableRegion: WindowDragRegionPolicy;

  readonly listenerId?: string;

  readonly onEvent?: WindowDragRuntimeEventListener;
}

const DEFAULT_LISTENER_ID = "sevynos:window-drag-runtime";

export class WindowDragRuntime {
  readonly #dispatcher: InputDispatcher;

  readonly #hitTester: WindowHitTester;

  readonly #dragController: WindowDragController;

  readonly #isDraggableRegion: WindowDragRegionPolicy;

  readonly #listenerId: string;

  readonly #onEvent: WindowDragRuntimeEventListener | undefined;

  #connected = false;

  public constructor(dependencies: WindowDragRuntimeDependencies) {
    this.#dispatcher = dependencies.dispatcher;

    this.#hitTester = dependencies.hitTester;

    this.#dragController = dependencies.dragController;

    this.#isDraggableRegion = dependencies.isDraggableRegion;

    this.#listenerId = dependencies.listenerId ?? DEFAULT_LISTENER_ID;

    this.#onEvent = dependencies.onEvent;
  }

  public get connected(): boolean {
    return this.#connected;
  }

  public connect(): void {
    if (this.#connected) {
      return;
    }

    this.#dispatcher.addListener({
      id: this.#listenerId,

      listener: (event) => {
        if (this.#isPointerEvent(event)) {
          this.handlePointerEvent(event);
        }
      },
    });

    this.#connected = true;

    this.#emit({
      type: "window-drag-runtime-connected",
    });
  }

  public disconnect(): void {
    if (!this.#connected) {
      return;
    }

    this.#dispatcher.removeListener(this.#listenerId);

    this.#dragController.cancelAll();

    this.#connected = false;

    this.#emit({
      type: "window-drag-runtime-disconnected",
    });
  }

  public isDragging(pointerId: number): boolean {
    return this.#dragController.isDragging(pointerId);
  }

  public cancelAll(): readonly ActiveWindowDrag[] {
    return this.#dragController.cancelAll();
  }

  public handlePointerEvent(event: PointerInputEvent): void {
    try {
      if (this.#dragController.isDragging(event.pointerId)) {
        const drag = this.#dragController.requireActiveDrag(event.pointerId);

        if (event.type !== "pointer-down") {
          this.#dragController.handlePointerEvent(event);

          this.#emit({
            type: "window-drag-runtime-event-forwarded",

            event,

            drag,
          });
        }

        return;
      }

      if (event.type !== "pointer-down") {
        return;
      }

      const hit = this.#hitTester.hitTest(event.position);

      if (hit === undefined) {
        this.#emit({
          type: "window-drag-runtime-ignored",

          event,

          windowId: null,

          reason: "no-window-hit",
        });

        return;
      }

      this.#emit({
        type: "window-drag-runtime-hit",

        event,

        hit,
      });

      if (!this.#isDraggableRegion(event, hit)) {
        this.#emit({
          type: "window-drag-runtime-ignored",

          event,

          windowId: hit.windowId,

          reason: "non-draggable-region",
        });

        return;
      }

      const drag = this.#dragController.beginDrag(hit.windowId, event);

      this.#emit({
        type: "window-drag-runtime-started",

        event,

        drag,
      });
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      this.#emit({
        type: "window-drag-runtime-failed",

        event,

        error: normalizedError,
      });

      throw normalizedError;
    }
  }

  #isPointerEvent(event: SevynInputEvent): event is PointerInputEvent {
    return (
      event.type === "pointer-move" ||
      event.type === "pointer-down" ||
      event.type === "pointer-up" ||
      event.type === "pointer-cancel"
    );
  }

  #emit(event: WindowDragRuntimeEvent): void {
    this.#onEvent?.(event);
  }
}
