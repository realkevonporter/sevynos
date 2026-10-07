/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useEffect, useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopLockScreenRenderInput } from "../desktop.js";

export interface LockScreenAccountSummary {
  readonly username: string;
  readonly fullName: string;
}

export type UnlockFailureReason = "invalid-credentials" | "locked-out";

export interface UnlockAttemptResult {
  readonly ok: boolean;
  readonly reason?: UnlockFailureReason | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface DesktopLockScreenProps extends DesktopLockScreenRenderInput {
  /**
   * Verifies the password for the locked session. The shell unlocks only when
   * the result is ok — there is no bypass path.
   */
  readonly onUnlock?: (
    password: string,
  ) => Promise<UnlockAttemptResult> | UnlockAttemptResult;
  /**
   * Login mode: no session is active yet (fresh boot or after switch-user).
   * Renders the account picker instead of the single-user unlock card.
   */
  readonly loginMode?: boolean | undefined;
  readonly accounts?: readonly LockScreenAccountSummary[] | undefined;
  readonly onLogin?: (
    username: string,
    password: string,
  ) => Promise<UnlockAttemptResult> | UnlockAttemptResult;
  readonly allowGuest?: boolean | undefined;
  readonly onGuestLogin?: (() => void) | undefined;
}

const CARD_WIDTH = 400;
const CARD_HEIGHT = 360;

function avatarInitial(username: string | undefined): string {
  const trimmed = (username ?? "").trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1).toLocaleUpperCase() : "•";
}

function displayName(account: LockScreenAccountSummary): string {
  const full = account.fullName.trim();
  return full.length > 0 ? full : account.username;
}

function lockoutMessage(retryAfterMs: number | undefined): string {
  const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 60000) / 1000));
  return `Too many attempts. Try again in ${String(seconds)}s.`;
}

/**
 * Desktop lock screen rendered as a real React Native component.
 * Full-screen surface with a clock block and a centered card:
 * avatar initial, username, password field, and unlock button.
 *
 * In login mode the card becomes an account picker (account list, password
 * field for the selected account, guest entry point).
 */
