import type { JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ReactNativeApplicationProps } from "@sevynos/react-native-host";
import { SevynShellTheme } from "@sevynos/system-applications";

export function HelloApplication(props: ReactNativeApplicationProps): JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.aura} />
      <View style={styles.mark}>
        <Text style={styles.symbol}>7</Text>
      </View>
      <Text style={styles.eyebrow}>NATIVE REACT APPLICATION</Text>
      <Text style={styles.title}>Welcome to SevynOS</Text>
      <Text style={styles.subtitle}>
        This application and every piece of shell chrome around it are composed with React
        Native.
      </Text>
      <View style={styles.sessionCard}>
        <View style={styles.sessionRow}>
          <Text style={styles.sessionLabel}>Application</Text>
          <Text numberOfLines={1} style={styles.sessionValue}>
            {props.applicationId}
          </Text>
        </View>
        <View style={styles.separator} />
        <View style={styles.sessionRow}>
          <Text style={styles.sessionLabel}>Session</Text>
          <Text numberOfLines={1} style={styles.sessionValue}>
            {props.sessionId}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.backgroundRaised,
    flex: 1,
    justifyContent: "center",
    overflow: "hidden",
    padding: 28,
  },
  aura: {
    backgroundColor: "rgba(121, 132, 232, 0.12)",
    borderRadius: SevynShellTheme.radius.round,
    height: 310,
    position: "absolute",
    right: -160,
    top: -150,
    width: 310,
  },
  mark: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: "rgba(230, 196, 122, 0.30)",
    borderRadius: 25,
    borderWidth: 1,
    height: 84,
    justifyContent: "center",
    width: 84,
  },
  symbol: {
    color: SevynShellTheme.colors.gold,
    fontSize: 40,
    fontWeight: "800",
  },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.8,
    marginTop: 24,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -0.9,
    marginTop: 10,
    textAlign: "center",
  },
  subtitle: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    maxWidth: 430,
    textAlign: "center",
  },
  sessionCard: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    marginTop: 28,
    maxWidth: 440,
    paddingHorizontal: 16,
    width: "100%",
  },
  sessionRow: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 46,
  },
  sessionLabel: {
    color: SevynShellTheme.colors.muted,
    fontSize: 11,
    fontWeight: "700",
    width: 82,
  },
  sessionValue: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 11,
  },
  separator: { backgroundColor: SevynShellTheme.colors.border, height: 1 },
});
