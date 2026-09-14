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

export interface QuickSettingsApplicationProps {
  readonly open?: boolean;
  readonly wifiEnabled?: boolean;
  readonly wifiName?: string;
  readonly bluetoothEnabled?: boolean;
  readonly airplaneMode?: boolean;
  readonly doNotDisturb?: boolean;
  readonly brightness?: number;
  readonly volume?: number;
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
}

export function QuickSettingsApplication({
  open = true,
  wifiEnabled,
  wifiName,
  bluetoothEnabled,
  airplaneMode,
  doNotDisturb,
  brightness,
  volume,
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
}: QuickSettingsApplicationProps = {}): JSX.Element | null {
  const [localWifi, setLocalWifi] = useState(true);
  const [localBluetooth, setLocalBluetooth] = useState(false);
  const [localAirplaneMode, setLocalAirplaneMode] = useState(false);
  const [localDoNotDisturb, setLocalDoNotDisturb] = useState(false);
  const [localBrightness, setLocalBrightness] = useState(0.78);
  const [localVolume, setLocalVolume] = useState(0.62);
  const [operationError, setOperationError] = useState<string>();

  if (!open) return null;

  const resolvedWifi = wifiEnabled ?? localWifi;
  const resolvedBluetooth = bluetoothEnabled ?? localBluetooth;
  const resolvedAirplane = airplaneMode ?? localAirplaneMode;
  const resolvedFocus = doNotDisturb ?? localDoNotDisturb;
  const resolvedBrightness = clampLevel(brightness ?? localBrightness);
  const resolvedVolume = clampLevel(volume ?? localVolume);
  const batteryFillWidth: DimensionValue =
    `${String(Math.round(clampLevel(batteryPercent / 100) * 100))}%` as DimensionValue;

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
      accessibilityLabel="Quick settings"
      accessibilityViewIsModal
      style={styles.overlay}
    >
      <Pressable
        accessibilityLabel="Close quick settings"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View style={styles.sheet}>
        <View style={styles.specularLine} />
        <View style={styles.handle} />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>CONTROL CENTER</Text>
            <Text style={styles.title}>Quick settings</Text>
          </View>
          <View style={styles.headerActions}>
            <View
              accessibilityLabel={`Battery ${String(Math.round(clampLevel(batteryPercent / 100) * 100))} percent${batteryCharging ? ", charging" : ""}`}
              style={styles.batteryPill}
            >
              <View style={styles.batteryShell}>
                <View
                  style={[
                    styles.batteryFill,
                    {
                      width: batteryFillWidth,
                    },
                  ]}
                />
              </View>
              <Text style={styles.batteryText}>
                {batteryCharging ? "⚡ " : ""}
                {Math.round(clampLevel(batteryPercent / 100) * 100)}%
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close quick settings"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
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
            <QuickSettingTile
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
            <QuickSettingTile
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
            <QuickSettingTile
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
            <QuickSettingTile
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

          <LevelControl
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
          <LevelControl
            glyph={resolvedVolume === 0 ? "×" : "♪"}
            label="Volume"
            level={resolvedVolume}
            onDecrease={() => {
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
              updateLevel(
                volume,
                resolvedVolume,
                0.1,
                setLocalVolume,
                onSetVolume,
                "Volume could not be changed.",
              );
            }}
          />

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

function QuickSettingTile({
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

function LevelControl({
  glyph,
  label,
  level,
  onDecrease,
  onIncrease,
}: {
  readonly glyph: string;
  readonly label: string;
  readonly level: number;
  readonly onDecrease: () => void;
  readonly onIncrease: () => void;
}): JSX.Element {
  const percentage = Math.round(level * 100);
  return (
    <View
      accessibilityLabel={`${label}, ${String(percentage)} percent`}
      accessibilityRole="adjustable"
      style={styles.levelCard}
    >
      <View style={styles.levelHeader}>
        <Text style={styles.levelGlyph}>{glyph}</Text>
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
    backgroundColor: "rgba(1, 3, 8, 0.62)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderWidth: 1,
    bottom: 0,
    left: 0,
    maxHeight: "92%",
    minHeight: "70%",
    overflow: "hidden",
    paddingTop: 9,
    position: "absolute",
    right: 0,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    height: 1,
    left: 28,
    position: "absolute",
    right: 28,
    top: 0,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: SevynShellTheme.colors.borderStrong,
    borderRadius: 2,
    height: 4,
    width: 38,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 2,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginTop: 3,
  },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 8 },
  batteryPill: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    height: 34,
    paddingHorizontal: 10,
  },
  batteryShell: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 3,
    borderWidth: 1,
    height: 9,
    overflow: "hidden",
    padding: 1,
    width: 19,
  },
  batteryFill: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: 1,
    height: "100%",
  },
  batteryText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 10,
    fontWeight: "700",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 17,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  closeText: { color: SevynShellTheme.colors.secondary, fontSize: 23, lineHeight: 25 },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.32)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginBottom: 10,
    marginHorizontal: 20,
    padding: 11,
  },
  errorText: { color: "#FFB7BC", fontSize: 11 },
  scroller: { flexGrow: 0 },
  content: { gap: 12, paddingBottom: 32, paddingHorizontal: 20 },
  toggleGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    minHeight: 118,
    padding: 14,
    width: "48%",
  },
  tileActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.42)",
  },
  tileGlyph: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 17,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  tileGlyphActive: { backgroundColor: SevynShellTheme.colors.accent },
  tileGlyphText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 18,
    fontWeight: "700",
  },
  tileGlyphTextActive: { color: "#FFFFFF" },
  tileLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 11,
  },
  tileSubtitle: { color: SevynShellTheme.colors.muted, fontSize: 10, marginTop: 3 },
  levelCard: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    padding: 14,
  },
  levelHeader: { alignItems: "center", flexDirection: "row" },
  levelGlyph: { color: SevynShellTheme.colors.gold, fontSize: 16, width: 24 },
  levelLabel: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  levelValue: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "700",
  },
  levelRow: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 12 },
  stepButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  stepText: { color: SevynShellTheme.colors.primary, fontSize: 17, lineHeight: 19 },
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
    borderRadius: 7,
    height: 14,
    marginLeft: -7,
    marginTop: -3,
    position: "absolute",
    width: 14,
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
    gap: 8,
    justifyContent: "center",
    minHeight: 44,
  },
  footerGlyph: { color: SevynShellTheme.colors.gold, fontSize: 14, fontWeight: "700" },
  footerText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    fontWeight: "700",
  },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.62 },
});
