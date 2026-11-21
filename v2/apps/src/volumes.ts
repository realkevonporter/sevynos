/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Removable-volume helpers for the File Manager sidebar (ported from
 * the #122 File Explorer: same helpers, same names). The volume list
 * itself comes from `sevyn files volumes` — one tab-separated line
 * per mount: mountPoint, label, removable (0/1), sizeBytes,
 * availableBytes — parsed here by parseVolumesOutput.
 */

export interface VolumeLike {
  readonly mountPoint: string;
  readonly removable?: boolean | undefined;
  readonly label?: string | undefined;
}

/** One volume as reported by `sevyn files volumes`. */
export interface Volume {
  readonly mountPoint: string;
  readonly label: string;
  readonly removable: boolean;
  readonly sizeBytes: number;
  readonly availableBytes: number;
}

/**
 * Parse `sevyn files volumes` output into volumes. Malformed lines
 * (wrong field count, non-numeric sizes) are skipped, never thrown.
 */
export function parseVolumesOutput(out: string): Volume[] {
  const volumes: Volume[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length !== 5) continue;
    const [mountPoint, label, removable, size, avail] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    const sizeBytes = Number(size);
    const availableBytes = Number(avail);
    if (
      !mountPoint ||
      !label ||
      !Number.isFinite(sizeBytes) ||
      !Number.isFinite(availableBytes)
    )
      continue;
    volumes.push({
      mountPoint,
      label,
      removable: removable === "1",
      sizeBytes,
      availableBytes,
    });
  }
  return volumes;
}

/**
 * Parse the `sevyn files clipboard` output: the JSON object the CLI
 * wrote, or null when the clipboard is empty (the CLI prints `empty`).
 * A malformed stored object is treated as empty, never thrown.
 */
export function parseClipboardOutput(out: string): {
  kind: "cut" | "copy";
  sourcePath: string;
  sourceName: string;
  sourceKind: "file" | "directory";
} | null {
  const text = out.trim();
  if (!text || text === "empty") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as Record<string, unknown>;
    if (entry.kind !== "cut" && entry.kind !== "copy") return null;
    if (typeof entry.sourcePath !== "string") return null;
    if (typeof entry.sourceName !== "string") return null;
    if (entry.sourceKind !== "file" && entry.sourceKind !== "directory") return null;
    return {
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      sourceName: entry.sourceName,
      sourceKind: entry.sourceKind,
    };
  } catch {
    return null;
  }
}

/** True when `path` is the volume's mount point or a folder inside it. */
export function isPathOnVolume(path: string, mountPoint: string): boolean {
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

/**
 * Sidebar order: the internal drive (`/`) first, then other
 * non-removable volumes, then removable volumes alphabetically by
 * label. The volume service already lists the internal drive; this
 * only shapes the order for display.
 */
export function sortVolumesForSidebar<T extends VolumeLike>(volumes: readonly T[]): T[] {
  return [...volumes].sort((a, b) => {
    if (a.mountPoint === "/") return -1;
    if (b.mountPoint === "/") return 1;
    const aInternal = a.removable === false;
    const bInternal = b.removable === false;
    if (aInternal !== bInternal) return aInternal ? -1 : 1;
    return (a.label ?? a.mountPoint).localeCompare(b.label ?? b.mountPoint);
  });
}

/**
 * Detect unplug-during-browse: returns the mount point the user is browsing
 * when that device is no longer in the volume list (unplugged without
 * eject), or undefined when everything is fine.
 *
 * `seenMountPoints` accumulates every mount point the volume service has
 * ever reported, so a device that vanishes between polls is still
 * recognized even though the current list no longer contains it.
 */
export function detectUnpluggedBrowsePath(
  currentPath: string,
  seenMountPoints: ReadonlySet<string>,
  volumes: readonly VolumeLike[],
): string | undefined {
  if (currentPath === "/") return undefined;
  for (const mountPoint of seenMountPoints) {
    if (!isPathOnVolume(currentPath, mountPoint)) continue;
    const stillMounted = volumes.some((volume) => volume.mountPoint === mountPoint);
    if (!stillMounted) return mountPoint;
  }
  return undefined;
}

/**
 * Human-readable "X free of Y" capacity line for a volume.
 * Volumes that report no size info (0/0) show "Size unknown" instead of
 * a misleading "0 B free of 0 B".
 */
export function formatVolumeCapacity(
  sizeBytes: number,
  availableBytes: number,
  formatBytes: (bytes: number) => string,
): string {
  if (sizeBytes <= 0 && availableBytes <= 0) return "Size unknown";
  return `${formatBytes(availableBytes)} free of ${formatBytes(sizeBytes)}`;
}

/** Short human-readable byte count (B, KB, MB, GB), one decimal at most. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${String(rounded)} ${units[unit] as string}`;
}
