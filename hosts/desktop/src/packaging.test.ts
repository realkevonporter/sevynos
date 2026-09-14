import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Genesis desktop packaging", () => {
  const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
  it("contains signed-ready metadata and restricted production files", async () => {
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    ) as {
      productName?: string;
      build?: {
        appId?: string;
        asar?: boolean;
        files?: readonly string[];
        mac?: { hardenedRuntime?: boolean };
        linux?: { target?: readonly string[] };
      };
    };
    expect(manifest.productName).toBe("SevynOS Genesis");
    expect(manifest.build).toMatchObject({
      appId: "org.sevynos.genesis",
      asar: true,
      mac: { hardenedRuntime: true },
      linux: { target: ["AppImage"] },
    });
    expect(manifest.build?.files).toEqual([
      "dist/main.js",
      "dist/preload.cjs",
      "dist/renderer.js",
      "dist/application-worker.js",
      "dist/system-applications/*.js",
      "dist/index.html",
      "package.json",
    ]);
  });

  it("ships a production CSP and no hard-coded development path", async () => {
    const html = await readFile(join(packageDirectory, "src", "index.html"), "utf8");
    const main = await readFile(join(packageDirectory, "src", "main.ts"), "utf8");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("connect-src 'self' http: https: data:");
    expect(main).not.toContain("/Users/");
    expect(main).toContain('setWindowOpenHandler(() => ({ action: "deny" }))');
  });

  it("production output excludes renderer source maps from its package whitelist", async () => {
    const files = await readdir(join(packageDirectory, "dist"));
    expect(files).toContain("renderer.js");
    expect(files).toContain("preload.cjs");
  });
});
