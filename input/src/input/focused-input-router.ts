import {
  FocusedInputTargetAlreadyRegisteredError,
  FocusedInputTargetHandlerError,
  FocusedInputTargetNotFoundError,
} from "../errors/focused-input-router-errors.js";
import type {
  FocusedInputRouteKind,
  FocusedInputRouterEvent,
  FocusedInputRouterEventListener,
} from "./focused-input-router-events.js";
import type { FocusManager } from "./focus-manager.js";
import type { FocusTargetId } from "./focus-state.js";
import type { InputDispatcher } from "./input-dispatcher.js";
import type { SevynInputEvent } from "./input-event.js";
import type { PointerCaptureManager } from "./pointer-capture-manager.js";
import type { PointerInputEvent } from "./pointer-input-event.js";

export type FocusedInputTargetHandler = (event: SevynInputEvent) => void;

export interface FocusedInputTargetRegistration {
  readonly targetId: FocusTargetId;

  readonly handler: FocusedInputTargetHandler;
}

export interface FocusedInputRouterDependencies {
  readonly dispatcher: InputDispatcher;

  readonly focusManager: FocusManager;

  readonly pointerCaptureManager: PointerCaptureManager;

  readonly listenerId?: string;

  readonly onEvent?: FocusedInputRouterEventListener;
}

export interface FocusedInputRouteResult {
  readonly event: SevynInputEvent;

  readonly routeKind: FocusedInputRouteKind;

  readonly targetId: FocusTargetId | null;

  readonly delivered: boolean;
}

const DEFAULT_LISTENER_ID = "sevynos:focused-input-router";

export class FocusedInputRouter {
  readonly #dispatcher: InputDispatcher;

  readonly #focusManager: FocusManager;

  readonly #pointerCaptureManager: PointerCaptureManager;

  readonly #listenerId: string;

  readonly #onEvent: FocusedInputRouterEventListener | undefined;

  readonly #targets = new Map<FocusTargetId, FocusedInputTargetHandler>();

  #connected = false;

  public constructor(dependencies: FocusedInputRouterDependencies) {
    this.#dispatcher = dependencies.dispatcher;

    this.#focusManager = dependencies.focusManager;

    this.#pointerCaptureManager = dependencies.pointerCaptureManager;

    this.#listenerId = dependencies.listenerId ?? DEFAULT_LISTENER_ID;

    this.#onEvent = dependencies.onEvent;
  }

  public get connected(): boolean {
    return this.#connected;
  }

  public get targetCount(): number {
    return this.#targets.size;
  }

  public connect(): void {
    if (this.#connected) {
      return;
    }

    this.#dispatcher.addListener({
      id: this.#listenerId,

      listener: (event) => {
        this.route(event);
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

  public registerTarget(registration: FocusedInputTargetRegistration): void {
    const { targetId, handler } = registration;

    if (this.#targets.has(targetId)) {
      throw new FocusedInputTargetAlreadyRegisteredError(targetId);
    }

    this.#targets.set(targetId, handler);

    this.#emit({
      type: "focused-input-target-registered",

      targetId,
    });
  }

  public removeTarget(targetId: FocusTargetId): void {
    if (!this.#targets.delete(targetId)) {
      throw new FocusedInputTargetNotFoundError(targetId);
    }

    /*
     * A removed target must not retain any
     * pointer captures.
     */
    this.#pointerCaptureManager.releaseForTarget(targetId);

    this.#emit({
      type: "focused-input-target-removed",

      targetId,
    });
  }

  public hasTarget(targetId: FocusTargetId): boolean {
    return this.#targets.has(targetId);
  }

  public listTargetIds(): readonly FocusTargetId[] {
    return Object.freeze([...this.#targets.keys()]);
  }

  public clearTargets(): void {
    const targetIds = [...this.#targets.keys()];

    this.#targets.clear();

    for (const targetId of targetIds) {
      this.#pointerCaptureManager.releaseForTarget(targetId);

      this.#emit({
        type: "focused-input-target-removed",

        targetId,
      });
    }
  }

  public route(event: SevynInputEvent): FocusedInputRouteResult {
    const routeKind = this.#resolveRouteKind(event);

    const targetId = this.#resolveTarget(event, routeKind);

    /*
     * Pointer-up and pointer-cancel must release capture
     * only after the final event has been routed.
     */
    try {
      return this.#routeToTarget(event, routeKind, targetId);
    } finally {
      if (this.#isPointerEvent(event)) {
        this.#pointerCaptureManager.handlePointerEvent(event);
      }
    }
  }

  #routeToTarget(
    event: SevynInputEvent,
    routeKind: FocusedInputRouteKind,
    targetId: FocusTargetId | null,
  ): FocusedInputRouteResult {
    if (targetId === null) {
      this.#emit({
        type: "focused-input-route-unrouted",

        event,

        routeKind,

        targetId: null,

        reason: "no-focused-target",
      });

      return this.#createResult({
        event,

        routeKind,

        targetId: null,

        delivered: false,
      });
    }

    const handler = this.#targets.get(targetId);

    if (handler === undefined) {
      this.#emit({
        type: "focused-input-route-unrouted",

        event,

        routeKind,

        targetId,

        reason: "target-handler-not-registered",
      });

      return this.#createResult({
        event,

        routeKind,

        targetId,

        delivered: false,
      });
    }

    this.#emit({
      type: "focused-input-route-started",

      event,

      routeKind,

      targetId,
    });

    try {
      handler(event);
    } catch (cause: unknown) {
      const error = new FocusedInputTargetHandlerError(targetId, cause);

      this.#emit({
        type: "focused-input-route-failed",

        event,

        routeKind,

        targetId,

        error,
      });

      throw error;
    }

    this.#emit({
      type: "focused-input-route-completed",

      event,

      routeKind,

      targetId,
    });

    return this.#createResult({
      event,

      routeKind,

      targetId,

      delivered: true,
    });
  }

  #resolveTarget(
    event: SevynInputEvent,
    routeKind: FocusedInputRouteKind,
  ): FocusTargetId | null {
    if (routeKind === "keyboard") {
      return this.#focusManager.state.keyboardFocus;
    }

    if (this.#isPointerEvent(event)) {
      const capture = this.#pointerCaptureManager.get(event.pointerId);

      if (capture !== undefined) {
        return capture.targetId;
      }
    }

    return this.#focusManager.state.pointerFocus;
  }

  #resolveRouteKind(event: SevynInputEvent): FocusedInputRouteKind {
    switch (event.type) {
      case "key-down":
      case "key-up":
        return "keyboard";

      case "pointer-move":
      case "pointer-down":
      case "pointer-up":
      case "pointer-cancel":
      case "wheel":
      case "touch-start":
      case "touch-move":
      case "touch-end":
      case "touch-cancel":
        return "pointer";
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

  #createResult(result: FocusedInputRouteResult): FocusedInputRouteResult {
    return Object.freeze({
      event: result.event,

      routeKind: result.routeKind,

      targetId: result.targetId,

      delivered: result.delivered,
    });
  }

  #emit(event: FocusedInputRouterEvent): void {
    this.#onEvent?.(event);
  }
}
