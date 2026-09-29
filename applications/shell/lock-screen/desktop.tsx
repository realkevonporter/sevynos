/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopLockScreenRenderInput } from "../desktop.js";

export interface DesktopLockScreenProps extends DesktopLockScreenRenderInput {
  readonly onUnlock?: (password: string) => void;
}

const CARD_WIDTH = 400;
const CARD_HEIGHT = 360;

function avatarInitial(username: string | undefined): string {
  const trimmed = (username ?? "").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toLocaleUpperCase() : "•";
}

/**
 * Desktop lock screen rendered as a real React Native component.
 * Full-screen surface with a clock block and a centered unlock card:
 * avatar initial, username, password field, and unlock button.
 */
export function DesktopLockScreen({
  displayBounds,
  locked,
  timeText,
  dateText,
  username,
  onUnlock,
}: DesktopLockScreenProps): JSX.Element | null {
  const [password, setPassword] = useState("");

  if (!locked) return null;

  const submit = (): void => {
    onUnlock?.(password);
    setPassword("");
  };

  return (
    <View
      style={[
        styles.surface,
        {
          left: displayBounds.x,
          top: displayBounds.y,
          width: displayBounds.width,
          height: displayBounds.height,
        },
      ]}
    >
      <View style={styles.wallpaperGlow} />
      <View style={styles.clockBlock}>
        <Text style={styles.timeText}>{timeText ?? "12:00"}</Text>
        <Text style={styles.dateText}>{dateText ?? "SevynOS"}</Text>
      </View>
      <View style={styles.card}>
        <View style={styles.specularLine} />
        <View style={styles.avatar}>
          <Text style={styles.avatarInitial}>{avatarInitial(username)}</Text>
        </View>
        <Text style={styles.username}>{username ?? "User"}</Text>
        <TextInput
          accessibilityLabel="Password"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          placeholder="Password"
          placeholderTextColor={SevynShellTheme.colors.muted}
          secureTextEntry={true}
          style={styles.passwordInput}
          value={password}
        />
        <Pressable
          accessibilityLabel="Unlock"
          accessibilityRole="button"
          onPress={submit}
          style={({ pressed }) => [
            styles.unlockButton,
            pressed && styles.unlockButtonPressed,
          ]}
        >
          <Text style={styles.unlockLabel}>Unlock</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.background,
    justifyContent: "center",
    position: "absolute",
  },
  wallpaperGlow: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderRadius: SevynShellTheme.radius.round,
    height: 420,
    opacity: 0.5,
    position: "absolute",
    width: 420,
  },
  clockBlock: {
    alignItems: "center",
    marginBottom: SevynShellTheme.spacing.xl,
  },
  timeText: {
    color: SevynShellTheme.colors.primary,
    fontSize: 84,
    fontWeight: "200",
    lineHeight: 88,
  },
  dateText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.title,
    fontWeight: "500",
    marginTop: SevynShellTheme.spacing.xs,
  },
  card: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    height: CARD_HEIGHT,
    justifyContent: "center",
    padding: SevynShellTheme.spacing.xl,
    position: "relative",
    shadowColor: SevynShellTheme.shadows.floating.shadowColor,
    shadowOffset: SevynShellTheme.shadows.floating.shadowOffset,
    shadowOpacity: SevynShellTheme.shadows.floating.shadowOpacity,
    shadowRadius: SevynShellTheme.shadows.floating.shadowRadius,
    width: CARD_WIDTH,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    borderRadius: SevynShellTheme.radius.round,
    height: 1,
    left: SevynShellTheme.spacing.xl,
    position: "absolute",
    right: SevynShellTheme.spacing.xl,
    top: 0,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    height: 72,
    justifyContent: "center",
    marginBottom: SevynShellTheme.spacing.md,
    width: 72,
  },
  avatarInitial: {
    color: SevynShellTheme.colors.accent,
    fontSize: 30,
    fontWeight: "600",
  },
  username: {
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.title,
    fontWeight: "600",
    marginBottom: SevynShellTheme.spacing.lg,
  },
  passwordInput: {
    backgroundColor: SevynShellTheme.colors.launcherSearchBackground,
    borderColor: SevynShellTheme.colors.launcherSearchBorder,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    color: SevynShellTheme.colors.primary,
    fontSize: SevynShellTheme.typography.body,
    height: 48,
    marginBottom: SevynShellTheme.spacing.md,
    paddingHorizontal: SevynShellTheme.spacing.md,
    width: "100%",
  },
  unlockButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: SevynShellTheme.radius.md,
    height: 48,
    justifyContent: "center",
    width: CARD_WIDTH - 100,
  },
  unlockButtonPressed: {
    backgroundColor: SevynShellTheme.colors.accentPressed,
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  unlockLabel: {
    color: "#0B0E1A",
    fontSize: SevynShellTheme.typography.body,
    fontWeight: "600",
  },
});
