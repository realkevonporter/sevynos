import { useState, type ComponentType, type JSX } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type PressableProps,
} from "react-native";
import { SevynMark } from "../mobile-home/mobile.js";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellApplicationSummary } from "../desktop.js";
import {
  createContextMenuState,
  dismissContextMenu,
  renderContextMenu,
  type ContextMenuState,
  type MenuItem,
} from "../context-menu.js";

interface WebContextMenuEvent {
  readonly nativeEvent: {
    readonly pageX: number;
    readonly pageY: number;
  };
  preventDefault: () => void;
}

interface WebPressableProps extends PressableProps {
  readonly onContextMenu?: (event: WebContextMenuEvent) => void;
}

const WebPressable = Pressable as unknown as ComponentType<WebPressableProps>;

export interface DesktopDockApplicationProps {
  readonly applications: readonly DesktopShellApplicationSummary[];
  readonly activeWorkspace: string;
  readonly workspaces: readonly string[];
  readonly onLaunch: (applicationId: string) => Promise<void> | void;
  readonly onSwitchWorkspace: (workspaceId: string) => void;
  readonly onToggleLauncher: () => void;
  readonly launcherOpen?: boolean;
}

export function DesktopDockApplication({
  applications,
  activeWorkspace,
  workspaces,
  onLaunch,
  onSwitchWorkspace,
  onToggleLauncher,
  launcherOpen,
}: DesktopDockApplicationProps): JSX.Element {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(dismissContextMenu());
  const [hoveredApp, setHoveredApp] = useState<string | null>(null);

  const handleContextMenu = (
    e: WebContextMenuEvent,
    application: DesktopShellApplicationSummary,
  ) => {
    e.preventDefault();
    const isRunning =
      application.running ?? (application.focused || application.minimized);
    const isPinned = application.pinned;

    const items: MenuItem[] = [];

    if (isRunning && isPinned) {
      items.push({
        id: "new-window",
        label: "New Window",
        onAction: () => {
          void onLaunch(application.applicationId);
          setContextMenu(dismissContextMenu());
        },
      });
      items.push({
        id: "unpin",
        label: "Unpin from Dock",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      });
      items.push({ kind: "separator" });
      items.push({
        id: "quit",
        label: "Quit",
        destructive: true,
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      });
    } else if (isRunning) {
      items.push({
        id: "new-window",
        label: "New Window",
        onAction: () => {
          void onLaunch(application.applicationId);
          setContextMenu(dismissContextMenu());
        },
      });
      items.push({
        id: "pin",
        label: "Pin to Dock",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      });
      items.push({ kind: "separator" });
      items.push({
        id: "quit",
        label: "Quit",
        destructive: true,
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      });
    } else if (isPinned) {
      items.push({
        id: "open",
        label: "Open",
        onAction: () => {
          void onLaunch(application.applicationId);
          setContextMenu(dismissContextMenu());
        },
      });
      items.push({
        id: "unpin",
        label: "Unpin from Dock",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      });
    }

    setContextMenu(
      createContextMenuState(
        { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY - 150 },
        items,
      ),
    );
  };

  return (
    <View accessibilityRole="toolbar" style={styles.dockContainer}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => {
          setContextMenu(dismissContextMenu());
        }}
      />
      <View style={styles.dockIsland}>
        {/* Specular glass reflection line */}
        <View style={styles.specularLine} />

        {/* Sevyn Launcher Emblem */}
        <Pressable
          accessibilityLabel="Toggle launcher"
          accessibilityRole="button"
          onPress={onToggleLauncher}
          style={({ pressed }) => [
            styles.launcherButton,
            launcherOpen && styles.launcherButtonActive,
            pressed && styles.buttonPressed,
          ]}
        >
          <SevynMark />
        </Pressable>

        <View style={styles.divider} />

        {/* Running Applications */}
        <ScrollView
          contentContainerStyle={styles.applicationList}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.applicationScroller}
        >
          {applications.map((application) => {
            const active = application.focused;
            const monogram = getAppMonogram(application.label);
            const isHovered = hoveredApp === application.applicationId;
            const isRunning =
              application.running ?? (application.focused || application.minimized);

            return (
              <View key={application.applicationId} style={styles.appContainer}>
                <WebPressable
                  accessibilityLabel={`Switch to ${application.label}`}
                  accessibilityRole="button"
                  onPress={() => {
                    void onLaunch(application.applicationId);
                  }}
                  onContextMenu={(e) => {
                    handleContextMenu(e, application);
                  }}
                  onHoverIn={() => {
                    setHoveredApp(application.applicationId);
                  }}
                  onHoverOut={() => {
                    setHoveredApp(null);
                  }}
                  style={({ pressed }) => [
                    styles.appTile,
                    active && styles.appTileActive,
                    application.minimized && styles.appTileMinimized,
                    isHovered && styles.appTileHovered,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <View
                    style={[
                      styles.appIconContainer,
                      active && styles.appIconContainerActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.appIconMonogram,
                        active && styles.appIconMonogramActive,
                      ]}
                    >
                      {monogram}
                    </Text>
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[styles.appLabel, active && styles.appLabelActive]}
                  >
                    {application.label}
                  </Text>
                  {active ? <View style={styles.activeGlowPill} /> : null}
                </WebPressable>
                {isRunning ? <View style={styles.runningDot} /> : null}
              </View>
            );
          })}
        </ScrollView>

        <View style={styles.divider} />

        {/* Workspace Switcher */}
        <View style={styles.workspacesContainer}>
          {workspaces.map((workspaceId) => {
            const active = workspaceId === activeWorkspace;
            const label = workspaceId.slice(-1);
            return (
              <Pressable
                key={workspaceId}
                accessibilityLabel={`Switch to workspace ${label}`}
                accessibilityRole="button"
                onPress={() => {
                  onSwitchWorkspace(workspaceId);
                }}
                style={({ pressed }) => [
                  styles.workspaceButton,
                  active && styles.workspaceButtonActive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text
                  style={[styles.workspaceLabel, active && styles.workspaceLabelActive]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {renderContextMenu(contextMenu, SevynShellTheme)}
    </View>
  );
}

function getAppMonogram(label: string): string {
  const lower = label.toLocaleLowerCase();
  if (lower.includes("welcome")) return "W";
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "WB";
  if (lower.includes("file")) return "FL";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "SM";
  if (lower.includes("note")) return "NT";
  if (lower.includes("text") || lower.includes("editor")) return "TE";
  if (lower.includes("app") && lower.includes("manage")) return "AM";
  if (lower.includes("gallery") || lower.includes("component")) return "UI";
  return label.slice(0, 1).toLocaleUpperCase() || "•";
}

const styles = StyleSheet.create({
  dockContainer: {
    alignItems: "center",
    bottom: 10,
    flexDirection: "row",
    height: 76,
    justifyContent: "center",
    left: 0,
    paddingHorizontal: SevynShellTheme.spacing.md,
    position: "absolute",
    right: 0,
    zIndex: 1000,
  },
  dockIsland: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.dockBackground,
    borderColor: SevynShellTheme.colors.dockBorder,
    borderRadius: SevynShellTheme.radius.dock,
    borderWidth: 1,
    flexDirection: "row",
    height: SevynShellTheme.dock.height,
    maxWidth: "84%",
    overflow: "hidden",
    paddingHorizontal: SevynShellTheme.spacing.sm + 2,
    position: "relative",
    shadowColor: SevynShellTheme.shadows.dock.shadowColor,
    shadowOffset: SevynShellTheme.shadows.dock.shadowOffset,
    shadowOpacity: SevynShellTheme.shadows.dock.shadowOpacity,
    shadowRadius: SevynShellTheme.shadows.dock.shadowRadius,
  },
  specularLine: {
    backgroundColor: SevynShellTheme.colors.dockSpecular,
    height: 1,
    left: 24,
    position: "absolute",
    right: 24,
    top: 0,
  },
  launcherButton: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 46,
  },
  launcherButtonActive: {
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: SevynShellTheme.colors.goldGlow,
  },
  divider: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    height: 28,
    marginHorizontal: SevynShellTheme.spacing.xs,
    width: 1,
  },
  applicationScroller: {
    flexGrow: 0,
    flexShrink: 1,
  },
  applicationList: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  appContainer: {
    alignItems: "center",
    justifyContent: "center",
    height: 56,
  },
  appTile: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: SevynShellTheme.radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    height: 44,
    justifyContent: "center",
    maxWidth: SevynShellTheme.dock.itemMaxWidth,
    minWidth: SevynShellTheme.dock.itemMinWidth,
    paddingHorizontal: SevynShellTheme.spacing.sm,
    position: "relative",
  },
  appTileHovered: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    transform: [{ scale: 1.04 }],
  },
  appTileActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
  },
  appTileMinimized: {
    opacity: 0.55,
  },
  appIconContainer: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.10)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 8,
    borderWidth: 1,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  appIconContainerActive: {
    backgroundColor: SevynShellTheme.colors.accent,
    borderColor: SevynShellTheme.colors.accentGlow,
  },
  appIconMonogram: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 12,
    fontWeight: "700",
  },
  appIconMonogramActive: {
    color: "#FFFFFF",
  },
  appLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  appLabelActive: {
    color: SevynShellTheme.colors.primary,
    fontWeight: "700",
  },
  activeGlowPill: {
    backgroundColor: SevynShellTheme.colors.dockActivePill,
    borderRadius: SevynShellTheme.radius.round,
    bottom: 2,
    height: 2.5,
    position: "absolute",
    width: 24,
  },
  runningDot: {
    backgroundColor: SevynShellTheme.colors.primary,
    borderRadius: 2,
    bottom: 3,
    height: 4,
    position: "absolute",
    width: 4,
    opacity: 0.9,
  },
  workspacesContainer: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.28)",
    borderColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    flexShrink: 0,
    gap: 3,
    minWidth: 116,
    padding: 3,
  },
  workspaceButton: {
    alignItems: "center",
    borderRadius: 10,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  workspaceButtonActive: {
    backgroundColor: SevynShellTheme.colors.goldSoft,
    borderColor: "rgba(240, 208, 138, 0.35)",
    borderWidth: 1,
  },
  workspaceLabel: {
    color: SevynShellTheme.colors.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  workspaceLabelActive: {
    color: SevynShellTheme.colors.gold,
    fontWeight: "800",
  },
  buttonPressed: {
    opacity: 0.65,
    transform: [{ scale: 0.95 }],
  },
});
