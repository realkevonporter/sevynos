/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from "vitest";
import type { FileSystemEntry, SevynFileSystem } from "@sevynos/react-native/internal";
import { UserScopedFileSystem } from "./user-scoped-file-system.js";

function entry(path: string, kind: "file" | "directory" = "file"): FileSystemEntry {
  const name = path.split("/").filter(Boolean).pop() ?? "";
  return Object.freeze({ name, path, kind, size: 0 });
}

/** Minimal in-memory SevynFileSystem recording the raw paths it receives. */
class RecordingFileSystem implements SevynFileSystem {
  public readonly seen: string[] = [];
  public entries: FileSystemEntry[] = [];

  public list(path: string): Promise<readonly FileSystemEntry[]> {
    this.seen.push(`list:${path}`);
    return Promise.resolve(Object.freeze([...this.entries]));
  }

  public read(path: string): Promise<string> {
    this.seen.push(`read:${path}`);
    return Promise.resolve(`content-of:${path}`);
  }

  public write(path: string): Promise<void> {
    this.seen.push(`write:${path}`);
    return Promise.resolve();
  }

  public createDirectory(path: string): Promise<void> {
    this.seen.push(`createDirectory:${path}`);
    return Promise.resolve();
  }

  public delete(path: string): Promise<void> {
    this.seen.push(`delete:${path}`);
    return Promise.resolve();
  }

  public rename(fromPath: string, toPath: string): Promise<void> {
    this.seen.push(`rename:${fromPath}->${toPath}`);
    return Promise.resolve();
  }

  public copy(fromPath: string, toPath: string): Promise<void> {
    this.seen.push(`copy:${fromPath}->${toPath}`);
    return Promise.resolve();
  }

  public stat(path: string): Promise<FileSystemEntry | undefined> {
    this.seen.push(`stat:${path}`);
    return Promise.resolve(entry(path));
  }

  public moveToTrash(path: string): Promise<void> {
    this.seen.push(`moveToTrash:${path}`);
    return Promise.resolve();
  }
}

describe("UserScopedFileSystem", () => {
  it("prefixes every operation with the user scope", async () => {
    const inner = new RecordingFileSystem();
    const scoped = new UserScopedFileSystem(inner, "users/kevon");

    await scoped.list("/Documents");
    await scoped.read("/Documents/notes.txt");
    await scoped.write("/Documents/notes.txt", "hello");
    await scoped.createDirectory("/Pictures");
    await scoped.delete("/Downloads/old.zip");
    await scoped.rename("/a.txt", "/b.txt");
    await scoped.copy("/a.txt", "/c.txt");
    await scoped.stat("/Music");
    await scoped.moveToTrash("/Videos/clip.mp4");

    expect(inner.seen).toEqual([
      "list:/users/kevon/Documents",
      "read:/users/kevon/Documents/notes.txt",
      "write:/users/kevon/Documents/notes.txt",
      "createDirectory:/users/kevon/Pictures",
      "delete:/users/kevon/Downloads/old.zip",
      "rename:/users/kevon/a.txt->/users/kevon/b.txt",
      "copy:/users/kevon/a.txt->/users/kevon/c.txt",
      "stat:/users/kevon/Music",
      "moveToTrash:/users/kevon/Videos/clip.mp4",
    ]);
  });

  it("translates entry paths back to home-relative paths", async () => {
    const inner = new RecordingFileSystem();
    inner.entries = [
      entry("/users/kevon/Documents"),
      entry("/users/kevon/Documents/notes.txt"),
    ];
    const scoped = new UserScopedFileSystem(inner, "users/kevon");

    const entries = await scoped.list("/");
    expect(entries.map((item) => item.path)).toEqual([
      "/Documents",
      "/Documents/notes.txt",
    ]);

    const statEntry = await scoped.stat("/Documents");
    expect(statEntry?.path).toBe("/Documents");
  });

  it("rejects invalid scopes", () => {
    const inner = new RecordingFileSystem();
    expect(() => new UserScopedFileSystem(inner, "")).toThrow(
      "Invalid user filesystem scope",
    );
    expect(() => new UserScopedFileSystem(inner, "../escape")).toThrow(
      "Invalid user filesystem scope",
    );
  });

  it("tolerates leading and trailing slashes in the scope", async () => {
    const inner = new RecordingFileSystem();
    const scoped = new UserScopedFileSystem(inner, "/users/kevon/");
    expect(scoped.scopeDir).toBe("users/kevon");
    await scoped.list("/");
    expect(inner.seen).toEqual(["list:/users/kevon"]);
  });
});
