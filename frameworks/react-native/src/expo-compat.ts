/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument */
/**
 * SevynOS Expo Platform Compatibility Layer
 *
 * Implements standard Expo module APIs directly on top of SevynOS native adapters
 * and Genesis render contracts so standard Expo applications run
 * unmodified on SevynOS.
 */
import { createElement, forwardRef, type ReactElement } from "react";
import { getNativeAdapters } from "./native-adapter-contracts.js";
import {
  Image as NativeImageComponent,
  View as NativeViewComponent,
  StatusBar as NativeStatusBar,
  type ImageProps as NativeImageProps,
  type NativeComponentProps,
} from "./primitives.js";

// ==========================================
// expo-constants
// ==========================================
export const Constants = Object.freeze({
  name: "expo-constants",
  deviceName: "SevynOS Device",
  sessionId: "sevyn-session-001",
  executionEnvironment: "bare",
  appOwnership: "standalone",
  expoVersion: "52.0.0",
  expoConfig: {
    name: "sample-app",
    slug: "sample-app",
    version: "1.0.0",
    orientation: "portrait",
    platforms: ["sevynos", "ios", "android", "web"],
    extra: {},
  },
  platform: {
    sevynos: {
      version: "0.1.0",
      target: "desktop",
    },
  },
  manifest: {
    name: "Sample App",
    slug: "sample-app",
    version: "1.0.0",
  },
});

// ==========================================
// expo-device
// ==========================================
export const DeviceType = Object.freeze({
  UNKNOWN: 0,
  PHONE: 1,
  TABLET: 2,
  DESKTOP: 3,
  TV: 4,
});

export const isDevice = true;
export const brand = "Sevyn";
export const manufacturer = "SevynOS";
export const modelName = "Sevyn Architecture Workstation";
export const designName = "Genesis";
export const productName = "SevynOS Genesis";
export const deviceYearClass = 2026;
export const totalMemory = 16 * 1024 * 1024 * 1024;
export const supportedCpuArchitectures = Object.freeze(["arm64", "x86_64"]);
export const osName = "SevynOS";
export const osVersion = "0.1.0";
export const osBuildId = "2026.09.sevyn";
export const osInternalBuildId = "2026.09.12";
export const deviceType = DeviceType.DESKTOP;

export const Device = Object.freeze({
  isDevice,
  brand,
  manufacturer,
  modelName,
  deviceYearClass,
  totalMemory,
  supportedCpuArchitectures,
  osName,
  osVersion,
  osBuildId,
  deviceType,
  DeviceType,
});

// ==========================================
// expo-secure-store
// ==========================================
export const WHEN_UNLOCKED = 0;
export const AFTER_FIRST_UNLOCK = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 4;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 5;
export const ALWAYS_THIS_DEVICE_ONLY = 6;

const memoryKeystore = new Map<string, string>();

export async function getItemAsync(
  key: string,
  _options?: unknown,
): Promise<string | null> {
  const biometrics = getNativeAdapters().biometrics;
  if (biometrics?.keystoreGet) {
    const val = await biometrics.keystoreGet(key);
    if (val !== null) return val;
  }
  return memoryKeystore.get(key) ?? null;
}

export async function setItemAsync(
  key: string,
  value: string,
  _options?: unknown,
): Promise<void> {
  const biometrics = getNativeAdapters().biometrics;
  if (biometrics?.keystoreSet) {
    await biometrics.keystoreSet(key, value);
  }
  memoryKeystore.set(key, value);
}

export async function deleteItemAsync(key: string, _options?: unknown): Promise<void> {
  const biometrics = getNativeAdapters().biometrics;
  if (biometrics?.keystoreDelete) {
    await biometrics.keystoreDelete(key);
  }
  memoryKeystore.delete(key);
}

export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(true);
}

export const SecureStore = Object.freeze({
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  isAvailableAsync,
  WHEN_UNLOCKED,
  AFTER_FIRST_UNLOCK,
  ALWAYS,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS_THIS_DEVICE_ONLY,
});

// ==========================================
// expo-clipboard
// ==========================================
let memoryClipboard = "";

export async function getStringAsync(): Promise<string> {
  const clipboard = getNativeAdapters().clipboard;
  return clipboard?.readText() ?? Promise.resolve(memoryClipboard);
}

export async function setStringAsync(text: string): Promise<boolean> {
  const clipboard = getNativeAdapters().clipboard;
  if (clipboard) {
    await clipboard.writeText(text);
  }
  memoryClipboard = text;
  return true;
}

