/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Direction-C file/folder icons for File Explorer: a full-bleed tile in the
 * type's brand color (the gradient mid-point, same convention as the shell's
 * application tiles in mobile-home/application-icons.ts) with a white glyph.
 *
 * The RN framework exposes no app-level gradient style prop — gradients
 * only exist at the native-command layer — so the tile is the solid
 * mid-point color, exactly as the shell's app tiles do it today. A true
 * two-stop gradient tile needs framework style plumbing first.
 */

import type { SevynIconName } from "@sevynos/react-native";

export type FileTileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "code"
  | "document"
  | "archive"
  | "drive"
  | "file";

export interface FileTile {
  readonly icon: SevynIconName;
  /** Tile background: the type's brand color (gradient mid-point). */
  readonly tileColor: string;
  readonly kind: FileTileKind;
}

const TILE_COLORS: Readonly<Record<FileTileKind, string>> = {
  folder: "#F5A623",
  image: "#E0448C",
  video: "#8B5CF6",
  audio: "#10B981",
  code: "#0EA5C9",
  document: "#3B82F6",
  archive: "#E8930C",
  drive: "#1D9BF0",
  file: "#64748B",
};

/** The drive tile color used for sidebar device rows. */
export const DRIVE_TILE_COLOR = "#1D9BF0";

export function getFileIcon(name: string, kind: "file" | "directory"): SevynIconName {
  if (kind === "directory") return "folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "svg", "bmp", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "flac", "ogg"].includes(ext)) return "music-note";
  if (["mp4", "mkv", "webm", "mov"].includes(ext)) return "film";
  if (["ts", "tsx", "js", "json", "py", "rs", "cpp", "c", "sh"].includes(ext))
    return "gear";
  if (["txt", "md", "log"].includes(ext)) return "file-text";
  return "file-text";
}

function tileKindFor(name: string, kind: "file" | "directory"): FileTileKind {
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

/** Direction-C tile (icon + tile color) for a file or folder entry. */
export function fileTileForEntry(name: string, kind: "file" | "directory"): FileTile {
  const tileKind = tileKindFor(name, kind);
  return {
    icon: getFileIcon(name, kind),
    tileColor: TILE_COLORS[tileKind],
    kind: tileKind,
  };
}

/** Direction-C tile for a drive / device row. */
export function driveTile(): FileTile {
  return { icon: "hard-drive", tileColor: DRIVE_TILE_COLOR, kind: "drive" };
}
