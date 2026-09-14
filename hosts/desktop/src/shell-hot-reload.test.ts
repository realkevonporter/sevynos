import { describe, expect, it } from "vitest";
import {
  createSystemApplicationModuleUrl,
  resolveSystemApplicationModule,
} from "./shell-hot-reload.js";

describe("desktop shell hot reload", () => {
  it("selects the matching application from an isolated bundle", () => {
    const application = {
      manifest: { id: "org.sevynos.shell.dock" },
      create: () => ({}),
    };
    expect(
      resolveSystemApplicationModule("org.sevynos.shell.dock", { application }),
    ).toBe(application);
  });

  it("cache-busts a local application module without accepting path traversal", () => {
    expect(
      createSystemApplicationModuleUrl(
        "file:///sevyn/dist/renderer.js",
        "org.sevynos.shell.dock",
        4,
      ),
    ).toBe("file:///sevyn/dist/system-applications/org.sevynos.shell.dock.js?revision=4");
    expect(() =>
      createSystemApplicationModuleUrl("file:///sevyn/dist/renderer.js", "../../dock", 4),
    ).toThrow(/Invalid/);
  });
});
