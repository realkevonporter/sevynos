import type { SevynSemanticColors } from "./tokens.js";

export interface NativeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type NativeInteractionState =
  "idle" | "hovered" | "focused" | "pressed" | "disabled";
export type NativeControlAction =
  | "theme"
  | "accent"
  | "taskbar-position"
  | "taskbar-behavior"
  | "display-layout"
  | "workspace-count"
  | "cursor-size"
  | "reduced-motion"
  | "restore-session"
  | "installer-launch"
  | "application-restart"
  | "application-close"
  | "application-diagnostics"
  | "custom"
  | (string & {});

export const SEVYN_RENDER_PROTOCOL_VERSION = 2 as const;

export interface NativeCornerRadii {
  readonly topLeft?: number;
  readonly topRight?: number;
  readonly bottomLeft?: number;
  readonly bottomRight?: number;
}

export interface NativeShadow {
  readonly color: string;
  readonly blur: number;
  readonly y: number;
  readonly x?: number;
  readonly opacity?: number;
}

export interface NativeGradientStop {
  readonly offset: number;
  readonly color: string;
}

export interface NativeLinearGradient {
  readonly kind: "linear";
  readonly angle?: number;
  readonly stops: readonly NativeGradientStop[];
}

export interface NativeRadialGradient {
  readonly kind: "radial";
  readonly stops: readonly NativeGradientStop[];
}

export type NativeGradient = NativeLinearGradient | NativeRadialGradient;

interface NativeCommandBase {
  readonly id: string;
  readonly bounds: NativeBounds;
  readonly opacity?: number;
}
export interface NativeMaterialCommand extends NativeCommandBase {
  readonly kind: "material";
  readonly color: string;
  readonly radius: number;
  readonly radii?: NativeCornerRadii;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly borderStyle?: "solid" | "dotted" | "dashed";
  readonly shadow?: NativeShadow;
  readonly blur?: number;
  readonly backdropBlur?: number;
  readonly gradient?: NativeGradient;
  readonly blink?: boolean;
}
export interface NativeTextCommand extends NativeCommandBase {
  readonly kind: "text";
  readonly text: string;
  readonly color: string;
  readonly size: number;
  readonly weight: number;
  readonly align?: "start" | "center" | "end";
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly fontFamily?: string;
  readonly fontStyle?: "normal" | "italic";
  readonly wrap?: boolean;
  readonly lines?: readonly string[];
  readonly measuredWidth?: number;
  readonly measuredHeight?: number;
}
export interface NativeIconCommand extends NativeCommandBase {
  readonly kind: "icon";
  readonly icon: SevynIconName;
  readonly color: string;
}
export interface NativeBitmapCommand extends NativeCommandBase {
  readonly kind: "bitmap";
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}
export interface NativeControlCommand extends NativeCommandBase {
  readonly kind: "control";
  readonly action: NativeControlAction;
  readonly label: string;
  readonly value: string;
  readonly state: NativeInteractionState;
  readonly accent: string;
  readonly foreground: string;
  readonly background: string;
  readonly radius: number;
  readonly radii?: NativeCornerRadii;
  readonly borderWidth?: number;
  readonly borderColor?: string;
  readonly borderStyle?: "solid" | "dotted" | "dashed";
  readonly shadow?: NativeShadow;
}
export interface NativeSeparatorCommand extends NativeCommandBase {
  readonly kind: "separator";
  readonly color: string;
}
export interface NativeClipCommand extends NativeCommandBase {
  readonly kind: "clip-start" | "clip-end";
}
export interface NativeGradientCommand extends NativeCommandBase {
  readonly kind: "gradient";
  readonly gradient: NativeGradient;
  readonly radius: number;
  readonly radii?: NativeCornerRadii;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly borderStyle?: "solid" | "dotted" | "dashed";
}
export type NativeRenderCommand =
  | NativeMaterialCommand
  | NativeTextCommand
  | NativeIconCommand
  | NativeBitmapCommand
  | NativeControlCommand
  | NativeSeparatorCommand
  | NativeClipCommand
  | NativeGradientCommand;
export type SevynIconName =
  | "appearance"
  | "color"
  | "display"
  | "workspace"
  | "pointer"
  | "motion"
  | "history"
  | "controls"
  | "gallery"
  | "search"
  // Application icons: monochrome line-art renditions of the per-app SVG
  // icon sets under applications/<app>/icons/<app>.svg. Rendered white on
  // the app's brand tile by ApplicationIcon (applications/shell).
  | "app-browser"
  | "app-calculator"
  | "app-camera"
  | "app-files"
  | "app-music"
  | "app-notes"
  | "app-settings"
  | "app-sevyn-code"
  | "app-store"
  | "app-system-monitor"
  | "app-terminal"
  | "app-text-editor"
  | "app-welcome"
  // Generic UI glyphs (emoji-free iconography for apps and shell).
  | "home"
  | "monitor"
  | "file-text"
  | "download"
  | "image"
  | "music-note"
  | "film"
  | "trash"
  | "folder"
  | "globe"
  | "gear"
  | "book"
  | "star"
  | "wifi"
  | "volume"
  | "battery"
  | "clock"
  | "package"
  | "keyboard"
  | "info"
  | "check"
  | "warning"
  | "lock"
  | "heart"
  | "airplane"
  | "brightness"
  | "zap"
  | "hard-drive"
  | "menu"
  | "grid"
  | "edit"
  | "x"
  | "refresh"
  | "moon"
  | "bluetooth";

export interface NativeApplicationSurfaceSnapshot {
  readonly kind: "sevyn-native-surface";
  readonly application: "settings" | "gallery";
  readonly appearance: "light" | "dark";
  readonly colors: SevynSemanticColors;
  readonly reducedMotion: boolean;
  readonly commands: readonly NativeRenderCommand[];
}

export function freezeSurface(
  surface: NativeApplicationSurfaceSnapshot,
): NativeApplicationSurfaceSnapshot {
  return Object.freeze({ ...surface, commands: Object.freeze([...surface.commands]) });
}
