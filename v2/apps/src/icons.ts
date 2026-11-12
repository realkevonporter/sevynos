// SevynOS v2 — staged app-icon paths (direction C, App-icon style).
//
// Same paths as the shell's v2/shell/src/icons.ts — the apps bundle
// separately, so the constant lives here too. Icons are drawn by
// v2/shell/icons/build_icons.py and staged by v2/image/build-m9-image.sh
// under /usr/share/sevyn/shell/icons/. A missing file simply doesn't
// paint, and the monogram glyph rendered underneath shows through.

export const ICON_DIR = "/usr/share/sevyn/shell/icons";

export function appIconPath(appId: string): string {
  return ICON_DIR + "/" + appId + ".png";
}

// 96x96 variant for the fallback screen tile (App.tsx).
export function appIconHeroPath(appId: string): string {
  return ICON_DIR + "/hero/" + appId + ".png";
}

// 72x72 variant for the EmptyState tile (App.tsx).
export function appIconLargePath(appId: string): string {
  return ICON_DIR + "/large/" + appId + ".png";
}

// 40x40 variant for the Store list row (App.tsx).
export function appIconSmallPath(appId: string): string {
  return ICON_DIR + "/small/" + appId + ".png";
}

// 20x20 glyph-only variant for window title bars.
export function appIconTitlePath(appId: string): string {
  return ICON_DIR + "/title/" + appId + ".png";
}

export function symbolPath(name: string): string {
  return ICON_DIR + "/symbols/" + name + ".png";
}
