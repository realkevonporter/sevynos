// SevynOS v2 — desktop icons (port of #123).
//
// Lists /data/Desktop through the existing `sevyn files list` verb
// and shows one direction-C tile per entry (the tile colors mirror
// File Explorer's palette, same as #123 — duplicated here instead
// of imported, so the shell stays self-contained). The shell has no
// vector icons, so each tile carries the entry's initial as its
// monogram, the Dock's convention.
//
// Behaviour:
//   - folder tap launches Files (it opens at /data root — a
//     deep-link channel that opens a folder directly is a
//     follow-up, not this port); a file tap opens its parent in
//     Files, which is /data for anything on the desktop.
//   - drag a rectangle over empty desktop space to multi-select
//     the icons it touches (gap unit 14, audit #23): the surface's
//     onPress starts the marquee, a press released without dragging
//     does nothing, and selected icons get a white 16% tint. Shift
//     adds, Ctrl/Cmd toggles, plain replaces — the Files selection
//     model (v2/rn/renderer/selection.ts), shared. No operations
//     act on the selection yet; the marquee is the primitive the
//     later desktop units consume.
//   - right-click on empty desktop space opens a context menu
//     (gap unit 11, audit #14) with "New folder" / "New text file"
//     — those actions used to be always-visible buttons at the top
//     of the desktop (left 24/164, top 22) and moved into the menu
//     here, per Kevon's direction (2026-11-26): create actions
//     belong in the right-click popup, not on the surface. Both
//     create through the existing `sevyn files mkdir` /
//     `sevyn files write` verbs, with a numbered suffix when the
//     name is taken. A right-click on a desktop icon does nothing
//     yet (no icon actions exist — Open/Rename/Trash are later
//     gap units) and never fires the icon's tap.
//   - the listing is re-read on every shell render (app LAUNCHED /
//     STOPPED events re-render the shell), so a change made from
//     Files shows up the next time the shell re-renders — there is
//     no 1s live re-list in this port.
//   - the desktop is a drop target (gap unit 15, audit #18): a file
//     drag from Files (or another app) hovering the desktop lights
//     the whole surface with the violet hover tint, and a drop moves
//     the files into /data/Desktop — one `sevyn files move` per
//     file, logged as `DESKTOP drop moved <name> to /data/Desktop`.
//     A file already on the desktop is a no-op; the Desktop folder
//     itself dropped here is refused. The shell re-lists on every
//     render, so the drop handler returns false on motion events
//     that change nothing — a re-render per motion would re-list
//     the desktop (a CLI call) dozens of times a second.
//
// NOT in this port: rename / delete / cut / copy / paste (no CLI
// verbs for them, and no icon menu trigger to hang them on).

import * as React from "react";
import { View, Text, Pressable } from "./host";
import { ContextMenu } from "../../rn/renderer/context-menu";
import type { ContextMenuEvent, DragDropEvent } from "../../rn/renderer/sevyn-renderer";
import {
  subscribeDragDrop,
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
} from "../../rn/renderer/sevyn-renderer";
import { EMPTY_SELECTION, type SelectionState } from "../../rn/renderer/selection";
import { DRAG_HOVER_FILL, FILE_DRAG_MIME } from "../../rn/renderer/drag";
import {
  baseName,
  isCutPasteNoop,
  isPasteIntoSelfOrDescendant,
  resolveMultiPasteTargets,
  type ClipboardEntry,
} from "../../rn/renderer/file-ops";
import {
  indicesInRect,
  MARQUEE_FILL,
  useMarqueeSelection,
  type MarqueeRect,
} from "../../rn/renderer/marquee";

export const DESKTOP_DIR = "/data/Desktop";

const ITEM_WIDTH = 104;
const ITEM_HEIGHT = 92;
const HORIZONTAL_GAP = 18;
const VERTICAL_GAP = 16;
// Icons start 22px from the top — the old always-visible action
// buttons used to sit here (top 22, 34 tall); they moved into the
// right-click menu (gap unit 11), so the grid takes their place.
const ICON_TOP = 22;
const ICON_LEFT = 24;
// The desktop starts below the shell's 48px top bar (see Shell.tsx):
// pointer coords are window coords, so the marquee math subtracts
// this to reach desktop coords. The manifest (layout decisions,
// 2026-11-28) will shrink the top bar to 32px — when it does, this
// moves with it.
const DESKTOP_TOP = 48;

