import { useState, useEffect, type JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SevynShellTheme } from "../theme.js";

declare module "react-native" {
  interface ViewStyle {
    backdropBlur?: number;
    blur?: number;
  }
}

export interface DesktopLockScreenProps {
  readonly locked: boolean;
  readonly onUnlock: () => void;
  readonly username?: string;
  readonly onPowerAction?: (action: "sleep" | "restart" | "shutdown") => void;
}

export function DesktopLockScreen({
  locked,
  onUnlock,
  username = "Sevyn User",
  onPowerAction,
}: DesktopLockScreenProps): JSX.Element | null {
  const [pin, setPin] = useState("");
  const [currentTime, setCurrentTime] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  if (!locked) return null;

  const formattedTime = currentTime.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const formattedDate = currentTime.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const handleUnlock = () => {
    setPin("");
    onUnlock();
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.content}>
        {/* Clock & Date Header */}
        <View style={styles.clockContainer}>
          <Text style={styles.timeText}>{formattedTime}</Text>
          <Text style={styles.dateText}>{formattedDate}</Text>
        </View>

        {/* User Card */}
        <View style={styles.userCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {username.slice(0, 1).toLocaleUpperCase()}
            </Text>
          </View>
          <Text style={styles.usernameText}>{username}</Text>

          {/* PIN / Password Input */}
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              placeholder="Enter PIN or password..."
              placeholderTextColor="rgba(255, 255, 255, 0.4)"
              secureTextEntry
              value={pin}
              onChangeText={setPin}
              onSubmitEditing={handleUnlock}
              accessibilityLabel="Lock screen password input"
            />
          </View>

          {/* Unlock Button */}
          <Pressable
            accessibilityLabel="Unlock SevynOS"
            accessibilityRole="button"
            onPress={handleUnlock}
            style={({ pressed }) => [
              styles.unlockButton,
              pressed && styles.unlockButtonPressed,
            ]}
          >
            <Text style={styles.unlockButtonText}>Unlock</Text>
          </Pressable>
        </View>

        {/* Quick Power Actions */}
        <View style={styles.powerRow}>
          <Pressable
            accessibilityLabel="Sleep"
            accessibilityRole="button"
            onPress={() => onPowerAction?.("sleep")}
            style={styles.powerButton}
          >
            <Text style={styles.powerButtonText}>Sleep</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Restart"
            accessibilityRole="button"
            onPress={() => onPowerAction?.("restart")}
            style={styles.powerButton}
          >
            <Text style={styles.powerButtonText}>Restart</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Shut Down"
            accessibilityRole="button"
            onPress={() => onPowerAction?.("shutdown")}
            style={[styles.powerButton, styles.shutdownButton]}
          >
            <Text style={[styles.powerButtonText, styles.shutdownButtonText]}>
              Shut Down
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    alignItems: "center",
    backdropBlur: 32,
    backgroundColor: "rgba(7, 9, 13, 0.88)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 2000,
  },
  content: {
    alignItems: "center",
    gap: 36,
    justifyContent: "center",
    maxWidth: 440,
    width: "90%",
  },
  clockContainer: {
    alignItems: "center",
    gap: 8,
  },
  timeText: {
    color: "#FFFFFF",
    fontSize: 64,
    fontWeight: "300",
    letterSpacing: -1,
  },
  dateText: {
    color: "rgba(255, 255, 255, 0.7)",
    fontSize: 18,
    fontWeight: "400",
  },
  userCard: {
    alignItems: "center",
    backdropBlur: 16,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 24,
    borderWidth: 1,
    gap: 16,
    padding: 28,
    width: "100%",
  },
  avatar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accent,
    borderColor: "rgba(255, 255, 255, 0.2)",
    borderRadius: 40,
    borderWidth: 2,
    height: 80,
    justifyContent: "center",
    width: 80,
  },
  avatarText: {
    color: "#FFFFFF",
    fontSize: 32,
    fontWeight: "700",
  },
  usernameText: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "600",
  },
  inputContainer: {
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    borderColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 14,
    borderWidth: 1,
    width: "100%",
  },
  input: {
    color: "#FFFFFF",
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  unlockButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 14,
    justifyContent: "center",
    paddingVertical: 12,
    width: "100%",
  },
  unlockButtonPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  unlockButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  powerRow: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
  },
  powerButton: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  powerButtonText: {
    color: "rgba(255, 255, 255, 0.75)",
    fontSize: 13,
    fontWeight: "500",
  },
  shutdownButton: {
    backgroundColor: "rgba(242, 85, 90, 0.15)",
    borderColor: "rgba(242, 85, 90, 0.3)",
  },
  shutdownButtonText: {
    color: "rgba(255, 120, 125, 0.9)",
  },
});
