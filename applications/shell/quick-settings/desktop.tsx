/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useState, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from "react-native";
import { SevynShellTheme } from "../theme.js";

export interface DesktopQuickSettingsProps {
  readonly open?: boolean;
  readonly wifiEnabled?: boolean;
  readonly wifiName?: string;
  readonly bluetoothEnabled?: boolean;
  readonly airplaneMode?: boolean;
  readonly doNotDisturb?: boolean;
  readonly brightness?: number;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly batteryPercent?: number;
  readonly batteryCharging?: boolean;
  readonly onClose?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onLock?: () => Promise<void> | void;
  readonly onSetWifiEnabled?: (enabled: boolean) => Promise<void> | void;
  readonly onSetBluetoothEnabled?: (enabled: boolean) => Promise<void> | void;
  readonly onSetAirplaneMode?: (enabled: boolean) => Promise<void> | void;
  readonly onSetDoNotDisturb?: (enabled: boolean) => Promise<void> | void;
  readonly onSetBrightness?: (level: number) => Promise<void> | void;
  readonly onSetVolume?: (level: number) => Promise<void> | void;
  readonly onSetMuted?: (muted: boolean) => Promise<void> | void;
}

/**
 * Desktop control center rendered as a React Native component, macOS-style.
 * A floating panel anchored to the top-right of the display with a grid of
 * connectivity toggles, brightness/volume sliders, and battery status.
 * It owns only transient presentation state; every change is an explicit
 * host callback.
 */
