import { describe, expect, it } from "vitest";
import {
  DESKTOP_VISUAL_METRICS,
  resolveDesktopAppearance,
} from "./desktop-appearance.js";

describe("desktop appearance contract", () => {
  it("provides one immutable dark appearance for Electron and Linux", () => {
    const appearance = resolveDesktopAppearance("dark");

    expect(appearance).toMatchObject({
      mode: "dark",
      background: { start: "#151A28", middle: "#181521", end: "#090B11" },
      window: { focusedTitle: "#F2F2F4" },
      taskbar: { surface: "rgba(28, 29, 36, 0.78)" },
    });
    expect(Object.isFrozen(appearance)).toBe(true);
    expect(Object.isFrozen(appearance.window.focusedShadow)).toBe(true);
  });

  it("provides the matching light appearance and resolves system safely", () => {
    expect(resolveDesktopAppearance("light")).toMatchObject({
      mode: "light",
      background: { start: "#D8E2F0", middle: "#E9E1D8", end: "#B7C7D7" },
      taskbar: { surface: "rgba(249, 250, 252, 0.76)" },
    });
    expect(resolveDesktopAppearance("system")).toBe(resolveDesktopAppearance("dark"));
  });

  it("shares geometry for effects that affect renderer damage", () => {
    expect(DESKTOP_VISUAL_METRICS).toMatchObject({
      titleBarHeight: 46,
      backgroundGridSpacing: 96,
      windowRadius: 16,
      taskbarRadius: 16,
    });
    expect(Object.isFrozen(DESKTOP_VISUAL_METRICS)).toBe(true);
  });
});
