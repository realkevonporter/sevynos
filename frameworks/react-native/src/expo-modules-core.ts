import { useCallback, useEffect, useState } from "react";
import { getNativeAdapters, SevynNativeModules } from "./native-adapter-contracts.js";
import { NativeEventEmitter, NativeModules } from "./native-modules.js";
import { TurboModuleRegistry } from "./upstream-compat.js";
import { Platform as BasePlatform } from "./stylesheet.js";

const globalScope = globalThis as unknown as Record<string, unknown>;
const hasWindow = typeof globalScope["window"] !== "undefined";
const docCandidate = hasWindow
  ? (globalScope["document"] as Record<string, unknown> | undefined)
  : undefined;

export const Platform = Object.freeze({
  ...BasePlatform,
  isDOMAvailable: typeof docCandidate?.["createElement"] === "function",
  canUseEventListeners:
    hasWindow &&
    typeof (globalScope["window"] as Record<string, unknown>)?.["addEventListener"] ===
      "function",
  canUseViewport:
    hasWindow &&
    typeof (globalScope["window"] as Record<string, unknown>)?.["screen"] !== "undefined",
});

export interface EventSubscription {
  remove(): void;
}
export type Subscription = EventSubscription;
export enum PermissionStatus {
  UNDETERMINED = "undetermined",
  DENIED = "denied",
  GRANTED = "granted",
}
export interface PermissionResponse {
  readonly status: PermissionStatus;
  readonly expires: "never" | number;
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}
export interface PermissionHookOptions {
  readonly get?: () => Promise<PermissionResponse>;
  readonly request?: () => Promise<PermissionResponse>;
}

export class EventEmitter<
  TEvents extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> {
  readonly #listeners = new Map<keyof TEvents, Set<TEvents[keyof TEvents]>>();
  public addListener<K extends keyof TEvents>(
    event: K,
    listener: TEvents[K],
  ): EventSubscription {
    const listeners = this.#listeners.get(event) ?? new Set<TEvents[keyof TEvents]>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  }
  public emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
  public removeAllListeners(event?: keyof TEvents): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }
}

export class NativeModule<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> extends EventEmitter<Events> {
  public readonly name: string;
  public constructor(name?: string) {
    super();
    this.name = name ?? this.constructor.name;
  }
}
export class Module<
  Events extends Record<string, (...args: never[]) => void> = Record<
    string,
    (...args: never[]) => void
  >,
> extends NativeModule<Events> {}
export class SharedObject extends NativeModule {
  public readonly nativeRef: string;
  public constructor(nativeRef = "SharedObject") {
    super("SharedObject");
    this.nativeRef = nativeRef;
  }
  public release(): void {
    // Native resources are released by the owning adapter.
  }
}

export class SharedRef<T = unknown> extends SharedObject {
  public nativeRefType = "unknown";
  public constructor(nativeRef = "sevyn-ref") {
    super(nativeRef);
  }
}

export function useReleasingSharedObject<T>(
  factory: () => T,
  dependencies: readonly unknown[] = [],
): T {
  const [object] = useState<T>(factory);
  useEffect(() => {
    return () => {
      if (
        object &&
        typeof (object as Record<string, unknown>)["release"] === "function"
      ) {
        ((object as Record<string, unknown>)["release"] as () => void)();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  return object;
}

export function installOnUIRuntime(): void {}

export async function reloadAppAsync(): Promise<void> {}

export const uuid = {
  v4: () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }),
};

export const NativeModulesProxy = NativeModules;
export const EventEmitterModule = NativeEventEmitter;
export const LegacyEventEmitter = EventEmitter;

export class UnavailabilityError extends Error {
  public readonly code = "ERR_UNAVAILABLE";
  public constructor(moduleName: string, propertyName: string) {
    super(
      `The method or property ${moduleName}.${propertyName} is not available on SevynOS`,
    );
  }
}

// The generic return type preserves Expo's typed native-module API.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function requireNativeModule<T = Record<string, unknown>>(name: string): T {
  const registered = TurboModuleRegistry.get(name);
  if (registered !== null && registered !== undefined) return registered as T;
  return createNativeModuleProxy(name) as T;
}

// The generic return type preserves Expo's typed optional-module API.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function requireOptionalNativeModule<T = Record<string, unknown>>(
  name: string,
): T | null {
  try {
    return requireNativeModule<T>(name);
  } catch {
    return null;
  }
}

export function requireNativeViewManager(name: string): unknown {
  return requireNativeModule(name);
}

export function createPermissionHook(options: PermissionHookOptions): () => {
  readonly permission: PermissionResponse | null;
  readonly get: () => Promise<PermissionResponse | null>;
  readonly request: () => Promise<PermissionResponse | null>;
} {
  return function usePermission() {
    const [permission, setPermission] = useState<PermissionResponse | null>(null);
    const get = useCallback(async () => {
      const next = await options.get?.();
      if (next !== undefined) setPermission(next);
      return next ?? permission;
    }, [options.get, permission]);
    const request = useCallback(async () => {
      const next = await options.request?.();
      if (next !== undefined) setPermission(next);
      return next ?? permission;
    }, [options.request, permission]);
    useEffect(() => {
      if (options.get === undefined) return;
      void options.get().then((next) => {
        setPermission(next);
      });
    }, [options.get]);
    return { permission, get, request };
  };
}

