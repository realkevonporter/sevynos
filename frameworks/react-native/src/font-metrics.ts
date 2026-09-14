import { sevynTokens } from "./tokens.js";

/**
 * DejaVu Sans proportional glyph advance ratios (advance / fontSize).
 * Derived from the DejaVu Sans TrueType metric tables (unitsPerEm = 2048).
 */
export const DEJAVU_SANS_GLYPH_RATIOS: Readonly<Record<string, number>> = Object.freeze({
  " ": 0.318,
  "!": 0.324,
  '"': 0.413,
  "#": 0.834,
  $: 0.605,
  "%": 0.945,
  "&": 0.772,
  "'": 0.244,
  "(": 0.379,
  ")": 0.379,
  "*": 0.433,
  "+": 0.834,
  ",": 0.318,
  "-": 0.362,
  ".": 0.318,
  "/": 0.413,
  // Monospaced tabular digits in DejaVu Sans
  "0": 0.605,
  "1": 0.605,
  "2": 0.605,
  "3": 0.605,
  "4": 0.605,
  "5": 0.605,
  "6": 0.605,
  "7": 0.605,
  "8": 0.605,
  "9": 0.605,
  ":": 0.318,
  ";": 0.318,
  "<": 0.834,
  "=": 0.834,
  ">": 0.834,
  "?": 0.547,
  "@": 0.995,
  // Uppercase
  A: 0.683,
  B: 0.677,
  C: 0.706,
  D: 0.745,
  E: 0.644,
  F: 0.597,
  G: 0.766,
  H: 0.772,
  I: 0.288,
  J: 0.48,
  K: 0.69,
  L: 0.585,
  M: 0.927,
  N: 0.772,
  O: 0.781,
  P: 0.646,
  Q: 0.781,
  R: 0.697,
  S: 0.635,
  T: 0.633,
  U: 0.747,
  V: 0.671,
  W: 0.976,
  X: 0.671,
  Y: 0.655,
  Z: 0.629,
  "[": 0.379,
  "\\": 0.413,
  "]": 0.379,
  "^": 0.547,
  _: 0.5,
  "`": 0.362,
  // Lowercase
  a: 0.613,
  b: 0.635,
  c: 0.547,
  d: 0.635,
  e: 0.606,
  f: 0.349,
  g: 0.635,
  h: 0.638,
  i: 0.277,
  j: 0.277,
  k: 0.588,
  l: 0.277,
  m: 0.971,
  n: 0.638,
  o: 0.613,
  p: 0.635,
  q: 0.635,
  r: 0.402,
  s: 0.522,
  t: 0.37,
  u: 0.638,
  v: 0.553,
  w: 0.823,
  x: 0.553,
  y: 0.553,
  z: 0.516,
  "{": 0.379,
  "|": 0.277,
  "}": 0.379,
  "~": 0.547,
  // Common symbols and punctuation
  "•": 0.318,
  "…": 0.825,
  "—": 1.0,
  "–": 0.605,
  "·": 0.318,
  "→": 0.834,
  "←": 0.834,
  "↑": 0.834,
  "↓": 0.834,
  "✓": 0.725,
  "×": 0.605,
  "●": 0.725,
  "○": 0.725,
  "◇": 0.725,
  "⌂": 0.834,
  "⟳": 0.834,
  "◀": 0.834,
  "▶": 0.834,
  "⚡": 1.0,
  "⚙": 1.0,
  "📁": 1.0,
  "💻": 1.0,
  "🌐": 1.0,
  "✨": 1.0,
  "🚀": 1.0,
  "🏷": 1.0,
  "🗑": 1.0,
  "⌨": 1.0,
  "➕": 1.0,
  "➖": 1.0,
  "▌": 0.5,
});

export interface TextMeasurementOptions {
  readonly weight?: number | string | undefined;
  readonly letterSpacing?: number | undefined;
  readonly fontFamily?: string | undefined;
  readonly lineHeight?: number | undefined;
}

export interface MeasuredTextResult {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly string[];
}

function resolveWeightFactor(weight: number | string | undefined): number {
  if (typeof weight === "string") {
    if (weight === "bold" || weight === "700" || weight === "800" || weight === "900")
      return 1.08;
    if (weight === "600") return 1.05;
    if (weight === "500") return 1.025;
    return 1.0;
  }
  if (typeof weight === "number") {
    if (weight >= 700) return 1.08;
    if (weight >= 600) return 1.05;
    if (weight >= 500) return 1.025;
    return 1.0;
  }
  return 1.0;
}

export function getCharacterAdvance(
  character: string,
  fontSize: number,
  options?: TextMeasurementOptions,
): number {
  if (character === "\uFE0F" || character === "\uFE0E" || character === "\u200D") {
    return 0;
  }
  const ratio =
    DEJAVU_SANS_GLYPH_RATIOS[character] ??
    (character.charCodeAt(0) >= 0x4e00 && character.charCodeAt(0) <= 0x9fff
      ? 1.0
      : character.toUpperCase() === character && character.toLowerCase() !== character
        ? 0.72
        : 0.605);

  const weightFactor = resolveWeightFactor(options?.weight);
  const letterSpacing = options?.letterSpacing ?? 0;
  return Math.round(fontSize * ratio * weightFactor) + letterSpacing;
}

