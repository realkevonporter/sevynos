import { describe, expect, it } from "vitest";
import {
  buildSevynApplicationPackage,
  verifyPackageIntegrity,
} from "@sevynos/react-native";
import { NotesApplication, notesManifest } from "./index.js";

describe("third-party Notes application", () => {
  it("uses a valid public manifest and produces an installable package", async () => {
    expect(NotesApplication).toBeTypeOf("function");
    const applicationPackage = await buildSevynApplicationPackage({
      manifest: notesManifest,
      files: { "dist/index.js": "export const NotesApplication = () => null;" },
      icons: { "icons/notes.svg": "<svg/>" },
    });
    await expect(verifyPackageIntegrity(applicationPackage)).resolves.toBeUndefined();
    expect(applicationPackage.manifest.instanceMode).toBe("multiple");
  });
});

describe("application icon asset", () => {
  it("ships the manifest-declared icon file", async () => {
    const { existsSync } = await import("node:fs");
    const iconUrl = new URL(`../${notesManifest.icon}`, import.meta.url);
    expect(existsSync(iconUrl)).toBe(true);
  });
});