export async function hasStringAsync(): Promise<boolean> {
  const text = await getStringAsync();
  return text.length > 0;
}

export const Clipboard = Object.freeze({
  getStringAsync,
  setStringAsync,
  hasStringAsync,
});

// ==========================================
// expo-haptics
// ==========================================
export enum ImpactFeedbackStyle {
  Light = "light",
  Medium = "medium",
  Heavy = "heavy",
  Rigid = "rigid",
  Soft = "soft",
}

export enum NotificationFeedbackType {
  Success = "success",
  Warning = "warning",
  Error = "error",
}

export async function impactAsync(
  style: ImpactFeedbackStyle = ImpactFeedbackStyle.Medium,
): Promise<void> {
  const vibration = getNativeAdapters().vibration;
  const duration =
    style === ImpactFeedbackStyle.Heavy
      ? 40
      : style === ImpactFeedbackStyle.Light || style === ImpactFeedbackStyle.Soft
        ? 15
        : 25;
  await vibration?.vibrate(duration);
}

export async function notificationAsync(
  type: NotificationFeedbackType = NotificationFeedbackType.Success,
): Promise<void> {
  const vibration = getNativeAdapters().vibration;
  const pattern =
    type === NotificationFeedbackType.Error
      ? [0, 30, 40, 30]
      : type === NotificationFeedbackType.Warning
        ? [0, 20, 30, 20]
        : 30;
  await vibration?.vibrate(pattern);
}

export async function selectionAsync(): Promise<void> {
  const vibration = getNativeAdapters().vibration;
  await vibration?.vibrate(10);
}

export const Haptics = Object.freeze({
  ImpactFeedbackStyle,
  NotificationFeedbackType,
  impactAsync,
  notificationAsync,
  selectionAsync,
});

// ==========================================
// expo-linking
// ==========================================
const linkingListeners = new Set<(event: { readonly url: string }) => void>();

export function createURL(
  path = "",
  options?: { queryParams?: Record<string, string> },
): string {
  const query = options?.queryParams
    ? `?${new URLSearchParams(options.queryParams).toString()}`
    : "";
  return `sevyn://${path.replace(/^\//, "")}${query}`;
}

export async function openURL(url: string): Promise<boolean> {
  const linking = getNativeAdapters().linking;
  if (linking) {
    await linking.openURL(url);
    return true;
  }
  return true;
}

export async function canOpenURL(url: string): Promise<boolean> {
  const linking = getNativeAdapters().linking;
  if (linking) return linking.canOpenURL(url);
  return Promise.resolve(/^(https?|sevyn):\/\//.test(url));
}

export function getInitialURL(): Promise<string | null> {
  const linking = getNativeAdapters().linking;
  return linking?.getInitialURL() ?? Promise.resolve(null);
}

export function addEventListener(
  type: string,
  listener: (event: { readonly url: string }) => void,
): { remove: () => void } {
  if (type === "url") linkingListeners.add(listener);
  return {
    remove: () => {
      linkingListeners.delete(listener);
    },
  };
}

export const Linking = Object.freeze({
  createURL,
  openURL,
  canOpenURL,
  getInitialURL,
  addEventListener,
});

// ==========================================
// expo-location
// ==========================================
export enum LocationAccuracy {
  Lowest = 1,
  Low = 2,
  Balanced = 3,
  High = 4,
  Highest = 5,
  BestForNavigation = 6,
}

export interface LocationPermissionResponse {
  readonly status: "granted" | "denied" | "undetermined";
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly expires: "never";
}

export interface LocationObject {
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly altitude: number | null;
    readonly accuracy: number | null;
    readonly altitudeAccuracy: number | null;
    readonly heading: number | null;
    readonly speed: number | null;
  };
  readonly timestamp: number;
}

export async function requestForegroundPermissionsAsync(): Promise<LocationPermissionResponse> {
  return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
}

export async function requestBackgroundPermissionsAsync(): Promise<LocationPermissionResponse> {
  return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
}

export async function getForegroundPermissionsAsync(): Promise<LocationPermissionResponse> {
  return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
}

