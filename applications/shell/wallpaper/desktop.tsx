/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopWallpaperRenderInput, DesktopWallpaperStyle } from "../desktop.js";

/**
 * One soft light field in a wallpaper variant. Positions mirror the
 * absolute-positioned aura Views in the stylesheet below.
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

const DEFAULT_SOLID_COLOR = "#090b11";

function solidColor(color: string | undefined): string {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : DEFAULT_SOLID_COLOR;
}

/**
 * Pure variant table, exported for tests. The RN framework exposes no
 * app-level gradient style prop, so every variant is built from solid
 * colors and opacity — the same constraint the file tiles work under.
 * "default" is the signature violet/gold/cyan gradient; "cosmic" is a
 * second gradient in the same visual language (magenta/teal nebula over
 * deep indigo); "minimal" is a near-flat field with a single faint aura;
 * "solid" is the chosen color, flat.
 */
export function wallpaperVariantFor(
  style: DesktopWallpaperStyle | undefined,
  color: string | undefined,
): WallpaperVariantSpec {
  const base = solidColor(color);
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
        background: SevynShellTheme.colors.background,
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

/**
 * Desktop wallpaper rendered as a React Native component.
 * Renders the selected wallpaper variant for every connected display,
 * positioned at each display's bounds. Pure function of the render input;
 * the host drives re-renders when displays or settings change, so picking
 * a new style applies without a restart.
 */
export function DesktopWallpaper(input: DesktopWallpaperRenderInput): JSX.Element {
  const variant = wallpaperVariantFor(input.wallpaperStyle, input.wallpaperColor);
  return (
    <View pointerEvents="none" style={styles.root}>
      {input.displays.map((display) => (
        <View
          key={display.id}
          pointerEvents="none"
          style={[
            styles.display,
            {
              backgroundColor: variant.background,
              left: display.bounds.x,
              top: display.bounds.y,
              width: display.bounds.width,
              height: display.bounds.height,
            },
          ]}
        >
          {variant.auras.map((aura, index) => (
            <View
              key={index}
              style={[
                styles.aura,
                {
                  backgroundColor: aura.backgroundColor,
                  width: aura.width,
                  height: aura.height,
                  ...(aura.top !== undefined ? { top: aura.top } : {}),
                  ...(aura.right !== undefined ? { right: aura.right } : {}),
                  ...(aura.bottom !== undefined ? { bottom: aura.bottom } : {}),
                  ...(aura.left !== undefined ? { left: aura.left } : {}),
                },
              ]}
            />
          ))}
          {variant.horizon ? <View style={styles.horizon} /> : null}
          {variant.grain ? <View style={styles.grain} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  display: {
    overflow: "hidden",
    position: "absolute",
  },
  aura: {
    borderRadius: SevynShellTheme.radius.round,
    position: "absolute",
  },
  horizon: {
    backgroundColor: "rgba(139, 156, 254, 0.08)",
    height: 240,
    left: -80,
    position: "absolute",
    right: -80,
    top: "40%",
    transform: [{ rotate: "-6deg" }],
  },
  grain: {
    backgroundColor: "rgba(6, 8, 15, 0.35)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
});
