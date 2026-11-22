// SevynOS v2 — the desktop wallpaper.
//
// Renders the selected wallpaper variant as a full-screen layer
// behind the top bar, desktop icons, and dock (the top bar is
// opaque, so the wallpaper shows through only below it). Pure
// function of style + color; the shell re-reads the setting on
// render, so picking a new style applies when Settings closes.
//
// Deviation from #123: the horizon band is unrotated. The old
// wallpaper rotated it -6deg; the v2 host has no transform style
// prop, so the band renders straight.

import * as React from "react";
import { View } from "./host";
import { wallpaperVariantFor, type WallpaperStyle } from "./wallpaper-variants";

export interface WallpaperProps {
  style: WallpaperStyle;
  color: string;
}

export function Wallpaper(props: WallpaperProps): React.ReactElement {
  const variant = wallpaperVariantFor(props.style, props.color);
  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        backgroundColor: variant.background,
      }}
    >
      {variant.auras.map((aura, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            backgroundColor: aura.backgroundColor,
            width: aura.width,
            height: aura.height,
            borderRadius: Math.min(aura.width, aura.height) / 2,
            ...(aura.top !== undefined ? { top: aura.top } : {}),
            ...(aura.right !== undefined ? { right: aura.right } : {}),
            ...(aura.bottom !== undefined ? { bottom: aura.bottom } : {}),
            ...(aura.left !== undefined ? { left: aura.left } : {}),
          }}
        />
      ))}
      {variant.horizon ? (
        <View
          style={{
            position: "absolute",
            backgroundColor: "rgba(139, 156, 254, 0.08)",
            height: 240,
            left: -80,
            right: -80,
            top: "40%",
          }}
        />
      ) : null}
      {variant.grain ? (
        <View
          style={{
            position: "absolute",
            backgroundColor: "rgba(6, 8, 15, 0.35)",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
          }}
        />
      ) : null}
    </View>
  );
}
