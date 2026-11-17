/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from "vitest";
import { LinuxVolumeService, type SevynVolume } from "./linux-volume-service.js";

async function volumesAfterRefresh(
  service: LinuxVolumeService,
): Promise<readonly SevynVolume[]> {
  service.start();
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const volumes = await service.listVolumes();
      if (volumes.length > 0) return volumes;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await service.listVolumes();
  } finally {
    service.stop();
  }
}

describe("LinuxVolumeService", () => {
  it("always lists the internal drive first, with real sizes", async () => {
    const service = new LinuxVolumeService();
    const volumes = await volumesAfterRefresh(service);
    const internal = volumes.find((volume) => volume.id === "internal");
    expect(internal).toMatchObject({
      label: "Internal Drive",
      mountPoint: "/",
      removable: false,
    });
    expect(internal?.sizeBytes).toBeGreaterThan(0);
    expect(internal?.availableBytes).toBeGreaterThan(0);
    expect(internal?.availableBytes).toBeLessThanOrEqual(internal?.sizeBytes ?? 0);
    expect(volumes[0]?.id).toBe("internal");
  });

  it("does not treat user-storage paths as volume paths", async () => {
    const service = new LinuxVolumeService();
    await volumesAfterRefresh(service);
    expect(service.isVolumePath("/Documents")).toBe(false);
    expect(service.isVolumePath("/")).toBe(false);
    expect(service.isVolumePath("/media/not-mounted")).toBe(false);
  });

  it("refuses to eject the internal drive", async () => {
    const service = new LinuxVolumeService();
    await volumesAfterRefresh(service);
    await expect(service.eject("internal")).rejects.toThrow(/cannot be ejected/i);
  });

  it("rejects eject for an unknown volume", async () => {
    const service = new LinuxVolumeService();
    await expect(service.eject("usb-nope")).rejects.toThrow(/not found/i);
  });
});