export async function getCurrentPositionAsync(
  _options?: unknown,
): Promise<LocationObject> {
  const location = getNativeAdapters().location;
  if (location) {
    const raw = (await location.getCurrentPosition()) as {
      readonly latitude?: unknown;
      readonly longitude?: unknown;
      readonly altitude?: unknown;
      readonly accuracy?: unknown;
    };
    return {
      coords: {
        latitude: typeof raw.latitude === "number" ? raw.latitude : 37.7749,
        longitude: typeof raw.longitude === "number" ? raw.longitude : -122.4194,
        altitude: typeof raw.altitude === "number" ? raw.altitude : 0,
        accuracy: typeof raw.accuracy === "number" ? raw.accuracy : 5,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }
  return {
    coords: {
      latitude: 37.7749,
      longitude: -122.4194,
      altitude: 0,
      accuracy: 5,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  };
}

export async function reverseGeocodeAsync(_coords: {
  latitude: number;
  longitude: number;
}): Promise<readonly unknown[]> {
  return [
    {
      name: "SevynOS Center",
      city: "Metropolis",
      region: "California",
      country: "United States",
      postalCode: "94105",
      isoCountryCode: "US",
    },
  ];
}

export const Location = Object.freeze({
  Accuracy: LocationAccuracy,
  requestForegroundPermissionsAsync,
  requestBackgroundPermissionsAsync,
  getForegroundPermissionsAsync,
  getCurrentPositionAsync,
  reverseGeocodeAsync,
});

// ==========================================
// expo-notifications
// ==========================================
const notificationReceivedListeners = new Set<(notification: unknown) => void>();
const notificationResponseListeners = new Set<(response: unknown) => void>();

export async function getExpoPushTokenAsync(
  _options?: unknown,
): Promise<{ data: string }> {
  return { data: "ExponentPushToken[sevynos-mock-push-token]" };
}

export async function getDevicePushTokenAsync(
  _options?: unknown,
): Promise<{ data: string; type: string }> {
  return { data: "sevynos-device-token", type: "sevynos" };
}

export async function requestNotificationPermissionsAsync(): Promise<{
  status: "granted";
  granted: true;
  canAskAgain: true;
  expires: "never";
}> {
  return { status: "granted", granted: true, canAskAgain: true, expires: "never" };
}

export async function scheduleNotificationAsync(request: unknown): Promise<string> {
  const notifications = getNativeAdapters().notifications;
  if (notifications) {
    return notifications.schedule(request);
  }
  return `sevyn-notif-${String(Date.now())}`;
}

export function addNotificationReceivedListener(
  listener: (notification: unknown) => void,
): { remove: () => void } {
  notificationReceivedListeners.add(listener);
  return {
    remove: () => {
      notificationReceivedListeners.delete(listener);
    },
  };
}

export function addNotificationResponseReceivedListener(
  listener: (response: unknown) => void,
): { remove: () => void } {
  notificationResponseListeners.add(listener);
  return {
    remove: () => {
      notificationResponseListeners.delete(listener);
    },
  };
}

export function setNotificationHandler(_handler: unknown): void {
  // Configures foreground presentation policy.
}

export async function getLastNotificationResponseAsync(): Promise<unknown> {
  return null;
}

export async function clearLastNotificationResponseAsync(): Promise<void> {
  // Clear last response
}

export async function cancelScheduledNotificationAsync(_id: string): Promise<void> {
  // Cancel
}

export async function cancelAllScheduledNotificationsAsync(): Promise<void> {
  // Cancel all
}

export async function getAllScheduledNotificationsAsync(): Promise<readonly unknown[]> {
  return [];
}

export async function setBadgeCountAsync(_count: number): Promise<boolean> {
  return true;
}

export async function getBadgeCountAsync(): Promise<number> {
  return 0;
}

export async function dismissNotificationAsync(_id: string): Promise<void> {
  // Dismiss
}

export async function dismissAllNotificationsAsync(): Promise<void> {
  // Dismiss all
}

export async function setNotificationChannelAsync(
  _id: string,
  _channel: unknown,
): Promise<unknown> {
  return null;
}

export async function deleteNotificationChannelAsync(_id: string): Promise<void> {
  // Delete channel
}

export async function getNotificationChannelsAsync(): Promise<readonly unknown[]> {
  return [];
}

export const Notifications = Object.freeze({
  getExpoPushTokenAsync,
  getDevicePushTokenAsync,
  requestPermissionsAsync: requestNotificationPermissionsAsync,
  getPermissionsAsync: requestNotificationPermissionsAsync,
  scheduleNotificationAsync,
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  setNotificationHandler,
  getLastNotificationResponseAsync,
  clearLastNotificationResponseAsync,
  cancelScheduledNotificationAsync,
  cancelAllScheduledNotificationsAsync,
  getAllScheduledNotificationsAsync,
  setBadgeCountAsync,
  getBadgeCountAsync,
  dismissNotificationAsync,
  dismissAllNotificationsAsync,
  setNotificationChannelAsync,
  deleteNotificationChannelAsync,
  getNotificationChannelsAsync,
});

// ==========================================
// expo-font
// ==========================================
export function useFonts(_map?: Record<string, unknown>): [boolean, Error | null] {
  return [true, null];
}

export async function loadAsync(
  _map: Record<string, unknown> | string,
  _source?: unknown,
): Promise<void> {
  // Fonts are registered dynamically with Genesis font metrics.
}

export function isLoaded(_name: string): boolean {
  return true;
}

export const loadFontAsync = loadAsync;
export const isFontLoaded = isLoaded;

export const Font = Object.freeze({
  useFonts,
  loadAsync,
  loadFontAsync,
  isLoaded,
  isFontLoaded,
});

// ==========================================
// expo-asset
// ==========================================
export class Asset {
  public name: string;
  public type: string;
  public uri: string;
  public localUri: string | null;
  public width?: number;
  public height?: number;
  public downloaded = false;

  public constructor(options: { name: string; type: string; uri: string }) {
    this.name = options.name;
    this.type = options.type;
    this.uri = options.uri;
    this.localUri = options.uri;
  }

  public async downloadAsync(): Promise<this> {
    this.downloaded = true;
    return this;
  }

  public static fromModule(moduleId: number | string): Asset {
    return new Asset({
      name: `asset-${String(moduleId)}`,
      type: "png",
      uri: typeof moduleId === "string" ? moduleId : `asset://${String(moduleId)}`,
    });
  }

  public static async loadAsync(
    moduleId: number | string | readonly (number | string)[],
  ): Promise<readonly Asset[]> {
    const modules = Array.isArray(moduleId) ? moduleId : [moduleId];
    return modules.map((mod) => Asset.fromModule(mod));
  }
}

// ==========================================
// expo-status-bar
// ==========================================
export interface ExpoStatusBarProps {
  readonly style?: "auto" | "inverted" | "light" | "dark";
  readonly animated?: boolean;
  readonly hidden?: boolean;
  readonly backgroundColor?: string;
  readonly translucent?: boolean;
}

export function StatusBar(props: ExpoStatusBarProps): ReactElement {
  const barStyle =
    props.style === "dark"
      ? "dark-content"
      : props.style === "light"
        ? "light-content"
        : "default";
  const nativeProps: Record<string, unknown> = { barStyle };
  if (props.hidden !== undefined) nativeProps["hidden"] = props.hidden;
  if (props.backgroundColor !== undefined)
    nativeProps["backgroundColor"] = props.backgroundColor;
  if (props.translucent !== undefined) nativeProps["translucent"] = props.translucent;
  return createElement(NativeStatusBar, nativeProps);
}

export function setStatusBarStyle(style: "auto" | "inverted" | "light" | "dark"): void {
  NativeStatusBar.setBarStyle(
    style === "dark" ? "dark-content" : style === "light" ? "light-content" : "default",
  );
}

export function setStatusBarHidden(
  hidden: boolean,
  animation?: "none" | "fade" | "slide",
): void {
  NativeStatusBar.setHidden(hidden, animation);
}

export function setStatusBarBackgroundColor(
  backgroundColor: string,
  animated?: boolean,
): void {
  NativeStatusBar.setBackgroundColor(backgroundColor, animated);
}

export function setStatusBarTranslucent(translucent: boolean): void {
  NativeStatusBar.setTranslucent(translucent);
}

// ==========================================
// expo-splash-screen
// ==========================================
export async function preventAutoHideAsync(): Promise<boolean> {
  return true;
}

export async function hideAsync(): Promise<boolean> {
  return true;
}

export const SplashScreen = Object.freeze({
  preventAutoHideAsync,
  hideAsync,
});

// ==========================================
// expo-linear-gradient
// ==========================================
export interface LinearGradientProps extends NativeComponentProps {
  readonly colors: readonly string[];
  readonly locations?: readonly number[];
  readonly start?: { x: number; y: number } | readonly [number, number];
  readonly end?: { x: number; y: number } | readonly [number, number];
}

export const LinearGradient = forwardRef<unknown, LinearGradientProps>((props, _ref) => {
  const firstColor = props.colors[0] ?? "transparent";
  return createElement(
    NativeViewComponent,
    {
      ...props,
      style: {
        backgroundColor: firstColor,
        ...(props.style ?? {}),
      },
    },
    props.children,
  );
});
LinearGradient.displayName = "LinearGradient";

// ==========================================
// expo-blur
// ==========================================
export interface BlurViewProps extends NativeComponentProps {
  readonly intensity?: number;
  readonly tint?: "light" | "dark" | "default" | "prominent";
}

export const BlurView = forwardRef<unknown, BlurViewProps>((props, _ref) => {
  const tintColor =
    props.tint === "dark"
      ? "rgba(15, 23, 42, 0.85)"
      : props.tint === "light"
        ? "rgba(255, 255, 255, 0.85)"
        : "rgba(30, 41, 59, 0.75)";
  return createElement(
    NativeViewComponent,
    {
      ...props,
      style: {
        backgroundColor: tintColor,
        ...(props.style ?? {}),
      },
    },
    props.children,
  );
});
BlurView.displayName = "BlurView";

// ==========================================
// expo-image
// ==========================================
export interface ExpoImageProps extends Omit<NativeImageProps, "source" | "placeholder"> {
  readonly source?: NativeImageProps["source"];
  readonly contentFit?: "cover" | "contain" | "fill" | "none" | "scale-down";
  readonly placeholder?: unknown;
  readonly transition?: number;
  readonly priority?: "low" | "normal" | "high";
}

export const Image = forwardRef<unknown, ExpoImageProps>((props, _ref) => {
  const resizeMode =
    props.contentFit === "contain"
      ? "contain"
      : props.contentFit === "fill"
        ? "stretch"
        : props.contentFit === "scale-down"
          ? "center"
          : "cover";
  return createElement(NativeImageComponent, {
    ...(props as unknown as NativeImageProps),
    resizeMode,
    ...(props.source !== undefined ? { source: props.source } : {}),
  });
});
Image.displayName = "ExpoImage";

// ==========================================
// expo-crypto
// ==========================================
export enum CryptoDigestAlgorithm {
  SHA1 = "SHA-1",
  SHA256 = "SHA-256",
  SHA384 = "SHA-384",
  SHA512 = "SHA-512",
  MD5 = "MD5",
}

export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function digestStringAsync(
  algorithm: CryptoDigestAlgorithm,
  data: string,
): Promise<string> {
  void algorithm;
  // Fast hash fallback for platform runtime
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

export const Crypto = Object.freeze({
  CryptoDigestAlgorithm,
  randomUUID,
  digestStringAsync,
});

// ==========================================
// expo-system-ui
// ==========================================
export async function setBackgroundColorAsync(_color: string): Promise<void> {
  // Syncs background color with Genesis host desktop window.
}

export async function getBackgroundColorAsync(): Promise<string | null> {
  return "#0A0D14";
}

export const SystemUI = Object.freeze({
  setBackgroundColorAsync,
  getBackgroundColorAsync,
});

// ==========================================
// expo-web-browser
// ==========================================
export async function openBrowserAsync(
  url: string,
  _options?: unknown,
): Promise<{ type: "opened" | "dismiss" }> {
  await openURL(url);
  return { type: "opened" };
}

export function dismissBrowser(): void {
  // Browser dismiss handler
}

export const WebBrowser = Object.freeze({
  openBrowserAsync,
  dismissBrowser,
});

const defaultCompat = Object.assign({}, Constants, {
  Constants,
  DeviceType,
  isDevice,
  brand,
  manufacturer,
  modelName,
  osName,
  osVersion,
  deviceType,
  totalMemory,
  supportedCpuArchitectures,
  isAvailableAsync,
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
  setStringAsync,
  getStringAsync,
  hasStringAsync,
  impactAsync,
  notificationAsync,
  selectionAsync,
  requestForegroundPermissionsAsync,
  getForegroundPermissionsAsync,
  getCurrentPositionAsync,
  requestNotificationPermissionsAsync,
  requestPermissionsAsync: requestNotificationPermissionsAsync,
  getPermissionsAsync: requestNotificationPermissionsAsync,
  getExpoPushTokenAsync,
  scheduleNotificationAsync,
  setNotificationHandler,
  loadAsync,
  useFonts,
  Asset,
  StatusBar,
  setStatusBarStyle,
  setStatusBarHidden,
  setStatusBarBackgroundColor,
  setStatusBarTranslucent,
  preventAutoHideAsync,
  hideAsync,
  SplashScreen,
  LinearGradient,
  BlurView,
  Image,
  Crypto,
  randomUUID,
  digestStringAsync,
  SystemUI,
  setBackgroundColorAsync,
  getBackgroundColorAsync,
  WebBrowser,
  openBrowserAsync,
  dismissBrowser,
});

export default defaultCompat;