export function registerWebModule<T>(module: T): T {
  return module;
}

export type ModuleDefinition = Readonly<Record<string, unknown>>;
export const NativeModulesProxyVersion = "1.0.0" as const;

function createNativeModuleProxy(name: string): object {
  const defaultConstants: Record<string, unknown> = {
    name,
    isDevice: true,
    brand: "Sevyn",
    modelName: "SevynOS Device",
    osName: "SevynOS",
    osVersion: "1.0.0",
    deviceType: 1,
    executionEnvironment: "bare",
    manifest: {},
    expoConfig: {},
    documentDirectory: "file:///sevynos/data/com.example.app/files/",
    cacheDirectory: "file:///sevynos/data/com.example.app/cache/",
    bundleDirectory: "file:///sevynos/data/com.example.app/bundle/",
  };

  return new Proxy(Object.create(null) as object, {
    get: (_target, property: string | symbol) => {
      if (property === "name") return name;
      if (property === "toString") return () => `[SevynNativeModule ${name}]`;
      if (typeof property !== "string") return undefined;
      if (property in defaultConstants) return defaultConstants[property];
      if (property === "getConstants") return () => defaultConstants;
      if (property === "addListener" || property === "removeListeners")
        return () => undefined;
      if (/^[A-Z]/.test(property)) {
        const defaultStatus = {
          id: 1,
          currentTime: 0,
          playbackDuration: 0,
          duration: 0,
          playing: false,
          isLoaded: true,
          isBuffering: false,
          didJustFinish: false,
          rate: 1,
          shouldCorrectPitch: true,
          volume: 1,
          isMuted: false,
          isLooping: false,
        };
        const FallbackClass = function (
          this: Record<string, unknown>,
          ...args: unknown[]
        ) {
          this["id"] = `native-instance-${String(Math.random())}`;
          this["validatePath"] = () => undefined;
          this["uri"] = typeof args[0] === "string" ? args[0] : "";
          this["currentStatus"] = defaultStatus;
          this["status"] = defaultStatus;
          this["playing"] = false;
          this["isLoaded"] = true;
          this["currentTime"] = 0;
          this["duration"] = 0;
          this["volume"] = 1;
          this["muted"] = false;
          this["loop"] = false;
          this["play"] = () => undefined;
          this["pause"] = () => undefined;
          this["replay"] = () => undefined;
          this["seekTo"] = (_seconds: number) => Promise.resolve();
          this["replace"] = (_source: unknown) => undefined;
          this["release"] = () => undefined;
          this["addListener"] = () => ({ remove: () => undefined });
          this["removeListener"] = () => undefined;
        };
        FallbackClass.prototype.validatePath = () => undefined;
        FallbackClass.prototype.exists = () => true;
        FallbackClass.prototype.isDirectory = () => false;
        FallbackClass.prototype.copy = () => undefined;
        FallbackClass.prototype.move = () => undefined;
        FallbackClass.prototype.delete = () => undefined;
        FallbackClass.prototype.currentStatus = defaultStatus;
        FallbackClass.prototype.status = defaultStatus;
        FallbackClass.prototype.playing = false;
        FallbackClass.prototype.isLoaded = true;
        FallbackClass.prototype.play = () => undefined;
        FallbackClass.prototype.pause = () => undefined;
        FallbackClass.prototype.replay = () => undefined;
        FallbackClass.prototype.seekTo = () => Promise.resolve();
        FallbackClass.prototype.replace = () => undefined;
        FallbackClass.prototype.release = () => undefined;
        FallbackClass.prototype.addListener = () => ({ remove: () => undefined });
        FallbackClass.prototype.removeListener = () => undefined;
        return FallbackClass;
      }
      if (
        property.endsWith("Directory") ||
        property.endsWith("Path") ||
        property.endsWith("Uri") ||
        property.endsWith("Url")
      ) {
        return `file:///sevynos/data/${property.toLowerCase()}/`;
      }
      const fn = (...args: readonly unknown[]) => {
        if (getNativeAdapters().nativeModules !== undefined) {
          return SevynNativeModules.invoke(
            name,
            property,
            args.length === 1 ? args[0] : args,
          ).catch(() => null);
        }
        return Promise.resolve(null);
      };
      Object.assign(fn, {
        replace: (searchValue: string | RegExp, replaceValue: string) =>
          `file:///sevynos/data/${property.toLowerCase()}/`.replace(
            searchValue,
            replaceValue,
          ),
      });
      return fn;
    },
  });
}

if (typeof globalThis !== "undefined") {
  const g = globalThis as unknown as Record<string, unknown>;
  g["expo"] ??= {
    reloadAppAsync: () => Promise.resolve(),
    modules: {},
    SharedObject: {
      __resolveInWorklet: (obj: unknown) => obj,
    },
  };
}
