import { type JSX } from "react";
import { StyleSheet, Text, View, Pressable } from "react-native";
import { SevynShellTheme } from "./theme.js";

export interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly destructive?: boolean;
  readonly onAction?: () => void;
}

export interface MenuSeparator {
  readonly kind: "separator";
}

export interface MenuSubmenu {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly items: readonly MenuItem[];
}

export type MenuItem = MenuAction | MenuSeparator | MenuSubmenu;

export interface MenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ContextMenuState {
  readonly visible: boolean;
  readonly position: MenuPosition;
  readonly items: readonly MenuItem[];
  readonly selectedIndex: number;
  readonly activeSubmenuId?: string;
}

export function createContextMenuState(
  position: MenuPosition,
  items: readonly MenuItem[],
): ContextMenuState {
  return Object.freeze({
    visible: true,
    position,
    items,
    selectedIndex: -1,
  });
}

export function isMenuSeparator(item: MenuItem): item is MenuSeparator {
  return "kind" in item;
}

export function isMenuSubmenu(item: MenuItem): item is MenuSubmenu {
  return "items" in item;
}

export function isMenuAction(item: MenuItem): item is MenuAction {
  return !("kind" in item) && !("items" in item);
}

export function dismissContextMenu(): ContextMenuState {
  return Object.freeze({
    visible: false,
    position: { x: 0, y: 0 },
    items: [],
    selectedIndex: -1,
  });
}

export function renderContextMenu(
  state: ContextMenuState,
  theme = SevynShellTheme,
): JSX.Element | null {
  if (!state.visible) return null;

  return (
    <View
      style={[
        styles.menuContainer,
        {
          left: state.position.x,
          top: state.position.y,
          backgroundColor: theme.colors.dockBackground,
          borderColor: theme.colors.dockBorder,
          borderRadius: theme.radius.md,
        },
      ]}
      accessibilityRole="menu"
    >
      {state.items.map((item, index) => {
        if (isMenuSeparator(item)) {
          return (
            <View
              key={`sep-${String(index)}`}
              style={[styles.separator, { backgroundColor: theme.colors.dockBorder }]}
            />
          );
        }

        const isSelected = index === state.selectedIndex;
        const isDisabled = item.disabled;
        const isDestructive = isMenuAction(item) && item.destructive;

        let textColor: string = theme.colors.primary;
        if (isDisabled) {
          textColor = theme.colors.muted;
        } else if (isDestructive) {
          textColor = "#ED7780";
        }

        return (
          <Pressable
            key={`item-${item.id}`}
            style={({ pressed }) => [
              styles.menuItem,
              isSelected && { backgroundColor: theme.colors.accentSoft },
              pressed && { opacity: 0.8 },
              isDisabled && { opacity: 0.45 },
            ]}
            accessibilityRole="menuitem"
            onPress={() => {
              if (!isDisabled && isMenuAction(item) && item.onAction) {
                item.onAction();
              }
            }}
          >
            <Text style={[styles.itemLabel, { color: textColor }]}>{item.label}</Text>
            {isMenuAction(item) && item.shortcut && (
              <Text style={[styles.shortcut, { color: theme.colors.muted }]}>
                {item.shortcut}
              </Text>
            )}
            {isMenuSubmenu(item) && (
              <Text style={[styles.submenuIndicator, { color: textColor }]}>▶</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  menuContainer: {
    position: "absolute",
    borderWidth: 1,
    padding: 6,
    minWidth: 190,
    zIndex: 9999,
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  separator: {
    height: 1,
    marginVertical: 4,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 6,
  },
  itemLabel: {
    fontSize: 13,
    fontWeight: "500",
    flex: 1,
  },
  shortcut: {
    fontSize: 11,
    marginLeft: 12,
  },
  submenuIndicator: {
    fontSize: 10,
    marginLeft: 8,
  },
});