const WIDTH_CACHE = new Map<string, number>();
const MAX_CACHE_ENTRIES = 5000;

export function measureTextWidth(
  text: string,
  fontSize: number,
  options?: TextMeasurementOptions,
): number {
  if (text.length === 0) return 0;
  const weight = options?.weight ?? 400;
  const letterSpacing = options?.letterSpacing ?? 0;
  const fontFamily = options?.fontFamily ?? "default";
  const cacheKey = `${fontFamily}:${String(fontSize)}:${String(weight)}:${String(letterSpacing)}:${text}`;

  const cached = WIDTH_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let width = 0;
  for (const character of text) {
    width += getCharacterAdvance(character, fontSize, options);
  }

  if (WIDTH_CACHE.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest entries
    const keys = WIDTH_CACHE.keys();
    for (let i = 0; i < 500; i++) {
      const nextKey = keys.next().value;
      if (nextKey !== undefined) WIDTH_CACHE.delete(nextKey);
    }
  }

  WIDTH_CACHE.set(cacheKey, width);
  return width;
}

export function wrapTextToLines(
  text: string,
  fontSize: number,
  maxWidth: number,
  options?: TextMeasurementOptions,
): readonly string[] {
  if (text.length === 0) return [""];
  if (maxWidth <= 0) return [""];

  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      const wordWidth = measureTextWidth(word, fontSize, options);

      if (wordWidth > maxWidth) {
        if (currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = "";
        }
        let chunk = "";
        for (const char of word) {
          const chunkCandidate = `${chunk}${char}`;
          if (
            measureTextWidth(chunkCandidate, fontSize, options) <= maxWidth ||
            chunk.length === 0
          ) {
            chunk = chunkCandidate;
          } else {
            lines.push(chunk);
            chunk = char;
          }
        }
        currentLine = chunk;
        continue;
      }

      const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
      const candidateWidth = measureTextWidth(candidate, fontSize, options);

      if (candidateWidth <= maxWidth) {
        currentLine = candidate;
      } else {
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines.length === 0 ? [""] : lines;
}

const MEASURE_CACHE = new Map<string, MeasuredTextResult>();

export function measureNativeText(
  text: string,
  fontSize: number = sevynTokens.typography.body.size,
  maxWidth: number = Number.POSITIVE_INFINITY,
  options?: TextMeasurementOptions,
): MeasuredTextResult {
  const safeText = text;
  const weight = options?.weight ?? 400;
  const letterSpacing = options?.letterSpacing ?? 0;
  const fontFamily = options?.fontFamily ?? "default";
  const lineHeight = options?.lineHeight ?? Math.round(fontSize * 1.4);
  const cacheKey = `${fontFamily}:${String(fontSize)}:${String(weight)}:${String(letterSpacing)}:${String(lineHeight)}:${String(maxWidth)}:${safeText}`;

  const cached = MEASURE_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: MeasuredTextResult;

  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    const singleLineWidth = measureTextWidth(safeText, fontSize, options);
    if (singleLineWidth <= maxWidth && !safeText.includes("\n")) {
      result = Object.freeze({
        width: singleLineWidth,
        height: lineHeight,
        lines: Object.freeze([safeText]),
      });
    } else {
      const lines = wrapTextToLines(safeText, fontSize, maxWidth, options);
      let maxLineWidth = 0;
      for (const line of lines) {
        maxLineWidth = Math.max(maxLineWidth, measureTextWidth(line, fontSize, options));
      }
      result = Object.freeze({
        width: Math.min(maxWidth, maxLineWidth),
        height: Math.max(lineHeight, lines.length * lineHeight),
        lines: Object.freeze(lines),
      });
    }
  } else if (safeText.includes("\n")) {
    const lines = safeText.split("\n");
    let maxLineWidth = 0;
    for (const line of lines) {
      maxLineWidth = Math.max(maxLineWidth, measureTextWidth(line, fontSize, options));
    }
    result = Object.freeze({
      width: maxLineWidth,
      height: Math.max(lineHeight, lines.length * lineHeight),
      lines: Object.freeze(lines),
    });
  } else {
    const singleLineWidth = measureTextWidth(safeText, fontSize, options);
    result = Object.freeze({
      width: singleLineWidth,
      height: lineHeight,
      lines: Object.freeze([safeText]),
    });
  }

  if (MEASURE_CACHE.size >= MAX_CACHE_ENTRIES) {
    const keys = MEASURE_CACHE.keys();
    for (let i = 0; i < 500; i++) {
      const nextKey = keys.next().value;
      if (nextKey !== undefined) MEASURE_CACHE.delete(nextKey);
    }
  }

  MEASURE_CACHE.set(cacheKey, result);
  return result;
}

export function clearFontMetricsCache(): void {
  WIDTH_CACHE.clear();
  MEASURE_CACHE.clear();
}
