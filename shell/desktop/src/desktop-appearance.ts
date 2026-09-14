import type { DesktopTheme } from "./desktop-settings.js";

export interface DesktopShadowAppearance {
  readonly color: string;
  readonly blur: number;
  readonly offsetY: number;
}

export interface DesktopWindowAppearance {
  readonly surface: string;
  readonly focusedBorder: string;
  readonly unfocusedBorder: string;
  readonly focusedTitleBar: string;
  readonly unfocusedTitleBar: string;
  readonly focusedTitle: string;
  readonly unfocusedTitle: string;
  readonly divider: string;
  readonly availableControl: string;
  readonly unavailableControl: string;
  readonly control: string;
  readonly unavailableControlIcon: string;
  readonly closeControl: string;
  readonly focusedShadow: DesktopShadowAppearance;
  readonly unfocusedShadow: DesktopShadowAppearance;
}

export interface DesktopAppearance {
  readonly mode: "dark" | "light";
  readonly background: {
    readonly start: string;
    readonly middle: string;
    readonly end: string;
    readonly glowStart: string;
    readonly glowMiddle: string;
    readonly grid: string;
  };
  readonly window: DesktopWindowAppearance;
  readonly taskbar: {
    readonly surface: string;
    readonly border: string;
    readonly text: string;
    readonly shadow: DesktopShadowAppearance;
  };
  readonly button: {
    readonly surface: string;
    readonly border: string;
    readonly activeBorder: string;
    readonly text: string;
    readonly activeText: string;
    readonly activeIndicator: string;
  };
  readonly launcher: {
    readonly surface: string;
    readonly border: string;
    readonly text: string;
    readonly iconEnd: string;
    readonly shadow: DesktopShadowAppearance;
  };
  readonly content: {
    readonly primary: string;
    readonly secondary: string;
    readonly success: string;
    readonly console: string;
  };
  readonly recovery: {
    readonly surface: string;
    readonly primary: string;
    readonly secondary: string;
  };
  readonly cursor: {
    readonly fill: string;
    readonly outline: string;
  };
}

export const DESKTOP_VISUAL_METRICS = deepFreeze({
  titleBarHeight: 46,
  backgroundGridSpacing: 96,
  backgroundGlowX: 0.72,
  backgroundGlowY: 0.18,
  backgroundGlowRadius: 0.58,
  windowRadius: 16,
  taskbarRadius: 16,
  buttonRadius: 13,
  launcherRadius: 16,
});

const DARK_DESKTOP_APPEARANCE: DesktopAppearance = deepFreeze({
  mode: "dark",
  background: {
    start: "#151A28",
    middle: "#181521",
    end: "#090B11",
    glowStart: "rgba(215, 172, 87, 0.22)",
    glowMiddle: "rgba(104, 143, 185, 0.14)",
    grid: "rgba(255, 255, 255, 0.045)",
  },
  window: {
    surface: "rgba(19, 20, 26, 0.94)",
    focusedBorder: "rgba(255, 255, 255, 0.26)",
    unfocusedBorder: "rgba(255, 255, 255, 0.08)",
    focusedTitleBar: "rgba(28, 29, 36, 0.96)",
    unfocusedTitleBar: "rgba(22, 23, 30, 0.94)",
    focusedTitle: "#F2F2F4",
    unfocusedTitle: "#9A9AA4",
    divider: "rgba(255, 255, 255, 0.08)",
    availableControl: "rgba(255, 255, 255, 0.075)",
    unavailableControl: "rgba(127, 127, 127, 0.035)",
    control: "#C7C8CD",
    unavailableControlIcon: "rgba(127, 127, 127, 0.30)",
    closeControl: "#D9656D",
    focusedShadow: { color: "rgba(0, 0, 0, 0.62)", blur: 42, offsetY: 16 },
    unfocusedShadow: { color: "rgba(0, 0, 0, 0.62)", blur: 26, offsetY: 10 },
  },
  taskbar: {
    surface: "rgba(28, 29, 36, 0.78)",
    border: "rgba(255, 255, 255, 0.12)",
    text: "rgba(235, 235, 240, 0.72)",
    shadow: { color: "rgba(0, 0, 0, 0.42)", blur: 28, offsetY: 8 },
  },
  button: {
    surface: "rgba(255, 255, 255, 0.075)",
    border: "rgba(255, 255, 255, 0.09)",
    activeBorder: "rgba(255, 255, 255, 0.24)",
    text: "#F0F0F3",
    activeText: "#211A0D",
    activeIndicator: "rgba(255, 255, 255, 0.72)",
  },
  launcher: {
    surface: "rgba(35, 36, 43, 0.94)",
    border: "rgba(255, 255, 255, 0.11)",
    text: "#F3F3F5",
    iconEnd: "#80622C",
    shadow: { color: "rgba(0, 0, 0, 0.42)", blur: 18, offsetY: 6 },
  },
  content: {
    primary: "#F5F7FF",
    secondary: "rgba(219, 226, 245, 0.82)",
    success: "#77D6A3",
    console: "#9EE6B8",
  },
  recovery: {
    surface: "rgba(7, 10, 18, 0.96)",
    primary: "#F5F7FF",
    secondary: "#DBE2F5",
  },
  cursor: { fill: "#FFFFFF", outline: "#090D18" },
});

