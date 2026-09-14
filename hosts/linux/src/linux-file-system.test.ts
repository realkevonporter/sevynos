import { mkdtemp, rm, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinuxFileSystem, detectMimeType } from "./linux-file-system.js";

describe("LinuxFileSystem", () => {
  let tempDir: string;
  let fs: LinuxFileSystem;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-fs-test-"));
    fs = new LinuxFileSystem({ rootDirectory: tempDir, defaultFiles: true });
    await fs.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects mime types based on file extension", () => {
    expect(detectMimeType("document.md")).toBe("text/markdown");
    expect(detectMimeType("photo.png")).toBe("image/png");
    expect(detectMimeType("audio.mp3")).toBe("audio/mpeg");
    expect(detectMimeType("unknown.custom")).toBe("application/octet-stream");
  });

  it("initializes standard directories and default welcome file", async () => {
    const rootEntries = await fs.list("/");
    const names = rootEntries.map((e) => e.name);
    expect(names).toContain("Desktop");
    expect(names).toContain("Documents");
    expect(names).toContain("Downloads");
    expect(names).toContain("Pictures");
    expect(names).toContain("Music");
    expect(names).toContain("Videos");

    const desktopEntries = await fs.list("/Desktop");
    expect(desktopEntries.some((e) => e.name === "Welcome to SevynOS.txt")).toBe(true);
    const welcome = await fs.read("/Desktop/Welcome to SevynOS.txt");
    expect(welcome).toContain("Welcome to SevynOS");
  });

  it("supports file write, read, stat, copy, and rename", async () => {
    await fs.write("/Documents/test.txt", "Hello SevynOS");
    expect(await fs.read("/Documents/test.txt")).toBe("Hello SevynOS");

    const statInfo = await fs.stat("/Documents/test.txt");
    expect(statInfo).toBeDefined();
    expect(statInfo?.kind).toBe("file");
    expect(statInfo?.mimeType).toBe("text/plain");
    expect(statInfo?.size).toBe(13);

    await fs.copy("/Documents/test.txt", "/Documents/test-copy.txt");
    expect(await fs.read("/Documents/test-copy.txt")).toBe("Hello SevynOS");

    await fs.rename("/Documents/test-copy.txt", "/Documents/test-renamed.txt");
    expect(await fs.read("/Documents/test-renamed.txt")).toBe("Hello SevynOS");
    await expect(fs.stat("/Documents/test-copy.txt")).resolves.toBeUndefined();
  });

  it("supports trash lifecycle: moveToTrash, listTrash, restoreFromTrash, and emptyTrash", async () => {
    await fs.write("/Documents/trashme.txt", "Delete me");
    await fs.moveToTrash("/Documents/trashme.txt");

    // File should no longer be in /Documents
    await expect(fs.stat("/Documents/trashme.txt")).resolves.toBeUndefined();

    // File should appear in listTrash
    const trashList = await fs.listTrash();
    expect(trashList.some((e) => e.name === "trashme.txt")).toBe(true);

    // Restore from trash
    await fs.restoreFromTrash("trashme.txt");
    expect(await fs.read("/Documents/trashme.txt")).toBe("Delete me");
    expect((await fs.listTrash()).some((e) => e.name === "trashme.txt")).toBe(false);

    // Trash again and empty
    await fs.moveToTrash("/Documents/trashme.txt");
    await fs.emptyTrash();
    expect(await fs.listTrash()).toHaveLength(0);
  });
});

