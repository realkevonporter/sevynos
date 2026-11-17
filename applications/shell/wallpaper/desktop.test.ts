/* eslint-disable no-restricted-imports */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SevynApplicationRuntime } from "@sevynos/react-native/internal";
import { DesktopWallpaper, wallpaperVariantFor } from "./desktop.js";

describe("wallpaperVariantFor", () => {
  it("keeps the signature gradient as the default variant", () => {
    const variant = wallpaperVariantFor(undefined, undefined);
    expect(variant.background).toBe("#06080F");
    expect(variant.auras).toHaveLength(3);
    expect(variant.horizon).toBe(true);
    expect(variant.grain).toBe(true);
  });

  it("renders a flat chosen color for the solid variant", () => {
    const variant = wallpaperVariantFor("solid", "#312E81");
    expect(variant).toMatchObject({
      background: "#312E81",
      horizon: false,
      grain: false,
    });
    expect(variant.auras).toHaveLength(0);
  });

  it("repairs an invalid solid color to the default night color", () => {
    expect(wallpaperVariantFor("solid", "not-a-color").background).toBe("#090b11");
    expect(wallpaperVariantFor("solid", undefined).background).toBe("#090b11");
  });

  it("renders cosmic as a second gradient in the same visual language", () => {
    const variant = wallpaperVariantFor("cosmic", undefined);
    expect(variant.background).toBe("#0b0620");
    expect(variant.auras).toHaveLength(3);
    expect(variant.horizon).toBe(true);
    expect(variant.grain).toBe(true);
    expect(variant.auras[0]?.backgroundColor).toContain("217, 70, 239");
  });

  it("renders minimal as a near-flat field with a single faint aura", () => {
    const variant = wallpaperVariantFor("minimal", undefined);
    expect(variant.background).toBe("#090b11");
    expect(variant.auras).toHaveLength(1);
    expect(variant.horizon).toBe(false);
    expect(variant.grain).toBe(false);
  });
});

describe("DesktopWallpaper", () => {
  it("paints the cosmic auras for the cosmic variant", () => {
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    });
    runtime.mount(
      createElement(DesktopWallpaper, {
        displays: [
          {
            id: "display-1",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            taskbarBounds: { x: 0, y: 744, width: 1280, height: 56 },
          },
        ],
        wallpaperStyle: "cosmic",
        wallpaperColor: "#090b11",
      }),
    );
    const materials = runtime.snapshot.commands.filter((cmd) => cmd.kind === "material");
    expect(materials.map((cmd) => ("color" in cmd ? cmd.color : ""))).toContain(
      "rgba(217, 70, 239, 0.22)",
    );
    expect(materials.map((cmd) => ("color" in cmd ? cmd.color : ""))).toContain(
      "#0b0620",
    );
  });

  it("paints a flat color with no auras for the solid variant", () => {
    const runtime = new SevynApplicationRuntime({
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    });
    runtime.mount(
      createElement(DesktopWallpaper, {
        displays: [
          {
            id: "display-1",
            bounds: { x: 0, y: 0, width: 1280, height: 800 },
            taskbarBounds: { x: 0, y: 744, width: 1280, height: 56 },
          },
        ],
        wallpaperStyle: "solid",
        wallpaperColor: "#312E81",
      }),
    );
    const materials = runtime.snapshot.commands.filter((cmd) => cmd.kind === "material");
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ color: "#312E81" });
  });
});
