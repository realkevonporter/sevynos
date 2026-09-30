/** SevynOS equivalents for the React Native NativeModules surface. */
import { AccessibilityInfo } from "./accessibility.js";
import { Appearance } from "./appearance.js";
import { PixelRatio } from "./pixel-ratio.js";
import { Platform, Dimensions } from "./stylesheet.js";
import { AppState, Linking } from "./utilities.js";
import { getNativeAdapters, requireNativeAdapter } from "./native-adapter-contracts.js";

type NetworkInfoState = Awaited<
  ReturnType<NonNullable<ReturnType<typeof getNativeAdapters>["networkInfo"]>["getState"]>
>;
const networkInfoListeners = new Set<(state: NetworkInfoState) => void>();
let unsubscribeNetworkInfo: (() => void) | undefined;
export const NetInfo = Object.freeze({
  fetch: async (): Promise<NetworkInfoState> =>
    getNativeAdapters().networkInfo?.getState() ?? {
      type: "unknown",
      isConnected: null,
      isInternetReachable: null,
    },
  addEventListener: (listener: (state: NetworkInfoState) => void) => {
    networkInfoListeners.add(listener);
    const adapter = getNativeAdapters().networkInfo;
    if (adapter !== undefined && unsubscribeNetworkInfo === undefined) {
      unsubscribeNetworkInfo = adapter.subscribe(() => {
        void adapter.getState().then((state) => {
          for (const active of networkInfoListeners) active(state);
        });
      });
    }
    void NetInfo.fetch().then(listener);
    return {
      remove: () => {
        networkInfoListeners.delete(listener);
        if (networkInfoListeners.size === 0) {
          unsubscribeNetworkInfo?.();
          unsubscribeNetworkInfo = undefined;
        }
      },
    };
  },
});

function createFallbackNativeModule(name: string): Record<string, unknown> {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (..._args: unknown[]) => {
        const callableResult: Record<string, unknown> = {
          remove: () => undefined,
          then: (resolve: (val: unknown) => void) => resolve(null),
          catch: () => callableResult,
        };
        return callableResult;
      };
    },
    has(target, prop) {
      if (typeof prop === "symbol") return Reflect.has(target, prop);
      return true;
    },
    construct(_target, _args) {
      const instance: Record<string, unknown> = {
        name,
        isAvailable: false,
        enabled: false,
        addListener: () => ({ remove: () => undefined }),
        removeListeners: () => undefined,
        removeAllListeners: () => undefined,
        getConstants: () => ({ isAvailable: false, enabled: false }),
        onAdEvent: () => ({ remove: () => undefined }),
      };
      return new Proxy(instance, handler);
    },
  };

  const Fallback = function (this: unknown) {
    const instance: Record<string, unknown> = {
      name,
      isAvailable: false,
      enabled: false,
      addListener: () => ({ remove: () => undefined }),
      removeListeners: () => undefined,
      removeAllListeners: () => undefined,
      getConstants: () => ({ isAvailable: false, enabled: false }),
      onAdEvent: () => ({ remove: () => undefined }),
    };
    return new Proxy(instance, handler);
  };

  try {
    Object.defineProperty(Fallback, "name", { value: name, configurable: true });
  } catch {
    // Ignore if not configurable
  }

  Object.assign(Fallback, {
    isAvailable: false,
    enabled: false,
    addListener: () => ({ remove: () => undefined }),
    removeListeners: () => undefined,
    removeAllListeners: () => undefined,
    getConstants: () => ({ isAvailable: false, enabled: false }),
    onAdEvent: () => ({ remove: () => undefined }),
  });

  return new Proxy(Fallback as unknown as Record<string, unknown>, handler);
}

const THIRD_PARTY_FALLBACK_MODULES = [
  "MLRNCameraModule",
  "MLRNMapViewModule",
  "MLRNLogModule",
  "MLRNGeoJSONSourceModule",
  "MLRNLocationModule",
  "MLRNVectorSourceModule",
  "MLRNNetworkModule",
  "MLRNOfflineModule",
  "MLRNStaticMapModule",
  "MLRNTransformRequestModule",
  "RNGoogleMobileAdsModule",
  "RNAppModule",
  "RNGoogleMobileAdsConsentModule",
  "RNGoogleMobileAdsAppOpenModule",
  "RNGoogleMobileAdsInterstitialModule",
  "RNGoogleMobileAdsRewardedModule",
  "RNGoogleMobileAdsRewardedInterstitialModule",
  "RNGoogleMobileAdsNativeModule",
  "NitroModules",
  "StripeSdk",
  "NativeWalletManager",
  "RNHapticFeedback",
  "VideoTrim",
] as const;

