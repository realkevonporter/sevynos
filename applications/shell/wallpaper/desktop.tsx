import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { SevynShellTheme } from "../theme.js";

export function DesktopWallpaperApplication(): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.wallpaper}>
      {/* Ambient Cosmic Nebulae */}
      <View style={[styles.aura, styles.cosmicViolet]} />
      <View style={[styles.aura, styles.celestialGold]} />
      <View style={[styles.aura, styles.astralCyan]} />
      <View style={[styles.aura, styles.deepCenterGlow]} />

      {/* Architectural Coordinate Matrix */}
      <View style={styles.gridOverlay}>
        <View style={styles.gridLineHorizontal1} />
        <View style={styles.gridLineHorizontal2} />
        <View style={styles.gridLineVertical1} />
        <View style={styles.gridLineVertical2} />
      </View>

      {/* Central Sevyn Luxury Emblem Lattice */}
      <View style={styles.emblemContainer}>
        <View style={styles.diamondOuter}>
          <View style={styles.diamondInner} />
          <View style={styles.diamondCore} />
        </View>
        <View style={styles.crosshairH} />
        <View style={styles.crosshairV} />
      </View>

      {/* Atmospheric Vignette */}
      <View style={styles.ambientMesh} />
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
  cosmicViolet: {
    backgroundColor: "rgba(139, 156, 254, 0.18)",
    height: 1020,
    right: -260,
    top: -320,
    width: 1020,
  },
  celestialGold: {
    backgroundColor: "rgba(240, 208, 138, 0.14)",
    bottom: -380,
    height: 960,
    left: -280,
    width: 960,
  },
  astralCyan: {
    backgroundColor: "rgba(76, 145, 240, 0.14)",
    height: 720,
    left: "22%",
    top: -180,
    width: 720,
  },
  deepCenterGlow: {
    backgroundColor: "rgba(139, 156, 254, 0.08)",
    height: 760,
    left: "50%",
    marginLeft: -380,
    marginTop: -380,
    top: "50%",
    width: 760,
  },
  gridOverlay: {
    bottom: 0,
    left: 0,
    opacity: 0.4,
    position: "absolute",
    right: 0,
    top: 0,
  },
  gridLineHorizontal1: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
    top: "33%",
  },
  gridLineHorizontal2: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    bottom: "33%",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
  },
  gridLineVertical1: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    bottom: 0,
    left: "33%",
    position: "absolute",
    top: 0,
    width: 1,
  },
  gridLineVertical2: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    bottom: 0,
    position: "absolute",
    right: "33%",
    top: 0,
    width: 1,
  },
  emblemContainer: {
    alignItems: "center",
    height: 200,
    justifyContent: "center",
    left: "50%",
    marginLeft: -100,
    marginTop: -100,
    position: "absolute",
    top: "50%",
    width: 200,
  },
  diamondOuter: {
    alignItems: "center",
    borderColor: "rgba(240, 208, 138, 0.28)",
    borderRadius: 12,
    borderWidth: 1.5,
    height: 92,
    justifyContent: "center",
    transform: [{ rotate: "45deg" }],
    width: 92,
  },
  diamondInner: {
    alignItems: "center",
    borderColor: "rgba(139, 156, 254, 0.32)",
    borderRadius: 6,
    borderWidth: 1.2,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  diamondCore: {
    backgroundColor: "rgba(240, 208, 138, 0.40)",
    borderRadius: 3,
    height: 18,
    width: 18,
  },
  crosshairH: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    height: 1,
    position: "absolute",
    width: 150,
  },
  crosshairV: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    height: 150,
    position: "absolute",
    width: 1,
  },
  ambientMesh: {
    backgroundColor: "rgba(2, 6, 14, 0.25)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
});
