/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { describe, expect, it } from "vitest";
import {
  iconGlyphForManifestIcon,
  tileColorForApplication,
} from "./application-icons.js";

describe("application icon mapping", () => {
  it("maps every shipped manifest icon to its vector glyph", () => {
    expect(iconGlyphForManifestIcon("icons/browser.svg")).toBe("app-browser");
    expect(iconGlyphForManifestIcon("icons/calculator.svg")).toBe("app-calculator");
    expect(iconGlyphForManifestIcon("icons/camera.svg")).toBe("app-camera");
    expect(iconGlyphForManifestIcon("icons/files.svg")).toBe("app-files");
    expect(iconGlyphForManifestIcon("icons/music.svg")).toBe("app-music");
    expect(iconGlyphForManifestIcon("icons/notes.svg")).toBe("app-notes");
    expect(iconGlyphForManifestIcon("icons/settings.svg")).toBe("app-settings");
    expect(iconGlyphForManifestIcon("icons/sevyn-code.svg")).toBe("app-sevyn-code");
    expect(iconGlyphForManifestIcon("icons/store.svg")).toBe("app-store");
    expect(iconGlyphForManifestIcon("icons/system-monitor.svg")).toBe(
      "app-system-monitor",
    );
    expect(iconGlyphForManifestIcon("icons/terminal.svg")).toBe("app-terminal");
    expect(iconGlyphForManifestIcon("icons/text-editor.svg")).toBe("app-text-editor");
    expect(iconGlyphForManifestIcon("icons/welcome.svg")).toBe("app-welcome");
  });

  it("falls back to undefined for unknown or missing icons", () => {
    expect(iconGlyphForManifestIcon(undefined)).toBeUndefined();
    expect(iconGlyphForManifestIcon("icons/third-party.svg")).toBeUndefined();
  });

  it("resolves brand tile colors with accent and shell fallbacks", () => {
    expect(tileColorForApplication("org.sevynos.browser", undefined, "#000000")).toBe(
      "#1D9BF0",
    );
    expect(tileColorForApplication("org.sevynos.store", undefined, "#000000")).toBe(
      "#6869EE",
    );
    expect(tileColorForApplication("org.sevynos.unknown", "#123456", "#000000")).toBe(
      "#123456",
    );
    expect(tileColorForApplication("org.sevynos.unknown", undefined, "#000000")).toBe(
      "#000000",
    );
  });
});
