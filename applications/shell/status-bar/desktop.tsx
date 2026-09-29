/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useEffect, useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellDisplay, DesktopStatusBarRenderInput } from "../desktop.js";

export interface DesktopStatusBarProps extends DesktopStatusBarRenderInput {
  readonly activeApplicationName?: string | undefined;
  readonly menus?: readonly string[] | undefined;
  readonly onOpenMenu?: (menu: string) => void;
}

const DEFAULT_MENUS = ["File", "Edit", "View", "Window", "Help"];

/**
 * macOS-style menu bar rendered as a real React Native component.
 * Left: Sevyn emblem, active app name, app menus.
 * Right: volume, wifi, battery, clock.
 */
export function DesktopStatusBar({
  displays,
  timeText,
  dateText,
  wifiState,
  wifiSignal,
  wifiSsid,
  batteryAvailable,
  batteryPercent,
  batteryCharging,
  audioVolume,
  audioMuted,
  activeApplicationName = "SevynOS",
  menus = DEFAULT_MENUS,
  onOpenMenu,
}: DesktopStatusBarProps): JSX.Element {
  return (
    <>
      {displays.map((display) => (
        <DisplayMenuBar
          key={display.id}
          display={display}
          timeText={timeText}
          dateText={dateText}
          wifiState={wifiState}
          wifiSignal={wifiSignal}
          wifiSsid={wifiSsid}
          batteryAvailable={batteryAvailable}
          batteryPercent={batteryPercent}
          batteryCharging={batteryCharging}
          audioVolume={audioVolume}
          audioMuted={audioMuted}
          activeApplicationName={activeApplicationName}
          menus={menus}
          onOpenMenu={onOpenMenu}
        />
      ))}
    </>
  );
}

interface DisplayMenuBarProps {
  readonly display: DesktopShellDisplay;
  readonly timeText?: string | undefined;
  readonly dateText?: string | undefined;
  readonly wifiState?:
    ("connected" | "connecting" | "disconnected" | "unavailable") | undefined;
  readonly wifiSignal?: number | undefined;
  readonly wifiSsid?: string | undefined;
  readonly batteryAvailable?: boolean | undefined;
  readonly batteryPercent?: number | undefined;
  readonly batteryCharging?: boolean | undefined;
  readonly audioVolume?: number | undefined;
  readonly audioMuted?: boolean | undefined;
  readonly activeApplicationName: string;
  readonly menus: readonly string[];
  readonly onOpenMenu?: ((menu: string) => void) | undefined;
}

function DisplayMenuBar({
  display,
  timeText,
  dateText,
  wifiState = "unavailable",
  wifiSignal,
  wifiSsid,
  batteryAvailable = true,
  batteryPercent,
  batteryCharging,
  audioVolume,
  audioMuted,
  activeApplicationName,
  menus,
  onOpenMenu,
}: DisplayMenuBarProps): JSX.Element {
  const [now, setNow] = useState(() => new Date());
  const [hoveredMenu, setHoveredMenu] = useState<string | undefined>(undefined);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const clock = timeText ?? formatClock(now);
  const date = dateText ?? formatDate(now);
  const showBattery = batteryAvailable;
  const pct = Math.min(100, Math.max(0, batteryPercent ?? 100));
  const batteryFillWidth = Math.max(2, Math.round((17 * pct) / 100));
  const signalLevel =
    wifiSignal !== undefined
      ? Math.max(0, Math.min(4, Math.round(wifiSignal)))
      : wifiState === "connected"
        ? 4
        : wifiState === "connecting"
          ? 2
          : 0;
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Menu bar"
      style={[
        styles.menuBar,
        {
          left: display.bounds.x,
          top: display.bounds.y,
          width: display.bounds.width,
        },
      ]}
    >
      <View style={styles.leftSection}>
        <View accessibilityElementsHidden={true} style={styles.emblem}>
          <Text style={styles.emblemText}>S</Text>
        </View>
        <Text style={styles.appName} numberOfLines={1}>
          {activeApplicationName}
        </Text>
        {menus.map((menu) => (
          <MenuItem
            key={menu}
            label={menu}
            hovered={hoveredMenu === menu}
            onHoverIn={() => {
              setHoveredMenu(menu);
            }}
            onHoverOut={() => {
              setHoveredMenu((current) => (current === menu ? undefined : current));
            }}
            onPress={() => onOpenMenu?.(menu)}
          />
        ))}
      </View>
      <View style={styles.rightSection}>
        {audioMuted !== undefined || audioVolume !== undefined ? (
          <View
            accessibilityLabel={
              audioMuted === true
                ? "Volume muted"
                : `Volume ${String(Math.round((audioVolume ?? 1) * 100))} percent`
            }
            style={styles.volumeGroup}
          >
            <View style={styles.speakerBody} />
            <Text style={styles.volumeGlyph}>{audioMuted === true ? "✕" : "♪"}</Text>
          </View>
        ) : null}
        <View
          accessibilityLabel={
            wifiState === "connected"
              ? `Wi-Fi connected${wifiSsid ? ` to ${wifiSsid}` : ""}`
              : wifiState === "connecting"
                ? "Wi-Fi connecting"
                : "Wi-Fi disconnected"
          }
          style={styles.signalBars}
        >
          {[0, 1, 2, 3].map((index) => (
            <View
              key={index}
              style={[
                styles.signalBar,
                { height: 3 + index * 2.5 },
                index >= signalLevel && styles.signalBarDim,
              ]}
            />
          ))}
        </View>
        {showBattery ? (
          <View
            accessibilityLabel={`Battery ${String(pct)} percent${
              batteryCharging === true ? ", charging" : ""
            }`}
            style={styles.batteryGroup}
          >
            <View style={styles.batteryShell}>
              <View
                style={[
                  styles.batteryFill,
                  { width: batteryFillWidth },
                  pct <= 20 && styles.batteryFillLow,
                  batteryCharging === true && styles.batteryFillCharging,
                ]}
              />
            </View>
            <View style={styles.batteryCap} />
            <Text style={styles.batteryLabel}>{`${String(pct)}%`}</Text>
          </View>
        ) : null}
        <Text
          accessibilityLabel={`Current date and time: ${date} ${clock}`}
          style={styles.clock}
        >
          {`${date}  ${clock}`}
        </Text>
      </View>
    </View>
  );
}

