"use strict";
// Design tokens — the ONE shared source (polish surface (a)).
//
// Values transcribed from layout-manifest/tokens.json (the SevynOS
// layout manifest, MANIFEST.md §2). That JSON is the human-readable
// authority; this file is the runnable one. test/tokens-test.js pins
// every value below to the manifest, so the two can never drift.
//
// Form: plain CommonJS, like the rest of this directory
// (sevyn-renderer.js, context-menu.js). The mechanics force it:
//   - The renderer tests run under plain node
//     (node test/renderer-test.js, require("../sevyn-renderer")) —
//     a .ts source cannot be required there.
//   - The apps/shell tsconfigs use moduleResolution "bundler" with
//     allowJs false, noEmit, and NO resolveJsonModule — TS cannot
//     import the manifest JSON directly, and a .ts source would sit
//     outside their include: ["src"].
//   - The apps/shell builds are esbuild bundles over the .js files
//     (see v2/apps/build-app.mjs, v2/shell/build-shell.mjs), which
//     bundle a CJS require("./tokens") with no change.
// TS consumers import the shape from ./tokens.d.ts, the same
// JS + .d.ts split context-menu.js / sevyn-renderer.js already use.
//
// The object is deep-frozen: one source, read-only, shared by the
// renderer, the apps, and the shell. Later polish surfaces migrate
// their own files' literals to reads from here; this PR wires only
// the shared renderer layer itself (context-menu.js, sevyn-renderer.js)
// and changes NO values — where the manifest's value differs from
// today's code (e.g. menu rowHeight 28 vs the current 32), the
// literal stays until that surface's PR changes it.
//
//   const { tokens } = require("./tokens");
//   const { tokens } = require("../../rn/renderer/tokens"); // TSX

