import { useEffect, useRef, useState, type JSX } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import {
  ApplicationIcon,
  SevynMark,
  type MobileApplicationSummary,
} from "../mobile-home/mobile.js";
import { SevynShellTheme } from "../theme.js";
import type {
  DesktopDockRenderInput,
  DesktopShellApplicationSummary,
  DesktopShellBounds,
  DesktopShellDisplay,
} from "../desktop.js";

export interface DesktopDockProps extends DesktopDockRenderInput {
  readonly onLaunchApplication?: (applicationId: string) => void;
  readonly onFocusApplication?: (applicationId: string) => void;
  readonly onSwitchWorkspace?: (workspaceId: string) => void;
}

/**
 * macOS-style floating dock rendered as a real React Native component.
 * Icon magnification on hover is driven by RN Animated scale transforms,
 * so the compositor can apply it on the GPU instead of re-rasterizing
 * every icon on the CPU for each pointer move.
 */
export function DesktopDock({
  displays,
  position,
  applications,
  activeWorkspace,
  workspaces,
  onLaunchApplication,
  onFocusApplication,
  onSwitchWorkspace,
}: DesktopDockProps): JSX.Element {
  return (
    <>
      {displays.map((display) => (
        <DisplayDock
          key={display.id}
          display={display}
          position={position}
          applications={applications.filter(
            (application) => application.displayId === display.id,
          )}
          activeWorkspace={activeWorkspace}
          workspaces={workspaces}
          onLaunchApplication={onLaunchApplication}
          onFocusApplication={onFocusApplication}
          onSwitchWorkspace={onSwitchWorkspace}
        />
      ))}
    </>
  );
}

interface DisplayDockProps {
  readonly display: DesktopShellDisplay;
  readonly position: DesktopDockRenderInput["position"];
  readonly applications: readonly DesktopShellApplicationSummary[];
  readonly activeWorkspace: string;
  readonly workspaces: readonly string[];
  readonly onLaunchApplication?: ((applicationId: string) => void) | undefined;
  readonly onFocusApplication?: ((applicationId: string) => void) | undefined;
  readonly onSwitchWorkspace?: ((workspaceId: string) => void) | undefined;
}