export function DesktopQuickSettings({
  open = true,
  wifiEnabled,
  wifiName,
  bluetoothEnabled,
  airplaneMode,
  doNotDisturb,
  brightness,
  volume,
  muted,
  batteryPercent = 100,
  batteryCharging = false,
  onClose,
  onOpenSettings,
  onLock,
  onSetWifiEnabled,
  onSetBluetoothEnabled,
  onSetAirplaneMode,
  onSetDoNotDisturb,
  onSetBrightness,
  onSetVolume,
  onSetMuted,
}: DesktopQuickSettingsProps = {}): JSX.Element | null {
  const [localWifi, setLocalWifi] = useState(true);
  const [localBluetooth, setLocalBluetooth] = useState(false);
  const [localAirplaneMode, setLocalAirplaneMode] = useState(false);
  const [localDoNotDisturb, setLocalDoNotDisturb] = useState(false);
  const [localBrightness, setLocalBrightness] = useState(0.78);
  const [localVolume, setLocalVolume] = useState(0.62);
  const [localMuted, setLocalMuted] = useState(false);
  const [operationError, setOperationError] = useState<string>();

  if (!open) return null;

  const resolvedWifi = wifiEnabled ?? localWifi;
  const resolvedBluetooth = bluetoothEnabled ?? localBluetooth;
  const resolvedAirplane = airplaneMode ?? localAirplaneMode;
  const resolvedFocus = doNotDisturb ?? localDoNotDisturb;
  const resolvedBrightness = clampLevel(brightness ?? localBrightness);
  const resolvedVolume = clampLevel(volume ?? localVolume);
  const resolvedMuted = muted ?? localMuted;
  const batteryLevel = clampLevel(batteryPercent / 100);
  const batteryFillWidth: DimensionValue =
    `${String(Math.round(batteryLevel * 100))}%` as DimensionValue;

  const updateToggle = (
    controlledValue: boolean | undefined,
    nextValue: boolean,
    setLocal: (enabled: boolean) => void,
    callback: ((enabled: boolean) => Promise<void> | void) | undefined,
    fallbackError: string,
  ): void => {
    const previous = controlledValue;
    if (controlledValue === undefined) setLocal(nextValue);
    setOperationError(undefined);
    Promise.resolve(callback?.(nextValue)).catch((error: unknown) => {
      if (previous === undefined) setLocal(!nextValue);
      setOperationError(messageForError(error, fallbackError));
    });
  };

  const updateLevel = (
    controlledValue: number | undefined,
    currentValue: number,
    delta: number,
    setLocal: (level: number) => void,
    callback: ((level: number) => Promise<void> | void) | undefined,
    fallbackError: string,
  ): void => {
    const nextValue = clampLevel(currentValue + delta);
    if (controlledValue === undefined) setLocal(nextValue);
    setOperationError(undefined);
    Promise.resolve(callback?.(nextValue)).catch((error: unknown) => {
      if (controlledValue === undefined) setLocal(currentValue);
      setOperationError(messageForError(error, fallbackError));
    });
  };

  return (
    <View
      accessibilityLabel="Control center"
      accessibilityViewIsModal
      style={styles.overlay}
    >
      <Pressable
        accessibilityLabel="Close control center"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View style={styles.panel}>
        <View style={styles.specularLine} />
        <View style={styles.header}>
          <Text style={styles.title}>Control Center</Text>
          <Pressable
            accessibilityLabel="Close control center"
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        {operationError === undefined ? null : (
          <Pressable
            accessibilityRole="alert"
            onPress={() => {
              setOperationError(undefined);
            }}
            style={styles.errorBanner}
          >
            <Text style={styles.errorText}>{operationError}</Text>
          </Pressable>
        )}

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          style={styles.scroller}
        >
          <View style={styles.toggleGrid}>
            <ControlTile
              active={resolvedWifi && !resolvedAirplane}
              disabled={resolvedAirplane}
              glyph="⌁"
              label="Wi-Fi"
              onPress={() => {
                updateToggle(
                  wifiEnabled,
                  !resolvedWifi,
                  setLocalWifi,
                  onSetWifiEnabled,
                  "Wi-Fi could not be changed.",
                );
              }}
              subtitle={
                resolvedAirplane
                  ? "Airplane mode"
                  : resolvedWifi
                    ? (wifiName ?? "Connected")
                    : "Off"
              }
            />
            <ControlTile
              active={resolvedBluetooth && !resolvedAirplane}
              disabled={resolvedAirplane}
              glyph="ᛒ"
              label="Bluetooth"
              onPress={() => {
                updateToggle(
                  bluetoothEnabled,
                  !resolvedBluetooth,
                  setLocalBluetooth,
                  onSetBluetoothEnabled,
                  "Bluetooth could not be changed.",
                );
              }}
              subtitle={
                resolvedAirplane ? "Airplane mode" : resolvedBluetooth ? "On" : "Off"
              }
            />
            <ControlTile
              active={resolvedAirplane}
              glyph="✈"
              label="Airplane"
              onPress={() => {
                updateToggle(
                  airplaneMode,
                  !resolvedAirplane,
                  setLocalAirplaneMode,
                  onSetAirplaneMode,
                  "Airplane mode could not be changed.",
                );
              }}
              subtitle={resolvedAirplane ? "On" : "Off"}
            />
            <ControlTile
              active={resolvedFocus}
              glyph="◐"
              label="Focus"
              onPress={() => {
                updateToggle(
                  doNotDisturb,
                  !resolvedFocus,
                  setLocalDoNotDisturb,
                  onSetDoNotDisturb,
                  "Focus mode could not be changed.",
                );
              }}
              subtitle={resolvedFocus ? "Quiet" : "Available"}
            />
          </View>

          <LevelSlider
            glyph="☀"
            label="Brightness"
            level={resolvedBrightness}
            onDecrease={() => {
              updateLevel(
                brightness,
                resolvedBrightness,
                -0.1,
                setLocalBrightness,
                onSetBrightness,
                "Brightness could not be changed.",
              );
            }}
            onIncrease={() => {
              updateLevel(
                brightness,
                resolvedBrightness,
                0.1,
                setLocalBrightness,
                onSetBrightness,
                "Brightness could not be changed.",
              );
            }}
          />
          <LevelSlider
            glyph={resolvedMuted || resolvedVolume === 0 ? "×" : "♪"}
            label="Volume"
            level={resolvedMuted ? 0 : resolvedVolume}
            onDecrease={() => {
              if (resolvedMuted) {
                updateToggle(
                  muted,
                  false,
                  setLocalMuted,
                  onSetMuted,
                  "Volume could not be changed.",
                );
                return;
              }
              updateLevel(
                volume,
                resolvedVolume,
                -0.1,
                setLocalVolume,
                onSetVolume,
                "Volume could not be changed.",
              );
            }}
            onIncrease={() => {
              if (resolvedMuted) {
                updateToggle(
                  muted,
                  false,
                  setLocalMuted,
                  onSetMuted,
                  "Volume could not be changed.",
                );
                return;
              }
              updateLevel(
                volume,
                resolvedVolume,
                0.1,
                setLocalVolume,
                onSetVolume,
                "Volume could not be changed.",
              );
            }}
            onToggleMute={() => {
              updateToggle(
                muted,
                !resolvedMuted,
                setLocalMuted,
                onSetMuted,
                "Mute could not be changed.",
              );
            }}
          />

          <View
            accessibilityLabel={`Battery ${String(Math.round(batteryLevel * 100))} percent${batteryCharging ? ", charging" : ""}`}
            style={styles.batteryCard}
          >
            <View style={styles.batteryShell}>
              <View style={[styles.batteryFill, { width: batteryFillWidth }]} />
            </View>
            <Text style={styles.batteryText}>
              {batteryCharging ? "⚡ " : ""}
              {Math.round(batteryLevel * 100)}%
            </Text>
            <Text style={styles.batteryLabel}>
              {batteryCharging ? "Charging" : "Battery"}
            </Text>
          </View>

          <View style={styles.footerActions}>
            <Pressable
              accessibilityLabel="Lock device"
              accessibilityRole="button"
              onPress={() => {
                void Promise.resolve(onLock?.()).catch((error: unknown) => {
                  setOperationError(
                    messageForError(error, "The device could not be locked."),
                  );
                });
              }}
              style={({ pressed }) => [styles.footerButton, pressed && styles.pressed]}
            >
              <Text style={styles.footerGlyph}>◇</Text>
              <Text style={styles.footerText}>Lock</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Open system settings"
              accessibilityRole="button"
              onPress={onOpenSettings}
              style={({ pressed }) => [styles.footerButton, pressed && styles.pressed]}
            >
              <Text style={styles.footerGlyph}>⚙</Text>
              <Text style={styles.footerText}>Settings</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function ControlTile({
  active,
  disabled = false,
  glyph,
  label,
  onPress,
  subtitle,
}: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly glyph: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly subtitle: string;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={`${label}, ${subtitle}`}
      accessibilityRole="switch"
      accessibilityState={{ checked: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        active && styles.tileActive,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.tileGlyph, active && styles.tileGlyphActive]}>
        <Text style={[styles.tileGlyphText, active && styles.tileGlyphTextActive]}>
          {glyph}
        </Text>
      </View>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.tileSubtitle}>
        {subtitle}
      </Text>
    </Pressable>
  );
}