const fallbackModulesRecord = Object.fromEntries(
  THIRD_PARTY_FALLBACK_MODULES.map((name) => [name, createFallbackNativeModule(name)]),
);

export const NativeModules = Object.freeze({
  ...fallbackModulesRecord,
  AppState,
  PlatformConstants: Object.freeze({
    Version: "1",
    OS: "sevynos",
    isTesting: false,
  }),
  DeviceInfo: Object.freeze({
    getConstants: () =>
      Object.freeze({
        Dimensions: Object.freeze({
          window: Dimensions.get("window"),
          screen: Dimensions.get("screen"),
        }),
        localeIdentifier: "en_US",
        interfaceIdiom: "desktop",
      }),
  }),
  PixelRatio,
  Appearance,
  AccessibilityInfo,
  UIManager: Object.freeze({
    getViewManagerConfig: (_name?: string) => ({
      Commands: {},
      Constants: {},
    }),
    get: (_name: string, viewConfigProvider?: () => unknown) =>
      viewConfigProvider ? viewConfigProvider() : undefined,
    hasViewManagerConfig: (_name?: string) => true,
    dispatchViewManagerCommand: () => undefined,
    measure: (
      _node: unknown,
      callback: (
        x: number,
        y: number,
        width: number,
        height: number,
        pageX: number,
        pageY: number,
      ) => void,
    ): void => {
      // Stub: actual measurement requires host layout info.
      // Calls back with zeros; implement via native adapter when available.
      callback(0, 0, 0, 0, 0, 0);
    },
    measureInWindow: (
      _node: unknown,
      callback: (x: number, y: number, width: number, height: number) => void,
    ): void => {
      callback(0, 0, 0, 0);
    },
  }),
  LinkingManager: Object.freeze({ openURL: (url: string) => Promise.resolve(url) }),
  Platform,
  Vibration: Object.freeze({
    vibrate: (pattern?: number | readonly number[]) => {
      void pattern;
    },
    cancel: () => undefined,
  }),
  ShareModule: Object.freeze({
    share: (
      content: { message?: string; title?: string; url?: string },
      _options?: { dialogTitle?: string },
    ) => {
      // Check for native share adapter; fall back to stub if unavailable.
      const adapters = getNativeAdapters() as {
        readonly share?: {
          readonly share?: (content: {
            message?: string;
            title?: string;
            url?: string;
          }) => Promise<{ action: string; activityType?: string }>;
        };
      };
      if (adapters.share?.share) {
        return adapters.share.share(content);
      }
      // Stub: no native share UI available, resolve as shared.
      return Promise.resolve({
        action: "sharedAction",
        activityType: content.title ?? "SevynOS",
      });
    },
  }),
  StatusBarManager: Object.freeze({
    getHeight: () => Promise.resolve({ height: 24 }),
    setColor: () => undefined,
    setHidden: (hidden: boolean) => {
      void hidden;
    },
  }),
  DevSettings: Object.freeze({
    reload: () => undefined,
    addMenuItem: (title: string, handler: () => void) => {
      void title;
      void handler;
    },
  }),
  I18nManager: Object.freeze({
    isRTL: false,
    doLeftAndRightSwapInRTL: false,
    getConstants: () => ({
      isRTL: false,
      doLeftAndRightSwapInRTL: false,
    }),
    allowRTL: (allow: boolean) => {
      void allow;
    },
    forceRTL: (force: boolean) => {
      void force;
    },
    swapLeftAndRightInRTL: (swap: boolean) => {
      void swap;
    },
  }),
  Linking,
  PermissionsAndroid: Object.freeze({
    RESULTS: Object.freeze({
      GRANTED: "granted",
      DENIED: "denied",
      NEVER_ASK_AGAIN: "never_ask_again",
    }),
    request: (permission: string) => {
      throw new Error(
        `PermissionsAndroid.request('${permission}') is not supported on SevynOS. Declare capabilities declaratively in manifest.json instead.`,
      );
    },
    check: (permission: string) => {
      void permission;
      return Promise.resolve(false);
    },
  }),
  NetInfo,
  HardwareModules: Object.freeze({
    camera: Object.freeze({
      capture: (options?: unknown) => requireNativeAdapter("camera").capture(options),
      recordStart: (options?: unknown) =>
        requireNativeAdapter("camera").recordStart?.(options),
      recordStop: () => requireNativeAdapter("camera").recordStop?.(),
      preview: () => requireNativeAdapter("camera").preview?.(),
      status: () => requireNativeAdapter("camera").status?.(),
      setTorch: (enabled: boolean) => requireNativeAdapter("camera").setTorch?.(enabled),
      readImage: (path: string) => requireNativeAdapter("camera").readImage?.(path),
    }),
    microphone: Object.freeze({
      start: (options?: unknown) => requireNativeAdapter("microphone").start(options),
      stop: () => requireNativeAdapter("microphone").stop(),
    }),
    bluetooth: Object.freeze({
      scan: () => requireNativeAdapter("bluetooth").scan(),
    }),
    geolocation: Object.freeze({
      getCurrentPosition: () => requireNativeAdapter("location").getCurrentPosition(),
    }),
    sensors: Object.freeze({
      read: (sensor: string) => requireNativeAdapter("sensors").read(sensor),
    }),
    biometrics: Object.freeze({
      authenticate: (reason?: string) =>
        requireNativeAdapter("biometrics").authenticate(reason),
    }),
    media: Object.freeze({
      play: (source: string) => requireNativeAdapter("media").play(source),
      pause: () => requireNativeAdapter("media").pause?.(),
      resume: () => requireNativeAdapter("media").resume?.(),
      stop: () => requireNativeAdapter("media").stop(),
      seek: (seconds: number) => requireNativeAdapter("media").seek?.(seconds),
      setVolume: (volume: number) => requireNativeAdapter("media").setVolume?.(volume),
      status: () => requireNativeAdapter("media").status?.(),
      scan: (directory?: string) => requireNativeAdapter("media").scan?.(directory),
    }),
    battery: Object.freeze({
      status: () => requireNativeAdapter("battery").status?.(),
    }),
    display: Object.freeze({
      getBrightness: () => requireNativeAdapter("display").getBrightness?.(),
      setBrightness: (val: number) =>
        requireNativeAdapter("display").setBrightness?.(val),
    }),
    audio: Object.freeze({
      getOutputs: () => requireNativeAdapter("audio").getOutputs?.(),
      setOutput: (id: string) => requireNativeAdapter("audio").setOutput?.(id),
    }),
    vibration: Object.freeze({
      vibrate: (pattern?: number | readonly number[]) =>
        requireNativeAdapter("vibration").vibrate(pattern),
      cancel: () => requireNativeAdapter("vibration").cancel?.(),
    }),
    nfc: Object.freeze({
      isAvailable: () => requireNativeAdapter("nfc").isAvailable?.(),
      scan: () => requireNativeAdapter("nfc").scan?.(),
      write: (data: unknown) => requireNativeAdapter("nfc").write?.(data),
    }),
    cellular: Object.freeze({
      getModemStatus: () => requireNativeAdapter("cellular").getModemStatus?.(),
      getSignal: () => requireNativeAdapter("cellular").getSignal?.(),
      getBearer: () => requireNativeAdapter("cellular").getBearer?.(),
      dial: (num: string) => requireNativeAdapter("cellular").dial?.(num),
      answer: () => requireNativeAdapter("cellular").answer?.(),
      hangup: () => requireNativeAdapter("cellular").hangup?.(),
      sendSms: (to: string, msg: string) =>
        requireNativeAdapter("cellular").sendSms?.(to, msg),
      listSms: () => requireNativeAdapter("cellular").listSms?.(),
    }),
    notifications: Object.freeze({
      schedule: (payload: unknown) =>
        requireNativeAdapter("notifications").schedule(payload),
    }),
  }),
});

export class NativeEventEmitter<
  T extends (...args: never[]) => void = (...args: never[]) => void,
> {
  readonly #events = new Map<string, Set<T>>();
  addListener(event: string, listener: T): { remove: () => void } {
    const listeners = this.#events.get(event) ?? new Set<T>();
    listeners.add(listener);
    this.#events.set(event, listeners);
    return {
      remove: () => {
        const set = this.#events.get(event);
        if (set) {
          set.delete(listener);
          if (set.size === 0) this.#events.delete(event);
        }
      },
    };
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#events.get(event) ?? []) {
      (listener as unknown as (...a: unknown[]) => void)(...args);
    }
  }
  removeAllListeners(event?: string): void {
    if (event === undefined) this.#events.clear();
    else this.#events.delete(event);
  }
}
