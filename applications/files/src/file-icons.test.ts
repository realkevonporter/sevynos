import { describe, expect, it } from "vitest";
import { driveTile, fileTileForEntry, getFileIcon } from "./file-icons.js";

describe("getFileIcon", () => {
  it("keeps the extension mapping", () => {
    expect(getFileIcon("Photos", "directory")).toBe("folder");
    expect(getFileIcon("photo.png", "file")).toBe("image");
    expect(getFileIcon("song.mp3", "file")).toBe("music-note");
    expect(getFileIcon("clip.mp4", "file")).toBe("film");
    expect(getFileIcon("app.ts", "file")).toBe("gear");
    expect(getFileIcon("notes.txt", "file")).toBe("file-text");
    expect(getFileIcon("unknown.xyz", "file")).toBe("file-text");
  });
});

describe("fileTileForEntry", () => {
  it("varies the tile color by type with a white-glyph icon", () => {
    expect(fileTileForEntry("Photos", "directory")).toEqual({
      icon: "folder",
      tileColor: "#F5A623",
      kind: "folder",
    });
    expect(fileTileForEntry("photo.png", "file").kind).toBe("image");
    expect(fileTileForEntry("clip.mp4", "file").kind).toBe("video");
    expect(fileTileForEntry("song.mp3", "file").kind).toBe("audio");
    expect(fileTileForEntry("app.ts", "file").kind).toBe("code");
    expect(fileTileForEntry("notes.txt", "file").kind).toBe("document");
    expect(fileTileForEntry("backup.zip", "file").kind).toBe("archive");
    expect(fileTileForEntry("unknown.xyz", "file").kind).toBe("file");
  });

  it("gives every type a distinct tile color", () => {
    const colors = new Set(
      [
        fileTileForEntry("d", "directory"),
        fileTileForEntry("a.png", "file"),
        fileTileForEntry("a.mp4", "file"),
        fileTileForEntry("a.mp3", "file"),
        fileTileForEntry("a.ts", "file"),
        fileTileForEntry("a.txt", "file"),
        fileTileForEntry("a.zip", "file"),
        fileTileForEntry("a.xyz", "file"),
      ].map((tile) => tile.tileColor),
    );
    expect(colors.size).toBe(8);
  });
});

describe("driveTile", () => {
  it("is a hard-drive glyph on the drive color", () => {
    expect(driveTile()).toEqual({
      icon: "hard-drive",
      tileColor: "#1D9BF0",
      kind: "drive",
    });
  });
});
