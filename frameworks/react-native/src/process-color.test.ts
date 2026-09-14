import { describe, expect, it } from "vitest";
import { processColor } from "./process-color.js";

describe("processColor (upstream React Native specification)", () => {
  it("handles null and undefined", () => {
    expect(processColor(null)).toBeNull();
    expect(processColor(undefined)).toBeUndefined();
    expect(processColor("")).toBeUndefined();
    expect(processColor("not-a-valid-color")).toBeUndefined();
  });

  it("normalizes standard named colors to 0xAARRGGBB", () => {
    // Red: alpha 0xFF, red 0xFF, green 0x00, blue 0x00 -> 0xFFFF0000 -> 4294901760
    expect(processColor("red")).toBe(0xffff0000 >>> 0);
    // Green: CSS green is #008000 -> alpha 0xFF, red 0, green 0x80, blue 0 -> 0xFF008000 -> 4278222848
    expect(processColor("green")).toBe(0xff008000 >>> 0);
    // Lime: #00FF00 -> 0xFF00FF00
    expect(processColor("lime")).toBe(0xff00ff00 >>> 0);
    // Blue: #0000FF -> 0xFF0000FF
    expect(processColor("blue")).toBe(0xff0000ff >>> 0);
    // Black: #000000 -> 0xFF000000
    expect(processColor("black")).toBe(0xff000000 >>> 0);
    // White: #FFFFFF -> 0xFFFFFFFF
    expect(processColor("white")).toBe(0xffffffff >>> 0);
    // Transparent: 0x00000000
    expect(processColor("transparent")).toBe(0);
  });

  it("normalizes hex colors in all formats (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)", () => {
    // #RGB: #f00 -> red
    expect(processColor("#f00")).toBe(0xffff0000 >>> 0);
    // #RGBA: #f008 -> red with 0x88 alpha
    expect(processColor("#f008")).toBe(0x88ff0000 >>> 0);
    // #RRGGBB: #123456
    expect(processColor("#123456")).toBe(0xff123456 >>> 0);
    // #RRGGBBAA: #12345678
    expect(processColor("#12345678")).toBe(0x78123456 >>> 0);
    // Case insensitivity
    expect(processColor("#AABBCC")).toBe(0xffaabbcc >>> 0);
  });

  it("normalizes rgb() and rgba() function values", () => {
    expect(processColor("rgb(255, 0, 0)")).toBe(0xffff0000 >>> 0);
    expect(processColor("rgba(255, 0, 0, 1)")).toBe(0xffff0000 >>> 0);
    // 50% opacity -> 128 (0x80)
    expect(processColor("rgba(0, 255, 0, 0.5)")).toBe(0x8000ff00 >>> 0);
    // Percentage components
    expect(processColor("rgb(100%, 0%, 0%)")).toBe(0xffff0000 >>> 0);
    expect(processColor("rgba(0%, 0%, 100%, 50%)")).toBe(0x800000ff >>> 0);
  });

  it("normalizes hsl() and hsla() function values", () => {
    // Red: hsl(0, 100%, 50%)
    expect(processColor("hsl(0, 100%, 50%)")).toBe(0xffff0000 >>> 0);
    // Green: hsl(120, 100%, 50%)
    expect(processColor("hsl(120, 100%, 50%)")).toBe(0xff00ff00 >>> 0);
    // Blue with opacity
    expect(processColor("hsla(240, 100%, 50%, 0.5)")).toBe(0x800000ff >>> 0);
  });

  it("normalizes numeric color inputs", () => {
    expect(processColor(0xffff0000)).toBe(0xffff0000 >>> 0);
    expect(processColor(-65536)).toBe(0xffff0000 >>> 0);
    expect(processColor(0)).toBe(0);
  });
});
