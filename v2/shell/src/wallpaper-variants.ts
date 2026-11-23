// SevynOS v2 — desktop wallpaper variants (port of #123).
//
// Pure variant table: style + solid color in, paint spec out. The
// host painter has no gradient primitive, so every variant is built
// from solid colors and opacity — the same constraint the file tiles
// work under. "default" is the signature violet/gold/cyan gradient;
// "cosmic" is a second gradient in the same visual language
// (magenta/teal nebula over deep indigo); "minimal" is a near-flat
// field with a single faint aura; "solid" is the chosen color, flat.
// "macos" is the macOS-style colorful abstract — warm orange,
// magenta, and purple auras over a deep midnight base, in the
// spirit of the Sonoma / Sequoia default wallpapers.
// Custom image wallpapers are not supported (same call as #123:
// the image loader only accepts http(s), data URIs, or files under
// the app asset roots, and there is no binary read for user files).

export type WallpaperStyle = "default" | "solid" | "cosmic" | "minimal" | "macos";

export const WALLPAPER_STYLES: readonly { label: string; value: WallpaperStyle }[] = [
  { label: "Default", value: "default" },
  { label: "Solid", value: "solid" },
  { label: "Cosmic", value: "cosmic" },
  { label: "Minimal", value: "minimal" },
  { label: "macOS", value: "macos" },
];

/** Flat colors offered for the solid wallpaper style. */
export const WALLPAPER_COLORS: readonly { name: string; value: string }[] = [
  { name: "Sevyn Night", value: "#090b11" },
  { name: "Slate", value: "#1E293B" },
  { name: "Indigo", value: "#312E81" },
  { name: "Violet", value: "#4C1D95" },
  { name: "Crimson", value: "#7F1D1D" },
  { name: "Forest", value: "#14532D" },
  { name: "Amber", value: "#78350F" },
  { name: "Teal", value: "#0F766E" },
];

export const DEFAULT_WALLPAPER_STYLE: WallpaperStyle = "default";
export const DEFAULT_WALLPAPER_COLOR = "#090b11";

export function isWallpaperStyle(
  value: string | null | undefined,
): value is WallpaperStyle {
  return (
    value === "default" ||
    value === "solid" ||
    value === "cosmic" ||
    value === "minimal" ||
    value === "macos"
  );
}

export function isWallpaperColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** Repair a stored value to the default when it is not a valid style. */
export function normalizeWallpaperStyle(
  value: string | null | undefined,
): WallpaperStyle {
  return isWallpaperStyle(value) ? value : DEFAULT_WALLPAPER_STYLE;
}

/** Repair a stored value to the default when it is not a #rrggbb color. */
export function normalizeWallpaperColor(value: string | null | undefined): string {
  return isWallpaperColor(value) ? (value as string) : DEFAULT_WALLPAPER_COLOR;
}

/**
 * One soft light field in a wallpaper variant. Positions mirror the
 * absolute-positioned aura Views in Wallpaper.tsx; percentage
 * positions resolve against the desktop size (the host's
 * yogaSetStyle supports them).
 */
export interface WallpaperAuraSpec {
  readonly backgroundColor: string;
  readonly width: number;
  readonly height: number;
  readonly top?: number | `${number}%` | undefined;
  readonly right?: number | `${number}%` | undefined;
  readonly bottom?: number | `${number}%` | undefined;
  readonly left?: number | `${number}%` | undefined;
}

export interface WallpaperVariantSpec {
  /** Flat base color behind the auras. */
  readonly background: string;
  readonly auras: readonly WallpaperAuraSpec[];
  readonly horizon: boolean;
  readonly grain: boolean;
}

export function wallpaperVariantFor(
  style: WallpaperStyle | undefined,
  color: string | undefined,
): WallpaperVariantSpec {
  const base = normalizeWallpaperColor(color);
  switch (style) {
    case "solid":
      return Object.freeze({
        background: base,
        auras: Object.freeze([]),
        horizon: false,
        grain: false,
      });
    case "cosmic":
      return Object.freeze({
        background: "#0b0620",
        auras: Object.freeze([
          Object.freeze({
            backgroundColor: "rgba(217, 70, 239, 0.22)",
            width: 520,
            height: 520,
            top: -160,
            left: -120,
          }),
          Object.freeze({
            backgroundColor: "rgba(45, 212, 191, 0.16)",
            width: 420,
            height: 420,
            bottom: -180,
            right: -140,
          }),
          Object.freeze({
            backgroundColor: "rgba(139, 92, 246, 0.14)",
            width: 300,
            height: 300,
            top: "45%",
            left: "55%",
          }),
        ]),
        horizon: true,
        grain: true,
      });
    case "macos":
      return Object.freeze({
        background: "#0c0a26",
        auras: Object.freeze([
          Object.freeze({
            backgroundColor: "rgba(139, 92, 246, 0.24)",
            width: 460,
            height: 460,
            top: -140,
            left: -160,
          }),
          Object.freeze({
            backgroundColor: "rgba(217, 70, 239, 0.24)",
            width: 480,
            height: 480,
            top: -160,
            right: -160,
          }),
          Object.freeze({
            backgroundColor: "rgba(249, 115, 22, 0.26)",
            width: 560,
            height: 560,
            bottom: -180,
            left: -140,
          }),
          Object.freeze({
            backgroundColor: "rgba(59, 130, 246, 0.22)",
            width: 440,
            height: 440,
            bottom: -200,
            right: -120,
          }),
        ]),
        horizon: true,
        grain: true,
      });
    case "minimal":
      return Object.freeze({
        background: base,
        auras: Object.freeze([
          Object.freeze({
            backgroundColor: "rgba(255, 255, 255, 0.05)",
            width: 600,
            height: 600,
            top: -220,
            right: -200,
          }),
        ]),
        horizon: false,
        grain: false,
      });
    case "default":
    default:
      return Object.freeze({
        // The old shell theme's background (#06080F).
        background: "#06080F",
        auras: Object.freeze([
          Object.freeze({
            backgroundColor: "rgba(139, 156, 254, 0.20)",
            width: 480,
            height: 480,
            top: -140,
            right: -180,
          }),
          Object.freeze({
            backgroundColor: "rgba(240, 208, 138, 0.16)",
            width: 460,
            height: 460,
            bottom: -200,
            left: -160,
          }),
          Object.freeze({
            backgroundColor: "rgba(76, 145, 240, 0.12)",
            width: 320,
            height: 320,
            top: "30%",
            left: "10%",
          }),
        ]),
        horizon: true,
        grain: true,
      });
  }
}
