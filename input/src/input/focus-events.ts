import type { FocusState, FocusTargetId } from "./focus-state.js";

export type FocusChangeReason =
  "programmatic" | "pointer" | "keyboard" | "target-removed" | "restore" | "clear";

export interface FocusTargetRegisteredEvent {
  readonly type: "focus-target-registered";

  readonly targetId: FocusTargetId;
}

export interface FocusTargetRemovedEvent {
  readonly type: "focus-target-removed";

  readonly targetId: FocusTargetId;
}

export interface KeyboardFocusChangedEvent {
  readonly type: "keyboard-focus-changed";

  readonly previousTargetId: FocusTargetId | null;

  readonly targetId: FocusTargetId | null;

  readonly reason: FocusChangeReason;
}

export interface PointerFocusChangedEvent {
  readonly type: "pointer-focus-changed";

  readonly previousTargetId: FocusTargetId | null;

  readonly targetId: FocusTargetId | null;

  readonly reason: FocusChangeReason;
}

export interface ActiveWindowChangedEvent {
  readonly type: "active-window-changed";

  readonly previousTargetId: FocusTargetId | null;

  readonly targetId: FocusTargetId | null;

  readonly reason: FocusChangeReason;
}

export interface FocusStateChangedEvent {
  readonly type: "focus-state-changed";

  readonly previousState: FocusState;

  readonly state: FocusState;

  readonly reason: FocusChangeReason;
}

export type FocusManagerEvent =
  | FocusTargetRegisteredEvent
  | FocusTargetRemovedEvent
  | KeyboardFocusChangedEvent
  | PointerFocusChangedEvent
  | ActiveWindowChangedEvent
  | FocusStateChangedEvent;

export type FocusManagerEventListener = (event: FocusManagerEvent) => void;