function LevelSlider({
  glyph,
  label,
  level,
  onDecrease,
  onIncrease,
  onToggleMute,
}: {
  readonly glyph: string;
  readonly label: string;
  readonly level: number;
  readonly onDecrease: () => void;
  readonly onIncrease: () => void;
  readonly onToggleMute?: () => void;
}): JSX.Element {
  const percentage = Math.round(level * 100);
  return (
    <View
      accessibilityLabel={`${label}, ${String(percentage)} percent`}
      accessibilityRole="adjustable"
      style={styles.levelCard}
    >
      <View style={styles.levelHeader}>
        {onToggleMute === undefined ? (
          <Text style={styles.levelGlyph}>{glyph}</Text>
        ) : (
          <Pressable
            accessibilityLabel={
              level === 0
                ? `Unmute ${label.toLocaleLowerCase()}`
                : `Mute ${label.toLocaleLowerCase()}`
            }
            accessibilityRole="button"
            onPress={onToggleMute}
            style={({ pressed }) => [styles.levelGlyphButton, pressed && styles.pressed]}
          >
            <Text style={styles.levelGlyph}>{glyph}</Text>
          </Pressable>
        )}
        <Text style={styles.levelLabel}>{label}</Text>
        <Text style={styles.levelValue}>{percentage}%</Text>
      </View>
      <View style={styles.levelRow}>
        <Pressable
          accessibilityLabel={`Decrease ${label.toLocaleLowerCase()}`}
          accessibilityRole="button"
          disabled={level <= 0}
          onPress={onDecrease}
          style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <View style={styles.levelTrack}>
          <View
            style={[
              styles.levelFill,
              { width: `${String(percentage)}%` as DimensionValue },
            ]}
          />
          <View
            style={[
              styles.levelThumb,
              { left: `${String(percentage)}%` as DimensionValue },
            ]}
          />
        </View>
        <Pressable
          accessibilityLabel={`Increase ${label.toLocaleLowerCase()}`}
          accessibilityRole="button"
          disabled={level >= 1}
          onPress={onIncrease}
          style={({ pressed }) => [styles.stepButton, pressed && styles.pressed]}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

const styles = StyleSheet.create({
  overlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1500,
  },
  backdrop: {
    backgroundColor: "rgba(1, 3, 8, 0.30)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  panel: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.launcherBorder,
    borderRadius: SevynShellTheme.radius.xl,
    borderWidth: 1,
    maxHeight: "86%",
    overflow: "hidden",
    paddingTop: 16,
    position: "absolute",
    right: 12,
    top: 60,
    width: 340,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    borderRadius: 1,
    height: 1,
    left: 24,
    position: "absolute",
    right: 24,
    top: 0,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 14,
    borderWidth: 1,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  closeText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 19,
    fontWeight: "300",
    lineHeight: 21,
  },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.32)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginBottom: 10,
    marginHorizontal: 18,
    padding: 10,
  },
  errorText: { color: "#FFB7BC", fontSize: 11 },
  scroller: { flexGrow: 0 },
  content: { gap: 10, paddingBottom: 20, paddingHorizontal: 18 },
  toggleGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    minHeight: 104,
    padding: 12,
    width: "48%",
  },
  tileActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(139, 156, 254, 0.42)",
  },
  tileGlyph: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 15,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  tileGlyphActive: { backgroundColor: SevynShellTheme.colors.accent },
  tileGlyphText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 16,
    fontWeight: "700",
  },
  tileGlyphTextActive: { color: "#FFFFFF" },
  tileLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 9,
  },
  tileSubtitle: { color: SevynShellTheme.colors.muted, fontSize: 10, marginTop: 2 },
  levelCard: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    padding: 12,
  },
  levelHeader: { alignItems: "center", flexDirection: "row" },
  levelGlyph: { color: SevynShellTheme.colors.gold, fontSize: 15, width: 22 },
  levelGlyphButton: {
    alignItems: "center",
    borderRadius: 11,
    height: 24,
    justifyContent: "center",
    marginRight: 2,
    width: 24,
  },
  levelLabel: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
  },
  levelValue: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "700",
  },
  levelRow: { alignItems: "center", flexDirection: "row", gap: 9, marginTop: 10 },
  stepButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 12,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  stepText: { color: SevynShellTheme.colors.primary, fontSize: 15, lineHeight: 17 },
  levelTrack: {
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 4,
    flex: 1,
    height: 8,
    position: "relative",
  },
  levelFill: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 4,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  levelThumb: {
    backgroundColor: "#FFFFFF",
    borderRadius: 6,
    height: 12,
    marginLeft: -6,
    marginTop: -2,
    position: "absolute",
    width: 12,
  },
  batteryCard: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 12,
  },
  batteryShell: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 4,
    borderWidth: 1,
    height: 12,
    overflow: "hidden",
    padding: 1.5,
    width: 26,
  },
  batteryFill: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: 1,
    height: "100%",
  },
  batteryText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    fontWeight: "700",
  },
  batteryLabel: {
    color: SevynShellTheme.colors.muted,
    flex: 1,
    fontSize: 11,
    textAlign: "right",
  },
  footerActions: { flexDirection: "row", gap: 10 },
  footerButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 40,
  },
  footerGlyph: { color: SevynShellTheme.colors.gold, fontSize: 13, fontWeight: "700" },
  footerText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "700",
  },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.62 },
});
