/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Cut/copy/paste clipboard for File Explorer (ported from the #122
 * File Explorer: same pure path math, same function names, so the
 * rules — paste into itself, name collisions, cross-volume moves —
 * are unit-testable without filesystem access. The component
 * performs the actual filesystem calls through `sevyn files`).
 *
 * Moved here from v2/apps/src/clipboard.ts by gap unit 15 (audit #18):
 * the shell's desktop is a drop target too, and the shell imports only
 * from the shared renderer layer — so the pure move rules live here
 * and both the apps and the shell import them from this one place.
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
 * The last component of a path (`photo.png` for
 * `/data/Photos/photo.png`). Trailing slashes are ignored, so
 * `/data/Photos/` is `Photos`; the root is `""`.
 */
export function baseName(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? clean : clean.slice(i + 1);
}

/**
 * The parent directory of a path (`/data/Photos` for
 * `/data/Photos/photo.png`). Trailing slashes are ignored; the
 * parent of a top-level name is `/`.
 */
export function dirName(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i <= 0 ? "/" : clean.slice(0, i);
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
 * Resolve the paste targets for a multi-file paste, in entry order.
 *
 * Each target is resolved against the names already in the folder
 * PLUS the names the earlier entries in this paste will take, so two
 * same-named files pasted from different folders suffix apart
 * (`photo.png`, `photo (1).png`) instead of colliding with each
 * other. Returns undefined when ANY entry must be refused (a folder
 * pasted into itself or a descendant) — the paste is all-or-nothing,
 * so the caller aborts before moving anything. (Moved here from the
 * selection module by gap unit 14: it resolves paste targets, so it
 * belongs with the clipboard module, and the shared selection module
 * must not import the apps' clipboard.)
 */
export function resolveMultiPasteTargets(
  entries: readonly ClipboardEntry[],
  destinationDir: string,
  existingNames: ReadonlySet<string>,
): { entry: ClipboardEntry; targetPath: string; targetName: string }[] | undefined {
  const taken = new Set(existingNames);
  const targets: { entry: ClipboardEntry; targetPath: string; targetName: string }[] = [];
  for (const entry of entries) {
    const target = resolvePasteTarget(entry, destinationDir, taken);
    if (!target) return undefined;
    taken.add(target.targetName);
    targets.push({ entry, ...target });
  }
  return targets;
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
