import { useMemo, useState, type JSX } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SevynShellTheme } from "../theme.js";

export interface SystemNotificationAction {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface SystemNotificationSummary {
  readonly id: string;
  readonly applicationId?: string;
  readonly applicationName: string;
  readonly title: string;
  readonly body: string;
  readonly timestamp?: Date | string | number;
  readonly read?: boolean;
  readonly accent?: string;
  readonly actions?: readonly SystemNotificationAction[];
}

export interface NotificationCenterApplicationProps {
  readonly notifications?: readonly SystemNotificationSummary[];
  readonly open?: boolean;
  readonly doNotDisturb?: boolean;
  readonly onAction?: (notificationId: string, actionId: string) => Promise<void> | void;
  readonly onClearAll?: () => Promise<void> | void;
  readonly onClose?: () => void;
  readonly onDismiss?: (notificationId: string) => Promise<void> | void;
  readonly onOpenNotification?: (notificationId: string) => Promise<void> | void;
  readonly onSetDoNotDisturb?: (enabled: boolean) => Promise<void> | void;
}

export function NotificationCenterApplication({
  notifications = [],
  open = true,
  doNotDisturb: initialDoNotDisturb = false,
  onAction,
  onClearAll,
  onClose,
  onDismiss,
  onOpenNotification,
  onSetDoNotDisturb,
}: NotificationCenterApplicationProps = {}): JSX.Element | null {
  const { width } = useWindowDimensions();
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [doNotDisturb, setDoNotDisturb] = useState(initialDoNotDisturb);
  const [pendingAction, setPendingAction] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const compact = width < 680;
  const visibleNotifications = useMemo(
    () => notifications.filter((notification) => !dismissedIds.has(notification.id)),
    [dismissedIds, notifications],
  );
  const unreadCount = visibleNotifications.filter(
    (notification) => notification.read !== true,
  ).length;

  if (!open) return null;

  const dismiss = (notificationId: string): void => {
    setDismissedIds((current) => new Set([...current, notificationId]));
    Promise.resolve(onDismiss?.(notificationId)).catch((error: unknown) => {
      setDismissedIds((current) => {
        const next = new Set(current);
        next.delete(notificationId);
        return next;
      });
      setOperationError(
        messageForError(error, "The notification could not be dismissed."),
      );
    });
  };

  const clearAll = (): void => {
    const previousIds = dismissedIds;
    setDismissedIds(new Set(notifications.map((notification) => notification.id)));
    Promise.resolve(onClearAll?.()).catch((error: unknown) => {
      setDismissedIds(previousIds);
      setOperationError(messageForError(error, "Notifications could not be cleared."));
    });
  };

  const setFocusMode = (enabled: boolean): void => {
    const previous = doNotDisturb;
    setDoNotDisturb(enabled);
    Promise.resolve(onSetDoNotDisturb?.(enabled)).catch((error: unknown) => {
      setDoNotDisturb(previous);
      setOperationError(messageForError(error, "Focus mode could not be changed."));
    });
  };

  const runNotificationAction = (notificationId: string, actionId: string): void => {
    const operationId = `${notificationId}:${actionId}`;
    setPendingAction(operationId);
    setOperationError(undefined);
    Promise.resolve(onAction?.(notificationId, actionId))
      .catch((error: unknown) => {
        setOperationError(messageForError(error, "That action could not be completed."));
      })
      .finally(() => {
        setPendingAction(undefined);
      });
  };

  return (
    <View
      accessibilityLabel="Notification center"
      accessibilityViewIsModal
      style={styles.overlay}
    >
      <Pressable
        accessibilityLabel="Close notification center"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View style={[styles.panel, compact ? styles.panelCompact : styles.panelWide]}>
        <View style={styles.specularLine} />
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>SEVYN OS</Text>
            <View style={styles.titleRow}>
              <Text style={styles.title}>Notifications</Text>
              {unreadCount > 0 ? (
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>{unreadCount}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <Pressable
            accessibilityLabel="Close notification center"
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <View style={styles.controls}>
          <Pressable
            accessibilityLabel="Focus mode"
            accessibilityRole="switch"
            accessibilityState={{ checked: doNotDisturb }}
            onPress={() => {
              setFocusMode(!doNotDisturb);
            }}
            style={({ pressed }) => [
              styles.focusControl,
              doNotDisturb && styles.focusControlActive,
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.focusGlyph, doNotDisturb && styles.focusGlyphActive]}>
              <View style={styles.focusMoon} />
            </View>
            <View style={styles.focusCopy}>
              <Text style={styles.focusTitle}>Focus</Text>
              <Text style={styles.focusSubtitle}>
                {doNotDisturb ? "Quiet notifications" : "Notifications allowed"}
              </Text>
            </View>
            <View style={[styles.switchTrack, doNotDisturb && styles.switchTrackActive]}>
              <View
                style={[styles.switchThumb, doNotDisturb && styles.switchThumbActive]}
              />
            </View>
          </Pressable>
          {visibleNotifications.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear all notifications"
              accessibilityRole="button"
              onPress={clearAll}
              style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
            >
              <Text style={styles.clearText}>Clear all</Text>
            </Pressable>
          ) : null}
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
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          style={styles.list}
        >
          {visibleNotifications.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyBell}>
                <View style={styles.bellDome} />
                <View style={styles.bellClapper} />
              </View>
              <Text style={styles.emptyTitle}>You’re all caught up</Text>
              <Text style={styles.emptyBody}>
                New activity will arrive here without interrupting your flow.
              </Text>
            </View>
          ) : (
            visibleNotifications.map((notification) => (
              <NotificationCard
                key={notification.id}
                notification={notification}
                onAction={(actionId) => {
                  runNotificationAction(notification.id, actionId);
                }}
                onDismiss={() => {
                  dismiss(notification.id);
                }}
                onOpen={() => {
                  void Promise.resolve(onOpenNotification?.(notification.id)).catch(
                    (error: unknown) => {
                      setOperationError(
                        messageForError(error, "The notification could not be opened."),
                      );
                    },
                  );
                }}
                pendingAction={pendingAction}
              />
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function NotificationCard({
  notification,
  onAction,
  onDismiss,
  onOpen,
  pendingAction,
}: {
  readonly notification: SystemNotificationSummary;
  readonly onAction: (actionId: string) => void;
  readonly onDismiss: () => void;
  readonly onOpen: () => void;
  readonly pendingAction?: string | undefined;
}): JSX.Element {
  const accent = notification.accent ?? SevynShellTheme.colors.accent;
  return (
    <View
      accessibilityLabel={`${notification.applicationName}: ${notification.title}`}
      style={styles.card}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.applicationIcon, { backgroundColor: accent }]}>
          <Text style={styles.applicationIconText}>
            {notification.applicationName.trim().slice(0, 1).toLocaleUpperCase() || "7"}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={`Open ${notification.title}`}
          accessibilityRole="button"
          onPress={onOpen}
          style={styles.cardHeading}
        >
          <View style={styles.applicationRow}>
            <Text numberOfLines={1} style={styles.applicationName}>
              {notification.applicationName}
            </Text>
            {notification.read === true ? null : <View style={styles.unreadDot} />}
          </View>
          <Text style={styles.timestamp}>{formatTimestamp(notification.timestamp)}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={`Dismiss ${notification.title}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onDismiss}
          style={({ pressed }) => [styles.dismissButton, pressed && styles.pressed]}
        >
          <Text style={styles.dismissText}>×</Text>
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" onPress={onOpen} style={styles.cardBody}>
        <Text style={styles.notificationTitle}>{notification.title}</Text>
        <Text style={styles.notificationBody}>{notification.body}</Text>
      </Pressable>
      {notification.actions === undefined || notification.actions.length === 0 ? null : (
        <View style={styles.actionRow}>
          {notification.actions.map((action) => {
            const operationId = `${notification.id}:${action.id}`;
            const pending = pendingAction === operationId;
            return (
              <Pressable
                key={action.id}
                accessibilityLabel={action.label}
                accessibilityRole="button"
                accessibilityState={{ busy: pending }}
                disabled={pending}
                onPress={() => {
                  onAction(action.id);
                }}
                style={({ pressed }) => [
                  styles.actionButton,
                  action.destructive === true && styles.actionButtonDestructive,
                  pressed && styles.pressed,
                ]}
              >
                {pending ? (
                  <ActivityIndicator
                    color={SevynShellTheme.colors.primary}
                    size="small"
                  />
                ) : (
                  <Text
                    style={[
                      styles.actionText,
                      action.destructive === true && styles.actionTextDestructive,
                    ]}
                  >
                    {action.label}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function formatTimestamp(timestamp: Date | string | number | undefined): string {
  if (timestamp === undefined) return "Now";
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Now";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (elapsedMinutes < 1) return "Now";
  if (elapsedMinutes < 60) return `${String(elapsedMinutes)}m`;
  if (elapsedMinutes < 1_440) return `${String(Math.floor(elapsedMinutes / 60))}h`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
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
    zIndex: 1400,
  },
  backdrop: {
    backgroundColor: "rgba(1, 3, 8, 0.56)",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  panel: {
    backgroundColor: SevynShellTheme.colors.launcherSurface,
    borderColor: SevynShellTheme.colors.borderStrong,
    borderWidth: 1,
    bottom: 0,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: 0,
  },
  panelWide: { maxWidth: 460, width: "42%" },
  panelCompact: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    height: "92%",
    left: 0,
    top: "8%",
    width: "100%",
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.glassSpecular,
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
    paddingBottom: 17,
    paddingHorizontal: 22,
    paddingTop: 26,
  },
  headerCopy: { flex: 1 },
  eyebrow: {
    color: SevynShellTheme.colors.gold,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 2.1,
  },
  titleRow: { alignItems: "center", flexDirection: "row", marginTop: 4 },
  title: {
    color: SevynShellTheme.colors.primary,
    fontSize: 27,
    fontWeight: "700",
    letterSpacing: -0.7,
  },
  countBadge: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 10,
    height: 20,
    justifyContent: "center",
    marginLeft: 9,
    minWidth: 20,
    paddingHorizontal: 5,
  },
  countText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
  closeButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  closeText: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 24,
    fontWeight: "300",
    lineHeight: 26,
  },
  controls: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
  },
  focusControl: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    minHeight: 62,
    paddingHorizontal: 12,
  },
  focusControlActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.38)",
  },
  focusGlyph: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.surface,
    borderRadius: 15,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  focusGlyphActive: { backgroundColor: SevynShellTheme.colors.accent },
  focusMoon: {
    borderColor: "#FFFFFF",
    borderRadius: 7,
    borderRightColor: "transparent",
    borderTopColor: "transparent",
    borderWidth: 2,
    height: 14,
    transform: [{ rotate: "35deg" }],
    width: 14,
  },
  focusCopy: { flex: 1, marginLeft: 9 },
  focusTitle: { color: SevynShellTheme.colors.primary, fontSize: 13, fontWeight: "700" },
  focusSubtitle: { color: SevynShellTheme.colors.muted, fontSize: 10, marginTop: 2 },
  switchTrack: {
    backgroundColor: SevynShellTheme.colors.elevatedSurface,
    borderRadius: 10,
    height: 20,
    padding: 2,
    width: 34,
  },
  switchTrackActive: { backgroundColor: SevynShellTheme.colors.accent },
  switchThumb: {
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    height: 16,
    width: 16,
  },
  switchThumbActive: { alignSelf: "flex-end" },
  clearButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  clearText: { color: SevynShellTheme.colors.secondary, fontSize: 11, fontWeight: "700" },
  errorBanner: {
    backgroundColor: "rgba(244, 109, 117, 0.12)",
    borderColor: "rgba(244, 109, 117, 0.32)",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    marginHorizontal: 18,
    marginTop: 12,
    padding: 11,
  },
  errorText: { color: "#FFB7BC", fontSize: 11, lineHeight: 16 },
  list: { flex: 1, marginTop: 14 },
  listContent: { gap: 10, paddingBottom: 32, paddingHorizontal: 18 },
  card: {
    backgroundColor: SevynShellTheme.colors.glass,
    borderColor: SevynShellTheme.colors.border,
    borderRadius: SevynShellTheme.radius.lg,
    borderWidth: 1,
    padding: 13,
  },
  cardHeader: { alignItems: "center", flexDirection: "row" },
  applicationIcon: {
    alignItems: "center",
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 11,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  applicationIconText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  cardHeading: { flex: 1, marginLeft: 10 },
  applicationRow: { alignItems: "center", flexDirection: "row" },
  applicationName: {
    color: SevynShellTheme.colors.secondary,
    flexShrink: 1,
    fontSize: 11,
    fontWeight: "700",
  },
  unreadDot: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderRadius: 3,
    height: 5,
    marginLeft: 6,
    width: 5,
  },
  timestamp: { color: SevynShellTheme.colors.muted, fontSize: 9, marginTop: 2 },
  dismissButton: {
    alignItems: "center",
    borderRadius: 14,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  dismissText: { color: SevynShellTheme.colors.muted, fontSize: 20, lineHeight: 22 },
  cardBody: { marginTop: 11 },
  notificationTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  notificationBody: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  actionButton: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: "rgba(159, 168, 255, 0.32)",
    borderRadius: SevynShellTheme.radius.sm,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 34,
    minWidth: 74,
    paddingHorizontal: 12,
  },
  actionButtonDestructive: {
    backgroundColor: "rgba(244, 109, 117, 0.11)",
    borderColor: "rgba(244, 109, 117, 0.28)",
  },
  actionText: { color: SevynShellTheme.colors.primary, fontSize: 11, fontWeight: "700" },
  actionTextDestructive: { color: "#FFB7BC" },
  emptyState: { alignItems: "center", paddingHorizontal: 26, paddingVertical: 64 },
  emptyBell: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassLight,
    borderRadius: 29,
    height: 58,
    justifyContent: "center",
    width: 58,
  },
  bellDome: {
    borderColor: SevynShellTheme.colors.secondary,
    borderRadius: 9,
    borderTopWidth: 2,
    borderWidth: 1.5,
    height: 18,
    width: 19,
  },
  bellClapper: {
    backgroundColor: SevynShellTheme.colors.secondary,
    borderRadius: 2,
    height: 3,
    marginTop: 2,
    width: 5,
  },
  emptyTitle: {
    color: SevynShellTheme.colors.primary,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 15,
  },
  emptyBody: {
    color: SevynShellTheme.colors.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    textAlign: "center",
  },
  pressed: { opacity: 0.64 },
});
