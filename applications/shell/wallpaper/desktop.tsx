/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopWallpaperRenderInput } from "../desktop.js";

/**
 * Desktop wallpaper rendered as a React Native component.
 * Renders the signature SevynOS gradient wallpaper (violet/gold/cyan auras
 * over the deep-space background) for every connected display, positioned at
 * each display's bounds. Pure function of the render input; the host drives
 * re-renders when displays change.
 */
export function DesktopWallpaper(input: DesktopWallpaperRenderInput): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.root}>
      {input.displays.map((display) => (
        <View
          key={display.id}
          pointerEvents="none"
          style={[
            styles.display,
            {
              left: display.bounds.x,
              top: display.bounds.y,
              width: display.bounds.width,
              height: display.bounds.height,
            },
          ]}
        >
          <View style={[styles.aura, styles.violetAura]} />
          <View style={[styles.aura, styles.goldAura]} />
          <View style={[styles.aura, styles.cyanAura]} />
          <View style={styles.horizon} />
          <View style={styles.grain} />
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
    backgroundColor: SevynShellTheme.colors.background,
    overflow: "hidden",
    position: "absolute",
  },
  aura: {
    borderRadius: SevynShellTheme.radius.round,
    position: "absolute",
  },
  violetAura: {
    backgroundColor: "rgba(139, 156, 254, 0.20)",
    height: 480,
    right: -180,
    top: -140,
    width: 480,
  },
  goldAura: {
    backgroundColor: "rgba(240, 208, 138, 0.16)",
    bottom: -200,
    height: 460,
    left: -160,
    width: 460,
  },
  cyanAura: {
    backgroundColor: "rgba(76, 145, 240, 0.12)",
    height: 320,
    left: "10%",
    top: "30%",
    width: 320,
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