export type DesktopTileKind =
  "folder" | "image" | "video" | "audio" | "code" | "document" | "archive" | "file";

export interface DesktopTile {
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

/** Direction-C tile (kind + tile color) for a desktop entry. */
export function desktopTileForEntry(
  name: string,
  kind: "file" | "directory",
): DesktopTile {
  const tileKind = tileKindFor(name, kind);
  return { tileColor: TILE_COLORS[tileKind], kind: tileKind };
}

export interface DesktopEntry {
  readonly name: string;
  readonly kind: "file" | "directory";
}

/** Columns in the icon grid for a surface of width surfaceWidth. */
export function desktopColumns(surfaceWidth: number): number {
  return Math.max(1, Math.floor((surfaceWidth - 48) / (ITEM_WIDTH + HORIZONTAL_GAP)));
}

/**
 * The desktop entries a marquee rect touches. `rect` is in window
 * (pointer) coords; the desktop starts DESKTOP_TOP below the window
 * top, so the rect is translated into desktop coords first. The
 * grid math is the render's math (same constants), so the band and
 * the icons cannot drift apart. (When the manifest's resizable
 * icon grid lands — S/M/L sizes, decided 2026-11-28 — this follows
 * the same size setting the render uses.)
 */
function indicesInDesktopRect(
  rect: MarqueeRect,
  entries: DesktopEntry[],
  columns: number,
): number[] {
  const desktopRect: MarqueeRect = {
    x: rect.x,
    y: rect.y - DESKTOP_TOP,
    width: rect.width,
    height: rect.height,
  };
  const icons: MarqueeRect[] = entries.map((_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      x: ICON_LEFT + column * (ITEM_WIDTH + HORIZONTAL_GAP),
      y: ICON_TOP + row * (ITEM_HEIGHT + VERTICAL_GAP),
      width: ITEM_WIDTH,
      height: ITEM_HEIGHT,
    };
  });
  return indicesInRect(icons, desktopRect);
}

// Parse one `sevyn files list` line ("d name" / "f name"); null for
// anything else (symlinks and unknowns are not shown as icons).
function parseListLine(line: string): DesktopEntry | null {
  if (line.length < 3 || line[1] !== " ") return null;
  const name = line.slice(2);
  if (!name) return null;
  if (line[0] === "d") return { name, kind: "directory" };
  if (line[0] === "f") return { name, kind: "file" };
  return null;
}

