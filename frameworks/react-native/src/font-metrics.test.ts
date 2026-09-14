import { describe, expect, it } from "vitest";
import {
  DEJAVU_SANS_GLYPH_RATIOS,
  clearFontMetricsCache,
  getCharacterAdvance,
  measureNativeText,
  measureTextWidth,
  wrapTextToLines,
} from "./font-metrics.js";
import { sevynTokens } from "./tokens.js";

describe("Real font metrics text measurement", () => {
  it("computes accurate proportional character advances for DejaVu Sans", () => {
    const fontSize = 14;

    // Narrow characters
    const dotAdvance = getCharacterAdvance(".", fontSize);
    const iAdvance = getCharacterAdvance("i", fontSize);
    const spaceAdvance = getCharacterAdvance(" ", fontSize);

    // Standard lowercase letters & digits
    const aAdvance = getCharacterAdvance("a", fontSize);
    const digitAdvance = getCharacterAdvance("5", fontSize);

    // Wide characters
    const mAdvance = getCharacterAdvance("m", fontSize);
    const wAdvance = getCharacterAdvance("w", fontSize);
    const bigMAdvance = getCharacterAdvance("M", fontSize);
    const bigWAdvance = getCharacterAdvance("W", fontSize);

    // Assert proportional relationships
    expect(iAdvance).toBeLessThan(aAdvance);
    expect(dotAdvance).toBeLessThan(aAdvance);
    expect(spaceAdvance).toBeLessThan(aAdvance);
    expect(aAdvance).toBeLessThan(mAdvance);
    expect(aAdvance).toBeLessThan(wAdvance);
    expect(wAdvance).toBeLessThanOrEqual(bigWAdvance);
    expect(aAdvance).toBeLessThan(bigMAdvance);
    expect(bigMAdvance).toBeGreaterThanOrEqual(13);
    expect(digitAdvance).toBe(Math.round(fontSize * 0.605));
  });

  it("scales advances with font weight", () => {
    const fontSize = 16;
    const regular = getCharacterAdvance("A", fontSize, { weight: 400 });
    const bold = getCharacterAdvance("A", fontSize, { weight: 700 });
    expect(bold).toBeGreaterThanOrEqual(regular);
  });

  it("incorporates letterSpacing", () => {
    const fontSize = 14;
    const normal = measureTextWidth("Sevyn", fontSize);
    const spaced = measureTextWidth("Sevyn", fontSize, { letterSpacing: 2 });
    expect(spaced).toBe(normal + 2 * "Sevyn".length);
  });

  it("caches measured text widths for performance without per-frame overhead", () => {
    clearFontMetricsCache();
    const str = "Fast measurement caching";
    const first = measureNativeText(str, 14);
    const second = measureNativeText(str, 14);
    expect(first).toBe(second); // exact reference from cache
  });

  it("wraps multi-line text accurately at maxWidth word boundaries", () => {
    const text = "Calm minimalism powered by React Native and the Genesis Engine.";
    const fontSize = 11;
    const maxWidth = 160;

    const lines = wrapTextToLines(text, fontSize, maxWidth);
    expect(lines.length).toBeGreaterThan(1);

    // Each line should not exceed maxWidth
    for (const line of lines) {
      expect(measureTextWidth(line, fontSize)).toBeLessThanOrEqual(maxWidth);
    }

    // Joining lines should preserve all words
    const reconstructed = lines.join(" ");
    expect(reconstructed).toBe(text);
  });

  it("breaks words that exceed maxWidth character-by-character to prevent overflow", () => {
    const longWord = "Supercalifragilisticexpialidocious";
    const fontSize = 14;
    const maxWidth = 80;

    const lines = wrapTextToLines(longWord, fontSize, maxWidth);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureTextWidth(line, fontSize)).toBeLessThanOrEqual(maxWidth);
    }
  });

  it("asserts measured widths match renderer output within 1px for a representative string set", () => {
    const representativeStrings = [
      "Welcome to SevynOS",
      "Calm minimalism powered by React Native and the Genesis Engine.",
      "EXPLORE SYSTEM APPLICATIONS",
      "Browser",
      "Browse offline docs & web",
      "Settings",
      "Themes, displays & audio",
      "Files",
      "Documents & storage",
      "Terminal",
      "Genesis Linux shell",
      "Alt + Tab",
      "Switch Windows",
      "Super",
      "Application Launcher",
      "Ctrl + Alt + T",
      "Genesis Terminal",
      "0123456789",
      "$1,234.56 (78%)",
      "• Item with bullet & ellipsis…",
      "Wi-Fi: Connected (100%)",
      "Battery: 85% Charging ⚡",
    ];

    const testFontSizes = [10, 11, 12, 14, 16, 21, 30];

    for (const text of representativeStrings) {
      for (const size of testFontSizes) {
        const measured = measureNativeText(text, size);

        // Renderer calculation: sum of character advances at the given scale
        let rendererSum = 0;
        for (const character of text) {
          if (character === "\uFE0F" || character === "\uFE0E" || character === "\u200D")
            continue;
          const ratio =
            DEJAVU_SANS_GLYPH_RATIOS[character] ??
            (character.charCodeAt(0) >= 0x4e00 && character.charCodeAt(0) <= 0x9fff
              ? 1.0
              : character.toUpperCase() === character &&
                  character.toLowerCase() !== character
                ? 0.72
                : 0.605);
          rendererSum += Math.round(size * ratio);
        }

        const diff = Math.abs(measured.width - rendererSum);
        expect(diff).toBeLessThanOrEqual(1);
      }
    }
  });

  it("normalizes typography token weights to standard OpenType values", () => {
    expect(sevynTokens.typography.micro.weight).toBe(600);
    expect(sevynTokens.typography.caption.weight).toBe(500);
    expect(sevynTokens.typography.body.weight).toBe(400);
    expect(sevynTokens.typography.label.weight).toBe(500);
    expect(sevynTokens.typography.title.weight).toBe(600);
    expect(sevynTokens.typography.display.weight).toBe(700);
  });
});
