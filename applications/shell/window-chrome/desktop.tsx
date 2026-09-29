/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";

export interface WindowChromeWindow {
  readonly id: string;
  readonly title: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly zIndex: number;
  readonly focused: boolean;
  readonly maximized: boolean;
}

export interface WindowChromeProps {
  readonly windows: readonly WindowChromeWindow[];
  readonly onClose?: (windowId: string) => void;
  readonly onMinimize?: (windowId: string) => void;
  readonly onMaximize?: (windowId: string) => void;
}

const TITLE_BAR_HEIGHT = 46;
const CONTROL_SIZE = 12;
const CONTROL_GAP = 8;
const CONTROL_LEFT_INSET = 20;
const CONTROL_TOP_INSET = 17;

type ControlKind = "close" | "minimize" | "maximize";

const CONTROL_COLORS: Record<ControlKind, string> = {
  close: "#FF5F57",
  minimize: "#FEBC2E",
  maximize: "#28C840",
};

function TrafficLight({
  kind,
  windowId,
  onPress,
}: {
  readonly kind: ControlKind;
  readonly windowId: string;
  readonly onPress?: (windowId: string, kind: ControlKind) => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={`${kind} window`}
      accessibilityRole="button"
      onPress={() => onPress?.(windowId, kind)}
      style={[styles.trafficLight, { backgroundColor: CONTROL_COLORS[kind] }]}
    />
  );
}

function WindowTitleBar({
  window,
  onClose,
  onMinimize,
  onMaximize,
}: {
  readonly window: WindowChromeWindow;
  readonly onClose?: ((windowId: string) => void) | undefined;
  readonly onMinimize?: ((windowId: string) => void) | undefined;
  readonly onMaximize?: ((windowId: string) => void) | undefined;
}): JSX.Element {
  const handleControlPress = (windowId: string, kind: ControlKind) => {
    if (kind === "close") onClose?.(windowId);
    else if (kind === "minimize") onMinimize?.(windowId);
    else onMaximize?.(windowId);
  };

  return (
    <View
      style={[
        styles.titleBar,
        {
          left: window.bounds.x,
          top: window.bounds.y,
          width: window.bounds.width,
          opacity: window.focused ? 1 : 0.85,
        },
      ]}
    >
      <View style={styles.controlsRow}>
        {(["close", "minimize", "maximize"] as const).map((kind) => (
          <TrafficLight
            key={kind}
            kind={kind}
            windowId={window.id}
            onPress={handleControlPress}
          />
        ))}
      </View>
      <Text numberOfLines={1} style={styles.title}>
        {window.title}
      </Text>
    </View>
  );
}

/**
 * Window chrome (title bars + traffic lights) rendered as a React Native component.
 * Replaces the native window chrome rendering in the compositor.
 * Renders title bars for all visible windows, ordered by zIndex.
 */
export function WindowChrome({
  windows,
  onClose,
  onMinimize,
  onMaximize,
}: WindowChromeProps): JSX.Element {
  const sorted = [...windows].sort((a, b) => a.zIndex - b.zIndex);
  return (
    <View pointerEvents="box-none" style={styles.root}>
      {sorted.map((window) => (
        <WindowTitleBar
          key={window.id}
          window={window}
          onClose={onClose}
          onMinimize={onMinimize}
          onMaximize={onMaximize}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  titleBar: {
    alignItems: "center",
    backgroundColor: SevynShellTheme.colors.glassStrong,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    flexDirection: "row",
    height: TITLE_BAR_HEIGHT,
    position: "absolute",
  },
  controlsRow: {
    flexDirection: "row",
    gap: CONTROL_GAP,
    left: CONTROL_LEFT_INSET,
    position: "absolute",
    top: CONTROL_TOP_INSET,
  },
  trafficLight: {
    borderRadius: CONTROL_SIZE / 2,
    height: CONTROL_SIZE,
    width: CONTROL_SIZE,
  },
  title: {
    color: SevynShellTheme.colors.primary,
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
});
