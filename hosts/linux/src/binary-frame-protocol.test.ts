import { describe, expect, it } from "vitest";
import { encodeBinaryFrame } from "./binary-frame-protocol.js";

describe("binary frame protocol", () => {
  it("frames a complete 1280x720 RGBA image without base64 expansion", () => {
    const pixels = new Uint8Array(1280 * 720 * 4);
    const encoded = encodeBinaryFrame({
      frameId: 42,
      displayId: "display-wayland",
      width: 1280,
      height: 720,
      stride: 5120,
      format: "rgba8888",
      pixels,
      damage: [{ x: 0, y: 0, width: 1280, height: 720 }],
      traceId: "focus-7",
    });

    expect(encoded.metadata.subarray(0, 8).toString("ascii")).toBe("SEVYNFRM");
    expect(encoded.metadata.readUInt32LE(8)).toBe(1);
    expect(encoded.metadata.readBigUInt64LE(16)).toBe(42n);
    expect(encoded.metadata.readUInt32LE(24)).toBe(1280);
    expect(encoded.metadata.readUInt32LE(28)).toBe(720);
    expect(encoded.metadata.readUInt32LE(48)).toBe(pixels.byteLength);
    expect(encoded.pixels.buffer).toBe(pixels.buffer);
    expect(encoded.byteLength).toBeLessThan(pixels.byteLength + 256);
  });

  it("rejects mismatched pixels and out-of-bounds damage", () => {
    expect(() =>
      encodeBinaryFrame({
        frameId: 1,
        displayId: "display",
        width: 2,
        height: 2,
        stride: 8,
        format: "rgba8888",
        pixels: new Uint8Array(15),
        damage: [{ x: 0, y: 0, width: 2, height: 2 }],
      }),
    ).toThrow(/pixel length/);
    expect(() =>
      encodeBinaryFrame({
        frameId: 1,
        displayId: "display",
        width: 2,
        height: 2,
        stride: 8,
        format: "rgba8888",
        pixels: new Uint8Array(16),
        damage: [{ x: 1, y: 1, width: 2, height: 2 }],
      }),
    ).toThrow(/damage region/);
  });
});
