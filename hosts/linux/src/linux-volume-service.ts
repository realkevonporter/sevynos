/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * USB/removable volume discovery for SevynOS on Linux.
 *
 * The image's udev rules (tools/qemu/usb-automount.rules) mount USB block
 * devices to /media/<kernel-name> (e.g. /media/sdb1) on insert and unmount
 * them on removal. This service watches /proc/mounts for mounts under /media
 * and exposes them as volumes to the rest of the system.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface SevynVolume {
  readonly id: string;
  readonly label: string;
  readonly mountPoint: string;
  readonly filesystem: string;
  readonly device: string;
  readonly sizeBytes: number;
  readonly availableBytes: number;
  readonly removable: boolean;
}

export type VolumeChangeListener = (volumes: readonly SevynVolume[]) => void;

const MEDIA_ROOT = "/media";
const PROC_MOUNTS = "/proc/mounts";

/**
 * Parse /proc/mounts and return entries mounted under /media.
 */
async function readMediaMounts(): Promise<
  { device: string; mountPoint: string; filesystem: string }[]
> {
  try {
    const content = await readFile(PROC_MOUNTS, "utf-8");
    const mounts: { device: string; mountPoint: string; filesystem: string }[] = [];
    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const device = parts[0];
      const mountPoint = parts[1];
      const filesystem = parts[2];
      if (device === undefined || mountPoint === undefined || filesystem === undefined)
        continue;
      if (!mountPoint.startsWith(MEDIA_ROOT + "/")) continue;
      // Skip the /media root itself; only actual device mounts.
      if (mountPoint === MEDIA_ROOT) continue;
      mounts.push({ device, mountPoint, filesystem });
    }
    return mounts;
  } catch {
    return [];
  }
}

/**
 * Derive a human-friendly label from the mount point.
 * e.g. /media/sdb1 -> "sdb1", /media/MYUSB -> "MYUSB"
 */
function labelForMount(mountPoint: string): string {
  const name = mountPoint.slice(MEDIA_ROOT.length + 1);
  return name || "USB Drive";
}

export class LinuxVolumeService {
  #listeners = new Set<VolumeChangeListener>();
  #volumes: readonly SevynVolume[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  /**
   * Start polling /proc/mounts for volume changes.
   * Polls every 2 seconds; cheap (single small file read).
   */
  public start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#refresh();
    this.#timer = setInterval(() => {
      void this.#refresh();
    }, 2000);
  }

  public stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  public listVolumes(): Promise<readonly SevynVolume[]> {
    return Promise.resolve(this.#volumes);
  }

  public subscribe(listener: VolumeChangeListener): () => void {
    this.#listeners.add(listener);
    // Immediately notify with current state.
    listener(this.#volumes);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Eject (unmount) a volume by ID.
   * Uses the system's unmount script if available, falls back to umount.
   */
  public async eject(volumeId: string): Promise<void> {
    const volume = this.#volumes.find((v) => v.id === volumeId);
    if (!volume) throw new Error(`Volume ${volumeId} not found.`);
    // Try the SevynOS unmount script first, fall back to umount.
    const scripts = [
      "/usr/local/bin/sevyn-usb-unmount",
      "/usr/bin/umount",
      "/bin/umount",
    ];
    for (const script of scripts) {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(script, [volume.mountPoint], { stdio: "ignore" });
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Eject failed with code ${String(code)}`));
          });
        });
        // Success; refresh to update the volume list.
        await this.#refresh();
        return;
      } catch {
        // Try next script.
        continue;
      }
    }
    throw new Error(`Could not eject ${volume.label}.`);
  }

  /**
   * Check if a path is inside an active volume mount point.
   * Used by the filesystem jail to allowlist removable storage.
   */
  public isVolumePath(path: string): boolean {
    return this.#volumes.some(
      (v) => path === v.mountPoint || path.startsWith(v.mountPoint + "/"),
    );
  }

  async #refresh(): Promise<void> {
    const mounts = await readMediaMounts();
    const volumes: SevynVolume[] = mounts.map((m) => ({
      id: `usb-${m.mountPoint.slice(MEDIA_ROOT.length + 1)}`,
      label: labelForMount(m.mountPoint),
      mountPoint: m.mountPoint,
      filesystem: m.filesystem,
      device: m.device,
      // Size info requires statvfs; report 0 for now (UI shows "USB Drive").
      sizeBytes: 0,
      availableBytes: 0,
      removable: true,
    }));

    // Only notify if the set changed.
    const prevIds = this.#volumes
      .map((v) => v.id)
      .sort()
      .join(",");
    const nextIds = volumes
      .map((v) => v.id)
      .sort()
      .join(",");
    if (prevIds !== nextIds) {
      this.#volumes = volumes;
      for (const listener of this.#listeners) {
        try {
          listener(this.#volumes);
        } catch {
          // Listener errors must not break the poll loop.
        }
      }
    } else {
      this.#volumes = volumes;
    }
  }
}