const tokens = {
  accent: {
    accents: {
      coral: {
        dark: "#FF8563",
        light: "#FF6B4A",
        name: "Coral",
        onFill: { dark: "#14141A", light: "#000000" },
        textLight: "#B24B34",
      },
      neutral: {
        dark: "#FAFAFA",
        light: "#14141A",
        name: "Neutral",
        onFill: { dark: "#14141A", light: "#FFFFFF" },
        textLight: "#14141A",
      },
      rose: {
        dark: "#F472A0",
        light: "#E84A7A",
        name: "Rose",
        onFill: { dark: "#14141A", light: "#000000" },
        textLight: "#A23455",
      },
      sky: {
        dark: "#38BDF8",
        light: "#0284C7",
        name: "Sky",
        onFill: { dark: "#14141A", light: "#000000" },
        textLight: "#015C8B",
      },
      teal: {
        dark: "#2EC4C4",
        light: "#0EA5A5",
        name: "Teal",
        onFill: { dark: "#14141A", light: "#000000" },
        textLight: "#0A7373",
      },
      violet: {
        dark: "#8B8BFF",
        light: "#5B5BD6",
        name: "Violet",
        onFill: { dark: "#14141A", light: "#FFFFFF" },
        textLight: "#5B5BD6",
      },
    },
    appliesTo: [
      "selection highlight",
      "focus rings",
      "active controls",
      "toggles/switches",
      "progress",
      "links",
      "AI button",
    ],
    default: "violet",
    neverAppliesTo: ["window chrome", "body text", "app icon colors", "wallpaper"],
    note: "Same six accents as Tokrah (utils/accent.ts), same light/dark fills and text variants. SevynOS default is violet; Tokrah default is neutral. Contrast ratios verified against SevynOS surfaces — see MANIFEST.md § Accent system.",
    perAppOverride: false,
  },
  color: {
    danger: {
      dark: "#EF4444",
      light: "#DC2626",
      textDark: "#F87171",
      textLight: "#B91C1C",
    },
    dark: {
      appBody: "#111827",
      background: "#06080F",
      border: "#4B5563",
      borderHairline: "#FFFFFF14",
      elevated: "#1F2937",
      hover: "#374151",
      sunken: "#111827",
      surface: "#1F2937",
      textMuted: "#9CA3AF",
      textPrimary: "#FAFAFA",
      textSecondary: "#D1D5DB",
    },
    fixed: {
      godBackground: "#B45309",
      godText: "#FEF3C7",
      relayBackground: "#1E40AF",
      relayText: "#DBEAFE",
      screenBackground: "#991B1B",
      screenText: "#FEE2E2",
    },
    light: {
      appBody: "#F9FAFB",
      background: "#F2F2F7",
      border: "#E5E7EB",
      borderHairline: "#00000014",
      elevated: "#FFFFFF",
      hover: "#F3F4F6",
      sunken: "#F2F2F7",
      surface: "#FFFFFF",
      textMuted: "#9CA3AF",
      textPrimary: "#14141A",
      textSecondary: "#6B7280",
    },
  },
  controlCenter: {
    anchorRight: 16,
    anchorTop: 40,
    iconHitArea: 28,
    iconSize: 20,
    padding: 12,
    radius: 12,
    rowGap: 8,
    segmentedHeight: 32,
    sliderKnob: 20,
    sliderRowHeight: 56,
    sliderTrackHeight: 4,
    toggleHeight: 24,
    toggleKnob: 20,
    toggleRowHeight: 44,
    toggleWidth: 44,
    width: 320,
  },
  desktopIcons: {
    labelShadow: "0 1px 3px rgba(0,0,0,0.45)",
    marginLeft: 24,
    marginTop: 22,
    selectionAlpha: { dark: 0.2, light: 0.15 },
    sizes: {
      large: {
        gapX: 24,
        gapY: 20,
        icon: 64,
        iconRadius: 10,
        labelSize: 13,
        tileHeight: 112,
        tileWidth: 128,
      },
      medium: {
        gapX: 18,
        gapY: 16,
        icon: 48,
        iconRadius: 8,
        labelSize: 12,
        tileHeight: 92,
        tileWidth: 104,
      },
      small: {
        gapX: 14,
        gapY: 12,
        icon: 36,
        iconRadius: 6,
        labelSize: 11,
        tileHeight: 72,
        tileWidth: 80,
      },
    },
  },
  dialog: {
    alertIconSize: 48,
    alertPadding: 20,
    alertRadius: 12,
    alertWidth: 360,
    buttonGap: 12,
    buttonHeight: 36,
    buttonMinWidth: 96,
    buttonOrder: "cancel-leading",
    buttonRadius: 6,
    maxButtons: 3,
    sheetMarginX: 24,
    sheetMaxWidth: 640,
    sheetRadius: 12,
  },
  files: {
    gridCellHeight: 108,
    gridCellWidth: 96,
    gridIcon: 64,
    gridIconRadius: 10,
    gridLabelSize: 13,
    gridPitch: 12,
    listMetaSize: 13,
    listModifiedWidth: 96,
    listRowHeight: 36,
    listSizeWidth: 80,
    listTile: 24,
    listTileRadius: 6,
    selectionAlpha: { dark: 0.2, light: 0.12 },
    toggleHeight: 28,
    toggleWidth: 64,
  },
  menu: {
    iconSlot: 20,
    labelPadX: 10,
    maxHeightFraction: 0.7,
    maxWidth: 320,
    minWidth: 200,
    padding: 4,
    radius: 8,
    rowHeight: 28,
    rowRadius: 6,
    separatorHeight: 9,
    width: 220,
  },
  motion: {
    easing: "cubic-bezier(0.2, 0, 0, 1)",
    hover: 120,
    menuOpen: 180,
    modeSwitch: 200,
    sheetSlide: 280,
    wallpaperChange: 200,
    windowOpen: 240,
  },
  radii: {
    button: 6,
    card: 12,
    control: 6,
    dialog: 12,
    dock: 24,
    input: 6,
    menu: 8,
    menuRow: 6,
    pill: 999,
    topbar: 0,
    window: 10,
  },
  shadow: {
    dark: {
      dialog: "0 12px 32px rgba(0,0,0,0.45)",
      menu: "0 8px 24px rgba(0,0,0,0.35)",
      window: "0 16px 48px rgba(0,0,0,0.45)",
    },
    light: {
      dialog: "0 12px 32px rgba(0,0,0,0.18)",
      menu: "0 8px 24px rgba(0,0,0,0.15)",
      window: "0 16px 48px rgba(0,0,0,0.20)",
    },
  },
  spacing: {
    buttonGap: 12,
    controlGap: 8,
    groupGap: 20,
    scale: [0, 4, 8, 12, 16, 20, 24, 32, 48],
    sectionGap: 24,
    windowMargin: 20,
  },
  topbar: {
    glass: {
      edge: { dark: "#ffffff14", light: "#00000014" },
      fill: { dark: "#ffffff1f", light: "#ffffffb3" },
      highlight: { dark: "#ffffff40", light: "#ffffff" },
      shade: { dark: "#00000033", light: "#00000033" },
    },
    height: 32,
    itemGap: 16,
    labelSize: 13,
    padX: 16,
    pillHeight: 28,
    pillRadius: 6,
  },
  type: {
    body: { lineHeight: 1.4, size: 14, weight: "normal" },
    caption: { lineHeight: 1.4, size: 12, weight: "normal" },
    dialogMessage: { size: 14, weight: "normal" },
    dialogTitle: { size: 16, weight: "bold" },
    menuLabel: { size: 14, weight: "normal" },
    menuShortcut: { size: 13, weight: "normal" },
    minimum: 11,
    secondary: { lineHeight: 1.4, size: 13, weight: "normal" },
    windowTitle: { lineHeight: 1.25, size: 16, weight: "bold" },
  },
  wallpaper: {
    hoverPreview: true,
    modeFallback: {
      cosmic: "macos-light",
      default: "macos-light",
      frost: "frost",
      macos: "macos-light",
      "macos-light": "default",
      minimal: "macos-light",
      solid: "macos-light",
    },
    modeSwitch: "auto",
    modeTag: {
      cosmic: "dark",
      default: "dark",
      frost: "both",
      macos: "dark",
      "macos-light": "light",
      minimal: "by-color",
      solid: "by-color",
    },
    pickerWidth: 420,
    styles: ["default", "solid", "cosmic", "minimal", "macos", "macos-light", "frost"],
    swatchRadius: 8,
    swatchSize: 44,
    thumbnailGap: 12,
    thumbnailHeight: 88,
    thumbnailRadius: 8,
    thumbnailWidth: 160,
  },
  window: {
    controlRadius: 6,
    controlSize: 28,
    controlZoneWidth: 100,
    controlsSide: "right",
    cornerRadius: 10,
    cornerRadiusMechanism: "compositor",
    defaultHeight: 600,
    defaultWidth: 960,
    minHeight: 320,
    minWidth: 480,
    resizeEdge: 8,
    titleBarHeight: 40,
    titleBarPadLeft: 16,
    titleBarPadRight: 12,
    titleIconGap: 8,
    titleIconSize: 20,
  },
  zOrder: {
    aiButton: 400,
    aiSidebar: 600,
    appWindows: 100,
    contextMenus: 700,
    desktopIcons: 10,
    dialogs: 800,
    dock: 300,
    lockScreen: 900,
    panels: 500,
    topbar: 200,
    wallpaper: 0,
    wallpaperPicker: 650,
  },
};

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

module.exports = { tokens: deepFreeze(tokens) };
