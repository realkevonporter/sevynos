import { describe, expect, it } from "vitest";
import {
  isCrossDeviceError,
  isCrossVolumeMove,
  isCutPasteNoop,
  isPasteIntoSelfOrDescendant,
  joinPath,
  resolvePasteTarget,
  splitName,
  type ClipboardEntry,
} from "./clipboard.js";

const cutDir: ClipboardEntry = {
  kind: "cut",
  sourcePath: "/Documents/Photos",
  sourceName: "Photos",
  sourceKind: "directory",
};
const copyFile: ClipboardEntry = {
  kind: "copy",
  sourcePath: "/Documents/photo.png",
  sourceName: "photo.png",
  sourceKind: "file",
};

describe("joinPath", () => {
  it("joins without doubling slashes", () => {
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("/Documents", "a")).toBe("/Documents/a");
    expect(joinPath("/Documents/", "a")).toBe("/Documents/a");
  });
});

describe("splitName", () => {
  it("splits base and extension", () => {
    expect(splitName("photo.png")).toEqual({ base: "photo", extension: ".png" });
    expect(splitName("Docs")).toEqual({ base: "Docs", extension: "" });
    expect(splitName(".gitignore")).toEqual({ base: ".gitignore", extension: "" });
  });
});

describe("isPasteIntoSelfOrDescendant", () => {
  it("refuses the source itself and its descendants", () => {
    expect(isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos")).toBe(
      true,
    );
    expect(
      isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos/Trip"),
    ).toBe(true);
  });

  it("allows siblings, parents and unrelated folders", () => {
    expect(isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents")).toBe(false);
    expect(isPasteIntoSelfOrDescendant("/Documents/Photos", "/Downloads")).toBe(false);
    expect(isPasteIntoSelfOrDescendant("/Documents/Photos", "/Documents/Photos2")).toBe(
      false,
    );
  });
});

describe("isCutPasteNoop", () => {
  it("is a no-op only for a cut back into its own parent", () => {
    expect(isCutPasteNoop(cutDir, "/Documents")).toBe(true);
    expect(isCutPasteNoop(cutDir, "/Downloads")).toBe(false);
    expect(isCutPasteNoop({ ...cutDir, kind: "copy" }, "/Documents")).toBe(false);
  });
});

describe("resolvePasteTarget", () => {
  it("returns the plain name when there is no collision", () => {
    expect(resolvePasteTarget(copyFile, "/Downloads", new Set())).toEqual({
      targetPath: "/Downloads/photo.png",
      targetName: "photo.png",
    });
  });

  it("suffixes before the extension on collision", () => {
    const existing = new Set(["photo.png", "photo (1).png"]);
    expect(resolvePasteTarget(copyFile, "/Downloads", existing)).toEqual({
      targetPath: "/Downloads/photo (2).png",
      targetName: "photo (2).png",
    });
  });

  it("suffixes folders without an extension", () => {
    const existing = new Set(["Photos"]);
    expect(resolvePasteTarget(copyFile, "/Downloads", existing)).toBeDefined();
    expect(
      resolvePasteTarget(
        {
          kind: "copy",
          sourcePath: "/Documents/Photos",
          sourceName: "Photos",
          sourceKind: "directory",
        },
        "/Downloads",
        existing,
      ),
    ).toEqual({ targetPath: "/Downloads/Photos (1)", targetName: "Photos (1)" });
  });

  it("refuses a folder pasted into itself or a descendant", () => {
    expect(
      resolvePasteTarget(cutDir, "/Documents/Photos/Trip", new Set()),
    ).toBeUndefined();
  });
});

describe("isCrossVolumeMove", () => {
  const volumes = [{ mountPoint: "/media/usb" }, { mountPoint: "/" }];

  it("detects moves between the internal drive and a USB volume", () => {
    expect(isCrossVolumeMove("/Documents/a.txt", "/media/usb", volumes)).toBe(true);
    expect(isCrossVolumeMove("/media/usb/a.txt", "/Documents", volumes)).toBe(true);
  });

  it("treats same-volume moves as renames", () => {
    expect(isCrossVolumeMove("/Documents/a.txt", "/Downloads", volumes)).toBe(false);
    expect(isCrossVolumeMove("/media/usb/a.txt", "/media/usb/Photos", volumes)).toBe(
      false,
    );
  });

  it("treats unlisted paths as the internal drive", () => {
    expect(isCrossVolumeMove("/Documents/a.txt", "/Downloads", [])).toBe(false);
  });
});

describe("isCrossDeviceError", () => {
  it("recognises EXDEV by message and by code", () => {
    expect(isCrossDeviceError(new Error("EXDEV: cross-device link not permitted"))).toBe(
      true,
    );
    expect(
      isCrossDeviceError(Object.assign(new Error("rename failed"), { code: "EXDEV" })),
    ).toBe(true);
    expect(isCrossDeviceError(new Error("EEXIST: destination already exists"))).toBe(
      false,
    );
    expect(isCrossDeviceError(undefined)).toBe(false);
  });
});
