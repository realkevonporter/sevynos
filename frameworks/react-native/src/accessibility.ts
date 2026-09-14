import { getNativeAdapters } from "./native-adapter-contracts.js";

export interface AccessibilityState {
  readonly accessibilityServiceEnabled: boolean;
  readonly screenReaderEnabled: boolean;
  readonly boldTextEnabled: boolean;
  readonly grayscaleEnabled: boolean;
  readonly invertColorsEnabled: boolean;
  readonly reduceMotionEnabled: boolean;
  readonly reduceTransparencyEnabled: boolean;
}

const defaults: AccessibilityState = Object.freeze({
  accessibilityServiceEnabled: false,
  screenReaderEnabled: false,
  boldTextEnabled: false,
  grayscaleEnabled: false,
  invertColorsEnabled: false,
  reduceMotionEnabled: false,
  reduceTransparencyEnabled: false,
});
let current: AccessibilityState = defaults;
const eventProperty = Object.freeze({
  accessibilityServiceChanged: "accessibilityServiceEnabled",
  screenReaderChanged: "screenReaderEnabled",
  boldTextChanged: "boldTextEnabled",
  grayscaleChanged: "grayscaleEnabled",
  invertColorsChanged: "invertColorsEnabled",
  reduceMotionChanged: "reduceMotionEnabled",
  reduceTransparencyChanged: "reduceTransparencyEnabled",
} satisfies Record<string, keyof AccessibilityState>);
type AccessibilityEventName = keyof typeof eventProperty;
const listeners = new Map<AccessibilityEventName, Set<(value: boolean) => void>>();
let unsubscribeNative: (() => void) | undefined;

async function refresh(): Promise<AccessibilityState> {
  const adapter = getNativeAdapters().accessibility;
  if (adapter === undefined) return current;
  const next = Object.freeze(await adapter.getState());
  publish(next);
  return next;
}

function publish(next: AccessibilityState): void {
  const previous = current;
  current = next;
  for (const [eventName, property] of Object.entries(eventProperty) as [
    AccessibilityEventName,
    keyof AccessibilityState,
  ][]) {
    if (previous[property] === next[property]) continue;
    for (const listener of listeners.get(eventName) ?? []) listener(next[property]);
  }
}

function ensureNativeSubscription(): void {
  if (unsubscribeNative !== undefined) return;
  const adapter = getNativeAdapters().accessibility;
  if (adapter === undefined) return;
  unsubscribeNative = adapter.subscribe(() => {
    void refresh();
  });
}

function query(property: keyof AccessibilityState): Promise<boolean> {
  return refresh().then((state) => state[property]);
}

export const AccessibilityInfo = Object.freeze({
  isAccessibilityServiceEnabled: () => query("accessibilityServiceEnabled"),
  isScreenReaderEnabled: () => query("screenReaderEnabled"),
  isBoldTextEnabled: () => query("boldTextEnabled"),
  isGrayscaleEnabled: () => query("grayscaleEnabled"),
  isInvertColorsEnabled: () => query("invertColorsEnabled"),
  isReduceMotionEnabled: () => query("reduceMotionEnabled"),
  isReduceTransparencyEnabled: () => query("reduceTransparencyEnabled"),

  async getRecommendedTimeoutMillis(originalTimeout: number): Promise<number> {
    const state = await refresh();
    return state.screenReaderEnabled || state.accessibilityServiceEnabled
      ? originalTimeout * 2
      : originalTimeout;
  },

  addEventListener(
    eventName: AccessibilityEventName,
    handler: (value: boolean) => void,
  ): { remove: () => void } {
    let eventListeners = listeners.get(eventName);
    if (eventListeners === undefined) {
      eventListeners = new Set();
      listeners.set(eventName, eventListeners);
    }
    eventListeners.add(handler);
    ensureNativeSubscription();
    return {
      remove(): void {
        eventListeners.delete(handler);
        if ([...listeners.values()].every((entries) => entries.size === 0)) {
          unsubscribeNative?.();
          unsubscribeNative = undefined;
        }
      },
    };
  },

  announceForAccessibility(announcement: string): void {
    void getNativeAdapters().accessibility?.announce(announcement);
  },

  announceForAccessibilityWithOptions(
    announcement: string,
    options?: { readonly queue?: boolean },
  ): void {
    void options;
    void getNativeAdapters().accessibility?.announce(announcement);
  },

  setAccessibilityFocus(reactTag: number): void {
    void getNativeAdapters().accessibility?.setFocus?.(reactTag);
  },

  sendAccessibilityEvent(handle: unknown, eventType: string): void {
    if (typeof handle !== "number") return;
    void getNativeAdapters().accessibility?.sendEvent?.(handle, eventType);
  },

  _setState(next: Partial<AccessibilityState>): void {
    publish(Object.freeze({ ...current, ...next }));
  },
});
