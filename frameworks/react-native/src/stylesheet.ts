import { useState, useEffect } from "react";
import type { NativeStyle } from "./native-types.js";
import { Appearance } from "./appearance.js";

/**
 * Standard React Native StyleSheet utility.
 */
export const StyleSheet = Object.freeze({
  hairlineWidth: 1,
  create<T extends Record<string, NativeStyle>>(styles: T): T {
    return Object.freeze(styles);
  },
  flatten<T extends NativeStyle>(
    styles: T | readonly (T | undefined | null | false)[] | undefined | null | false,
  ): NativeStyle {
    if (!styles) return {};
    if (Array.isArray(styles)) {
      const flattened: NativeStyle = {};
      for (const style of styles) {
        if (style) Object.assign(flattened, style);
      }
      return flattened;
    }
    return styles as NativeStyle;
  },
  absoluteFill: Object.freeze({
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  } as const),
  absoluteFillObject: Object.freeze({
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  } as const),
});

export interface ScaledSize {
  width: number;
  height: number;
  scale: number;
  fontScale: number;
}

let currentWindowSize: ScaledSize = {
  width: 1280,
  height: 720,
  scale: 1,
  fontScale: 1,
};

const dimensionListeners = new Set<
  (event: { window: ScaledSize; screen: ScaledSize }) => void
>();

export const Dimensions = Object.freeze({
  get(dim: "window" | "screen"): ScaledSize {
    void dim;
    return { ...currentWindowSize };
  },
  set(size: Partial<ScaledSize>): void {
    currentWindowSize = { ...currentWindowSize, ...size };
    const payload = {
      window: { ...currentWindowSize },
      screen: { ...currentWindowSize },
    };
    dimensionListeners.forEach((listener) => {
      listener(payload);
    });
  },
  addEventListener(
    type: "change",
    handler: (event: { window: ScaledSize; screen: ScaledSize }) => void,
  ): { remove: () => void } {
    dimensionListeners.add(handler);
    return {
      remove: () => {
        dimensionListeners.delete(handler);
      },
    };
  },
});

export function useWindowDimensions(): ScaledSize {
  const [dimensions, setDimensions] = useState<ScaledSize>(Dimensions.get("window"));
  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ window }) => {
      setDimensions(window);
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return dimensions;
}

export function useColorScheme(): "dark" | "light" {
  const [scheme, setScheme] = useState<"dark" | "light">(
    () => Appearance.getColorScheme() ?? "dark",
  );
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setScheme(colorScheme ?? "dark");
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return scheme;
}

export interface PlatformSelectOptions<T> {
  readonly sevynos?: T;
  readonly native?: T;
  readonly default?: T;
  readonly web?: T;
  readonly macos?: T;
  readonly linux?: T;
  readonly ios?: T;
  readonly android?: T;
}

export const Platform = Object.freeze({
  OS: "sevynos" as const,
  Version: "1.0.0",
  isTesting: false,
  isTV: false,
  select<T>(options: PlatformSelectOptions<T>): T | undefined {
    if ("sevynos" in options) return options.sevynos;
    if ("native" in options) return options.native;
    if ("linux" in options) return options.linux;
    return options.default;
  },
});

export interface AlertButton {
  readonly text?: string;
  readonly onPress?: () => void;
  readonly style?: "default" | "cancel" | "destructive";
}

export const Alert = Object.freeze({
  alert(title: string, message?: string, buttons?: readonly AlertButton[]): void {
    if (typeof console !== "undefined") {
      console.log(`[Alert] ${title}: ${message ?? ""}`);
    }
    const defaultButton = buttons?.[0];
    if (defaultButton?.onPress) {
      defaultButton.onPress();
    }
  },
});
