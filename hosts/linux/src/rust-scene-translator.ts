// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Translates TypeScript NativeRenderCommands to the Rust compositor protocol.
 *
 * This is the bridge between the Node.js scene graph and the Rust rasterizer.
 * Each command type is mapped to its Rust equivalent; unsupported commands
 * fall back to a placeholder so the compositor never crashes on unknown input.
 */

import type { Scene, SceneCommand, Rect, Color } from "./rust-scene-protocol.js";
import type { NativeRenderCommand } from "@sevynos/react-native/internal";
import type { DesktopSceneNode } from "@sevynos/desktop-shell/internal";

/**
 * Input to the translator: either low-level render commands or high-level
 * desktop scene nodes. The translator handles both, mapping each to the
 * corresponding Rust protocol command.
 */
export type TranslatableNode = NativeRenderCommand | DesktopSceneNode;

function toRect(bounds: { x: number; y: number; width: number; height: number }): Rect {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function toColor(color: string, opacity = 1): Color {
  // Parse hex colors like #RRGGBB or #RRGGBBAA.
  const hex = color.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a: a * opacity };
}

/**
 * Translate a single node to a Rust SceneCommand.
 * Returns null for nodes that have no Rust equivalent yet.
 *
 * Note: This is prototype code. DesktopSceneNode and NativeRenderCommand
 * have different shapes; the switch below handles the kinds that appear
 * in practice, with property access guarded by the kind discriminant.
 */
export function translateCommand(cmd: TranslatableNode): SceneCommand | null {
  // All translatable nodes carry bounds; desktop nodes without explicit
  // bounds fall back to a zero rect.
  const rawBounds = "bounds" in cmd && cmd.bounds !== undefined
    ? cmd.bounds
    : { x: 0, y: 0, width: 0, height: 0 };
  const bounds = toRect(rawBounds);

  switch (cmd.kind) {
    case "color":
      return {
        kind: "color",
        bounds,
        color: toColor(cmd.color ?? "#000000", cmd.opacity),
        radius: cmd.radius ?? 0,
        opacity: cmd.opacity ?? 1,
      };

    case "bitmap":
      return {
        kind: "bitmap",
        bounds,
        width: cmd.width,
        height: cmd.height,
        pixels_base64: Buffer.from(cmd.pixels).toString("base64"),
        opacity: cmd.opacity ?? 1,
      };

    case "text": {
      const lines = cmd.lines ?? [cmd.text ?? ""];
      // For now, join lines; multi-line layout is a follow-up.
      return {
        kind: "text",
        bounds,
        text: lines.join("\n"),
        size: cmd.size ?? 14,
        color: toColor(cmd.color ?? "#ffffff", cmd.opacity),
        align: cmd.align ?? "start",
        opacity: cmd.opacity ?? 1,
      };
    }

    case "clip-start":
      return { kind: "clip-start", bounds, radius: cmd.radius ?? 0 };

    case "clip-end":
      return { kind: "clip-end" };

    case "gradient":
      return {
        kind: "gradient",
        bounds,
        start: toColor(cmd.from ?? "#000000", cmd.opacity),
        end: toColor(cmd.to ?? "#ffffff", cmd.opacity),
        angle: cmd.angle ?? 0,
        opacity: cmd.opacity ?? 1,
      };

    case "icon":
      return {
        kind: "icon",
        bounds,
        name: cmd.name ?? "unknown",
        color: toColor(cmd.color ?? "#ffffff", cmd.opacity),
        size: cmd.size ?? 16,
        opacity: cmd.opacity ?? 1,
      };

    case "material":
      return {
        kind: "material",
        bounds,
        material: cmd.material ?? "regular",
        radius: cmd.radius ?? 0,
        opacity: cmd.opacity ?? 1,
      };

    case "desktop-background":
      return {
        kind: "desktop-background",
        bounds,
        color: toColor(cmd.color ?? "#141416"),
      };

    case "desktop-status-bar":
      return { kind: "desktop-status-bar", bounds };

    case "desktop-window":
      return {
        kind: "desktop-window",
        bounds,
        title: cmd.title ?? "",
        focused: cmd.focused ?? false,
      };

    case "desktop-taskbar":
      return { kind: "desktop-taskbar", bounds };

    case "desktop-cursor":
      return {
        kind: "desktop-cursor",
        x: cmd.x ?? 0,
        y: cmd.y ?? 0,
        cursor_kind: cmd.cursor ?? "default",
      };

    case "separator":
      return {
        kind: "separator",
        bounds,
        color: toColor(cmd.color ?? "#333333"),
        vertical: cmd.vertical ?? false,
      };

    default:
      // Unsupported command types render as transparent placeholders.
      // This ensures the compositor never crashes on new command kinds.
      return null;
  }
}

/**
 * Translate a full scene's node list.
 */
export function translateScene(
  commands: readonly TranslatableNode[],
  width: number,
  height: number,
): Scene {
  const rustCommands: SceneCommand[] = [];
  for (const cmd of commands) {
    const translated = translateCommand(cmd);
    if (translated !== null) {
      rustCommands.push(translated);
    }
  }
  return { width, height, commands: rustCommands };
}
