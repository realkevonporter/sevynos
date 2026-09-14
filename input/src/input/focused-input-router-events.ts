import type { SevynInputEvent } from "./input-event.js";
import type { FocusTargetId } from "./focus-state.js";

export type FocusedInputRouteKind = "keyboard" | "pointer";

export type FocusedInputUnroutedReason =
  "no-focused-target" | "target-handler-not-registered";

export interface FocusedInputTargetRegisteredEvent {
  readonly type: "focused-input-target-registered";

  readonly targetId: FocusTargetId;
}

export interface FocusedInputTargetRemovedEvent {
  readonly type: "focused-input-target-removed";

  readonly targetId: FocusTargetId;
}

export interface FocusedInputRouteStartedEvent {
  readonly type: "focused-input-route-started";

  readonly event: SevynInputEvent;

  readonly routeKind: FocusedInputRouteKind;

  readonly targetId: FocusTargetId;
}

export interface FocusedInputRouteCompletedEvent {
  readonly type: "focused-input-route-completed";

  readonly event: SevynInputEvent;

  readonly routeKind: FocusedInputRouteKind;

  readonly targetId: FocusTargetId;
}

export interface FocusedInputRouteUnroutedEvent {
  readonly type: "focused-input-route-unrouted";

  readonly event: SevynInputEvent;

  readonly routeKind: FocusedInputRouteKind;

  readonly targetId: FocusTargetId | null;

  readonly reason: FocusedInputUnroutedReason;
}

export interface FocusedInputRouteFailedEvent {
  readonly type: "focused-input-route-failed";

  readonly event: SevynInputEvent;

  readonly routeKind: FocusedInputRouteKind;

  readonly targetId: FocusTargetId;

  readonly error: Error;
}

export type FocusedInputRouterEvent =
  | FocusedInputTargetRegisteredEvent
  | FocusedInputTargetRemovedEvent
  | FocusedInputRouteStartedEvent
  | FocusedInputRouteCompletedEvent
  | FocusedInputRouteUnroutedEvent
  | FocusedInputRouteFailedEvent;

export type FocusedInputRouterEventListener = (event: FocusedInputRouterEvent) => void;
