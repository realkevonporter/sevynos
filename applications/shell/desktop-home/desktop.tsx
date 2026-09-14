import { useState, type ComponentProps, type ComponentType, type JSX } from "react";
import { Pressable, StyleSheet } from "react-native";
import { SevynShellTheme } from "../theme.js";
import {
  createContextMenuState,
  dismissContextMenu,
  renderContextMenu,
  type ContextMenuState,
  type MenuItem,
} from "../context-menu.js";

type WebPressableProps = ComponentProps<typeof Pressable> & {
  onContextMenu?: (event: {
    preventDefault: () => void;
    nativeEvent: { pageX: number; pageY: number };
  }) => void;
};

const WebPressable = Pressable as unknown as ComponentType<WebPressableProps>;

export function DesktopHomeApplication(): JSX.Element {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(dismissContextMenu());

  const handleContextMenu = (
    e: Parameters<NonNullable<WebPressableProps["onContextMenu"]>>[0],
  ) => {
    e.preventDefault();

    const items: MenuItem[] = [
      {
        id: "new-folder",
        label: "New Folder",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "new-file",
        label: "New File",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "paste",
        label: "Paste",
        disabled: true,
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "select-all",
        label: "Select All",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "sort-by",
        label: "Sort By",
        items: [
          {
            id: "sort-name",
            label: "Name",
            onAction: () => {
              setContextMenu(dismissContextMenu());
            },
          },
          {
            id: "sort-date",
            label: "Date",
            onAction: () => {
              setContextMenu(dismissContextMenu());
            },
          },
          {
            id: "sort-size",
            label: "Size",
            onAction: () => {
              setContextMenu(dismissContextMenu());
            },
          },
          {
            id: "sort-kind",
            label: "Kind",
            onAction: () => {
              setContextMenu(dismissContextMenu());
            },
          },
        ],
      },
      {
        id: "refresh",
        label: "Refresh",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      { kind: "separator" },
      {
        id: "change-wallpaper",
        label: "Change Wallpaper",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
      {
        id: "desktop-settings",
        label: "Desktop Settings",
        onAction: () => {
          setContextMenu(dismissContextMenu());
        },
      },
    ];

    setContextMenu(
      createContextMenuState({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }, items),
    );
  };

  return (
    <WebPressable
      style={StyleSheet.absoluteFill}
      onPress={() => {
        setContextMenu(dismissContextMenu());
      }}
      onContextMenu={handleContextMenu}
    >
      {renderContextMenu(contextMenu, SevynShellTheme)}
    </WebPressable>
  );
}