describe("Linux filesystem data safety", () => {
  let base: string;
  let root: string;
  let filesystem: LinuxFileSystem;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "sevyn-fs-safety-"));
    root = join(base, "user");
    filesystem = new LinuxFileSystem({ rootDirectory: root, defaultFiles: false });
    await filesystem.initialize();
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("honors empty storage and reports initialization failures", async () => {
    expect(await filesystem.list("/Desktop")).toEqual([]);
    const blocked = join(base, "blocked");
    await writeFile(blocked, "file");
    await expect(
      new LinuxFileSystem({ rootDirectory: blocked }).initialize(),
    ).rejects.toThrow();
  });

  it("rejects traversal, root mutations and sibling-prefix escapes", async () => {
    await mkdir(join(base, "user-other"));
    await writeFile(join(base, "user-other", "secret"), "outside");
    await expect(filesystem.read("../user-other/secret")).rejects.toThrow();
    await expect(filesystem.write("/../user-other/secret", "changed")).rejects.toThrow();
    await expect(filesystem.delete("/")).rejects.toThrow();
    await expect(filesystem.rename("/", "/moved")).rejects.toThrow();
    await expect(filesystem.moveToTrash("/")).rejects.toThrow();
    expect(await readFile(join(base, "user-other", "secret"), "utf8")).toBe("outside");
  });

  it("rejects symlink ancestors, dangling links and nested copy links", async () => {
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside", "secret"), "outside");
    await symlink(join(base, "outside"), join(root, "escape"));
    await symlink(join(base, "outside", "new"), join(root, "dangling"));
    await expect(filesystem.read("/escape/secret")).rejects.toThrow();
    await expect(filesystem.write("/escape/new", "bad")).rejects.toThrow();
    await expect(filesystem.write("/dangling", "bad")).rejects.toThrow();
    await filesystem.createDirectory("/source");
    await symlink(join(base, "outside"), join(root, "source", "link"));
    await expect(filesystem.copy("/source", "/copied")).rejects.toThrow();
    expect(await filesystem.stat("/copied")).toBeUndefined();
  });

  it("does not overwrite existing copy, rename or restore destinations", async () => {
    await filesystem.write("/Documents/a", "a");
    await filesystem.write("/Documents/b", "b");
    await expect(filesystem.copy("/Documents/a", "/Documents/b")).rejects.toThrow();
    await expect(filesystem.rename("/Documents/a", "/Documents/b")).rejects.toThrow();
    await filesystem.moveToTrash("/Documents/a");
    await filesystem.write("/Documents/a", "new");
    await expect(filesystem.restoreFromTrash("a")).rejects.toThrow();
    expect(await filesystem.read("/Documents/a")).toBe("new");
    expect(await filesystem.read("/Documents/b")).toBe("b");
    expect(await filesystem.listTrash()).toHaveLength(1);
  });

  it("preserves concurrent same-name deletions and restores both", async () => {
    await filesystem.write("/Documents/report.txt", "first");
    await filesystem.write("/Desktop/report.txt", "second");
    await Promise.all([
      filesystem.moveToTrash("/Documents/report.txt"),
      filesystem.moveToTrash("/Desktop/report.txt"),
    ]);
    const items = await filesystem.listTrash();
    expect(items).toHaveLength(2);
    for (const item of items) await filesystem.restoreFromTrash(item.name);
    expect(await filesystem.read("/Documents/report.txt")).toBe("first");
    expect(await filesystem.read("/Desktop/report.txt")).toBe("second");
  });

  it("round-trips newlines and percent characters in original paths", async () => {
    const path = "/Documents/line\nbreak%20.txt";
    await filesystem.write(path, "kept");
    await filesystem.moveToTrash(path);
    await filesystem.restoreFromTrash("line\nbreak%20.txt");
    expect(await filesystem.read(path)).toBe("kept");
  });

  it("rejects forged restore metadata and malformed item names", async () => {
    await filesystem.write("/Documents/a", "safe");
    await filesystem.moveToTrash("/Documents/a");
    await writeFile(
      join(root, ".Trash/info/a.trashinfo"),
      "[Trash Info]\nPath=" + join(base, "outside") + "\n",
    );
    await expect(filesystem.restoreFromTrash("a")).rejects.toThrow();
    await expect(filesystem.restoreFromTrash("../a")).rejects.toThrow();
    expect(await filesystem.listTrash()).toHaveLength(1);
  });
});
