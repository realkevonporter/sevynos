/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { useState, type JSX } from "react";
import {
  Pressable,
  SevynIcon,
  StyleSheet,
  Text,
  TextInput,
  View,
  type SevynIconName,
} from "@sevynos/react-native";
import { SevynShellTheme } from "../theme.js";
import type { DesktopShellBounds, DesktopWorkspaceRenderInput } from "../desktop.js";

export type DesktopWorkspaceProps = DesktopWorkspaceRenderInput;

const ITEM_WIDTH = 104;
const ITEM_HEIGHT = 92;
const HORIZONTAL_GAP = 18;
const VERTICAL_GAP = 16;
const MENU_WIDTH = 200;

interface DesktopPointerEvent {
  readonly x: number;
  readonly y: number;
}

/**
 * Direction-C desktop tile for one entry: a full-bleed tile in the type's
 * brand color (the gradient mid-point, same convention as the shell's
 * application tiles) with a white vector glyph.
 *
 * The colors and glyphs deliberately mirror File Explorer's file-icons
 * (PR #122) so the desktop and the file manager agree — but the table is
 * duplicated here instead of imported, so this change merges cleanly onto
 * main without the File Explorer branch. If the palette ever changes,
 * update both tables.
 */
export type DesktopTileKind =
  "folder" | "image" | "video" | "audio" | "code" | "document" | "archive" | "file";

export interface DesktopTile {
  readonly icon: SevynIconName;
  /** Tile background: the type's brand color (gradient mid-point). */
  readonly tileColor: string;
  readonly kind: DesktopTileKind;
}

const TILE_COLORS: Readonly<Record<DesktopTileKind, string>> = {
  folder: "#F5A623",
  image: "#E0448C",
  video: "#8B5CF6",
  audio: "#10B981",
  code: "#0EA5C9",
  document: "#3B82F6",
  archive: "#E8930C",
  file: "#64748B",
};

function tileKindFor(name: string, kind: "file" | "directory"): DesktopTileKind {
  if (kind === "directory") return "folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "svg", "bmp", "webp", "gif"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mkv", "webm", "mov"].includes(ext)) return "video";
  if (["ts", "tsx", "js", "jsx", "json", "py", "rs", "cpp", "c", "h", "sh"].includes(ext))
    return "code";
  if (["zip", "tar", "gz", "tgz"].includes(ext)) return "archive";
  if (["txt", "md", "log", "pdf", "doc", "docx"].includes(ext)) return "document";
  return "file";
}

function tileIconFor(kind: DesktopTileKind): SevynIconName {
  switch (kind) {
    case "folder":
      return "folder";
    case "image":
      return "image";
    case "video":
      return "film";
    case "audio":
      return "music-note";
    case "code":
      return "gear";
    case "document":
    case "archive":
    case "file":
    default:
      return "file-text";
  }
}

/** Direction-C tile (icon + tile color) for a desktop entry. */
export function desktopTileForEntry(
  name: string,
  kind: "file" | "directory",
): DesktopTile {
  const tileKind = tileKindFor(name, kind);
  return {
    icon: tileIconFor(tileKind),
    tileColor: TILE_COLORS[tileKind],
    kind: tileKind,
  };
}

interface DesktopClipboard {
  readonly path: string;
  readonly mode: "copy" | "cut";
}

interface ItemMenuState {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly x: number;
  readonly y: number;
}

function WorkspaceAction({
  label,
  x,
  y,
  onPress = (): void => undefined,
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
      style={({ pressed }: { pressed: boolean }) => ({
        ...styles.action,
        left: x,
        top: y,
        ...(pressed ? styles.actionPressed : {}),
      })}
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
  cut,
  onPress = (): void => undefined,
  onContextMenu = (): void => undefined,
}: {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly x: number;
  readonly y: number;
  readonly cut: boolean;
  readonly onPress?: ((path: string) => void) | undefined;
  readonly onContextMenu?: ((event: DesktopPointerEvent) => void) | undefined;
}): JSX.Element {
  const tile = desktopTileForEntry(name, kind);
  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={() => {
        onPress(path);
      }}
      onContextMenu={onContextMenu}
      style={({ pressed }: { pressed: boolean }) => ({
        ...styles.item,
        left: x,
        top: y,
        ...(pressed ? styles.itemPressed : {}),
        ...(cut ? styles.itemCut : {}),
      })}
    >
      <View style={{ ...styles.icon, backgroundColor: tile.tileColor }}>
        <SevynIcon name={tile.icon} size={24} color="#FFFFFF" />
      </View>
      <Text numberOfLines={2} style={styles.itemLabel}>
        {name}
      </Text>
    </Pressable>
  );
}

