import { useEffect, useState, type JSX } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";

export interface MobileStatusBarApplicationProps {
  readonly batteryPercent?: number | undefined;
  readonly batteryCharging?: boolean | undefined;
  readonly wifiConnected?: boolean | undefined;
  readonly signalBars?: number | undefined;
}

export function MobileStatusBarApplication({
  batteryPercent,
  batteryCharging,
  wifiConnected = true,
  signalBars = 4,
}: MobileStatusBarApplicationProps = {}): JSX.Element {
  const [currentTime, setCurrentTime] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 30_000);
    return (): void => {
      clearInterval(timer);
    };
  }, []);

  const activeBars = wifiConnected ? Math.max(0, Math.min(4, signalBars)) : 0;
  const pct = Math.min(100, Math.max(0, batteryPercent ?? 100));
  const fillWidth = Math.max(2, Math.round((17 * pct) / 100));

  return (
    <View style={styles.container}>
      <Text accessibilityLabel="Current time" style={styles.time}>
        {currentTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </Text>
      <Text accessibilityElementsHidden style={styles.systemName}>
        ◇ SEVYN OS
      </Text>
      <View
        accessibilityLabel={`${wifiConnected ? "Network connected" : "Network disconnected"}, battery ${String(pct)} percent`}
        style={styles.indicators}
      >
        <View style={styles.signalBars}>
          <View
            style={[
              styles.signalBar,
              styles.signalBarOne,
              activeBars < 1 && styles.signalBarDim,
            ]}
          />
          <View
            style={[
              styles.signalBar,
              styles.signalBarTwo,
              activeBars < 2 && styles.signalBarDim,
            ]}
          />
          <View
            style={[
              styles.signalBar,
              styles.signalBarThree,
              activeBars < 3 && styles.signalBarDim,
            ]}
          />
          <View
            style={[
              styles.signalBar,
              styles.signalBarFour,
              activeBars < 4 && styles.signalBarDim,
            ]}
          />
        </View>
        <View
          style={[
            styles.connectionIndicator,
            !wifiConnected && styles.connectionIndicatorDisconnected,
          ]}
        />
        <View style={styles.batteryShell}>
          <View
            style={[
              styles.batteryFill,
              batteryPercent !== undefined ? { width: fillWidth } : undefined,
              batteryCharging === true ? styles.batteryFillCharging : undefined,
            ]}
          />
        </View>
        <View style={styles.batteryCap} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flexDirection: "row",
    height: 44,
    justifyContent: "space-between",
    paddingHorizontal: SevynShellTheme.spacing.lg,
    position: "relative",
  },
  time: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
    minWidth: 72,
  },
  systemName: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 10.5,
    fontWeight: "800",
    left: 0,
    letterSpacing: 2.4,
    opacity: 0.85,
    position: "absolute",
    right: 0,
    textAlign: "center",
    textTransform: "uppercase",
  },
  indicators: { alignItems: "center", flexDirection: "row", gap: 7 },
  signalBars: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 2,
    height: 12,
  },
  signalBar: {
    backgroundColor: SevynShellTheme.colors.primary,
    borderRadius: 1.5,
    width: 3,
  },
  signalBarDim: {
    opacity: 0.25,
  },
  signalBarOne: { height: 4.5 },
  signalBarTwo: { height: 7 },
  signalBarThree: { height: 9.5 },
  signalBarFour: { height: 12 },
  connectionIndicator: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: SevynShellTheme.radius.round,
    height: 6,
    width: 6,
  },
  connectionIndicatorDisconnected: {
    backgroundColor: SevynShellTheme.colors.muted,
  },
  batteryShell: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 4,
    borderWidth: 1,
    height: 11,
    padding: 1.5,
    width: 22,
  },
  batteryFill: {
    backgroundColor: SevynShellTheme.colors.primary,
    borderRadius: 1.5,
    flex: 1,
  },
  batteryFillCharging: {
    backgroundColor: SevynShellTheme.colors.gold,
  },
  batteryCap: {
    backgroundColor: SevynShellTheme.colors.secondary,
    borderBottomRightRadius: 1.5,
    borderTopRightRadius: 1.5,
    height: 5,
    marginLeft: -5.5,
    width: 1.5,
  },
});
