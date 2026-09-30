import { createContext, useRef } from "react";
import { Appearance } from "./appearance.js";
import { AnimatedValue, AnimatedValueXY } from "./animated.js";
import { NativeEventEmitter, NativeModules } from "./native-modules.js";

export class EventEmitter<T extends Record<string, (...args: never[]) => void>> {
  readonly #events = new Map<keyof T, Set<T[keyof T]>>();
  addListener<K extends keyof T>(event: K, listener: T[K]): { remove: () => void } {
    const listeners = this.#events.get(event) ?? new Set<T[keyof T]>();
    listeners.add(listener);
    this.#events.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  }
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    for (const listener of this.#events.get(event) ?? []) listener(...args);
  }
  removeAllListeners(event?: keyof T): void {
    if (event === undefined) this.#events.clear();
    else this.#events.delete(event);
  }
}

export const DeviceEventEmitter = new NativeEventEmitter();
export const NativeAppEventEmitter = DeviceEventEmitter;

export { InteractionManager } from "./interaction-manager.js";
export {
  LayoutAnimation,
  getPendingLayoutAnimation,
  consumePendingLayoutAnimation,
  clearPendingLayoutAnimation,
  type LayoutAnimationConfig,
  type LayoutAnimationPropertyConfig,
  type LayoutAnimationType,
  type LayoutAnimationProperty,
  type LayoutAnimationCallback,
} from "./layout-animation.js";

export const Vibration = NativeModules.Vibration;
export const DeviceInfo = NativeModules.DeviceInfo;
export const I18nManager = NativeModules.I18nManager;
export const DevSettings = NativeModules.DevSettings;
export const DevMenu = NativeModules.DevSettings;
export const UIManager = NativeModules.UIManager;
export const Share = NativeModules.ShareModule;
export const PermissionsAndroid = NativeModules.PermissionsAndroid;

const settings = new Map<string, unknown>();
export const Settings = Object.freeze({
  get: (key: string) => settings.get(key),
  set: (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) settings.set(key, value);
  },
  watchKeys: (_keys: string | readonly string[], callback: () => void) => {
    void callback;
    return 0;
  },
  clearWatch: (watchId: number) => {
    void watchId;
  },
});

export { processColor } from "./process-color.js";
export const PlatformColor = (...names: string[]): string => names[0] ?? "transparent";
export const DynamicColorIOS = (colors: {
  readonly light: string;
  readonly dark: string;
  readonly highContrastLight?: string;
  readonly highContrastDark?: string;
}): string =>
  Appearance.getColorScheme() === "light"
    ? (colors.highContrastLight ?? colors.light)
    : (colors.highContrastDark ?? colors.dark);
export const findNodeHandle = (component: { id?: string } | null): string | null =>
  component?.id ?? null;
export const TurboModuleRegistry = Object.freeze({
  get: (name: string): unknown =>
    turboModules.get(name) ?? (NativeModules as Record<string, unknown>)[name] ?? null,
  getEnforcing: (name: string): unknown => {
    const module =
      turboModules.get(name) ?? (NativeModules as Record<string, unknown>)[name];
    if (module === undefined) throw new Error(`Native module ${name} is not registered.`);
    return module;
  },
  register: (name: string, module: unknown): (() => void) => {
    if (!name.trim()) throw new Error("TurboModule names cannot be empty.");
    turboModules.set(name, module);
    return () => {
      if (turboModules.get(name) === module) turboModules.delete(name);
    };
  },
  invalidate: (name?: string): void => {
    if (name === undefined) turboModules.clear();
    else turboModules.delete(name);
  },
});

const turboModules = new Map<string, unknown>();

/**
 * Systrace developer tracing utility.
 * In SevynOS runtimes, performance profiling is driven by Genesis engine tracing
 * and host diagnostics, so Systrace acts as a standard zero-overhead no-op.
 */
export const Systrace = Object.freeze({
  beginEvent: (name: string): void => {
    void name;
  },
  endEvent: (): void => undefined,
  beginAsyncEvent: (name: string): number => {
    void name;
    return 0;
  },
  endAsyncEvent: (name: string, cookie: number): void => {
    void name;
    void cookie;
  },
  counterEvent: (name: string, value: number): void => {
    void name;
    void value;
  },
});

/**
 * LogBox warning/error overlay.
 * In SevynOS, diagnostics and warnings are routed to console logs and system
 * diagnostic collectors rather than rendering intrusive UI popups over apps.
 */
