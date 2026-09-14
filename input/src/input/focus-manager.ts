import {
  FocusTargetAlreadyRegisteredError,
  FocusTargetNotRegisteredError,
} from "../errors/focus-errors.js";
import type {
  FocusChangeReason,
  FocusManagerEvent,
  FocusManagerEventListener,
} from "./focus-events.js";
import {
  createFocusState,
  EMPTY_FOCUS_STATE,
  type FocusState,
  type FocusTargetId,
} from "./focus-state.js";

export interface FocusManagerDependencies {
  readonly onEvent?: FocusManagerEventListener;
}

export class FocusManager {
  readonly #targets = new Set<FocusTargetId>();

  readonly #history: FocusTargetId[] = [];

  readonly #onEvent: FocusManagerEventListener | undefined;

  #state: FocusState = EMPTY_FOCUS_STATE;

  public constructor(dependencies: FocusManagerDependencies = {}) {
    this.#onEvent = dependencies.onEvent;
  }

  public get state(): FocusState {
    return this.#state;
  }

  public get targetCount(): number {
    return this.#targets.size;
  }

  public registerTarget(targetId: FocusTargetId): void {
    if (this.#targets.has(targetId)) {
      throw new FocusTargetAlreadyRegisteredError(targetId);
    }

    this.#targets.add(targetId);

    this.#emit({
      type: "focus-target-registered",

      targetId,
    });
  }

  public removeTarget(targetId: FocusTargetId): void {
    this.#requireTarget(targetId);

    this.#targets.delete(targetId);

    this.#removeFromHistory(targetId);

    this.#emit({
      type: "focus-target-removed",

      targetId,
    });

    const previousState = this.#state;

    const keyboardWasRemoved = previousState.keyboardFocus === targetId;

    const pointerWasRemoved = previousState.pointerFocus === targetId;

    const activeWasRemoved = previousState.activeWindow === targetId;

    if (!keyboardWasRemoved && !pointerWasRemoved && !activeWasRemoved) {
      return;
    }

    const restoredTarget =
      keyboardWasRemoved || activeWasRemoved
        ? this.#findRestorableTarget()
        : previousState.keyboardFocus;

    const nextState = createFocusState({
      keyboardFocus: keyboardWasRemoved ? restoredTarget : previousState.keyboardFocus,

      pointerFocus: pointerWasRemoved ? null : previousState.pointerFocus,

      activeWindow: activeWasRemoved ? restoredTarget : previousState.activeWindow,
    });

    this.#commitState(nextState, "target-removed");
  }

  public hasTarget(targetId: FocusTargetId): boolean {
    return this.#targets.has(targetId);
  }

  public listTargets(): readonly FocusTargetId[] {
    return Object.freeze([...this.#targets]);
  }

  public focusKeyboard(
    targetId: FocusTargetId,
    reason: FocusChangeReason = "programmatic",
  ): void {
    this.#requireTarget(targetId);

    this.#recordHistory(targetId);

    this.#commitState(
      createFocusState({
        keyboardFocus: targetId,

        pointerFocus: this.#state.pointerFocus,

        activeWindow: targetId,
      }),
      reason,
    );
  }

  public focusPointer(
    targetId: FocusTargetId,
    reason: FocusChangeReason = "pointer",
  ): void {
    this.#requireTarget(targetId);

    this.#commitState(
      createFocusState({
        keyboardFocus: this.#state.keyboardFocus,

        pointerFocus: targetId,

        activeWindow: this.#state.activeWindow,
      }),
      reason,
    );
  }

  public activate(
    targetId: FocusTargetId,
    reason: FocusChangeReason = "programmatic",
  ): void {
    this.#requireTarget(targetId);

    this.#recordHistory(targetId);

    this.#commitState(
      createFocusState({
        keyboardFocus: this.#state.keyboardFocus,

        pointerFocus: this.#state.pointerFocus,

        activeWindow: targetId,
      }),
      reason,
    );
  }

  public clearKeyboardFocus(reason: FocusChangeReason = "clear"): void {
    this.#commitState(
      createFocusState({
        keyboardFocus: null,

        pointerFocus: this.#state.pointerFocus,

        activeWindow: this.#state.activeWindow,
      }),
      reason,
    );
  }

  public clearPointerFocus(reason: FocusChangeReason = "clear"): void {
    this.#commitState(
      createFocusState({
        keyboardFocus: this.#state.keyboardFocus,

        pointerFocus: null,

        activeWindow: this.#state.activeWindow,
      }),
      reason,
    );
  }

  public clearAll(reason: FocusChangeReason = "clear"): void {
    this.#commitState(EMPTY_FOCUS_STATE, reason);
  }

  public restorePreviousFocus(): FocusTargetId | null {
    const targetId = this.#findRestorableTarget();

    if (targetId === null) {
      this.clearKeyboardFocus("restore");

      return null;
    }

    this.focusKeyboard(targetId, "restore");

    return targetId;
  }

  public getHistory(): readonly FocusTargetId[] {
    return Object.freeze([...this.#history]);
  }

  #commitState(nextState: FocusState, reason: FocusChangeReason): void {
    const previousState = this.#state;

    if (this.#statesEqual(previousState, nextState)) {
      return;
    }

    this.#state = nextState;

    if (previousState.keyboardFocus !== nextState.keyboardFocus) {
      this.#emit({
        type: "keyboard-focus-changed",

        previousTargetId: previousState.keyboardFocus,

        targetId: nextState.keyboardFocus,

        reason,
      });
    }

    if (previousState.pointerFocus !== nextState.pointerFocus) {
      this.#emit({
        type: "pointer-focus-changed",

        previousTargetId: previousState.pointerFocus,

        targetId: nextState.pointerFocus,

        reason,
      });
    }

    if (previousState.activeWindow !== nextState.activeWindow) {
      this.#emit({
        type: "active-window-changed",

        previousTargetId: previousState.activeWindow,

        targetId: nextState.activeWindow,

        reason,
      });
    }

    this.#emit({
      type: "focus-state-changed",

      previousState,

      state: nextState,

      reason,
    });
  }

  #recordHistory(targetId: FocusTargetId): void {
    this.#removeFromHistory(targetId);

    this.#history.push(targetId);
  }

  #removeFromHistory(targetId: FocusTargetId): void {
    let index = this.#history.indexOf(targetId);

    while (index !== -1) {
      this.#history.splice(index, 1);

      index = this.#history.indexOf(targetId);
    }
  }

  #findRestorableTarget(): FocusTargetId | null {
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      const targetId = this.#history[index];

      if (
        targetId !== undefined &&
        this.#targets.has(targetId) &&
        targetId !== this.#state.keyboardFocus
      ) {
        return targetId;
      }
    }

    return null;
  }

  #requireTarget(targetId: FocusTargetId): void {
    if (!this.#targets.has(targetId)) {
      throw new FocusTargetNotRegisteredError(targetId);
    }
  }

  #statesEqual(left: FocusState, right: FocusState): boolean {
    return (
      left.keyboardFocus === right.keyboardFocus &&
      left.pointerFocus === right.pointerFocus &&
      left.activeWindow === right.activeWindow
    );
  }

  #emit(event: FocusManagerEvent): void {
    this.#onEvent?.(event);
  }
}
