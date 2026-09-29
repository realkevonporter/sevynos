/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellBounds, DesktopWorkspaceRenderInput } from "../desktop.js";

export interface DesktopWorkspaceProps extends DesktopWorkspaceRenderInput {
  readonly onNewFolder?: () => void;
  readonly onNewFile?: () => void;
  readonly onOpenEntry?: (path: string) => void;
}

const ITEM_WIDTH = 104;
const ITEM_HEIGHT = 92;
const HORIZONTAL_GAP = 18;
const VERTICAL_GAP = 16;

function WorkspaceAction({
  label,
  x,
  y,
  onPress,
}: {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly onPress?: (() => void) | undefined;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [
        styles.action,
        { left: x, top: y },
        pressed && styles.actionPressed,
      ]}
    >
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function WorkspaceItem({
  name,
  path,
  kind,
  x,
  y,
  onPress,
}: {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly x: number;
  readonly y: number;
  readonly onPress?: ((path: string) => void) | undefined;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={() => onPress?.(path)}
      style={({ pressed }: { pressed: boolean }) => [
        styles.item,
        { left: x, top: y },
        pressed && styles.itemPressed,
      ]}
    >
      <View
        style={[styles.icon, kind === "directory" ? styles.folderIcon : styles.fileIcon]}
      >
        <Text style={styles.iconGlyph}>{kind === "directory" ? "📁" : "📄"}</Text>
      </View>
      <Text numberOfLines={2} style={styles.itemLabel}>
        {name}
      </Text>
    </Pressable>
  );
}

/**
 * Desktop workspace (icons) rendered as a React Native component.
 * Replaces the native `renderDesktopWorkspace` scene-node builder.
 * Shows "New folder" / "New text file" actions plus a grid of desktop entries.
 */
export function DesktopWorkspace({
  display,
  entries,
  onNewFolder,
  onNewFile,
  onOpenEntry,
}: DesktopWorkspaceProps): JSX.Element {
  const actionY = display.y + 70;
  const iconTop = actionY + 52;
  const columns = Math.max(
    1,
    Math.floor((display.width - 48) / (ITEM_WIDTH + HORIZONTAL_GAP)),
  );
  return (
    <View pointerEvents="box-none" style={styles.root}>
      <WorkspaceAction
        label="New folder"
        x={display.x + 24}
        y={actionY}
        onPress={onNewFolder}
      />
      <WorkspaceAction
        label="New text file"
        x={display.x + 164}
        y={actionY}
        onPress={onNewFile}
      />
      {entries.map((entry, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        return (
          <WorkspaceItem
            key={entry.path}
            name={entry.name}
            path={entry.path}
            kind={entry.kind}
            x={display.x + 24 + column * (ITEM_WIDTH + HORIZONTAL_GAP)}
            y={iconTop + row * (ITEM_HEIGHT + VERTICAL_GAP)}
            onPress={onOpenEntry}
          />
        );
      })}
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
  action: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: SevynShellTheme.radius.md,
    height: 34,
    justifyContent: "center",
    position: "absolute",
    width: 132,
  },
  actionPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  actionLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 13,
    fontWeight: "500",
  },
  item: {
    alignItems: "center",
    borderRadius: SevynShellTheme.radius.md,
    height: ITEM_HEIGHT,
    justifyContent: "flex-start",
    paddingTop: 8,
    position: "absolute",
    width: ITEM_WIDTH,
  },
  itemPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  icon: {
    alignItems: "center",
    borderRadius: SevynShellTheme.radius.sm,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  folderIcon: {
    backgroundColor: "rgba(240, 208, 138, 0.2)",
  },
  fileIcon: {
    backgroundColor: "rgba(139, 156, 254, 0.2)",
  },
  iconGlyph: {
    fontSize: 28,
  },
  itemLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12,
    marginTop: 6,
    textAlign: "center",
  },
});

export type { DesktopShellBounds };
