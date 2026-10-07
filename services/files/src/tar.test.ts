import { describe, expect, it } from "vitest";
import { parseTarArchive } from "./tar.js";
import { buildTestTar } from "./test-helpers.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("parseTarArchive", () => {
  it("parses files, directories and symlinks", () => {
    const payload = textEncoder.encode("file contents");
    const bytes = buildTestTar([
      { name: "a.txt", data: payload },
      { name: "docs", directory: true },
      { name: "link", symlink: "a.txt" },
    ]);
    const entries = parseTarArchive(bytes);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.name).toBe("a.txt");
    expect(entries[0]?.kind).toBe("file");
    expect(entries[0]?.size).toBe(payload.length);
    expect(
      textDecoder.decode(
        bytes.subarray(
          entries[0]?.dataOffset ?? 0,
          (entries[0]?.dataOffset ?? 0) + (entries[0]?.size ?? 0),
        ),
      ),
    ).toBe("file contents");
    expect(entries[1]?.kind).toBe("directory");
    expect(entries[2]?.kind).toBe("symlink");
    expect(entries[2]?.linkname).toBe("a.txt");
  });

  it("resolves GNU long names", () => {
    const longName = `deep/nested/${"x".repeat(120)}.txt`;
    const bytes = buildTestTar([{ name: longName, data: textEncoder.encode("z") }]);
    const entries = parseTarArchive(bytes);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe(longName);
  });

  it("exposes mtimes as epoch milliseconds", () => {
    const bytes = buildTestTar([{ name: "a.txt", data: new Uint8Array() }]);
    const entries = parseTarArchive(bytes);
    expect(entries[0]?.mtime).toBe(1_700_000_000_000);
  });

  it("rejects headers with bad checksums", () => {
    const bytes = buildTestTar([{ name: "a.txt", data: textEncoder.encode("x") }]);
    const modeByte = bytes[100];
    if (modeByte === undefined) throw new Error("test fixture is empty");
    bytes[100] = modeByte ^ 0xff; // corrupt the mode field
    expect(() => parseTarArchive(bytes)).toThrow(/checksum/);
  });

  it("rejects payloads that run past the end of the archive", () => {
    const bytes = buildTestTar([{ name: "a.txt", data: textEncoder.encode("x") }]);
    // Cut right after the 512-byte header: the 1-byte payload is missing.
    expect(() => parseTarArchive(bytes.subarray(0, 512))).toThrow(/exceeds/);
  });

  it("stops at the zero-block end marker", () => {
    const bytes = buildTestTar([{ name: "a.txt", data: new Uint8Array() }]);
    const entries = parseTarArchive(bytes);
    expect(entries).toHaveLength(1);
  });
});
