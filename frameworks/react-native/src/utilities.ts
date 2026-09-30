// Standard React Native Platform Utilities for SevynOS
import { getNativeAdapters } from "./native-adapter-contracts.js";

export type AppStateStatus = "active" | "background" | "inactive";

let currentAppState: AppStateStatus = "active";
const appStateListeners = new Set<(state: AppStateStatus) => void>();

export const AppState = {
  get currentState(): AppStateStatus {
    return currentAppState;
  },
  set currentState(val: AppStateStatus) {
    currentAppState = val;
    for (const listener of appStateListeners) {
      listener(val);
    }
  },
  /**
   * Internal: called by the host to notify of app lifecycle transitions.
   * e.g., when the app goes to background/foreground.
   */
  _setAppState(val: AppStateStatus): void {
    AppState.currentState = val;
  },
  addEventListener(
    type: "change" | "memoryWarning",
    handler: (state: AppStateStatus) => void,
  ): { remove: () => void } {
    if (type === "change") {
      appStateListeners.add(handler);
    }
    return {
      remove(): void {
        appStateListeners.delete(handler);
      },
    };
  },
};

let clipboardContent = "";

export const Clipboard = {
  getString(): Promise<string> {
    return getNativeAdapters().clipboard?.readText() ?? Promise.resolve(clipboardContent);
  },
  setString(content: string): void {
    clipboardContent = content;
    void getNativeAdapters()
      .clipboard?.writeText(content)
      .catch(() => undefined);
  },
};

const linkingListeners = new Set<(event: { readonly url: string }) => void>();

export const Linking = {
  async openURL(url: string): Promise<boolean> {
    const adapter = getNativeAdapters().linking;
    if (adapter !== undefined) await adapter.openURL(url);
    else if (!(await this.canOpenURL(url))) throw new Error(`Unable to open URL: ${url}`);
    for (const listener of linkingListeners) {
      listener({ url });
    }
    return true;
  },
  canOpenURL(url: string): Promise<boolean> {
    const adapter = getNativeAdapters().linking;
    if (adapter !== undefined) return adapter.canOpenURL(url);
    return Promise.resolve(
      url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("sevyn://"),
    );
  },
  getInitialURL(): Promise<string | null> {
    return getNativeAdapters().linking?.getInitialURL() ?? Promise.resolve(null);
  },
  addEventListener(
    type: "url",
    handler: (event: { readonly url: string }) => void,
  ): { remove: () => void } {
    linkingListeners.add(handler);
    return {
      remove(): void {
        linkingListeners.delete(handler);
      },
    };
  },
  /**
   * @deprecated Use addEventListener which returns a subscription.
   */
  removeEventListener(
    _type: "url",
    handler: (event: { readonly url: string }) => void,
  ): void {
    linkingListeners.delete(handler);
  },
};

type BackHandlerListener = () => boolean | null | undefined;
const backListeners: BackHandlerListener[] = [];

export const BackHandler = {
  addEventListener(
    _eventName: "hardwareBackPress",
    handler: BackHandlerListener,
  ): { remove: () => void } {
    backListeners.push(handler);
    return {
      remove(): void {
        const idx = backListeners.indexOf(handler);
        if (idx >= 0) backListeners.splice(idx, 1);
      },
    };
  },
  removeEventListener(
    _eventName: "hardwareBackPress",
    handler: BackHandlerListener,
  ): void {
    const idx = backListeners.indexOf(handler);
    if (idx >= 0) backListeners.splice(idx, 1);
  },
  exitApp(): void {
    // Graceful exit handler
  },
};

const keyboardListeners = new Map<string, Set<() => void>>();
let keyboardVisible = false;

export const Keyboard = {
  dismiss(): void {
    keyboardVisible = false;
    const hideListeners = keyboardListeners.get("keyboardDidHide");
    if (hideListeners) {
      for (const fn of hideListeners) fn();
    }
  },
  isVisible(): boolean {
    return keyboardVisible;
  },
  addListener(eventType: string, listener: () => void): { remove: () => void } {
    let set = keyboardListeners.get(eventType);
    if (!set) {
      set = new Set();
      keyboardListeners.set(eventType, set);
    }
    set.add(listener);
    return {
      remove(): void {
        set.delete(listener);
      },
    };
  },
};

const globalScope = globalThis as unknown as {
  requestAnimationFrame?: (callback: (time: number) => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

if (typeof globalScope.requestAnimationFrame === "undefined") {
  globalScope.requestAnimationFrame = (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 16) as unknown as number;
  globalScope.cancelAnimationFrame = (id: number) => clearTimeout(id);
}

export const requestAnimationFrame = globalScope.requestAnimationFrame;
export const cancelAnimationFrame = globalScope.cancelAnimationFrame;
