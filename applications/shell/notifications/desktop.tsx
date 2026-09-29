/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useMemo, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SevynShellTheme } from "../theme.js";

export interface DesktopNotification {
  readonly id: string;
  readonly title: string;
  readonly body?: string | undefined;
  /** Display name of the app or service that posted the notification. */
  readonly source?: string | undefined;
  /** Unix epoch milliseconds when the notification was posted. */
  readonly timestamp: number;
}

export interface DesktopNotificationsProps {
  readonly notifications?: readonly DesktopNotification[];
  readonly open?: boolean;
  readonly onClose?: () => void;
  readonly onDismiss?: (notificationId: string) => void;
  readonly onClearAll?: () => void;
}

/**
 * Desktop notification center rendered as a React Native component.
 * Slides in from the right edge of the display with stacked notification
 * cards, macOS-style. It owns only transient presentation state; dismissal
 * and clearing remain explicit host callbacks.
 */
export function DesktopNotifications({
  notifications = [],
  open = true,
  onClose,
  onDismiss,
  onClearAll,
}: DesktopNotificationsProps = {}): JSX.Element | null {
  const { height } = useWindowDimensions();
  const sortedNotifications = useMemo(
    () => [...notifications].sort((first, second) => second.timestamp - first.timestamp),
    [notifications],
  );
  if (!open) return null;
  return (
    <View
      accessibilityLabel="Notification center"
      accessibilityViewIsModal
      style={[styles.overlay, { height }]}
    >
      <Pressable
        accessibilityLabel="Close notification center"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View style={styles.panel}>
        <View style={styles.specularLine} />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>NOTIFICATIONS</Text>
            <Text style={styles.title}>Notification Center</Text>
          </View>
          <View style={styles.headerActions}>
            {sortedNotifications.length === 0 ? null : (
              <Pressable
                accessibilityLabel="Clear all notifications"
                accessibilityRole="button"
                onPress={onClearAll}
                style={({ pressed }) => [
                  styles.clearAllButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.clearAllText}>Clear All</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityLabel="Close notification center"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          style={styles.scroller}
        >
          {sortedNotifications.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyMark}>
                <Text style={styles.emptyMarkText}>◌</Text>
              </View>
              <Text style={styles.emptyTitle}>No notifications</Text>
              <Text style={styles.emptyBody}>
                New notifications from your apps will appear here.
              </Text>
            </View>
          ) : (
            sortedNotifications.map((notification) => (
              <View
                key={notification.id}
                accessibilityLabel={`${notification.source ?? "Notification"}: ${notification.title}`}
                accessibilityRole="alert"
                style={styles.card}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.cardSourceRow}>
                    <View style={styles.sourceDot} />
                    <Text numberOfLines={1} style={styles.cardSource}>
                      {(notification.source ?? "System").toLocaleUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.cardHeaderRight}>
                    <Text style={styles.cardTime}>
                      {formatRelativeTime(notification.timestamp)}
                    </Text>
                    <Pressable
                      accessibilityLabel={`Dismiss notification: ${notification.title}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        onDismiss?.(notification.id);
                      }}
                      style={({ pressed }) => [
                        styles.dismissButton,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.dismissText}>×</Text>
                    </Pressable>
                  </View>
                </View>
                <Text style={styles.cardTitle}>{notification.title}</Text>
                {notification.body ? (
                  <Text numberOfLines={4} style={styles.cardBody}>
                    {notification.body}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${String(days)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const styles = StyleSheet.create({
  overlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 1300,
  },
  backdrop: {
    backgroundColor: "rgba(1, 3, 8, 0.35)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  panel: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.launcherBorder,
    borderLeftWidth: 1,
    bottom: 0,
    overflow: "hidden",
    paddingTop: 20,
    position: "absolute",
    right: 0,
    top: 0,
    width: 380,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: 1,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 22,
  },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.5,
    marginTop: 4,
  },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 8 },
  clearAllButton: {
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.round,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  clearAllText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 11,
    fontWeight: "700",
  },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  closeText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 22,
    fontWeight: "300",
    lineHeight: 24,
  },
  scroller: { flex: 1 },
  content: { gap: 10, paddingBottom: 32, paddingHorizontal: 16, paddingTop: 16 },
  card: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    padding: 14,
  },
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  cardSourceRow: { alignItems: "center", flex: 1, flexDirection: "row", gap: 6 },
  sourceDot: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  cardSource: {
    color: SevynShellTheme.colors.muted,
    flex: 1,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  cardHeaderRight: { alignItems: "center", flexDirection: "row", gap: 6 },
  cardTime: { color: SevynShellTheme.colors.muted, fontSize: 10, fontWeight: "600" },
  dismissButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 10,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  dismissText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 15,
    fontWeight: "300",
    lineHeight: 17,
  },
  cardTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 8,
  },
  cardBody: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  emptyState: { alignItems: "center", paddingHorizontal: 28, paddingVertical: 58 },
  emptyMark: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderRadius: 24,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  emptyMarkText: { color: SevynShellTheme.colors.gold, fontSize: 24, fontWeight: "400" },
  emptyTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 17,
    fontWeight: "700",
    marginTop: 16,
  },
  emptyBody: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    textAlign: "center",
  },
  pressed: { opacity: 0.64 },
});
