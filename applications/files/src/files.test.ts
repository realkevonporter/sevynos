import { describe, expect, it } from "vitest";
import { filesManifest } from "./index.js";

describe("FilesApplication", () => {
  it("exports a valid SevynApplicationManifest", () => {
    expect(filesManifest.id).toBe("org.sevynos.files");
    expect(filesManifest.name).toBe("File Manager");
    expect(filesManifest.runtime).toBe("react-native");
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${filesManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
