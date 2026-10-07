import { describe, expect, it, vi } from "vitest";
import type { FileSystemEntry, SevynFileSystem } from "@sevynos/react-native";
import {
  deleteTrashItemForever,
  emptyTrashBin,
  formatBytes,
  formatDeletedAt,
  isValidTrashName,
  loadTrashItems,
  parseTrashInfo,
  restoreTrashItem,
} from "./trash.js";

const entry = (name: string, overrides?: Partial<FileSystemEntry>): FileSystemEntry => ({
  name,
  path: `trash://${name}`,
  kind: "file",
  size: 42,
  ...overrides,
});

function stubFilesystem(
  overrides?: Partial<SevynFileSystem>,
): SevynFileSystem & { calls: string[] } {
  const calls: string[] = [];
  const filesystem = {
    list: () => Promise.resolve([]),
    read: () => Promise.resolve(""),
    write: () => Promise.resolve(),
    createDirectory: () => Promise.resolve(),
    calls,
    ...overrides,
  } as SevynFileSystem & { calls: string[] };
  return filesystem;
}

describe("parseTrashInfo", () => {
  it("parses a percent-encoded path and ISO deletion date", () => {
    const record = parseTrashInfo(
      "[Trash Info]\nPath=%2Fhome%2Fuser%2FMy%20Docs%2Freport.txt\nPathEncoding=percent\nDeletionDate=2026-10-06T14:30:00.000Z\n",
    );
    expect(record.originalPath).toBe("/home/user/My Docs/report.txt");
    expect(record.deletedAt).toBe(Date.parse("2026-10-06T14:30:00.000Z"));
  });

  it("accepts legacy records with literal paths", () => {
    const record = parseTrashInfo("[Trash Info]\nPath=/home/user/notes.txt\n");
    expect(record.originalPath).toBe("/home/user/notes.txt");
    expect(record.deletedAt).toBeUndefined();
  });

  it("falls back to the raw path when percent-decoding fails", () => {
    const record = parseTrashInfo(
      "[Trash Info]\nPath=%2Fhome%2Fuser%2F%ZZbad\nPathEncoding=percent\n",
    );
    expect(record.originalPath).toBe("%2Fhome%2Fuser%2F%ZZbad");
  });

  it("ignores malformed dates", () => {
    const record = parseTrashInfo("[Trash Info]\nDeletionDate=not-a-date\n");
    expect(record.deletedAt).toBeUndefined();
  });

  it("returns undefined fields for garbage input", () => {
    const record = parseTrashInfo("hello world");
    expect(record.originalPath).toBeUndefined();
    expect(record.deletedAt).toBeUndefined();
  });
});

describe("isValidTrashName", () => {
  it("accepts ordinary names, including spaces and dots", () => {
    expect(isValidTrashName("report.txt")).toBe(true);
    expect(isValidTrashName("My Photos")).toBe(true);
    expect(isValidTrashName("archive.tar.gz")).toBe(true);
    expect(isValidTrashName("backup.1.txt")).toBe(true);
  });

  it("rejects empty, dot segments, and path separators", () => {
    expect(isValidTrashName("")).toBe(false);
    expect(isValidTrashName(".")).toBe(false);
    expect(isValidTrashName("..")).toBe(false);
    expect(isValidTrashName("a/b")).toBe(false);
    expect(isValidTrashName("a\\b")).toBe(false);
    expect(isValidTrashName("a\0b")).toBe(false);
  });
});