interface MenuItemProps {
  readonly label: string;
  readonly hovered: boolean;
  readonly onHoverIn: () => void;
  readonly onHoverOut: () => void;
  readonly onPress: () => void;
}

function MenuItem({
  label,
  hovered,
  onHoverIn,
  onHoverOut,
  onPress,
}: MenuItemProps): JSX.Element {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={`${label} menu`}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuItem,
        hovered && styles.menuItemHovered,
        pressed && styles.menuItemPressed,
      ]}
    >
      <Text style={styles.menuLabel}>{label}</Text>
    </Pressable>
  );
}

function formatClock(now: Date): string {
  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${String(hours)}:${minutes} ${ampm}`;
}

function formatDate(now: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const dayName = days[now.getDay()] ?? "Mon";
  const monthName = months[now.getMonth()] ?? "Jan";
  return `${dayName} ${monthName} ${String(now.getDate())}`;
}

const MENU_BAR_HEIGHT = 28;

const styles = StyleSheet.create({
  menuBar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusBarBackground,
    borderBottomColor: SevynShellTheme.colors.statusBarBorder,
    borderBottomWidth: 1,
    flexDirection: "row",
    height: MENU_BAR_HEIGHT,
    justifyContent: "space-between",
    paddingHorizontal: 12,
    position: "absolute",
  },
  leftSection: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
  emblem: {
    alignItems: "center",
    backgroundColor: "#C9A24B",
    borderRadius: 4,
    height: 14,
    justifyContent: "center",
    marginRight: 4,
    width: 14,
  },
  emblemText: {
    color: "#1C1917",
    fontSize: 9,
    fontWeight: "800",
  },
  appName: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
    marginRight: 8,
    maxWidth: 160,
  },
  menuItem: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  menuItemHovered: {
    backgroundColor: "rgba(255, 255, 255, 0.10)",
  },
  menuItemPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.18)",
  },
  menuLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontWeight: "400",
  },
  rightSection: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  volumeGroup: {
    alignItems: "center",
    flexDirection: "row",
    gap: 3,
  },
  speakerBody: {
    backgroundColor: SevynShellTheme.colors.secondary,
    borderRadius: 1,
    height: 6,
    width: 4,
  },
  volumeGlyph: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
  },
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
  batteryGroup: {
    alignItems: "center",
    flexDirection: "row",
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
  batteryFillLow: {
    backgroundColor: SevynShellTheme.colors.danger,
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
  batteryLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    marginLeft: 7,
  },
  clock: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
  },
});
