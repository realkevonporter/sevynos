export class NativeModuleUnavailableError extends Error {
  public constructor(readonly moduleName: string) {
    super(`SevynOS native module "${moduleName}" is unavailable on this device.`);
    this.name = "NativeModuleUnavailableError";
  }
}

export interface SevynNativeAdapters {
  readonly accessibility?: {
    getState(): Promise<{
      readonly accessibilityServiceEnabled: boolean;
      readonly screenReaderEnabled: boolean;
      readonly boldTextEnabled: boolean;
      readonly grayscaleEnabled: boolean;
      readonly invertColorsEnabled: boolean;
      readonly reduceMotionEnabled: boolean;
      readonly reduceTransparencyEnabled: boolean;
    }>;
    subscribe(listener: () => void): () => void;
    announce(message: string): Promise<void>;
    setFocus?(reactTag: number): Promise<void>;
    sendEvent?(reactTag: number, eventType: string): Promise<void>;
  };
  readonly image?: {
    load(uri: string): Promise<import("./native-types.js").NativeBitmapSource>;
  };
  readonly clipboard?: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
  readonly linking?: {
    openURL(url: string): Promise<void>;
    canOpenURL(url: string): Promise<boolean>;
    getInitialURL(): Promise<string | null>;
  };
  readonly networkInfo?: {
    getState(): Promise<{
      readonly type: "wifi" | "none" | "unknown";
      readonly isConnected: boolean | null;
      readonly isInternetReachable: boolean | null;
      readonly details?: Readonly<Record<string, unknown>>;
    }>;
    subscribe(listener: () => void): () => void;
  };
  readonly webSocket?: {
    open(
      url: string,
      protocols?: string | readonly string[],
    ): Promise<{
      readonly id: string;
      readonly protocol: string;
      readonly extensions?: string;
    }>;
    send(
      id: string,
      data: { readonly text?: string; readonly base64?: string },
    ): Promise<void>;
    receive(id: string): Promise<{
      readonly type: "message" | "error" | "close" | "timeout";
      readonly text?: string;
      readonly base64?: string;
      readonly code?: number;
      readonly reason?: string;
      readonly message?: string;
    }>;
    close(id: string, code?: number, reason?: string): Promise<void>;
  };
  readonly camera?: {
    capture(options?: unknown): Promise<unknown>;
    recordStart?(options?: unknown): Promise<unknown>;
    recordStop?(): Promise<unknown>;
    preview?(): Promise<unknown>;
    status?(): Promise<unknown>;
    setTorch?(enabled: boolean): Promise<unknown>;
    readImage?(path: string): Promise<unknown>;
  };
  readonly microphone?: {
    start(options?: unknown): Promise<void>;
    stop(): Promise<void>;
  };
  readonly location?: { getCurrentPosition(): Promise<unknown> };
  readonly bluetooth?: { scan(): Promise<readonly unknown[]> };
  readonly sensors?: {
    read(sensor: string): Promise<unknown>;
    subscribe?(
      sensor: string,
      listener: (reading: unknown) => void,
      options?: unknown,
    ): Promise<() => void> | (() => void);
  };
  readonly biometrics?: {
    authenticate(reason?: string): Promise<boolean>;
    enroll?(type: string, label?: string): Promise<unknown>;
    deleteEnrolled?(type: string, id: string): Promise<unknown>;
    listEnrolled?(): Promise<readonly unknown[]>;
    verifyPin?(pin: string): Promise<boolean>;
    keystoreGet?(key: string): Promise<string | null>;
    keystoreSet?(key: string, secret: string): Promise<void>;
    keystoreDelete?(key: string): Promise<boolean>;
    keystoreList?(): Promise<readonly string[]>;
  };
  readonly media?: {
    play(source: string): Promise<unknown>;
    pause?(): Promise<unknown>;
    resume?(): Promise<unknown>;
    stop(): Promise<unknown>;
    seek?(seconds: number): Promise<unknown>;
    setVolume?(volume: number): Promise<unknown>;
    status?(): Promise<unknown>;
    scan?(directory?: string): Promise<readonly unknown[]>;
  };
  readonly battery?: {
    status?(): Promise<unknown>;
  };
  readonly display?: {
    getBrightness?(): Promise<number>;
    setBrightness?(val: number): Promise<void>;
    getAutoBrightness?(): Promise<boolean>;
    setAutoBrightness?(enabled: boolean): Promise<void>;
    getOrientation?(): Promise<string>;
    lockOrientation?(orientation: string): Promise<void>;
    acquireWakeLock?(): Promise<() => void>;
    isWakeLocked?(): boolean;
  };
  readonly audio?: {
    getOutputs?(): Promise<readonly unknown[]>;
    setOutput?(deviceId: string): Promise<void>;
  };
  readonly vibration?: {
    vibrate(pattern?: number | readonly number[]): Promise<void>;
    cancel?(): Promise<void>;
  };
  readonly nfc?: {
    isAvailable?(): Promise<boolean>;
    scan?(): Promise<unknown>;
    write?(data: unknown): Promise<void>;
  };
  readonly cellular?: {
    getModemStatus?(): Promise<unknown>;
    getSignal?(): Promise<unknown>;
    getBearer?(): Promise<unknown>;
    dial?(number: string): Promise<unknown>;
    answer?(): Promise<void>;
    hangup?(): Promise<void>;
    sendSms?(recipient: string, message: string): Promise<unknown>;
    listSms?(): Promise<readonly unknown[]>;
  };
  readonly notifications?: { schedule(payload: unknown): Promise<string> };
  readonly nativeModules?: {
    invoke(module: string, method: string, argumentsValue?: unknown): Promise<unknown>;
  };
  readonly webview?: { createEngine(): import("./services.js").SevynBrowserEngine };
}

let adapters: SevynNativeAdapters = Object.freeze({});

export function installNativeAdapters(next: SevynNativeAdapters): void {
  adapters = Object.freeze({ ...next });
}

export function getNativeAdapters(): SevynNativeAdapters {
  return adapters;
}

export function requireNativeAdapter<K extends keyof SevynNativeAdapters>(
  name: K,
): NonNullable<SevynNativeAdapters[K]> {
  const adapter = adapters[name];
  if (adapter === undefined) throw new NativeModuleUnavailableError(name);
  return adapter;
}

export const SevynNativeModules = Object.freeze({
  invoke(
    module: string,
    method: string,
    argumentsValue: unknown = null,
  ): Promise<unknown> {
    return requireNativeAdapter("nativeModules").invoke(module, method, argumentsValue);
  },
});
