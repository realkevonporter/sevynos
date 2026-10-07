/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Removable-volume helpers for the File Manager sidebar.
 */

export interface VolumeLike {
  readonly mountPoint: string;
}

/** True when `path` is the volume's mount point or a folder inside it. */
export function isPathOnVolume(path: string, mountPoint: string): boolean {
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
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

/** Human-readable "X free of Y" capacity line for a volume. */
export function formatVolumeCapacity(
  sizeBytes: number,
  availableBytes: number,
  formatBytes: (bytes: number) => string,
): string {
  return `${formatBytes(availableBytes)} free of ${formatBytes(sizeBytes)}`;
}
