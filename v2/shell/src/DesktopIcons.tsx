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
//   - "New folder" / "New text file" create through the existing
//     `sevyn files mkdir` / `sevyn files write` verbs, with a
//     numbered suffix when the name is taken.
//   - the listing is re-read on every shell render (app LAUNCHED /
//     STOPPED events re-render the shell), so a change made from
//     Files shows up the next time the shell re-renders — there is
//     no 1s live re-list in this port.
//
// NOT in this port: right-click context menus (the renderer has
// no onContextMenu), rename / delete / cut / copy / paste (no CLI
// verbs for them, and no menu trigger to hang them on).

import * as React from "react";
import { View, Text, Pressable } from "./host";
import {
  subscribeSurfaceSize,
  getSurfaceSizeSnapshot,
} from "../../rn/renderer/sevyn-renderer";

export const DESKTOP_DIR = "/data/Desktop";

const ITEM_WIDTH = 104;
const ITEM_HEIGHT = 92;
const HORIZONTAL_GAP = 18;
const VERTICAL_GAP = 16;
const ACTION_TOP = 22;
const ACTION_HEIGHT = 34;
const ACTION_WIDTH = 132;

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
  const entries = listDesktopEntries();
  const taken = new Set(entries.map((e) => e.name));
  const columns = desktopColumns(size.width);
  const iconTop = ACTION_TOP + ACTION_HEIGHT + 18;

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

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
      }}
    >
      <Pressable
        onPress={newFolder}
        style={{
          position: "absolute",
          left: 24,
          top: ACTION_TOP,
          width: ACTION_WIDTH,
          height: ACTION_HEIGHT,
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          borderRadius: 8,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: "#ffffff" }}>
          New folder
        </Text>
      </Pressable>
      <Pressable
        onPress={newTextFile}
        style={{
          position: "absolute",
          left: 24 + ACTION_WIDTH + 8,
          top: ACTION_TOP,
          width: ACTION_WIDTH,
          height: ACTION_HEIGHT,
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          borderRadius: 8,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "500", color: "#ffffff" }}>
          New text file
        </Text>
      </Pressable>
      {entries.map((entry, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const x = 24 + column * (ITEM_WIDTH + HORIZONTAL_GAP);
        const y = iconTop + row * (ITEM_HEIGHT + VERTICAL_GAP);
        const tile = desktopTileForEntry(entry.name, entry.kind);
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
    </View>
  );
}
