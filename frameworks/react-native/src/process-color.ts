/**
 * Upstream React Native processColor implementation.
 * Normalizes color strings (hex, rgb, rgba, hsl, hsla, named colors)
 * and numbers into 32-bit unsigned 0xAARRGGBB integers.
 */

const NAMED_COLORS: Readonly<Record<string, number>> = Object.freeze({
  transparent: 0x00000000,
  aliceblue: 0xfff0f8ff,
  antiquewhite: 0xfffaebd7,
  aqua: 0xff00ffff,
  aquamarine: 0xff7fffd4,
  azure: 0xfff0ffff,
  beige: 0xfff5f5dc,
  bisque: 0xffffe4c4,
  black: 0xff000000,
  blanchedalmond: 0xffffebcd,
  blue: 0xff0000ff,
  blueviolet: 0xff8a2be2,
  brown: 0xffa52a2a,
  burlywood: 0xffdeb887,
  cadetblue: 0xff5f9ea0,
  chartreuse: 0xff7fff00,
  chocolate: 0xffd2691e,
  coral: 0xffff7f50,
  cornflowerblue: 0xff6495ed,
  cornsilk: 0xfffff8dc,
  crimson: 0xffdc143c,
  cyan: 0xff00ffff,
  darkblue: 0xff00008b,
  darkcyan: 0xff008b8b,
  darkgoldenrod: 0xffb8860b,
  darkgray: 0xffa9a9a9,
  darkgreen: 0xff006400,
  darkgrey: 0xffa9a9a9,
  darkkhaki: 0xffbdb76b,
  darkmagenta: 0xff8b008b,
  darkolivegreen: 0xff556b2f,
  darkorange: 0xffff8c00,
  darkorchid: 0xff9932cc,
  darkred: 0xff8b0000,
  darksalmon: 0xffe9967a,
  darkseagreen: 0xff8fbc8f,
  darkslateblue: 0xff483d8b,
  darkslategray: 0xff2f4f4f,
  darkslategrey: 0xff2f4f4f,
  darkturquoise: 0xff00ced1,
  darkviolet: 0xff9400d3,
  deeppink: 0xffff1493,
  deepskyblue: 0xff00bfff,
  dimgray: 0xff696969,
  dimgrey: 0xff696969,
  dodgerblue: 0xff1e90ff,
  firebrick: 0xffb22222,
  floralwhite: 0xfffffaf0,
  forestgreen: 0xff228b22,
  fuchsia: 0xffff00ff,
  gainsboro: 0xffdcdcdc,
  ghostwhite: 0xfff8f8ff,
  gold: 0xffffd700,
  goldenrod: 0xffdaa520,
  gray: 0xff808080,
  green: 0xff008000,
  greenyellow: 0xffadff2f,
  grey: 0xff808080,
  honeydew: 0xfff0fff0,
  hotpink: 0xffff69b4,
  indianred: 0xffcd5c5c,
  indigo: 0xff4b0082,
  ivory: 0xfffffff0,
  khaki: 0xfff0e68c,
  lavender: 0xffe6e6fa,
  lavenderblush: 0xfffff0f5,
  lawngreen: 0xff7cfc00,
  lemonchiffon: 0xfffffacd,
  lightblue: 0xffadd8e6,
  lightcoral: 0xfff08080,
  lightcyan: 0xffe0ffff,
  lightgoldenrodyellow: 0xfffafad2,
  lightgray: 0xffd3d3d3,
  lightgreen: 0xff90ee90,
  lightgrey: 0xffd3d3d3,
  lightpink: 0xffffb6c1,
  lightsalmon: 0xffffa07a,
  lightseagreen: 0xff20b2aa,
  lightskyblue: 0xff87cefa,
  lightslategray: 0xff778899,
  lightslategrey: 0xff778899,
  lightsteelblue: 0xffb0c4de,
  lightyellow: 0xffffffe0,
  lime: 0xff00ff00,
  limegreen: 0xff32cd32,
  linen: 0xfffaf0e6,
  magenta: 0xffff00ff,
  maroon: 0xff800000,
  mediumaquamarine: 0xff66cdaa,
  mediumblue: 0xff0000cd,
  mediumorchid: 0xffba55d3,
  mediumpurple: 0xff9370db,
  mediumseagreen: 0xff3cb371,
  mediumslateblue: 0xff7b68ee,
  mediumspringgreen: 0xff00fa9a,
  mediumturquoise: 0xff48d1cc,
  mediumvioletred: 0xffc71585,
  midnightblue: 0xff191970,
  mintcream: 0xfff5fffa,
  mistyrose: 0xffffe4e1,
  moccasin: 0xffffe4b5,
  navajowhite: 0xffffdead,
  navy: 0xff000080,
  oldlace: 0xfffdf5e6,
  olive: 0xff808000,
  olivedrab: 0xff6b8e23,
  orange: 0xffffa500,
  orangered: 0xffff4500,
  orchid: 0xffda70d6,
  palegoldenrod: 0xffeee8aa,
  palegreen: 0xff98fb98,
  paleturquoise: 0xffafeeee,
  palevioletred: 0xffdb7093,
  papayawhip: 0xffffefd5,
  peachpuff: 0xffffdab9,
  peru: 0xffcd853f,
  pink: 0xffffc0cb,
  plum: 0xffdda0dd,
  powderblue: 0xffb0e0e6,
  purple: 0xff800080,
  rebeccapurple: 0xff663399,
  red: 0xffff0000,
  rosybrown: 0xffbc8f8f,
  royalblue: 0xff4169e1,
  saddlebrown: 0xff8b4513,
  salmon: 0xfffa8072,
  sandybrown: 0xfff4a460,
  seagreen: 0xff2e8b57,
  seashell: 0xfffff5ee,
  sienna: 0xffa0522d,
  silver: 0xffc0c0c0,
  skyblue: 0xff87ceeb,
  slateblue: 0xff6a5acd,
  slategray: 0xff708090,
  slategrey: 0xff708090,
  snow: 0xfffffafa,
  springgreen: 0xff00ff7f,
  steelblue: 0xff4682b4,
  tan: 0xffd2b48c,
  teal: 0xff008080,
  thistle: 0xffd8bfd8,
  tomato: 0xffff6347,
  turquoise: 0xff40e0d0,
  violet: 0xffee82ee,
  wheat: 0xfff5deb3,
  white: 0xffffffff,
  whitesmoke: 0xfff5f5f5,
  yellow: 0xffffff00,
  yellowgreen: 0xff9acd32,
});

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseUnit(val: string): number {
  if (val.endsWith("%")) {
    return Number.parseFloat(val) / 100;
  }
  return Number.parseFloat(val);
}