export function DesktopLockScreen({
  displayBounds,
  locked,
  timeText,
  dateText,
  username,
  onUnlock,
  loginMode,
  accounts,
  onLogin,
  allowGuest,
  onGuestLogin,
}: DesktopLockScreenProps): JSX.Element | null {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [selectedUsername, setSelectedUsername] = useState<string | undefined>(undefined);

  const now = Date.now();
  const lockedOut = now < lockedUntil;

  // Re-render when a lockout expires so the form becomes usable again.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return;
    const timer = setTimeout(() => {
      setLockedUntil(0);
    }, lockedUntil - Date.now());
    return () => {
      clearTimeout(timer);
    };
  }, [lockedUntil]);

  if (!locked) return null;

  const accountList = accounts ?? [];
  const effectiveUsername =
    selectedUsername ?? accountList[0]?.username ?? username ?? "";

  const handleResult = (result: UnlockAttemptResult): void => {
    if (result.ok) {
      setError(undefined);
      setPassword("");
      return;
    }
    if (result.reason === "locked-out") {
      setLockedUntil(Date.now() + (result.retryAfterMs ?? 60000));
      setError(lockoutMessage(result.retryAfterMs));
    } else {
      setError("Incorrect password. Try again.");
    }
    setPassword("");
  };

  const submit = (): void => {
    if (busy || lockedOut) return;
    setBusy(true);
    setError(undefined);
    const attempt = loginMode
      ? onLogin?.(effectiveUsername, password)
      : onUnlock?.(password);
    void Promise.resolve(attempt)
      .then((result) => {
        if (result !== undefined) handleResult(result);
      })
      .catch((verificationError: unknown) => {
        setError(
          verificationError instanceof Error
            ? verificationError.message
            : "Verification failed. Try again.",
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const submitLabel = loginMode ? "Log in" : "Unlock";
  const heading = loginMode
    ? displayName({
        username: effectiveUsername,
        fullName:
          accountList.find((account) => account.username === effectiveUsername)
            ?.fullName ?? "",
      })
    : (username ?? "User");

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
      <View
        style={[
          styles.card,
          loginMode === true && accountList.length > 1 ? styles.cardFlexible : undefined,
        ]}
      >
        <View style={styles.specularLine} />
        {loginMode && accountList.length > 1 && (
          <View style={styles.accountList}>
            {accountList.map((account) => {
              const selected = account.username === effectiveUsername;
              return (
                <Pressable
                  key={account.username}
                  accessibilityRole="button"
                  accessibilityLabel={`Log in as ${displayName(account)}`}
                  onPress={() => {
                    setSelectedUsername(account.username);
                    setError(undefined);
                    setPassword("");
                  }}
                  style={
                    selected
                      ? [styles.accountRow, styles.accountRowSelected]
                      : styles.accountRow
                  }
                >
                  <View style={styles.accountAvatar}>
                    <Text style={styles.accountAvatarInitial}>
                      {avatarInitial(displayName(account))}
                    </Text>
                  </View>
                  <Text
                    style={
                      selected
                        ? [styles.accountName, styles.accountNameSelected]
                        : styles.accountName
                    }
                  >
                    {displayName(account)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        <View style={styles.avatar}>
          <Text style={styles.avatarInitial}>{avatarInitial(heading)}</Text>
        </View>
        <Text style={styles.username}>{heading}</Text>
        <TextInput
          accessibilityLabel="Password"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy && !lockedOut}
          onChangeText={(value) => {
            setPassword(value);
            if (error !== undefined) setError(undefined);
          }}
          onSubmitEditing={submit}
          placeholder="Password"
          placeholderTextColor={SevynShellTheme.colors.muted}
          secureTextEntry={true}
          style={styles.passwordInput}
          value={password}
        />
        {error !== undefined && <Text style={styles.errorText}>{error}</Text>}
        <Pressable
          accessibilityLabel={submitLabel}
          accessibilityRole="button"
          disabled={busy || lockedOut}
          onPress={submit}
          style={({ pressed }) => [
            styles.unlockButton,
            pressed && styles.unlockButtonPressed,
            (busy || lockedOut) && styles.unlockButtonDisabled,
          ]}
        >
          <Text style={styles.unlockLabel}>
            {lockedOut ? "Locked" : busy ? "Checking…" : submitLabel}
          </Text>
        </Pressable>
        {loginMode === true && allowGuest === true && onGuestLogin !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log in as guest"
            onPress={onGuestLogin}
            style={styles.guestButton}
          >
            <Text style={styles.guestLabel}>Log in as guest</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
    shadowRadius: SevynShellTheme.shadows.floating.shadowRadius,
    width: CARD_WIDTH,
  },
  cardFlexible: {
    height: undefined,
    minHeight: CARD_HEIGHT,
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
  accountList: {
    marginBottom: SevynShellTheme.spacing.md,
    width: "100%",
  },
  accountRow: {
    alignItems: "center",
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    flexDirection: "row",
    marginBottom: SevynShellTheme.spacing.xs,
    padding: SevynShellTheme.spacing.sm,
  },
  accountRowSelected: {
    borderColor: SevynShellTheme.colors.accent,
    backgroundColor: SevynShellTheme.colors.accentSoft,
  },
  accountAvatar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderRadius: SevynShellTheme.radius.round,
    height: 32,
    justifyContent: "center",
    marginRight: SevynShellTheme.spacing.sm,
    width: 32,
  },
  accountAvatarInitial: {
    color: SevynShellTheme.colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  accountName: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.body,
  },
  accountNameSelected: {
    color: SevynShellTheme.colors.primary,
    fontWeight: "600",
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
  errorText: {
    color: "#F87171",
    fontSize: SevynShellTheme.typography.caption,
    marginBottom: SevynShellTheme.spacing.sm,
    textAlign: "center",
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
  unlockButtonDisabled: {
    opacity: 0.5,
  },
  unlockLabel: {
    color: "#0B0E1A",
    fontSize: SevynShellTheme.typography.body,
    fontWeight: "600",
  },
  guestButton: {
    marginTop: SevynShellTheme.spacing.md,
    padding: SevynShellTheme.spacing.sm,
  },
  guestLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: SevynShellTheme.typography.body,
  },
});
