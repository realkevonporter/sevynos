import { View, NativeText, Pressable } from "./primitives.js";
import { type ReactElement } from "react";

// Types for menu items
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

// Menu state and positioning
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

export interface ContextMenuTheme {
  readonly colors: {
    readonly glassStrong: string;
    readonly border: string;
    readonly primary: string;
    readonly muted: string;
    readonly danger: string;
    readonly accentSoft: string;
  };
  readonly radius: {
    readonly md: number;
    readonly sm: number;
  };
  readonly spacing: {
    readonly xxs: number;
    readonly xs: number;
    readonly sm: number;
  };
  readonly typography: {
    readonly body: number;
    readonly caption: number;
  };
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

export function contextMenuKeyHandler(
  state: ContextMenuState,
  key: string,
): ContextMenuState {
  if (!state.visible) return state;

  switch (key) {
    case "ArrowDown": {
      let nextIndex = state.selectedIndex + 1;
      while (nextIndex < state.items.length) {
        const item = state.items[nextIndex];
        if (item !== undefined && isMenuSeparator(item)) {
          nextIndex++;
        } else {
          break;
        }
      }
      if (nextIndex >= state.items.length) {
        nextIndex = state.selectedIndex;
      }
      return Object.freeze({ ...state, selectedIndex: nextIndex });
    }
    case "ArrowUp": {
      let prevIndex = state.selectedIndex - 1;
      while (prevIndex >= 0) {
        const item = state.items[prevIndex];
        if (item !== undefined && isMenuSeparator(item)) {
          prevIndex--;
        } else {
          break;
        }
      }
      if (prevIndex < 0) {
        prevIndex = state.selectedIndex;
      }
      return Object.freeze({ ...state, selectedIndex: prevIndex });
    }
    case "Enter": {
      const selectedItem = state.items[state.selectedIndex];
      if (
        selectedItem &&
        isMenuAction(selectedItem) &&
        !selectedItem.disabled &&
        selectedItem.onAction
      ) {
        selectedItem.onAction();
      }
      return state;
    }
    case "Escape": {
      return dismissContextMenu();
    }
  }
  return state;
}

export function renderContextMenu(
  state: ContextMenuState,
  theme: ContextMenuTheme,
): ReactElement | null {
  if (!state.visible) return null;

  return View({
    style: {
      position: "absolute",
      left: state.position.x,
      top: state.position.y,
      backgroundColor: theme.colors.glassStrong,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: theme.radius.md,
      padding: theme.spacing.xxs,
      minWidth: 200,
    },
    role: "menu",
    children: state.items.map((item, index) => {
      if (isMenuSeparator(item)) {
        return View({
          key: `sep-${String(index)}`,
          style: {
            height: 1,
            backgroundColor: theme.colors.border,
            marginVertical: theme.spacing.xxs,
          },
        });
      }

      const isSelected = index === state.selectedIndex;
      const isDisabled = item.disabled;
      const isDestructive = isMenuAction(item) && item.destructive;

      let textColor = theme.colors.primary;
      if (isDisabled) {
        textColor = theme.colors.muted;
      } else if (isDestructive) {
        textColor = theme.colors.danger;
      }

      const itemChildren: ReactElement[] = [];

      itemChildren.push(
        NativeText({
          text: item.label,
          style: {
            color: textColor,
            fontSize: theme.typography.body,
            flex: 1,
          },
        }),
      );

      if (isMenuAction(item) && item.shortcut) {
        itemChildren.push(
          NativeText({
            text: item.shortcut,
            style: {
              color: theme.colors.muted,
              fontSize: theme.typography.caption,
              textAlign: "right",
            },
          }),
        );
      }

      if (isMenuSubmenu(item)) {
        itemChildren.push(
          NativeText({
            text: "▶",
            style: {
              color: textColor,
              fontSize: theme.typography.caption,
              textAlign: "right",
              marginLeft: theme.spacing.sm,
            },
          }),
        );
      }

      return Pressable({
        key: `item-${String(item.id || index)}`,
        style: {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs,
          backgroundColor: isSelected ? theme.colors.accentSoft : "transparent",
          borderRadius: theme.radius.sm,
          opacity: isDisabled ? 0.5 : 1,
        },
        role: "menuitem",
        onPress: () => {
          if (!isDisabled && isMenuAction(item) && item.onAction) {
            item.onAction();
          }
        },
        children: itemChildren,
      });
    }),
  });
}
