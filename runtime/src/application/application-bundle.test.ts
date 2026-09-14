import { describe, expect, it } from "vitest";
import {
  createSevynBundle,
  extractSevynBundle,
  computeCrc32,
} from "./application-bundle.js";
import type { ApplicationManifest } from "./application-manifest.js";

describe("application-bundle (.sevyn zip)", () => {
  it("computes standard CRC32 correctly", () => {
    const data = new TextEncoder().encode("123456789");
    // Standard CRC-32 check value for "123456789" is 0xcbf43926
    expect(computeCrc32(data)).toBe(0xcbf43926);
  });

  it("packs and extracts a .sevyn bundle roundtrip", () => {
    const manifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.calculator",
      name: "Calculator",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["notifications"],
      system: false,
    };

    const bytecode = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const iconData = new TextEncoder().encode("<svg>calculator</svg>");

    const bundle = createSevynBundle({
      manifest,
      bytecode,
      assets: {
        "icon.svg": iconData,
      },
      extraFiles: {
        "README.txt": new TextEncoder().encode("Calculator app"),
      },
    });

    expect(bundle.length).toBeGreaterThan(50);
    // Standard ZIP signature PK\x03\x04
    expect(bundle[0]).toBe(0x50);
    expect(bundle[1]).toBe(0x4b);
    expect(bundle[2]).toBe(0x03);
    expect(bundle[3]).toBe(0x04);

    const extracted = extractSevynBundle(bundle);
    expect(extracted.manifest).toEqual(manifest);
    expect(extracted.bytecode).toEqual(bytecode);
    expect(extracted.assets.get("icon.svg")).toEqual(iconData);
    expect(extracted.files.get("README.txt")).toEqual(
      new TextEncoder().encode("Calculator app"),
    );
  });

  it("rejects bundle with missing manifest or invalid format", () => {
    expect(() => {
      extractSevynBundle(new Uint8Array([1, 2, 3, 4]));
    }).toThrow("missing ZIP End of Central Directory record");
  });
});