function parseByteOrPercent(val: string): number {
  if (val.endsWith("%")) {
    return clampByte((Number.parseFloat(val) / 100) * 255);
  }
  return clampByte(Number.parseFloat(val));
}

function parseAlpha(val: string | undefined): number {
  if (val === undefined) return 255;
  if (val.endsWith("%")) {
    return clampByte((Number.parseFloat(val) / 100) * 255);
  }
  const num = Number.parseFloat(val);
  if (num <= 1) {
    return clampByte(num * 255);
  }
  return clampByte(num);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const normH = ((h % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(1, s));
  const normL = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * normL - 1)) * normS;
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (normH >= 0 && normH < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (normH >= 60 && normH < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (normH >= 120 && normH < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (normH >= 180 && normH < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (normH >= 240 && normH < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

function toAarrggbb(alpha: number, red: number, green: number, blue: number): number {
  return ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

/**
 * Normalizes any valid CSS / React Native color value to an 0xAARRGGBB integer.
 * Matches upstream React Native's `processColor` function.
 */
export function processColor(
  color: string | number | null | undefined,
): number | null | undefined {
  if (color === null) return null;
  if (color === undefined) return undefined;

  if (typeof color === "number") {
    // If it's already within 32-bit int range, normalize via >>> 0
    if (Number.isFinite(color)) {
      return color >>> 0;
    }
    return undefined;
  }

  if (typeof color !== "string") {
    return undefined;
  }

  const trimmed = color.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  // 1. Named color check
  const named = NAMED_COLORS[trimmed];
  if (named !== undefined) {
    return named >>> 0;
  }

  // 2. Hex color check
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    // #RGB
    if (hex.length === 3 && /^[0-9a-f]{3}$/.test(hex)) {
      const r = Number.parseInt(hex.charAt(0).repeat(2), 16);
      const g = Number.parseInt(hex.charAt(1).repeat(2), 16);
      const b = Number.parseInt(hex.charAt(2).repeat(2), 16);
      return toAarrggbb(255, r, g, b);
    }
    // #RGBA
    if (hex.length === 4 && /^[0-9a-f]{4}$/.test(hex)) {
      const r = Number.parseInt(hex.charAt(0).repeat(2), 16);
      const g = Number.parseInt(hex.charAt(1).repeat(2), 16);
      const b = Number.parseInt(hex.charAt(2).repeat(2), 16);
      const a = Number.parseInt(hex.charAt(3).repeat(2), 16);
      return toAarrggbb(a, r, g, b);
    }
    // #RRGGBB
    if (hex.length === 6 && /^[0-9a-f]{6}$/.test(hex)) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return toAarrggbb(255, r, g, b);
    }
    // #RRGGBBAA
    if (hex.length === 8 && /^[0-9a-f]{8}$/.test(hex)) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = Number.parseInt(hex.slice(6, 8), 16);
      return toAarrggbb(a, r, g, b);
    }
    return undefined;
  }

  // 3. rgb() / rgba() check
  const rgbMatch =
    /^rgba?\(\s*([^\s,/]+)\s*[,/ ]\s*([^\s,/]+)\s*[,/ ]\s*([^\s,/]+)(?:\s*[,/ ]\s*([^\s,/]+))?\s*\)$/.exec(
      trimmed,
    );
  if (rgbMatch !== null) {
    const r = parseByteOrPercent(rgbMatch[1] ?? "0");
    const g = parseByteOrPercent(rgbMatch[2] ?? "0");
    const b = parseByteOrPercent(rgbMatch[3] ?? "0");
    const a = parseAlpha(rgbMatch[4]);
    return toAarrggbb(a, r, g, b);
  }

  // 4. hsl() / hsla() check
  const hslMatch =
    /^hsla?\(\s*([\d.-]+(?:deg)?)\s*[,/ ]\s*([\d.-]+%?)\s*[,/ ]\s*([\d.-]+%?)(?:\s*[,/ ]\s*([^\s,/]+))?\s*\)$/.exec(
      trimmed,
    );
  if (hslMatch !== null) {
    const rawH = hslMatch[1] ?? "0";
    const h = Number.parseFloat(rawH.replace("deg", ""));
    const s = parseUnit(hslMatch[2] ?? "0");
    const l = parseUnit(hslMatch[3] ?? "0");
    const a = parseAlpha(hslMatch[4]);
    const [r, g, b] = hslToRgb(h, s, l);
    return toAarrggbb(a, r, g, b);
  }

  return undefined;
}
