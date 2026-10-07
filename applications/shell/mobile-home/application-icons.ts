/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { createElement, type JSX } from "react";
import { NativeIcon, type NativeComponentProps } from "@sevynos/react-native";

/**
 * Manifest icon path (as declared by `SevynApplicationManifest.icon`, e.g.
 * "icons/browser.svg") -> NativeIcon glyph name. The glyphs are monochrome
 * line-art renditions of the per-app SVG sets under
 * applications/<app>/icons/<app>.svg, drawn by both Genesis renderers
 * (canvas-genesis-renderer and software-frame-renderer).
 */
const MANIFEST_ICON_GLYPHS: Record<string, string> = {
  "icons/browser.svg": "app-browser",
  "icons/calculator.svg": "app-calculator",
  "icons/camera.svg": "app-camera",
  "icons/files.svg": "app-files",
  "icons/music.svg": "app-music",
  "icons/notes.svg": "app-notes",
  "icons/settings.svg": "app-settings",
  "icons/sevyn-code.svg": "app-sevyn-code",
  "icons/store.svg": "app-store",
  "icons/system-monitor.svg": "app-system-monitor",
  "icons/terminal.svg": "app-terminal",
  "icons/text-editor.svg": "app-text-editor",
  "icons/welcome.svg": "app-welcome",
};

/**
 * Brand tile colors per application id, matching the gradient mid-point of
 * the app's SVG icon set. Used by ApplicationIcon for the tile background.
 */
const APPLICATION_TILE_COLORS: Record<string, string> = {
  "org.sevynos.browser": "#1D9BF0",
  "org.sevynos.calculator": "#E8930C",
  "org.sevynos.camera": "#E0448C",
  "org.sevynos.files": "#F5A623",
  "org.sevynos.music": "#8B5CF6",
  "org.sevynos.notes": "#EAB308",
  "org.sevynos.settings": "#64748B",
  "org.sevynos.sevyn-code": "#0EA5C9",
  "org.sevynos.store": "#6869EE",
  "org.sevynos.system-monitor": "#10B981",
  "org.sevynos.terminal": "#1F2937",
  "org.sevynos.text-editor": "#3B82F6",
  "org.sevynos.welcome": "#D9A83F",
};

/**
 * Resolve the NativeIcon glyph name for a manifest `icon` path.
 * Returns undefined when the manifest declares no icon or an icon with no
 * matching glyph, in which case callers fall back to the letter tile.
 */
export function iconGlyphForManifestIcon(
  manifestIcon: string | undefined,
): string | undefined {
  if (manifestIcon === undefined) return undefined;
  return MANIFEST_ICON_GLYPHS[manifestIcon];
}

/**
 * Resolve the brand tile color for an application. Falls back to the
 * summary accent, then to the shell accent.
 */
export function tileColorForApplication(
  applicationId: string,
  accent: string | undefined,
  fallback: string,
): string {
  return APPLICATION_TILE_COLORS[applicationId] ?? accent ?? fallback;
}

export interface ShellGlyphProps {
  readonly name: string;
  readonly size: number;
  readonly color?: string;
}

/**
 * Emoji-free vector glyph. Thin wrapper over the NativeIcon primitive so
 * shell and app UI can use vector iconography without touching the font
 * stack (which has no emoji glyphs).
 */
export function ShellGlyph({
  name,
  size,
  color = "#FFFFFF",
}: ShellGlyphProps): JSX.Element {
  return createElement(NativeIcon, {
    icon: name,
    style: { width: size, height: size, color },
  } as unknown as NativeComponentProps);
}