const LIGHT_DESKTOP_APPEARANCE: DesktopAppearance = deepFreeze({
  mode: "light",
  background: {
    start: "#D8E2F0",
    middle: "#E9E1D8",
    end: "#B7C7D7",
    glowStart: "rgba(215, 172, 87, 0.24)",
    glowMiddle: "rgba(104, 143, 185, 0.12)",
    grid: "rgba(255, 255, 255, 0.16)",
  },
  window: {
    surface: "rgba(248, 249, 252, 0.94)",
    focusedBorder: "rgba(255, 255, 255, 0.86)",
    unfocusedBorder: "rgba(35, 39, 48, 0.12)",
    focusedTitleBar: "rgba(255, 255, 255, 0.82)",
    unfocusedTitleBar: "rgba(241, 243, 247, 0.90)",
    focusedTitle: "#26272C",
    unfocusedTitle: "#26272C",
    divider: "rgba(25, 27, 33, 0.08)",
    availableControl: "rgba(25, 27, 33, 0.055)",
    unavailableControl: "rgba(127, 127, 127, 0.035)",
    control: "#555861",
    unavailableControlIcon: "rgba(127, 127, 127, 0.30)",
    closeControl: "#D9656D",
    focusedShadow: { color: "rgba(33, 39, 52, 0.26)", blur: 42, offsetY: 16 },
    unfocusedShadow: { color: "rgba(33, 39, 52, 0.26)", blur: 26, offsetY: 10 },
  },
  taskbar: {
    surface: "rgba(249, 250, 252, 0.76)",
    border: "rgba(255, 255, 255, 0.78)",
    text: "rgba(43, 45, 52, 0.64)",
    shadow: { color: "rgba(30, 36, 48, 0.18)", blur: 28, offsetY: 8 },
  },
  button: {
    surface: "rgba(255, 255, 255, 0.62)",
    border: "rgba(34, 37, 45, 0.08)",
    activeBorder: "rgba(255, 255, 255, 0.24)",
    text: "#303138",
    activeText: "#211A0D",
    activeIndicator: "rgba(33, 26, 13, 0.55)",
  },
  launcher: {
    surface: "rgba(250, 251, 253, 0.90)",
    border: "rgba(30, 33, 40, 0.10)",
    text: "#292A30",
    iconEnd: "#B78432",
    shadow: { color: "rgba(31, 36, 46, 0.16)", blur: 18, offsetY: 6 },
  },
  content: {
    primary: "#26272C",
    secondary: "rgba(43, 45, 52, 0.76)",
    success: "#287A52",
    console: "#287A52",
  },
  recovery: {
    surface: "rgba(242, 245, 250, 0.97)",
    primary: "#26272C",
    secondary: "#555861",
  },
  cursor: { fill: "#FFFFFF", outline: "#090D18" },
});

export function resolveDesktopAppearance(theme: DesktopTheme): DesktopAppearance {
  return theme === "light" ? LIGHT_DESKTOP_APPEARANCE : DARK_DESKTOP_APPEARANCE;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
