/**
 * Upstream React Native ActionSheetIOS implementation.
 * Provides real in-shell modal action sheets instead of silent cancels.
 */

export interface ActionSheetIOSOptions {
  readonly title?: string;
  readonly message?: string;
  readonly options: readonly string[];
  readonly cancelButtonIndex?: number;
  readonly destructiveButtonIndex?: number | readonly number[];
  readonly disabledButtonIndices?: readonly number[];
  readonly tintColor?: string;
  readonly cancelButtonTintColor?: string;
  readonly anchor?: number;
  readonly userInterfaceStyle?: "light" | "dark";
}

export interface ActiveActionSheet {
  readonly id: string;
  readonly options: ActionSheetIOSOptions;
  select(buttonIndex: number): void;
  cancel(): void;
}

export type ActionSheetListener = (sheet: ActiveActionSheet | null) => void;

let currentActiveSheet: ActiveActionSheet | null = null;
const listeners = new Set<ActionSheetListener>();

export function getActiveActionSheet(): ActiveActionSheet | null {
  return currentActiveSheet;
}

export function subscribeActionSheet(listener: ActionSheetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener(currentActiveSheet);
    } catch {
      // Ignore listener errors
    }
  }
}

export function dismissActionSheet(): void {
  if (currentActiveSheet !== null) {
    currentActiveSheet.cancel();
  }
}

export const ActionSheetIOS = Object.freeze({
  showActionSheetWithOptions: (
    options: ActionSheetIOSOptions,
    callback: (buttonIndex: number) => void,
  ): void => {
    if (!Array.isArray(options.options) || options.options.length === 0) {
      return;
    }

    const id = `action-sheet-${String(Date.now())}`;
    let settled = false;

    const select = (buttonIndex: number): void => {
      if (settled) return;
      settled = true;
      currentActiveSheet = null;
      notifyListeners();
      callback(buttonIndex);
    };

    const cancel = (): void => {
      const cancelIndex =
        options.cancelButtonIndex ?? Math.max(0, options.options.length - 1);
      select(cancelIndex);
    };

    currentActiveSheet = Object.freeze({
      id,
      options: Object.freeze({
        ...options,
        options: Object.freeze(options.options.slice()),
      }),
      select,
      cancel,
    });

    notifyListeners();
  },

  showShareActionSheetWithOptions: (
    _options: unknown,
    failureCallback: (error: Error) => void,
    _successCallback: (completed: boolean, activityType?: string) => void,
  ): void => {
    void _successCallback;
    failureCallback(new Error("Share sheets are unavailable on this host."));
  },

  getActiveActionSheet,
  dismissActionSheet,
});
