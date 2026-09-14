import type { InputDispatcher } from "./input-dispatcher.js";
import type { SevynInputEvent } from "./input-event.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { WindowHitTester } from "./window-hit-tester.js";
import type { WindowResizeController } from "./window-resize-controller.js";
import type { WindowResizeEdgeDetector } from "./window-resize-edge-detector.js";
import type { WindowResizeEdge } from "./window-resize-edge.js";
import type {
  WindowResizeRuntimeEvent,
  WindowResizeRuntimeEventListener,
} from "./window-resize-runtime-events.js";
import type { ActiveWindowResize } from "./window-resize-state.js";

export interface WindowResizeRuntimeDependencies {
  readonly dispatcher: InputDispatcher;

  readonly hitTester: WindowHitTester;

  readonly edgeDetector: WindowResizeEdgeDetector;

  readonly resizeController: WindowResizeController;

  readonly listenerId?: string;

  readonly onEvent?: WindowResizeRuntimeEventListener;
}

const DEFAULT_LISTENER_ID = "sevynos:window-resize-runtime";

export class WindowResizeRuntime {
  readonly #dispatcher: InputDispatcher;

  readonly #hitTester: WindowHitTester;

  readonly #edgeDetector: WindowResizeEdgeDetector;

  readonly #resizeController: WindowResizeController;

  readonly #listenerId: string;

  readonly #onEvent: WindowResizeRuntimeEventListener | undefined;

  #connected = false;

  public constructor(dependencies: WindowResizeRuntimeDependencies) {
    this.#dispatcher = dependencies.dispatcher;

    this.#hitTester = dependencies.hitTester;

    this.#edgeDetector = dependencies.edgeDetector;

    this.#resizeController = dependencies.resizeController;

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
      type: "window-resize-runtime-connected",
    });
  }

  public disconnect(): void {
    if (!this.#connected) {
      return;
    }

    this.#dispatcher.removeListener(this.#listenerId);

    this.#resizeController.cancelAll();

    this.#connected = false;

    this.#emit({
      type: "window-resize-runtime-disconnected",
    });
  }

  public isResizing(pointerId: number): boolean {
    return this.#resizeController.getActiveResize(pointerId) !== undefined;
  }

  public cancelAll(): readonly ActiveWindowResize[] {
    return this.#resizeController.cancelAll();
  }

  public getResizeEdge(pointerId: number): WindowResizeEdge | undefined {
    return this.#resizeController.getActiveResize(pointerId)?.edge;
  }

  public handlePointerEvent(event: PointerInputEvent): void {
    try {
      const activeResize = this.#resizeController.getActiveResize(event.pointerId);

      if (activeResize !== undefined) {
        if (event.type !== "pointer-down") {
          this.#resizeController.handlePointerEvent(event);

          this.#emit({
            type: "window-resize-runtime-event-forwarded",

            event,

            resize: activeResize,
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
          type: "window-resize-runtime-ignored",

          event,

          windowId: null,

          reason: "no-window-hit",
        });

        return;
      }

      const edge = this.#edgeDetector.detect(event.position, hit.window.bounds);

      if (edge === undefined) {
        this.#emit({
          type: "window-resize-runtime-ignored",

          event,

          windowId: hit.windowId,

          reason: "not-resize-border",
        });

        return;
      }

      this.#emit({
        type: "window-resize-runtime-hit",

        event,

        hit,

        edge,
      });

      const resize = this.#resizeController.beginResize(hit.windowId, edge, event);

      this.#emit({
        type: "window-resize-runtime-started",

        event,

        resize,
      });
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      this.#emit({
        type: "window-resize-runtime-failed",

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

  #emit(event: WindowResizeRuntimeEvent): void {
    this.#onEvent?.(event);
  }
}
