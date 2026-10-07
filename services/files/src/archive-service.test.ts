import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectArchiveFormat,
  FileArchiveService,
  isSafeArchiveEntryName,
  type ArchiveProgress,
} from "./archive-service.js";
import { buildTestTar, buildTestZip } from "./test-helpers.js";

const textEncoder = new TextEncoder();

describe("detectArchiveFormat / isSafeArchiveEntryName", () => {
  it("detects formats by extension", () => {
    expect(detectArchiveFormat("backup.ZIP")).toBe("zip");
    expect(detectArchiveFormat("archive.tar.gz")).toBe("tar.gz");
    expect(detectArchiveFormat("archive.tgz")).toBe("tar.gz");
    expect(detectArchiveFormat("archive.tar")).toBe("tar");
    expect(detectArchiveFormat("photo.png")).toBeUndefined();
  });

  it("rejects zip-slip names", () => {
    expect(isSafeArchiveEntryName("docs/a.txt")).toBe(true);
    expect(isSafeArchiveEntryName("a.txt")).toBe(true);
    expect(isSafeArchiveEntryName("dir/")).toBe(true);
    expect(isSafeArchiveEntryName("/etc/passwd")).toBe(false);
    expect(isSafeArchiveEntryName("../evil.txt")).toBe(false);
    expect(isSafeArchiveEntryName("a/../../evil.txt")).toBe(false);
    expect(isSafeArchiveEntryName("")).toBe(false);
    expect(isSafeArchiveEntryName("a//b")).toBe(false);
  });
});

describe("FileArchiveService", () => {
  let root: string;
  let service: FileArchiveService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sevyn-archives-"));
    service = new FileArchiveService({ rootDirectory: root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const collectProgress = (): {
    events: ArchiveProgress[];
    listener: (p: ArchiveProgress) => void;
  } => {
    const events: ArchiveProgress[] = [];
    return { events, listener: (p) => events.push(p) };
  };

  it("round-trips createZip -> listEntries -> extract with byte-identical output", async () => {
    const binary = new Uint8Array(256);
    for (let i = 0; i < binary.length; i += 1) binary[i] = i;
    await writeFile(join(root, "hello.txt"), "hello archives");
    await writeFile(join(root, "data.bin"), binary);
    const { listener, events } = collectProgress();
    await service.createZip(".", "out/bundle.zip", listener);
    expect(events.length).toBeGreaterThan(0);

    const entries = await service.listEntries("out/bundle.zip");
    const names = entries.map((entry) => entry.name).sort();
    expect(names).toContain("hello.txt");
    expect(names).toContain("data.bin");
    const hello = entries.find((entry) => entry.name === "hello.txt");
    expect(hello?.size).toBe("hello archives".length);

    // The created zip must parse with the independent parser path too.
    const extractProgress = collectProgress();
    const result = await service.extract(
      "out/bundle.zip",
      "restored",
      extractProgress.listener,
    );
    expect(result.entriesExtracted).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toEqual([]);
    expect(extractProgress.events.length).toBeGreaterThan(0);
    expect(await readFile(join(root, "restored/hello.txt"), "utf8")).toBe(
      "hello archives",
    );
    expect(await readFile(join(root, "restored/data.bin"))).toEqual(Buffer.from(binary));
  });

  it("extracts tar.gz archives", async () => {
    const tarBytes = buildTestTar([
      { name: "notes/todo.txt", data: textEncoder.encode("buy milk") },
      { name: "notes", directory: true },
    ]);
    await writeFile(join(root, "notes.tar.gz"), gzipSync(tarBytes));
    const entries = await service.listEntries("notes.tar.gz");
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "notes/",
      "notes/todo.txt",
    ]);
    const result = await service.extract("notes.tar.gz", "unpacked");
    expect(result.entriesExtracted).toBe(1);
    expect(await readFile(join(root, "unpacked/notes/todo.txt"), "utf8")).toBe(
      "buy milk",
    );
  });

  it("extracts plain tar archives", async () => {
    const tarBytes = buildTestTar([{ name: "a.txt", data: textEncoder.encode("A") }]);
    await writeFile(join(root, "plain.tar"), tarBytes);
    const result = await service.extract("plain.tar", "tar-out");
    expect(result.entriesExtracted).toBe(1);
    expect(await readFile(join(root, "tar-out/a.txt"), "utf8")).toBe("A");
  });

  it("refuses zip-slip entries", async () => {
    const evil = buildTestZip([
      { name: "../evil.txt", data: textEncoder.encode("x"), method: 0 },
    ]);
    await writeFile(join(root, "evil.zip"), evil);
    await expect(service.extract("evil.zip", "out")).rejects.toThrow(/Unsafe/);
  });

  it("skips tar symlinks instead of materializing them", async () => {
    const tarBytes = buildTestTar([
      { name: "real.txt", data: textEncoder.encode("real") },
      { name: "link.txt", symlink: "real.txt" },
    ]);
    await writeFile(join(root, "links.tar"), tarBytes);
    const result = await service.extract("links.tar", "links-out");
    expect(result.entriesExtracted).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("link.txt");
  });

  it("rejects archives outside the root", async () => {
    await expect(service.listEntries("../outside.zip")).rejects.toThrow(/escapes/);
    await expect(service.extract("../outside.zip", "out")).rejects.toThrow(/escapes/);
  });

  it("rejects unsupported formats with a clear error", async () => {
    await writeFile(join(root, "file.rar"), "nope");
    await expect(service.listEntries("file.rar")).rejects.toThrow(/Unsupported/);
  });

  it("fails cleanly on corrupt archives", async () => {
    await writeFile(join(root, "broken.zip"), "not a zip at all");
    await expect(service.extract("broken.zip", "out")).rejects.toThrow();
  });
});
