export type FocusTargetId = string;

export interface FocusState {
  readonly keyboardFocus: FocusTargetId | null;

  readonly pointerFocus: FocusTargetId | null;

  readonly activeWindow: FocusTargetId | null;
}

export const EMPTY_FOCUS_STATE: FocusState = Object.freeze({
  keyboardFocus: null,

  pointerFocus: null,

  activeWindow: null,
});

export function createFocusState(state: FocusState): FocusState {
  return Object.freeze({
    keyboardFocus: state.keyboardFocus,

    pointerFocus: state.pointerFocus,

    activeWindow: state.activeWindow,
  });
}
