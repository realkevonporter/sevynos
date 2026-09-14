export type SevynAppearance = "light" | "dark";
export type SevynAccent = string;

export interface SevynSemanticColors {
  readonly canvas: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly material: string;
  readonly materialStrong: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly border: string;
  readonly separator: string;
  readonly focus: string;
  readonly accent: string;
  readonly accentText: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly shadow: string;
}

const accents: Readonly<Record<string, string>> = Object.freeze({
  gold: "#D7AC57",
  azure: "#669DEB",
  verdant: "#52AE82",
  rose: "#D77598",
});

export const sevynTokens = Object.freeze({
  accent: accents,
  spacing: Object.freeze({ xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 }),
  radius: Object.freeze({ xs: 6, sm: 10, md: 14, lg: 20, xl: 28 }),
  typography: Object.freeze({
    micro: Object.freeze({ size: 10, lineHeight: 14, weight: 600 }),
    caption: Object.freeze({ size: 12, lineHeight: 17, weight: 500 }),
    body: Object.freeze({ size: 14, lineHeight: 21, weight: 400 }),
    label: Object.freeze({ size: 14, lineHeight: 20, weight: 500 }),
    title: Object.freeze({ size: 21, lineHeight: 28, weight: 600 }),
    display: Object.freeze({ size: 30, lineHeight: 38, weight: 700 }),
  }),
  border: Object.freeze({ hairline: 0.5, standard: 1, focus: 2 }),
  shadow: Object.freeze({
    low: Object.freeze({ blur: 12, y: 4, opacity: 0.18 }),
    high: Object.freeze({ blur: 28, y: 12, opacity: 0.3 }),
  }),
  material: Object.freeze({
    subtle: Object.freeze({ opacity: 0.72, blur: 14 }),
    regular: Object.freeze({ opacity: 0.84, blur: 22 }),
    strong: Object.freeze({ opacity: 0.94, blur: 30 }),
  }),
  motion: Object.freeze({
    instant: 0,
    quick: 110,
    standard: 190,
    deliberate: 310,
    spring: Object.freeze({ mass: 1, stiffness: 360, damping: 32 }),
  }),
  cursor: Object.freeze({ defaultSize: 1, focusRingOffset: 3 }),
});

export function resolveAccent(accent: SevynAccent): string {
  if (accent.startsWith("#")) return accent;
  return accents[accent] ?? "#D7AC57";
}

export function resolveSevynColors(
  appearance: SevynAppearance,
  accent: SevynAccent = "gold",
): SevynSemanticColors {
  const accentColor = resolveAccent(accent);
  return appearance === "light"
    ? Object.freeze({
        canvas: "#E9ECF2",
        surface: "#F6F7FA",
        surfaceRaised: "#FFFFFF",
        material: "rgba(255,255,255,0.70)",
        materialStrong: "rgba(255,255,255,0.90)",
        text: "#1C1D21",
        textSecondary: "#5C6069",
        textMuted: "#858A94",
        border: "rgba(30,33,40,0.12)",
        separator: "rgba(30,33,40,0.08)",
        focus: accentColor,
        accent: accentColor,
        accentText: "#19140A",
        success: "#267B54",
        warning: "#A96819",
        danger: "#B64650",
        shadow: "rgba(26,31,43,0.20)",
      })
    : Object.freeze({
        canvas: "#0B0C10",
        surface: "#17181D",
        surfaceRaised: "#202127",
        material: "rgba(31,32,39,0.74)",
        materialStrong: "rgba(38,39,47,0.92)",
        text: "#F4F4F6",
        textSecondary: "#C0C1C7",
        textMuted: "#898B94",
        border: "rgba(255,255,255,0.13)",
        separator: "rgba(255,255,255,0.085)",
        focus: accentColor,
        accent: accentColor,
        accentText: "#19140A",
        success: "#67C695",
        warning: "#E5AE62",
        danger: "#ED7780",
        shadow: "rgba(0,0,0,0.52)",
      });
}

export function motionDuration(duration: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : duration;
}
