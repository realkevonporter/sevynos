// SevynOS v2 — staged app-icon paths (direction C, App-icon style).
//
// Icons are drawn by v2/shell/icons/build_icons.py and staged into the
// image by v2/image/build-m9-image.sh under /usr/share/sevyn/shell/
// icons/. The Dock derives the path from the app id, so no manifest /
// loader / appd change is needed; a missing file simply doesn't
// paint, and the monogram glyph rendered underneath shows through
// (third-party apps keep working with no icon).

export const ICON_DIR = "/usr/share/sevyn/shell/icons";

export function appIconPath(appId: string): string {
  return ICON_DIR + "/" + appId + ".png";
}

export function symbolPath(name: string): string {
  return ICON_DIR + "/symbols/" + name + ".png";
}
