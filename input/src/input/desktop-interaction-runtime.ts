import type { InputDispatcher } from "./input-dispatcher.js";
import type { SevynInputEvent } from "./input-event.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type {
  DesktopInteractionKind,
  DesktopInteractionRuntimeEvent,
  DesktopInteractionRuntimeEventListener,
} from "./desktop-interaction-runtime-events.js";
import type { ActiveWindowDrag } from "./window-drag-state.js";
import type { ActiveWindowResize } from "./window-resize-state.js";

export interface DesktopPointerFocusController {
  handlePointerEvent(event: PointerInputEvent): unknown;
}

export interface DesktopWindowDragRuntime {
  isDragging(pointerId: number): boolean;

  handlePointerEvent(event: PointerInputEvent): void;

  cancelAll(): readonly ActiveWindowDrag[];
}

export interface DesktopWindowResizeRuntime {
  isResizing(pointerId: number): boolean;

  handlePointerEvent(event: PointerInputEvent): void;

  cancelAll(): readonly ActiveWindowResize[];
}

export interface DesktopCursorController {
  handlePointerEvent(event: PointerInputEvent): unknown;
}

export interface DesktopInteractionRuntimeDependencies {
  readonly dispatcher: InputDispatcher;

  readonly pointerFocusController: DesktopPointerFocusController;

  readonly dragRuntime: DesktopWindowDragRuntime;

  readonly resizeRuntime: DesktopWindowResizeRuntime;

  readonly cursorRuntime: DesktopCursorController;

  readonly listenerId?: string;

  readonly onEvent?: DesktopInteractionRuntimeEventListener;
}

const DEFAULT_LISTENER_ID = "sevynos:desktop-interaction-runtime";

export class DesktopInteractionRuntime {
  readonly #dispatcher: InputDispatcher;

  readonly #pointerFocusController: DesktopPointerFocusController;

  readonly #dragRuntime: DesktopWindowDragRuntime;

  readonly #resizeRuntime: DesktopWindowResizeRuntime;

  readonly #cursorRuntime: DesktopCursorController;

  readonly #listenerId: string;

  readonly #onEvent: DesktopInteractionRuntimeEventListener | undefined;

  #connected = false;

  public constructor(dependencies: DesktopInteractionRuntimeDependencies) {
    this.#dispatcher = dependencies.dispatcher;

    this.#pointerFocusController = dependencies.pointerFocusController;

    this.#dragRuntime = dependencies.dragRuntime;

    this.#resizeRuntime = dependencies.resizeRuntime;

    this.#cursorRuntime = dependencies.cursorRuntime;

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
      type: "desktop-interaction-runtime-connected",
    });
  }

  public disconnect(): void {
    if (!this.#connected) {
      return;
    }

    this.#dispatcher.removeListener(this.#listenerId);

    this.#resizeRuntime.cancelAll();
    this.#dragRuntime.cancelAll();

    this.#connected = false;

    this.#emit({
      type: "desktop-interaction-runtime-disconnected",
    });
  }

  public handlePointerEvent(event: PointerInputEvent): DesktopInteractionKind {
    try {
      const interaction = this.#routePointerEvent(event);

      /*
       * Cursor state must update after routing because
       * the current event may begin or end a drag/resize.
       */
      this.#cursorRuntime.handlePointerEvent(event);

      this.#emit({
        type: "desktop-interaction-handled",

        event,

        interaction,
      });

      return interaction;
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      this.#emit({
        type: "desktop-interaction-failed",

        event,

        error: normalizedError,
      });

      throw normalizedError;
    }
  }

  #routePointerEvent(event: PointerInputEvent): DesktopInteractionKind {
    /*
     * Existing interactions retain ownership of their
     * pointer until pointer-up or pointer-cancel.
     *
     * Resize is checked first as the higher-priority
     * desktop interaction.
     */
    if (this.#resizeRuntime.isResizing(event.pointerId)) {
      this.#resizeRuntime.handlePointerEvent(event);

      if (event.type === "pointer-cancel") {
        this.#pointerFocusController.handlePointerEvent(event);
      }

      return "resize";
    }

    if (this.#dragRuntime.isDragging(event.pointerId)) {
      this.#dragRuntime.handlePointerEvent(event);

      if (event.type === "pointer-cancel") {
        this.#pointerFocusController.handlePointerEvent(event);
      }

      return "drag";
    }

    /*
     * Update hover and click-to-focus state before
     * attempting to begin a new desktop interaction.
     */
    this.#pointerFocusController.handlePointerEvent(event);

    if (event.type !== "pointer-down") {
      return "focus";
    }

    /*
     * Resize borders have priority over draggable
     * regions such as window title bars.
     */
    this.#resizeRuntime.handlePointerEvent(event);

    if (this.#resizeRuntime.isResizing(event.pointerId)) {
      return "resize";
    }

    this.#dragRuntime.handlePointerEvent(event);

    if (this.#dragRuntime.isDragging(event.pointerId)) {
      return "drag";
    }

    return "focus";
  }

  #isPointerEvent(event: SevynInputEvent): event is PointerInputEvent {
    return (
      event.type === "pointer-move" ||
      event.type === "pointer-down" ||
      event.type === "pointer-up" ||
      event.type === "pointer-cancel"
    );
  }

  #emit(event: DesktopInteractionRuntimeEvent): void {
    this.#onEvent?.(event);
  }
}