export const LogBox = Object.freeze({
  ignoreLogs: (patterns: readonly (string | RegExp)[]): void => {
    void patterns;
  },
  ignoreAllLogs: (ignore?: boolean): void => {
    void ignore;
  },
  install: (): void => undefined,
  uninstall: (): void => undefined,
});

const linear = (value: number): number => value;
const easeIn =
  (power: number) =>
  (value: number): number =>
    Math.pow(value, power);
export const Easing = Object.freeze({
  step0: (value: number) => (value > 0 ? 1 : 0),
  step1: (value: number) => (value >= 1 ? 1 : 0),
  linear,
  ease: (value: number) => value * value * (3 - 2 * value),
  quad: easeIn(2),
  cubic: easeIn(3),
  poly: easeIn,
  sin: (value: number) => 1 - Math.cos((value * Math.PI) / 2),
  circle: (value: number) => 1 - Math.sqrt(1 - value * value),
  exp: (value: number) => (value === 0 ? 0 : Math.pow(2, 10 * (value - 1))),
  elastic:
    (bounciness = 1) =>
    (value: number) =>
      1 -
      Math.pow(Math.cos((value * Math.PI) / 2), 3) *
        Math.cos(value * bounciness * Math.PI),
  back:
    (amount = 1.70158) =>
    (value: number) =>
      value * value * ((amount + 1) * value - amount),
  bounce: (value: number) => {
    if (value < 1 / 2.75) return 7.5625 * value * value;
    if (value < 2 / 2.75) {
      const next = value - 1.5 / 2.75;
      return 7.5625 * next * next + 0.75;
    }
    if (value < 2.5 / 2.75) {
      const next = value - 2.25 / 2.75;
      return 7.5625 * next * next + 0.9375;
    }
    const next = value - 2.625 / 2.75;
    return 7.5625 * next * next + 0.984375;
  },
  bezier: (x1: number, y1: number, x2: number, y2: number) => (value: number) => {
    const inverse = 1 - value;
    void x1;
    void x2;
    return (
      3 * inverse * inverse * value * y1 + 3 * inverse * value * value * y2 + value ** 3
    );
  },
  in: (easing: (value: number) => number) => easing,
  out: (easing: (value: number) => number) => (value: number) => 1 - easing(1 - value),
  inOut: (easing: (value: number) => number) => (value: number) =>
    value < 0.5 ? easing(value * 2) / 2 : 1 - easing((1 - value) * 2) / 2,
});

export {
  ActionSheetIOS,
  getActiveActionSheet,
  dismissActionSheet,
  subscribeActionSheet,
  type ActionSheetIOSOptions,
  type ActiveActionSheet,
} from "./action-sheet.js";

export const ToastAndroid = Object.freeze({
  SHORT: 0,
  LONG: 1,
  TOP: 49,
  BOTTOM: 81,
  CENTER: 17,
  show: (message: string, _duration: number) => {
    void _duration;
    void Promise.resolve()
      .then(() => NativeModules.HardwareModules.notifications.schedule({ message }))
      .catch(() => undefined);
  },
  showWithGravity: (message: string, duration: number, _gravity: number) => {
    void duration;
    void _gravity;
    void Promise.resolve()
      .then(() => NativeModules.HardwareModules.notifications.schedule({ message }))
      .catch(() => undefined);
  },
  showWithGravityAndOffset: (
    message: string,
    duration: number,
    gravity: number,
    _xOffset: number,
    _yOffset: number,
  ) => {
    void duration;
    void gravity;
    void _xOffset;
    void _yOffset;
    void Promise.resolve()
      .then(() => NativeModules.HardwareModules.notifications.schedule({ message }))
      .catch(() => undefined);
  },
});

export const PanResponder = Object.freeze({
  create: (config: Record<string, ((...args: never[]) => unknown) | undefined>) => ({
    panHandlers: {
      onStartShouldSetResponder: config["onStartShouldSetPanResponder"],
      onMoveShouldSetResponder: config["onMoveShouldSetPanResponder"],
      onStartShouldSetResponderCapture: config["onStartShouldSetPanResponderCapture"],
      onMoveShouldSetResponderCapture: config["onMoveShouldSetPanResponderCapture"],
      onResponderGrant: config["onPanResponderGrant"],
      onResponderMove: config["onPanResponderMove"],
      onResponderRelease: config["onPanResponderRelease"],
      onResponderTerminate: config["onPanResponderTerminate"],
      onResponderTerminationRequest: config["onPanResponderTerminationRequest"],
    },
  }),
});