/** List the desktop directory (empty when it is missing or unreadable). */
export function listDesktopEntries(): DesktopEntry[] {
  const raw = Sevyn.exec("sevyn files list " + DESKTOP_DIR);
  const nl = raw.indexOf("\n");
  if (nl < 0) return [];
  const code = parseInt(raw.slice(0, nl), 10);
  if (code !== 0) return [];
  const entries: DesktopEntry[] = [];
  for (const line of raw.slice(nl + 1).split("\n")) {
    const entry = parseListLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

// Double-quote one CLI argument (the host's tokenizer strips the
// quotes and unescapes \" / \\, so names with spaces pass through
// intact — same helper as the Settings app).
function q(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// First unused name: "New folder", "New folder 2", ... (same for
// "New text file.txt").
function unusedName(taken: Set<string>, base: string, suffix: string): string {
  let name = base + suffix;
  let n = 2;
  while (taken.has(name)) {
    name = base + " " + n + suffix;
    n++;
  }
  return name;
}

export interface DesktopIconsProps {
  onLaunch(appId: string): void;
}

export function DesktopIcons(props: DesktopIconsProps): React.ReactElement {
  const size = React.useSyncExternalStore(subscribeSurfaceSize, getSurfaceSizeSnapshot);
  // Re-render trigger only: the listing is read fresh on every
  // render, so bumping this after a create re-lists immediately.
  const [, setRefresh] = React.useState(0);
  // Right-click menu anchor (gap unit 11): null when closed.
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const entries = listDesktopEntries();
  const taken = new Set(entries.map((e) => e.name));
  const columns = desktopColumns(size.width);
  const iconTop = ICON_TOP;

  // Multi-selection (gap unit 14, audit #23): the selected desktop
  // entries, in listing order, plus the anchor a Shift-marquee
  // ranges from. No operations act on it yet — the marquee is the
  // primitive the later desktop units (icon drag, icon actions)
  // consume. A plain click on empty desktop space still does
  // nothing (no onClick), and a tap on an icon still opens Files.
  const [selection, setSelection] = React.useState<SelectionState>(EMPTY_SELECTION);
  const marquee = useMarqueeSelection({
    selection,
    onSelection: setSelection,
    names: entries.map((e) => e.name),
    indicesForRect: (rect) => indicesInDesktopRect(rect, entries, columns),
  });
  // The drag rect in desktop coords, for the band overlay. The top
  // is clamped at the surface edge (display only — the selection
  // rect is unclamped, and a drag into the top bar touches no icon)
  // so a drag upward never paints over the top bar.
  const band = marquee.dragRect
    ? {
        x: marquee.dragRect.x,
        y: Math.max(0, marquee.dragRect.y - DESKTOP_TOP),
        width: marquee.dragRect.width,
        height: marquee.dragRect.height - Math.max(0, DESKTOP_TOP - marquee.dragRect.y),
      }
    : null;

  function openInFiles(entry: DesktopEntry): void {
    // Files always opens at /data root — the parent of any desktop
    // entry — so launching it is the open, for folders and files.
    // Through the shell's launch path, so a tap gets the same
    // "Starting…" feedback (and focus behaviour) as a dock tap.
    Sevyn.log("DESKTOP open " + DESKTOP_DIR + "/" + entry.name);
    props.onLaunch("files");
  }

  function newFolder(): void {
    const name = unusedName(taken, "New folder", "");
    Sevyn.exec("sevyn files mkdir " + q(DESKTOP_DIR + "/" + name));
    setRefresh((r) => r + 1);
  }

  function newTextFile(): void {
    const name = unusedName(taken, "New text file", ".txt");
    Sevyn.exec("sevyn files write " + q(DESKTOP_DIR + "/" + name) + ' ""');
    setRefresh((r) => r + 1);
  }

  // Drop target (gap unit 15, audit #18): the whole desktop
  // surface accepts a file drag. Hover lights the surface; a drop
  // moves the files into /data/Desktop. The hover lives in a ref
  // as well as state — the shell re-lists on every render (a CLI
  // call), so the handler returns false on motion events that
  // change nothing, and the move runs only on a real drop.
  const [dropHover, setDropHover] = React.useState(false);
  const dropHoverRef = React.useRef(false);
  function setHover(next: boolean): boolean {
    if (dropHoverRef.current === next) return false;
    dropHoverRef.current = next;
    setDropHover(next);
    return true;
  }
  function moveDropped(paths: string[]): void {
    const items: ClipboardEntry[] = paths.map((p) => ({
      kind: "cut",
      sourcePath: p,
      sourceName: baseName(p),
      sourceKind: "file",
    }));
    // A file already on the desktop is a no-op; the Desktop
    // folder itself (or a descendant) is refused — the same
    // rules as a paste into the folder.
    if (items.every((entry) => isCutPasteNoop(entry, DESKTOP_DIR))) return;
    if (items.some((entry) => isPasteIntoSelfOrDescendant(entry.sourcePath, DESKTOP_DIR)))
      return;
    const existing = new Set(listDesktopEntries().map((e) => e.name));
    const targets = resolveMultiPasteTargets(items, DESKTOP_DIR, existing);
    if (!targets) return;
    let moved = 0;
    for (const t of targets) {
      const raw = Sevyn.exec(
        "sevyn files move " + q(t.entry.sourcePath) + " " + q(t.targetPath),
      );
      const nl = raw.indexOf("\n");
      if (nl < 0 || parseInt(raw.slice(0, nl), 10) !== 0) {
        setRefresh((r) => r + 1);
        return;
      }
      moved += 1;
      // The m9-check assertion line: one per moved file.
      Sevyn.log("DESKTOP drop moved " + t.entry.sourceName + " to " + DESKTOP_DIR);
    }
    if (moved > 0) setRefresh((r) => r + 1);
  }
  React.useEffect(() => {
    return subscribeDragDrop((ev: DragDropEvent) => {
      if (ev.type === "enter") {
        if (!ev.mimes || !ev.mimes.includes(FILE_DRAG_MIME)) return false;
        return setHover(true);
      }
      if (ev.type === "motion") return setHover(true);
      if (ev.type === "leave") return setHover(false);
      if (ev.type === "drop") {
        setHover(false);
        const paths = ev.paths ?? [];
        if (paths.length === 0) return true;
        moveDropped(paths);
        return true;
      }
      return false;
    });
  }, []);

  return (
    <View
      // The desktop surface is a plain View: the renderer (gap unit
      // 11) emits a hit rect for a View that declares onContextMenu,
      // so a right-click on empty desktop space reaches this
      // handler — and (gap unit 14) a View with onPress is pressable
      // the same way, so a left-press on empty space starts the
      // marquee. Icons are emitted after the surface rect, so they
      // still win the hit-test where they overlap it — a right-click
      // on an icon hits the icon (which has no onContextMenu) and
      // does nothing, never launching Files, and a left-press on an
      // icon hits the icon's own onPress, never starting a marquee.
      onPress={marquee.begin}
      onContextMenu={(ev: ContextMenuEvent) =>
        setMenu({ x: ev.nativeEvent.x, y: ev.nativeEvent.y })
      }
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      }}
    >
      {entries.map((entry, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = ICON_LEFT + column * (ITEM_WIDTH + HORIZONTAL_GAP);
        const y = iconTop + row * (ITEM_HEIGHT + VERTICAL_GAP);
        const tile = desktopTileForEntry(entry.name, entry.kind);
        const isSelected = selection.selected.includes(entry.name);
        return (
          <Pressable
            key={entry.name}
            onPress={() => openInFiles(entry)}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: ITEM_WIDTH,
              height: ITEM_HEIGHT,
              borderRadius: 8,
              alignItems: "center",
              paddingTop: 8,
              backgroundColor: isSelected ? "#FFFFFF29" : "#00000000",
            }}
          >
            <View
              style={{
                width: 48,
                height: 48,
                backgroundColor: tile.tileColor,
                borderRadius: 8,
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 24,
                  fontWeight: "bold",
                  color: "#ffffff",
                  textAlign: "center",
                }}
              >
                {entry.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <Text
              style={{
                fontSize: 12,
                color: "#ffffff",
                marginTop: 6,
                textAlign: "center",
              }}
            >
              {entry.name}
            </Text>
          </Pressable>
        );
      })}
      {/* The rubber band (gap unit 14): the drag rect in desktop
          coords. It is present only mid-drag, when all pointer
          handling is host-level (motion/release never hit-test), so
          it cannot swallow a press. Drawn above the icons, below
          the context menu. */}
      {band ? (
        <View
          style={{
            position: "absolute",
            left: band.x,
            top: band.y,
            width: band.width,
            height: band.height,
            backgroundColor: MARQUEE_FILL,
          }}
        />
      ) : null}
      {/* The drop hover (gap unit 15): the whole desktop surface
          lights while a file drag hovers it. Above the icons, below
          the context menu; pointer-transparent in effect — a View
          with no handlers never wins a hit-test. */}
      {dropHover ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            backgroundColor: DRAG_HOVER_FILL,
          }}
        />
      ) : null}
      {/* Context menu (gap unit 11): last child so it draws and
          hit-tests above everything else. The desktop offers only
          the two create actions today — nothing is invented here. */}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { id: "new-folder", label: "New folder", onSelect: newFolder },
            { id: "new-text-file", label: "New text file", onSelect: newTextFile },
          ]}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </View>
  );
}