function ContextMenuItem({
  label,
  destructive,
  disabled,
  onPress = (): void => undefined,
}: {
  readonly label: string;
  readonly destructive?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onPress?: (() => void) | undefined;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled === true}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        ...styles.contextMenuItem,
        ...(pressed ? styles.contextMenuItemPressed : {}),
        ...(disabled === true ? styles.contextMenuItemDisabled : {}),
      })}
    >
      <Text
        style={{
          ...styles.contextMenuItemText,
          ...(destructive === true ? styles.contextMenuItemTextDestructive : {}),
          ...(disabled === true ? styles.contextMenuItemTextDisabled : {}),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Desktop workspace (icons) rendered as a React Native component.
 * Replaces the native `renderDesktopWorkspace` scene-node builder.
 * Shows "New folder" / "New text file" actions plus a grid of desktop entries.
 *
 * Right-click an icon for Open / Cut / Copy / Paste / Rename / Delete
 * (file-service operations only, via the callbacks the scene composer
 * wires to the desktop runtime). Right-click empty desktop space for
 * Change wallpaper / New folder / New text file. The menu follows the
 * browser's backdrop + menu pattern.
 */
export function DesktopWorkspace({
  display,
  entries,
  onNewFolder,
  onNewFile,
  onOpenEntry,
  onRenameEntry,
  onDeleteEntry,
  onPasteEntry,
  onChangeWallpaper,
}: DesktopWorkspaceProps): JSX.Element {
  const [menu, setMenu] = useState<ItemMenuState | undefined>(undefined);
  const [backgroundMenu, setBackgroundMenu] = useState<
    { x: number; y: number } | undefined
  >(undefined);
  const [clipboard, setClipboard] = useState<DesktopClipboard | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | undefined>(
    undefined,
  );
  const [renameValue, setRenameValue] = useState<string>("");

  const closeMenus = (): void => {
    setMenu(undefined);
    setBackgroundMenu(undefined);
  };

  const actionY = display.y + 70;
  const iconTop = actionY + 52;
  const columns = Math.max(
    1,
    Math.floor((display.width - 48) / (ITEM_WIDTH + HORIZONTAL_GAP)),
  );
  const clampMenu = (x: number, y: number): { x: number; y: number } => ({
    x: Math.max(display.x + 8, Math.min(x, display.x + display.width - MENU_WIDTH - 8)),
    y: Math.max(display.y + 8, Math.min(y, display.y + display.height - 240)),
  });
  const pasteTargetFor = (entry: ItemMenuState): string =>
    entry.kind === "directory" ? entry.path : "/Desktop";
  const confirmRename = (): void => {
    if (renaming === undefined) return;
    const next = renameValue.trim();
    if (next.length > 0 && next !== renaming.name) {
      onRenameEntry?.(renaming.path, next);
    }
    setRenaming(undefined);
  };

  return (
    <View
      pointerEvents="box-none"
      style={styles.root}
      onContextMenu={(event: DesktopPointerEvent) => {
        closeMenus();
        setBackgroundMenu(clampMenu(display.x + event.x, display.y + event.y));
      }}
    >
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
        const itemX = display.x + 24 + column * (ITEM_WIDTH + HORIZONTAL_GAP);
        const itemY = iconTop + row * (ITEM_HEIGHT + VERTICAL_GAP);
        return (
          <WorkspaceItem
            key={entry.path}
            name={entry.name}
            path={entry.path}
            kind={entry.kind}
            x={itemX}
            y={itemY}
            cut={clipboard?.mode === "cut" && clipboard.path === entry.path}
            onPress={onOpenEntry}
            onContextMenu={() => {
              closeMenus();
              // Place the menu below the icon: the context-menu event
              // coordinates are relative to the deepest hit element, not
              // the icon, so the icon's known grid position is the anchor.
              setMenu({
                path: entry.path,
                name: entry.name,
                kind: entry.kind,
                ...clampMenu(itemX, itemY + ITEM_HEIGHT + 4),
              });
            }}
          />
        );
      })}
      {(menu !== undefined || backgroundMenu !== undefined) && (
        <>
          <Pressable
            accessibilityLabel="Close menu"
            onPress={closeMenus}
            style={styles.contextMenuBackdrop}
          />
          <View
            style={{
              ...styles.contextMenu,
              left: (menu ?? backgroundMenu)?.x ?? 0,
              top: (menu ?? backgroundMenu)?.y ?? 0,
            }}
          >
            {menu !== undefined ? (
              <>
                <ContextMenuItem
                  label="Open"
                  onPress={() => {
                    closeMenus();
                    onOpenEntry?.(menu.path);
                  }}
                />
                <ContextMenuItem
                  label="Cut"
                  onPress={() => {
                    setClipboard({ path: menu.path, mode: "cut" });
                    closeMenus();
                  }}
                />
                <ContextMenuItem
                  label="Copy"
                  onPress={() => {
                    setClipboard({ path: menu.path, mode: "copy" });
                    closeMenus();
                  }}
                />
                <ContextMenuItem
                  label="Paste"
                  disabled={clipboard === undefined}
                  onPress={() => {
                    if (clipboard === undefined) return;
                    const source = clipboard;
                    const target = pasteTargetFor(menu);
                    if (source.mode === "cut") setClipboard(undefined);
                    closeMenus();
                    onPasteEntry?.(source.path, source.mode, target);
                  }}
                />
                <ContextMenuItem
                  label="Rename"
                  onPress={() => {
                    setRenameValue(menu.name);
                    setRenaming({ path: menu.path, name: menu.name });
                    closeMenus();
                  }}
                />
                <ContextMenuItem
                  label="Delete"
                  destructive
                  onPress={() => {
                    closeMenus();
                    onDeleteEntry?.(menu.path);
                  }}
                />
              </>
            ) : (
              <>
                <ContextMenuItem
                  label="Change wallpaper"
                  onPress={() => {
                    closeMenus();
                    onChangeWallpaper?.();
                  }}
                />
                <ContextMenuItem
                  label="New folder"
                  onPress={() => {
                    closeMenus();
                    onNewFolder?.();
                  }}
                />
                <ContextMenuItem
                  label="New text file"
                  onPress={() => {
                    closeMenus();
                    onNewFile?.();
                  }}
                />
              </>
            )}
          </View>
        </>
      )}
      {renaming !== undefined && (
        <>
          <Pressable
            accessibilityLabel="Cancel rename"
            onPress={() => {
              setRenaming(undefined);
            }}
            style={styles.contextMenuBackdrop}
          />
          <View
            style={{
              ...styles.renameDialog,
              left: Math.max(display.x + 8, display.x + (display.width - 320) / 2),
              top: display.y + Math.max(120, display.height / 2 - 90),
            }}
          >
            <Text style={styles.renameTitle}>Rename “{renaming.name}”</Text>
            <TextInput
              accessibilityLabel="New name"
              autoFocus
              onChangeText={setRenameValue}
              onSubmitEditing={confirmRename}
              style={styles.renameInput}
              value={renameValue}
            />
            <View style={styles.renameActions}>
              <Pressable
                accessibilityLabel="Cancel"
                accessibilityRole="button"
                onPress={() => {
                  setRenaming(undefined);
                }}
                style={styles.renameButton}
              >
                <Text style={styles.renameButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Rename"
                accessibilityRole="button"
                onPress={confirmRename}
                style={{ ...styles.renameButton, ...styles.renameConfirmButton }}
              >
                <Text style={styles.renameButtonText}>Rename</Text>
              </Pressable>
            </View>
          </View>
        </>
      )}
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
  itemCut: {
    opacity: 0.5,
  },
  icon: {
    alignItems: "center",
    borderRadius: SevynShellTheme.radius.sm,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  itemLabel: {
    color: SevynShellTheme.colors.primary,
    fontSize: 12,
    marginTop: 6,
    textAlign: "center",
  },
  contextMenuBackdrop: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  contextMenu: {
    backgroundColor: "#1E293B",
    borderRadius: 8,
    minWidth: MENU_WIDTH,
    paddingVertical: 4,
    position: "absolute",
    zIndex: 1000,
  },
  contextMenuItem: {
    borderRadius: 4,
    marginHorizontal: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  contextMenuItemPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  contextMenuItemDisabled: {
    opacity: 0.4,
  },
  contextMenuItemText: {
    color: "#F3F4F6",
    fontSize: 13,
  },
  contextMenuItemTextDestructive: {
    color: "#F87171",
  },
  contextMenuItemTextDisabled: {
    color: "#9CA3AF",
  },
  renameDialog: {
    backgroundColor: "#1E293B",
    borderRadius: 12,
    padding: 16,
    position: "absolute",
    width: 320,
    zIndex: 1000,
  },
  renameTitle: {
    color: "#F3F4F6",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 12,
  },
  renameInput: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 8,
    color: "#F3F4F6",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 12,
  },
  renameButton: {
    alignItems: "center",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  renameConfirmButton: {
    backgroundColor: "#D7AC57",
    marginLeft: 8,
  },
  renameButtonText: {
    color: "#F3F4F6",
    fontSize: 13,
    fontWeight: "600",
  },
});

export type { DesktopShellBounds };
