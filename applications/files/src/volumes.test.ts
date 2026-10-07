import { describe, expect, it } from "vitest";
import {
  detectUnpluggedBrowsePath,
  formatVolumeCapacity,
  isPathOnVolume,
} from "./volumes.js";

describe("isPathOnVolume", () => {
  it("matches the mount point and its subfolders only", () => {
    expect(isPathOnVolume("/media/usb", "/media/usb")).toBe(true);
    expect(isPathOnVolume("/media/usb/photos", "/media/usb")).toBe(true);
    expect(isPathOnVolume("/media/usb2", "/media/usb")).toBe(false);
    expect(isPathOnVolume("/", "/media/usb")).toBe(false);
    expect(isPathOnVolume("/Documents", "/media/usb")).toBe(false);
  });
});

describe("detectUnpluggedBrowsePath", () => {
  const seen = new Set(["/media/usb", "/media/backup"]);

  it("returns undefined at the home folder", () => {
    expect(detectUnpluggedBrowsePath("/", seen, [])).toBeUndefined();
  });

  it("returns undefined while the browsed device is still mounted", () => {
    expect(
      detectUnpluggedBrowsePath("/media/usb/photos", seen, [
        { mountPoint: "/media/usb" },
      ]),
    ).toBeUndefined();
  });

  it("returns the mount point when its device vanished", () => {
    expect(
      detectUnpluggedBrowsePath("/media/usb/photos", seen, [
        { mountPoint: "/media/backup" },
      ]),
    ).toBe("/media/usb");
  });

  it("returns the mount point itself when browsing it directly", () => {
    expect(detectUnpluggedBrowsePath("/media/usb", seen, [])).toBe("/media/usb");
  });

  it("ignores paths on unseen mount points", () => {
    expect(detectUnpluggedBrowsePath("/media/newstick", seen, [])).toBeUndefined();
  });

  it("ignores regular folders", () => {
    expect(detectUnpluggedBrowsePath("/Documents", seen, [])).toBeUndefined();
  });
});

describe("formatVolumeCapacity", () => {
  it("renders a free-of-total line", () => {
    expect(formatVolumeCapacity(1000, 250, (bytes) => `${String(bytes)}B`)).toBe(
      "250B free of 1000B",
    );
  });
});