/**
 * PushNotificationIOS compatibility.
 * On SevynOS, system notifications are granted to system and sandboxed applications
 * by default through the SevynOS notification and hardware service layers.
 */
export const PushNotificationIOS = Object.freeze({
  addEventListener: (
    type: string,
    handler: (...args: unknown[]) => void,
  ): { remove: () => void } => {
    void type;
    void handler;
    return {
      remove: () => undefined,
    };
  },
  removeEventListener: (type: string, handler: (...args: unknown[]) => void): void => {
    void type;
    void handler;
  },
  requestPermissions: (
    permissions?: Record<string, boolean>,
  ): Promise<Record<string, boolean>> =>
    Promise.resolve({
      alert: permissions?.["alert"] ?? true,
      badge: permissions?.["badge"] ?? true,
      sound: permissions?.["sound"] ?? true,
    }),
  abandonPermissions: () => undefined,
  checkPermissions: (callback: (permissions: Record<string, boolean>) => void) => {
    callback({ alert: true, badge: true, sound: true });
  },
  getInitialNotification: () => Promise.resolve(null),
});

const callableModules = new Map<string, unknown>();
export function registerCallableModule(
  name: string,
  module: Record<string, unknown> | (() => unknown),
): void {
  callableModules.set(name, typeof module === "function" ? module() : module);
}

export const ReactNativeVersion = Object.freeze({
  major: 0,
  minor: 85,
  patch: 3,
  prerelease: null,
});
export const RootTagContext = createContext<number>(0);
export const unstable_TextAncestorContext = createContext<boolean>(false);
export const unstable_batchedUpdates = <T>(
  callback: (...args: never[]) => T,
  ...args: never[]
): T => callback(...args);
export function usePressability<T extends Record<string, unknown>>(config: T): T {
  return config;
}
export function useAnimatedValue(initialValue: number): AnimatedValue {
  const value = useRef<AnimatedValue | undefined>(undefined);
  value.current ??= new AnimatedValue(initialValue);
  return value.current;
}
export const useAnimatedValueXY = (initial: {
  x: number;
  y: number;
}): AnimatedValueXY => {
  const value = useRef<AnimatedValueXY | undefined>(undefined);
  value.current ??= new AnimatedValueXY(initial);
  return value.current;
};
export const useAnimatedColor = (
  initial: string,
): { getValue(): string; setValue(value: string): void } => {
  const value = useRef(initial);
  return {
    getValue: () => value.current,
    setValue: (next: string) => {
      value.current = next;
    },
  };
};
export const Networking = Object.freeze({
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
});
export const NativeDialogManagerAndroid = Object.freeze({ showAlert: () => undefined });
export const UTFSequence = Object.freeze({
  BOM: "\ufeff",
  BULLET: "\u2022",
  BULLET_SP: "\u00a0\u2022\u00a0",
  MDASH: "\u2014",
  MDASH_SP: "\u00a0\u2014\u00a0",
  MIDDOT: "\u00b7",
  MIDDOT_KATAKANA: "\u30fb",
  MIDDOT_SP: "\u00a0\u00b7\u00a0",
  NBSP: "\u00a0",
  NDASH: "\u2013",
  NDASH_SP: "\u00a0\u2013\u00a0",
  NEWLINE: "\n",
  PIZZA: "\ud83c\udf55",
  TRIANGLE_LEFT: "\u25c0",
  TRIANGLE_RIGHT: "\u25b6",
});
export const VirtualViewMode = Object.freeze({ Visible: 0, Prerender: 1, Hidden: 2 });

export type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

let globalErrorHandler: ErrorHandler = (error: unknown, isFatal?: boolean) => {
  if (isFatal) {
    console.error("Fatal Error:", error);
  } else {
    console.warn("Unhandled Error:", error);
  }
};

export const ErrorUtils = Object.freeze({
  setGlobalHandler(handler: ErrorHandler): void {
    globalErrorHandler = handler;
  },
  getGlobalHandler(): ErrorHandler {
    return globalErrorHandler;
  },
  reportError(error: unknown): void {
    globalErrorHandler(error, false);
  },
  reportFatalError(error: unknown): void {
    globalErrorHandler(error, true);
  },
});

if (typeof globalThis !== "undefined") {
  const g = globalThis as unknown as {
    ErrorUtils?: typeof ErrorUtils;
    __DEV__?: boolean;
  };
  g.ErrorUtils ??= ErrorUtils;
  g.__DEV__ ??= false;
}
