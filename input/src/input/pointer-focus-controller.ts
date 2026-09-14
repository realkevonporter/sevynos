import type { FocusManager } from "./focus-manager.js";
import type { FocusTargetId } from "./focus-state.js";
import type { InputDispatcher } from "./input-dispatcher.js";
import { PointerFocusTargetNotRegisteredError } from "../errors/pointer-focus-controller-errors.js";
import type {
  PointerFocusControllerEvent,
  PointerFocusControllerEventListener,
} from "./pointer-focus-controller-events.js";
import type { PointerInputEvent } from "./pointer-input-event.js";
import type { SevynInputEvent } from "./input-event.js";
import type { WindowHitTester } from "./window-hit-tester.js";
import type { PointerWindowActivationController } from "./pointer-window-activation-controller.js";
import { PointerWindowActivationError } from "../errors/pointer-window-activation-error.js";

export interface PointerFocusControllerDependencies {
  readonly dispatcher: InputDispatcher;

  readonly focusManager: FocusManager;

  readonly hitTester: WindowHitTester;

  readonly windowController: PointerWindowActivationController;

  readonly listenerId?: string;

  readonly focusOnPointerDown?: boolean;

  readonly activateOnPointerDown?: boolean;

  readonly onEvent?: PointerFocusControllerEventListener;
}

export interface PointerFocusUpdateResult {
  readonly event: PointerInputEvent;

  readonly previousTargetId: FocusTargetId | null;

  readonly targetId: FocusTargetId | null;

  readonly hit: boolean;

  readonly activated: boolean;
}

const DEFAULT_LISTENER_ID = "sevynos:pointer-focus-controller";

export class PointerFocusController {
  readonly #dispatcher: InputDispatcher;

  readonly #focusManager: FocusManager;

  readonly #hitTester: WindowHitTester;

  readonly #listenerId: string;

  readonly #focusOnPointerDown: boolean;

  readonly #activateOnPointerDown: boolean;

  readonly #onEvent: PointerFocusControllerEventListener | undefined;

  readonly #windowController: PointerWindowActivationController;

  #connected = false;

  public constructor(dependencies: PointerFocusControllerDependencies) {
    this.#dispatcher = dependencies.dispatcher;

    this.#focusManager = dependencies.focusManager;

    this.#hitTester = dependencies.hitTester;

    this.#windowController = dependencies.windowController;

    this.#listenerId = dependencies.listenerId ?? DEFAULT_LISTENER_ID;

    this.#focusOnPointerDown = dependencies.focusOnPointerDown ?? true;

    this.#activateOnPointerDown = dependencies.activateOnPointerDown ?? true;

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
  }

  public disconnect(): void {
    if (!this.#connected) {
      return;
    }

    this.#dispatcher.removeListener(this.#listenerId);

    this.#connected = false;
  }

  public handlePointerEvent(event: PointerInputEvent): PointerFocusUpdateResult {
    const previousTargetId = this.#focusManager.state.pointerFocus;

    if (event.type === "pointer-cancel") {
      this.#focusManager.clearPointerFocus("pointer");

      return this.#createResult({
        event,

        previousTargetId,

        targetId: null,

        hit: false,

        activated: false,
      });
    }

    const hit = this.#hitTester.hitTest(event.position);

    if (hit === undefined) {
      this.#emit({
        type: "pointer-focus-miss",

        event,
      });

      this.#focusManager.clearPointerFocus("pointer");

      this.#emitFocusChange(event, previousTargetId, null);

      return this.#createResult({
        event,

        previousTargetId,

        targetId: null,

        hit: false,

        activated: false,
      });
    }

    const targetId: FocusTargetId = hit.windowId;

    this.#emit({
      type: "pointer-focus-hit",

      event,

      hit,
    });

    try {
      this.#assertRegisteredTarget(targetId);
    } catch (error: unknown) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));

      this.#emit({
        type: "pointer-focus-rejected",

        event,

        error: normalizedError,
      });

      throw normalizedError;
    }

    this.#focusManager.focusPointer(targetId, "pointer");

    this.#emitFocusChange(event, previousTargetId, targetId);

    let activated = false;

    if (event.type === "pointer-down") {
      if (this.#activateOnPointerDown) {
        try {
          this.#windowController.focusWindow(hit.window.id);
        } catch (cause: unknown) {
          const error = new PointerWindowActivationError(targetId, cause);

          this.#emit({
            type: "pointer-focus-rejected",

            event,

            error,
          });

          throw error;
        }

        this.#focusManager.activate(targetId, "pointer");

        activated = true;

        this.#emit({
          type: "pointer-focus-window-activated",

          event,

          targetId,
        });
      }

      if (this.#focusOnPointerDown) {
        this.#focusManager.focusKeyboard(targetId, "pointer");
      }
    }

    return this.#createResult({
      event,

      previousTargetId,

      targetId,

      hit: true,

      activated,
    });
  }

  #assertRegisteredTarget(targetId: FocusTargetId): void {
    if (!this.#focusManager.hasTarget(targetId)) {
      throw new PointerFocusTargetNotRegisteredError(targetId);
    }
  }

  #emitFocusChange(
    event: PointerInputEvent,
    previousTargetId: FocusTargetId | null,
    targetId: FocusTargetId | null,
  ): void {
    if (previousTargetId === targetId) {
      return;
    }

    this.#emit({
      type: "pointer-focus-updated",

      event,

      previousTargetId,

      targetId,
    });
  }

  #isPointerEvent(event: SevynInputEvent): event is PointerInputEvent {
    return (
      event.type === "pointer-move" ||
      event.type === "pointer-down" ||
      event.type === "pointer-up" ||
      event.type === "pointer-cancel"
    );
  }

  #createResult(result: PointerFocusUpdateResult): PointerFocusUpdateResult {
    return Object.freeze({
      event: result.event,

      previousTargetId: result.previousTargetId,

      targetId: result.targetId,

      hit: result.hit,

      activated: result.activated,
    });
  }

  #emit(event: PointerFocusControllerEvent): void {
    this.#onEvent?.(event);
  }
}
