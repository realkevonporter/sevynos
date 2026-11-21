/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Cut/copy/paste clipboard for File Explorer (ported from the #122
 * File Explorer: same pure path math, same function names, so the
 * rules — paste into itself, name collisions, cross-volume moves —
 * are unit-testable without filesystem access. The component
 * performs the actual filesystem calls through `sevyn files`).
 */

export type ClipboardKind = "cut" | "copy";

export interface ClipboardEntry {
  readonly kind: ClipboardKind;
  /** Absolute virtual path of the item that was cut/copied. */
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly sourceKind: "file" | "directory";
}

export interface VolumeLike {
  readonly mountPoint: string;
}

/** Join a directory path and a child name without producing `//`. */
export function joinPath(directory: string, name: string): string {
  const base = directory === "/" ? "" : directory.replace(/\/+$/, "");
  return `${base}/${name}`;
}

/**
 * Split a filename into base + extension for collision suffixing.
 * Dotfiles (`.gitignore`) have no extension; `archive.tar.gz` keeps `.gz`.
 */
export function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * True when pasting `sourcePath` into `destinationDir` would put a folder
 * inside itself (or a file onto itself): same directory, the source itself,
 * or any descendant of the source.
 */
export function isPasteIntoSelfOrDescendant(
  sourcePath: string,
  destinationDir: string,
): boolean {
  const source = sourcePath.replace(/\/+$/, "");
  const destination = destinationDir.replace(/\/+$/, "") || "/";
  if (destination === source) return true;
  if (destination.startsWith(`${source}/`)) return true;
  return false;
}

/**
 * Resolve the paste target name inside `destinationDir`.
 *
 * Returns undefined when the paste must be refused (folder into itself or
 * a descendant). Otherwise returns the first non-colliding name:
 * `name`, then `name (1)`, `name (2)`, … with the suffix inserted before
 * the extension (`photo (1).png`, `Docs (1)` for folders).
 */
export function resolvePasteTarget(
  entry: ClipboardEntry,
  destinationDir: string,
  existingNames: ReadonlySet<string>,
): { targetPath: string; targetName: string } | undefined {
  if (isPasteIntoSelfOrDescendant(entry.sourcePath, destinationDir)) {
    return undefined;
  }
  // Pasting an item back into the folder it already lives in is a copy of
  // itself, not a move into itself — the collision suffix handles it.
  const { base, extension } = splitName(entry.sourceName);
  for (let index = 0; ; index += 1) {
    const targetName =
      index === 0 ? entry.sourceName : `${base} (${String(index)})${extension}`;
    if (!existingNames.has(targetName)) {
      return { targetPath: joinPath(destinationDir, targetName), targetName };
    }
  }
}

/**
 * True when `sourcePath` and `destinationDir` live on different volumes,
 * i.e. a rename (move) between them would fail with EXDEV and the caller
 * must copy + delete instead. `volumes` are the mounted volumes; any path
 * that is not on a listed volume is treated as the internal drive, and the
 * internal drive is the volume whose mount point is `/`.
 */
export function isCrossVolumeMove(
  sourcePath: string,
  destinationDir: string,
  volumes: readonly VolumeLike[],
): boolean {
  const volumeFor = (path: string): string => {
    let best = "/";
    for (const volume of volumes) {
      if (volume.mountPoint === "/") continue;
      if (
        (path === volume.mountPoint || path.startsWith(`${volume.mountPoint}/`)) &&
        volume.mountPoint.length > best.length
      ) {
        best = volume.mountPoint;
      }
    }
    return best;
  };
  return volumeFor(sourcePath) !== volumeFor(destinationDir);
}

/**
 * True when a cut item is pasted back into the folder it already lives in:
 * a move to the same place, i.e. a no-op the UI reports instead of
 * renaming the item to `name (1)`.
 */
export function isCutPasteNoop(entry: ClipboardEntry, destinationDir: string): boolean {
  if (entry.kind !== "cut") return false;
  const parent = entry.sourcePath.slice(0, entry.sourcePath.lastIndexOf("/")) || "/";
  const destination = destinationDir.replace(/\/+$/, "") || "/";
  return parent === destination;
}

/** True when a filesystem error is a cross-device rename failure. */
export function isCrossDeviceError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message.includes("EXDEV") || error.message.includes("cross-device")) {
      return true;
    }
    const code = (error as unknown as { code?: unknown }).code;
    return code === "EXDEV";
  }
  return false;
}
