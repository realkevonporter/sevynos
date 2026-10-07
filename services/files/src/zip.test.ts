import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseZipArchive, readZipEntryData } from "./zip.js";
import { buildTestZip } from "./test-helpers.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const inflate = (data: Uint8Array): Uint8Array => inflateRawSync(data);

describe("parseZipArchive", () => {
  it("lists stored and deflated entries with sizes", () => {
    const bytes = buildTestZip([
      { name: "hello.txt", data: textEncoder.encode("hello world"), method: 0 },
      {
        name: "docs/readme.md",
        data: textEncoder.encode("# readme\n".repeat(100)),
        method: 8,
      },
      { name: "empty-dir/", data: new Uint8Array(), method: 0 },
    ]);
    const archive = parseZipArchive(bytes);
    expect(archive.entries).toHaveLength(3);
    expect(archive.entries[0]?.name).toBe("hello.txt");
    expect(archive.entries[0]?.method).toBe(0);
    expect(archive.entries[0]?.uncompressedSize).toBe(11);
    expect(archive.entries[1]?.name).toBe("docs/readme.md");
    expect(archive.entries[1]?.method).toBe(8);
    expect(archive.entries[1]?.uncompressedSize).toBe(900);
    expect(archive.entries[1]?.compressedSize).toBeLessThan(900);
    expect(archive.entries[2]?.isDirectory).toBe(true);
  });

  it("reads back stored and deflated payloads with checksum verification", () => {
    const payload = textEncoder.encode("the quick brown fox ".repeat(50));
    const bytes = buildTestZip([
      { name: "stored.bin", data: payload, method: 0 },
      { name: "deflated.bin", data: payload, method: 8 },
    ]);
    const archive = parseZipArchive(bytes);
    for (const entry of archive.entries) {
      expect(textDecoder.decode(readZipEntryData(bytes, entry, inflate))).toBe(
        textDecoder.decode(payload),
      );
    }
  });

  it("decodes UTF-8 entry names", () => {
    const bytes = buildTestZip([
      { name: "café/naïve.txt", data: textEncoder.encode("x"), method: 0 },
    ]);
    const archive = parseZipArchive(bytes);
    expect(archive.entries[0]?.name).toBe("café/naïve.txt");
  });

  it("rejects non-zip input", () => {
    expect(() => parseZipArchive(textEncoder.encode("definitely not a zip"))).toThrow(
      /end-of-central-directory/,
    );
  });

  it("rejects encrypted entries with a clear error", () => {
    const bytes = buildTestZip([
      { name: "secret.txt", data: textEncoder.encode("x"), encrypted: true },
    ]);
    expect(() => parseZipArchive(bytes)).toThrow(/Encrypted/);
  });

  it("rejects truncated archives", () => {
    const bytes = buildTestZip([
      { name: "a.txt", data: textEncoder.encode("hello"), method: 0 },
    ]);
    expect(() => parseZipArchive(bytes.subarray(0, 20))).toThrow();
  });

  it("detects CRC corruption on extraction", () => {
    const bytes = buildTestZip([
      { name: "a.txt", data: textEncoder.encode("hello"), method: 0 },
    ]);
    const archive = parseZipArchive(bytes);
    const entry = archive.entries[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    // Flip a payload byte (stored entry: payload starts at dataOffset).
    const firstByte = bytes[entry.dataOffset];
    if (firstByte === undefined) throw new Error("test fixture is empty");
    bytes[entry.dataOffset] = firstByte ^ 0xff;
    expect(() => readZipEntryData(bytes, entry, inflate)).toThrow(/checksum/);
  });
});
