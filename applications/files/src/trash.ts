/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Trash view model for the File Manager.
 *
 * The host filesystem implements the freedesktop Trash specification:
 * trashed payloads live in `/.Trash/files/<name>` and their metadata in
 * `/.Trash/info/<name>.trashinfo` (`[Trash Info]` with a percent-encoded
 * `Path=` and an ISO-8601 `DeletionDate=`). This module builds the rich
 * Trash view (original location, date deleted, per-item delete-forever) on
 * top of the existing SevynFileSystem primitives — no host changes needed.
 */

import type { FileSystemEntry, SevynFileSystem } from "@sevynos/react-native";

export interface TrashItem {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  /** Absolute original path the item was deleted from, when recorded. */
  readonly originalLocation: string | undefined;
  /** Deletion time as epoch milliseconds, when recorded. */
  readonly deletedAt: number | undefined;
  readonly entry: FileSystemEntry;
}

export interface TrashInfoRecord {
  readonly originalPath: string | undefined;
  readonly deletedAt: number | undefined;
}

const TRASH_INFO_DIR = "/.Trash/info";
const TRASH_FILES_DIR = "/.Trash/files";

/**
 * Parse a freedesktop `.trashinfo` file. Returns undefined fields when the
 * record is missing or malformed — callers must degrade gracefully.
 */
export function parseTrashInfo(content: string): TrashInfoRecord {
  const pathMatch = /^Path=(.+)$/m.exec(content);
  const encodingMatch = /^PathEncoding=percent$/m.exec(content);
  const dateMatch = /^DeletionDate=(.+)$/m.exec(content);

  let originalPath: string | undefined;
  if (pathMatch?.[1] !== undefined) {
    const raw = pathMatch[1].trim();
    if (encodingMatch) {
      try {
        originalPath = decodeURIComponent(raw);
      } catch {
        originalPath = raw;
      }
    } else {
      originalPath = raw;
    }
  }

  let deletedAt: number | undefined;
  if (dateMatch?.[1] !== undefined) {
    const parsed = Date.parse(dateMatch[1].trim());
    if (!Number.isNaN(parsed)) deletedAt = parsed;
  }

  return { originalPath, deletedAt };
}

/** Trash entry names are single path segments; reject anything else. */
export function isValidTrashName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function trashInfoPath(name: string): string {
  return `${TRASH_INFO_DIR}/${name}.trashinfo`;
}

function trashFilePath(name: string): string {
  return `${TRASH_FILES_DIR}/${name}`;
}

/**
 * Load every trashed item with its metadata. Items whose `.trashinfo` is
 * missing or unreadable still appear, with unknown location/date.
 */
export async function loadTrashItems(
  filesystem: SevynFileSystem,
): Promise<readonly TrashItem[]> {
  if (!filesystem.listTrash) return [];
  const entries = await filesystem.listTrash();
  const items: TrashItem[] = [];
  for (const entry of entries) {
    let record: TrashInfoRecord = { originalPath: undefined, deletedAt: undefined };
    try {
      const content = await filesystem.read(trashInfoPath(entry.name));
      record = parseTrashInfo(content);
    } catch {
      // Missing metadata: the item is still restorable/deletable by name.
    }
    items.push({
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      originalLocation: record.originalPath,
      deletedAt: record.deletedAt ?? entry.modified,
      entry,
    });
  }
  // Newest first; items with unknown date sink to the bottom.
  return items.sort((a, b) => (b.deletedAt ?? -1) - (a.deletedAt ?? -1));
}

/**
 * Permanently delete one trashed item: payload first, then its metadata.
 * A failed payload deletion leaves the metadata so the item stays visible
 * and recoverable instead of silently vanishing.
 */
export async function deleteTrashItemForever(
  filesystem: SevynFileSystem,
  name: string,
): Promise<void> {
  if (!isValidTrashName(name)) throw new Error("Invalid Trash item name.");
  if (!filesystem.delete) {
    throw new Error("Permanent deletion is not supported by this filesystem.");
  }
  await filesystem.delete(trashFilePath(name));
  try {
    await filesystem.delete(trashInfoPath(name));
  } catch {
    // Payload is gone; a stale metadata file is harmless and cleaned up by
    // the next empty-trash. Surface nothing so the UI stays truthful.
  }
}

export async function restoreTrashItem(
  filesystem: SevynFileSystem,
  name: string,
): Promise<void> {
  if (!filesystem.restoreFromTrash)
    throw new Error("Restore is not supported by this filesystem.");
  await filesystem.restoreFromTrash(name);
}

export async function emptyTrashBin(filesystem: SevynFileSystem): Promise<void> {
  if (!filesystem.emptyTrash)
    throw new Error("Emptying Trash is not supported by this filesystem.");
  await filesystem.emptyTrash();
}

export function formatDeletedAt(deletedAt: number | undefined): string {
  if (deletedAt === undefined) return "Unknown";
  const date = new Date(deletedAt);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === "TB") break;
    value /= 1024;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
