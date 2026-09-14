import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { SevynShellTheme } from "../theme.js";

export function MobileWallpaperApplication(): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.wallpaper}>
      <View style={[styles.aura, styles.violetAura]} />
      <View style={[styles.aura, styles.goldAura]} />
      <View style={[styles.aura, styles.cyanAura]} />
      <View style={styles.horizon} />
      <View style={styles.grain} />
    </View>
  );
}

const styles = StyleSheet.create({
  wallpaper: {
    backgroundColor: SevynShellTheme.colors.background,
    bottom: 0,
    left: 0,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: 0,
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