function DisplayDock({
  display,
  position,
  applications,
  activeWorkspace,
  workspaces,
  onLaunchApplication,
  onFocusApplication,
  onSwitchWorkspace,
}: DisplayDockProps): JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | undefined>(undefined);
  const dockBounds = getFloatingDockBounds(
    display.taskbarBounds,
    applications.length,
    workspaces.length,
    position,
  );
  const vertical = position === "left" || position === "right";

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Dock"
      style={[
        styles.dock,
        {
          left: dockBounds.x - display.taskbarBounds.x,
          top: dockBounds.y - display.taskbarBounds.y,
          width: dockBounds.width,
          height: dockBounds.height,
          flexDirection: vertical ? "column" : "row",
        },
      ]}
    >
      <View style={styles.specularLine} />
      <View style={styles.launcherSlot}>
        <SevynMark />
      </View>
      {applications.length > 0 ? <View style={styles.divider} /> : null}
      {applications.map((application, index) => (
        <DockIcon
          key={application.applicationId}
          application={application}
          scale={magnificationFor(index, hoveredIndex)}
          onHoverIn={(): void => {
            setHoveredIndex(index);
          }}
          onHoverOut={(): void => {
            setHoveredIndex((current) => (current === index ? undefined : current));
          }}
          onPress={(): void => {
            if (application.focused) {
              onFocusApplication?.(application.applicationId);
            } else {
              onLaunchApplication?.(application.applicationId);
            }
          }}
        />
      ))}
      {workspaces.length > 0 ? (
        <>
          <View style={styles.divider} />
          <View
            accessibilityRole="tablist"
            accessibilityLabel="Workspaces"
            style={styles.workspaceList}
          >
            {workspaces.map((workspaceId) => (
              <Pressable
                key={workspaceId}
                accessibilityRole="tab"
                accessibilityLabel={`Workspace ${workspaceId}`}
                accessibilityState={{ selected: workspaceId === activeWorkspace }}
                onPress={(): void => onSwitchWorkspace?.(workspaceId)}
                style={({ pressed }) => [
                  styles.workspaceButton,
                  workspaceId === activeWorkspace && styles.workspaceButtonActive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text
                  style={[
                    styles.workspaceLabel,
                    workspaceId === activeWorkspace && styles.workspaceLabelActive,
                  ]}
                >
                  {workspaceId.slice(-1)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

interface DockIconProps {
  readonly application: DesktopShellApplicationSummary;
  readonly scale: number;
  readonly onHoverIn: () => void;
  readonly onHoverOut: () => void;
  readonly onPress: () => void;
}

function DockIcon({
  application,
  scale,
  onHoverIn,
  onHoverOut,
  onPress,
}: DockIconProps): JSX.Element {
  const animatedScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.spring(animatedScale, {
      toValue: scale,
      useNativeDriver: true,
      stiffness: 320,
      damping: 22,
      mass: 0.8,
    }).start();
  }, [animatedScale, scale]);

  const running = (application.running ?? application.focused) || application.minimized;
  const summary: MobileApplicationSummary = {
    id: application.applicationId,
    name: application.label,
    running,
    ...(application.icon === undefined ? {} : { icon: application.icon }),
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={application.label}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        application.focused && styles.iconButtonFocused,
        pressed && styles.buttonPressed,
      ]}
    >
      <Animated.View
        style={[styles.iconScaler, { transform: [{ scale: animatedScale }] }]}
      >
        <ApplicationIcon application={summary} size={34} />
      </Animated.View>
      {running ? (
        <View
          style={[
            styles.runningIndicator,
            application.focused && styles.runningIndicatorFocused,
          ]}
        />
      ) : null}
    </Pressable>
  );
}

/**
 * macOS magnification curve: the hovered icon grows to 1.5x, with a smooth
 * falloff for neighbors. Neighbors lift slightly so the dock feels fluid.
 */
function magnificationFor(index: number, hoveredIndex: number | undefined): number {
  if (hoveredIndex === undefined) return 1;
  const distance = Math.abs(index - hoveredIndex);
  if (distance === 0) return 1.5;
  if (distance === 1) return 1.28;
  if (distance === 2) return 1.12;
  return 1;
}

interface FloatingDockBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * macOS-style floating dock bounds: centered, width based on icon count,
 * 8px from the screen edge. Mirrors the layout math in desktop.ts so the
 * RN dock occupies exactly the same space as the scene-node dock.
 */
function getFloatingDockBounds(
  taskbarBounds: DesktopShellBounds,
  iconCount: number,
  workspaceCount: number,
  position: DesktopDockRenderInput["position"],
): FloatingDockBounds {
  const tilePitch = 54;
  const workspacePitch = 32;
  const dividerWidth = 20;
  const horizontalPadding = 16;
  const dockWidth = Math.max(
    80,
    iconCount * tilePitch +
      (workspaceCount > 0 ? dividerWidth + workspaceCount * workspacePitch : 0) +
      horizontalPadding * 2,
  );
  const dockHeight = 60;
  const margin = 8;

  switch (position) {
    case "top":
      return {
        x: Math.round(taskbarBounds.x + (taskbarBounds.width - dockWidth) / 2),
        y: taskbarBounds.y + margin,
        width: dockWidth,
        height: dockHeight,
      };
    case "left":
      return {
        x: taskbarBounds.x + margin,
        y: Math.round(taskbarBounds.y + (taskbarBounds.height - dockHeight) / 2),
        width: dockWidth,
        height: dockHeight,
      };
    case "right":
      return {
        x: taskbarBounds.x + taskbarBounds.width - dockWidth - margin,
        y: Math.round(taskbarBounds.y + (taskbarBounds.height - dockHeight) / 2),
        width: dockWidth,
        height: dockHeight,
      };
    case "bottom":
    default:
      return {
        x: Math.round(taskbarBounds.x + (taskbarBounds.width - dockWidth) / 2),
        y: taskbarBounds.y + taskbarBounds.height - dockHeight - margin,
        width: dockWidth,
        height: dockHeight,
      };
  }
}

const styles = StyleSheet.create({
  dock: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.dockBackground,
    borderColor: SevynShellTheme.colors.dockBorder,
    borderRadius: SevynShellTheme.radius.dock,
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    position: "absolute",
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
  launcherSlot: {
    alignItems: "center",
    height: 48,
    justifyContent: "center",
    width: 44,
  },
  divider: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
    height: 30,
    marginHorizontal: 7,
    width: 1,
  },
  iconButton: {
    alignItems: "center",
    borderRadius: 18,
    height: 48,
    justifyContent: "center",
    position: "relative",
    width: 50,
  },
  iconButtonFocused: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
    borderWidth: 1,
  },
  iconScaler: {
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPressed: { opacity: 0.65, transform: [{ scale: 0.94 }] },
  runningIndicator: {
    backgroundColor: "rgba(255, 255, 255, 0.40)",
    borderRadius: SevynShellTheme.radius.round,
    bottom: 3,
    height: 3,
    position: "absolute",
    width: 12,
  },
  runningIndicatorFocused: {
    backgroundColor: SevynShellTheme.colors.gold,
    width: 20,
  },
  workspaceList: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
  workspaceButton: {
    alignItems: "center",
    borderRadius: SevynShellTheme.radius.round,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  workspaceButtonActive: {
    backgroundColor: SevynShellTheme.colors.accentSoft,
    borderColor: SevynShellTheme.colors.accentGlow,
    borderWidth: 1,
  },
  workspaceLabel: {
    color: SevynShellTheme.colors.secondary,
    fontSize: 13,
    fontWeight: "600",
  },
  workspaceLabelActive: {
    color: SevynShellTheme.colors.primary,
  },
});