describe("loadTrashItems", () => {
  it("attaches original location and deletion date from .trashinfo", async () => {
    const filesystem = stubFilesystem({
      listTrash: () => Promise.resolve([entry("report.txt")]),
      read: (path: string) => {
        expect(path).toBe("/.Trash/info/report.txt.trashinfo");
        return Promise.resolve(
          "[Trash Info]\nPath=%2FDocuments%2Freport.txt\nPathEncoding=percent\n" +
            "DeletionDate=2026-10-06T14:30:00.000Z\n",
        );
      },
    });
    const items = await loadTrashItems(filesystem);
    expect(items).toHaveLength(1);
    expect(items[0]?.originalLocation).toBe("/Documents/report.txt");
    expect(items[0]?.deletedAt).toBe(Date.parse("2026-10-06T14:30:00.000Z"));
  });

  it("keeps items whose metadata is missing, with unknown location", async () => {
    const filesystem = stubFilesystem({
      listTrash: () => Promise.resolve([entry("orphan.txt")]),
      read: () => Promise.reject(new Error("ENOENT")),
    });
    const items = await loadTrashItems(filesystem);
    expect(items).toHaveLength(1);
    expect(items[0]?.originalLocation).toBeUndefined();
    expect(items[0]?.deletedAt).toBeUndefined();
  });

  it("sorts newest deletions first, unknowns last", async () => {
    const filesystem = stubFilesystem({
      listTrash: () =>
        Promise.resolve([entry("old.txt"), entry("new.txt"), entry("mystery.txt")]),
      read: (path: string) => {
        if (path.includes("old.txt"))
          return Promise.resolve("[Trash Info]\nDeletionDate=2026-10-01T00:00:00.000Z\n");
        if (path.includes("new.txt"))
          return Promise.resolve("[Trash Info]\nDeletionDate=2026-10-06T00:00:00.000Z\n");
        return Promise.reject(new Error("ENOENT"));
      },
    });
    const items = await loadTrashItems(filesystem);
    expect(items.map((item) => item.name)).toEqual(["new.txt", "old.txt", "mystery.txt"]);
  });

  it("returns an empty list when the filesystem has no trash support", async () => {
    const filesystem = stubFilesystem({});
    delete (filesystem as { listTrash?: unknown }).listTrash;
    await expect(loadTrashItems(filesystem)).resolves.toEqual([]);
  });
});

describe("deleteTrashItemForever", () => {
  it("deletes the payload then its metadata", async () => {
    const deleted: string[] = [];
    const filesystem = stubFilesystem({
      delete: (path: string) => {
        deleted.push(path);
        return Promise.resolve();
      },
    });
    await deleteTrashItemForever(filesystem, "report.txt");
    expect(deleted).toEqual([
      "/.Trash/files/report.txt",
      "/.Trash/info/report.txt.trashinfo",
    ]);
  });

  it("succeeds when the metadata file is already gone", async () => {
    const deleted: string[] = [];
    const filesystem = stubFilesystem({
      delete: (path: string) => {
        deleted.push(path);
        if (path.endsWith(".trashinfo")) return Promise.reject(new Error("ENOENT"));
        return Promise.resolve();
      },
    });
    await deleteTrashItemForever(filesystem, "report.txt");
    expect(deleted).toHaveLength(2);
  });

  it("rejects invalid names before touching the filesystem", async () => {
    const remove = vi.fn();
    const filesystem = stubFilesystem({ delete: remove });
    await expect(deleteTrashItemForever(filesystem, "../evil")).rejects.toThrow(
      "Invalid Trash item name",
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("throws a clear error when delete is unsupported", async () => {
    const filesystem = stubFilesystem({});
    delete (filesystem as { delete?: unknown }).delete;
    await expect(deleteTrashItemForever(filesystem, "a.txt")).rejects.toThrow(
      "not supported",
    );
  });
});

describe("restoreTrashItem / emptyTrashBin", () => {
  it("delegates to the filesystem primitives", async () => {
    const restore = vi.fn((name: string): Promise<void> => {
      expect(name).toBe("report.txt");
      return Promise.resolve();
    });
    const empty = vi.fn(() => Promise.resolve());
    const filesystem = stubFilesystem({
      restoreFromTrash: restore,
      emptyTrash: empty,
    });
    await restoreTrashItem(filesystem, "report.txt");
    await emptyTrashBin(filesystem);
    expect(restore).toHaveBeenCalledWith("report.txt");
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("throws clear errors when primitives are missing", async () => {
    const filesystem = stubFilesystem({});
    delete (filesystem as { restoreFromTrash?: unknown }).restoreFromTrash;
    delete (filesystem as { emptyTrash?: unknown }).emptyTrash;
    await expect(restoreTrashItem(filesystem, "a")).rejects.toThrow("not supported");
    await expect(emptyTrashBin(filesystem)).rejects.toThrow("not supported");
  });
});

describe("formatters", () => {
  it("formatBytes renders human sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(14_900_000_000)).toBe("14 GB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("formatDeletedAt handles unknown dates", () => {
    expect(formatDeletedAt(undefined)).toBe("Unknown");
    expect(formatDeletedAt(Date.parse("2026-10-06T14:30:00.000Z"))).toContain("2026");
  });
});
