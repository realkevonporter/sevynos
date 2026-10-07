import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isGzipStream, parseGzipHeader } from "./gzip.js";

const textEncoder = new TextEncoder();

describe("parseGzipHeader", () => {
  it("accepts a real gzip stream and reports the header length", () => {
    const bytes = gzipSync(textEncoder.encode("hello gzip"));
    const header = parseGzipHeader(bytes);
    expect(header.headerLength).toBe(10);
    expect(header.name).toBeUndefined();
  });

  it("rejects non-gzip input", () => {
    expect(() => parseGzipHeader(textEncoder.encode("not a gzip stream!!"))).toThrow(
      /magic/,
    );
    expect(isGzipStream(textEncoder.encode("not a gzip stream!!"))).toBe(false);
  });

  it("rejects truncated headers", () => {
    const bytes = gzipSync(textEncoder.encode("hello"));
    expect(() => parseGzipHeader(bytes.subarray(0, 5))).toThrow(/truncated/);
  });

  it("parses the FNAME extra field", () => {
    // Hand-built gzip member with an original filename.
    const name = textEncoder.encode("notes.txt");
    const header = new Uint8Array(10 + name.length + 1);
    header[0] = 0x1f;
    header[1] = 0x8b;
    header[2] = 8;
    header[3] = 0x08; // FNAME
    header.set(name, 10);
    const parsed = parseGzipHeader(header);
    expect(parsed.name).toBe("notes.txt");
    expect(parsed.headerLength).toBe(header.length);
  });
});

describe("isGzipStream", () => {
  it("detects gzip streams", () => {
    expect(isGzipStream(gzipSync(textEncoder.encode("x")))).toBe(true);
    expect(isGzipStream(new Uint8Array())).toBe(false);
  });
});
