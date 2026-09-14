import { useEffect, useState, type JSX } from "react";
import { StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { SevynShellTheme } from "../theme.js";
import {
  createContextMenuState,
  dismissContextMenu,
  renderContextMenu,
  type ContextMenuState,
  type MenuItem,
} from "../context-menu.js";
import {
  NotificationCenterApplication,
  type SystemNotificationSummary,
} from "../notifications/center.js";

export interface PowerServiceProp {
  readonly shutdown: () => Promise<void>;
  readonly restart?: () => Promise<void>;
  readonly lock?: () => Promise<void>;
  readonly sleep?: () => Promise<void>;
  readonly logout?: () => Promise<void>;
}

export interface DesktopStatusBarApplicationProps {
  readonly activeWorkspace?: string;
  readonly powerService?: PowerServiceProp;
  readonly batteryPercent?: number | undefined;
  readonly batteryCharging?: boolean | undefined;
  readonly batteryAvailable?: boolean | undefined;
  readonly wifiState?:
    ("connected" | "connecting" | "disconnected" | "unavailable") | undefined;
  readonly wifiSsid?: string | undefined;
  readonly audioVolume?: number | undefined;
  readonly audioMuted?: boolean | undefined;
  readonly notifications?: readonly SystemNotificationSummary[] | undefined;
  readonly onDismissNotification?:
    ((notificationId: string) => Promise<void> | void) | undefined;
  readonly onClearAllNotifications?: (() => Promise<void> | void) | undefined;
  readonly onNotificationAction?:
    ((notificationId: string, actionId: string) => Promise<void> | void) | undefined;
}

export function DesktopStatusBarApplication({
  activeWorkspace,
  powerService,
  batteryPercent,
  batteryCharging,
  batteryAvailable,
  wifiState = "connected",
  wifiSsid,
  notifications = [],
  onDismissNotification,
  onClearAllNotifications,
  onNotificationAction,
}: DesktopStatusBarApplicationProps = {}): JSX.Element {
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [powerMenuState, setPowerMenuState] = useState<ContextMenuState>(() =>
    dismissContextMenu(),
  );
  const [, setConfirmAction] = useState<"restart" | "shutdown" | null>(null);
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 10_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const formattedTime = currentTime.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const formattedDate = currentTime
    .toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .toLocaleUpperCase();

  const workspaceLabel =
    activeWorkspace !== undefined
      ? activeWorkspace.replace("workspace-", "WORKSPACE ")
      : undefined;

  const handlePowerClick = () => {
    if (powerMenuState.visible) {
      setPowerMenuState(dismissContextMenu());
      setConfirmAction(null);
    } else {
      setConfirmAction(null);
      setPowerMenuState(createContextMenuState({ x: 0, y: 34 }, getMenuItems(null)));
    }
  };

  const getMenuItems = (confirm: "restart" | "shutdown" | null): readonly MenuItem[] => {
    if (confirm === "restart") {
      return [
        {
          id: "confirm-restart",
          label: "Confirm Restart",
          destructive: true,
          onAction: () => {
            void powerService?.restart?.();
            setPowerMenuState(dismissContextMenu());
            setConfirmAction(null);
          },
        },
        {
          id: "cancel",
          label: "Cancel",
          onAction: () => {
            setConfirmAction(null);
            setPowerMenuState(
              createContextMenuState({ x: 0, y: 34 }, getMenuItems(null)),
            );
          },
        },
      ];
    }
    if (confirm === "shutdown") {
      return [
        {
          id: "confirm-shutdown",
          label: "Confirm Shut Down",
          destructive: true,
          onAction: () => {
            void powerService?.shutdown();
            setPowerMenuState(dismissContextMenu());
            setConfirmAction(null);
          },
        },
        {
          id: "cancel",
          label: "Cancel",
          onAction: () => {
            setConfirmAction(null);
            setPowerMenuState(
              createContextMenuState({ x: 0, y: 34 }, getMenuItems(null)),
            );
          },
        },
      ];
    }
    return [
      {
        id: "lock",
        label: "Lock Screen",
        onAction: () => {
          void powerService?.lock?.();
          setPowerMenuState(dismissContextMenu());
        },
      },
      {
        id: "sleep",
        label: "Sleep",
        onAction: () => {
          void powerService?.sleep?.();
          setPowerMenuState(dismissContextMenu());
        },
      },
      { kind: "separator" },
      {
        id: "restart",
        label: "Restart",
        destructive: true,
        onAction: () => {
          setConfirmAction("restart");
          setPowerMenuState(
            createContextMenuState({ x: 0, y: 34 }, getMenuItems("restart")),
          );
        },
      },
      {
        id: "shutdown",
        label: "Shut Down",
        destructive: true,
        onAction: () => {
          setConfirmAction("shutdown");
          setPowerMenuState(
            createContextMenuState({ x: 0, y: 34 }, getMenuItems("shutdown")),
          );
        },
      },
      { kind: "separator" },
      {
        id: "logout",
        label: "Log Out",
        onAction: () => {
          void powerService?.logout?.();
          setPowerMenuState(dismissContextMenu());
        },
      },
    ];
  };

  const wifiLabel =
    wifiState === "connected"
      ? wifiSsid
        ? wifiSsid.length > 12
          ? `${wifiSsid.slice(0, 11)}…`
          : wifiSsid
        : "Connected"
      : wifiState === "connecting"
        ? "Connecting…"
        : wifiState === "disconnected"
          ? "Offline"
          : "No Wi-Fi";

  const wifiDotStyle =
    wifiState === "connected"
      ? styles.onlineDot
      : wifiState === "connecting"
        ? styles.connectingDot
        : styles.offlineDot;

  const showBattery = batteryAvailable !== false && batteryPercent !== undefined;
  const batteryDisplay = showBattery
    ? `${String(Math.min(100, Math.max(0, Math.round(batteryPercent))))}%${batteryCharging ? " ⚡" : ""}`
    : undefined;
  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <View style={styles.container}>
      {powerMenuState.visible && renderContextMenu(powerMenuState, SevynShellTheme)}
      {/* Specular Top Reflection Line */}
      <View style={styles.topHighlight} />

      <View style={styles.leftSection}>
        <TouchableOpacity style={styles.brandContainer} onPress={handlePowerClick}>
          <Text style={styles.brandMark}>◇</Text>
          <Text style={styles.systemName}>SEVYN OS</Text>
        </TouchableOpacity>
        {workspaceLabel !== undefined ? (
          <View style={styles.workspaceTagPill}>
            <Text style={styles.workspaceTag}>{workspaceLabel}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.centerSection}>
        <Text accessibilityLabel="Current time" style={styles.time}>
          {formattedTime}
        </Text>
        <Text style={styles.dateSeparator}>·</Text>
        <Text style={styles.date}>{formattedDate}</Text>
      </View>

      <View style={styles.rightSection}>
        <View style={styles.statusIndicator}>
          <View style={wifiDotStyle} />
          <Text style={styles.statusText}>{wifiLabel}</Text>
        </View>
        {batteryDisplay !== undefined ? (
          <View style={styles.systemPill}>
            <Text style={styles.systemPillText}>{batteryDisplay}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          accessibilityLabel="Notification center"
          style={[
            styles.notificationButton,
            notificationCenterOpen ? styles.notificationButtonActive : undefined,
          ]}
          onPress={() => {
            setNotificationCenterOpen((prev) => !prev);
          }}
        >
          <Text style={styles.notificationIcon}>🔔</Text>
          {unreadCount > 0 ? (
            <View style={styles.notificationBadge}>
              <Text style={styles.notificationBadgeText}>
                {unreadCount > 9 ? "9+" : String(unreadCount)}
              </Text>
            </View>
          ) : null}
        </TouchableOpacity>
      </View>
      {notificationCenterOpen ? (
        <NotificationCenterApplication
          notifications={notifications}
          open={true}
          onClose={() => {
            setNotificationCenterOpen(false);
          }}
          {...(onDismissNotification !== undefined
            ? { onDismiss: onDismissNotification }
            : {})}
          {...(onClearAllNotifications !== undefined
            ? { onClearAll: onClearAllNotifications }
            : {})}
          {...(onNotificationAction !== undefined
            ? { onAction: onNotificationAction }
            : {})}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusBarBackground,
    borderBottomColor: SevynShellTheme.colors.statusBarBorder,
    borderBottomWidth: 1,
    flexDirection: "row",
    height: SevynShellTheme.statusBar.height,
    justifyContent: "space-between",
    paddingHorizontal: SevynShellTheme.statusBar.paddingHorizontal,
    position: "relative",
    top: 0,
    width: "100%",
    zIndex: 950,
  },
  topHighlight: {
    backgroundColor: SevynShellTheme.colors.statusBarSpecular,
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  leftSection: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  brandContainer: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusPillBackground,
    borderColor: SevynShellTheme.colors.statusPillBorder,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  brandMark: {
    color: SevynShellTheme.colors.gold,
    fontSize: 13,
    fontWeight: "700",
  },
  systemName: {
    color: SevynShellTheme.colors.primary,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 2.2,
  },
  workspaceTagPill: {
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: "rgba(240, 208, 138, 0.30)",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  workspaceTag: {
    color: SevynShellTheme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  centerSection: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusPillBackground,
    borderColor: SevynShellTheme.colors.statusPillBorder,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  time: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12.5,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
  },
  dateSeparator: {
    color: SevynShellTheme.colors.muted,
    fontSize: 11,
    opacity: 0.7,
  },
  date: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
  },
  rightSection: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  statusIndicator: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusPillBackground,
    borderColor: SevynShellTheme.colors.statusPillBorder,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  onlineDot: {
    backgroundColor: SevynShellTheme.colors.success,
    borderRadius: SevynShellTheme.radius.round,
    height: 6,
    width: 6,
  },
  connectingDot: {
    backgroundColor: "#FF9500",
    borderRadius: SevynShellTheme.radius.round,
    height: 6,
    width: 6,
  },
  offlineDot: {
    backgroundColor: SevynShellTheme.colors.muted,
    borderRadius: SevynShellTheme.radius.round,
    height: 6,
    width: 6,
  },
  statusText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "600",
  },
  systemPill: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusPillBackground,
    borderColor: SevynShellTheme.colors.statusPillBorder,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  systemPillText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 10.5,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  notificationButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.statusPillBackground,
    borderColor: SevynShellTheme.colors.statusPillBorder,
    borderRadius: 12,
    borderWidth: 1,
    height: 30,
    justifyContent: "center",
    position: "relative",
    width: 30,
  },
  notificationButtonActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
  },
  notificationIcon: {
    fontSize: 12,
  },
  notificationBadge: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 8,
    height: 15,
    justifyContent: "center",
    minWidth: 15,
    paddingHorizontal: 3,
    position: "absolute",
    right: -3,
    top: -3,
  },
  notificationBadgeText: {
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "800",
  },
});
