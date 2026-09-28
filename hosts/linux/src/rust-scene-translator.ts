// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Translates desktop scene nodes to the Rust compositor protocol.
 *
 * This is the bridge between the Node.js scene graph and the Rust rasterizer.
 * Each desktop node type is mapped to its Rust equivalent; unsupported nodes
 * return null so the compositor skips them instead of crashing.
 *
 * NOTE: This is prototype code. Only desktop-window and desktop-cursor are
 * currently mapped. Full scene-graph coverage (background, taskbar, status
 * bar, app surfaces) is TODO.
 */

import type { Scene, SceneCommand, Rect } from "./rust-scene-protocol.js";
import type { DesktopSceneNode } from "@sevynos/desktop-shell/internal";
import type { WindowBounds } from "@sevynos/graphics";

function toRect(bounds: WindowBounds): Rect {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * Translate a single desktop scene node to a Rust SceneCommand.
 * Returns null for node types that have no Rust equivalent yet.
 */
export function translateCommand(node: DesktopSceneNode): SceneCommand | null {
  switch (node.kind) {
    case "desktop-window": {
      return {
        kind: "desktop-window",
        bounds: toRect(node.base.bounds),
        title: node.title,
        focused: node.base.focused,
      };
    }

    case "desktop-cursor": {
      if (!node.visible) return null;
      return {
        kind: "desktop-cursor",
        x: node.position.x,
        y: node.position.y,
        cursor_kind: node.cursorKind,
      };
    }

    default:
      // Unsupported node types (background, taskbar, status bar, app
      // surfaces, etc.) are skipped. Full coverage is TODO.
      return null;
  }
}

/**
 * Translate a full scene's node list.
 */
export function translateScene(
  nodes: readonly DesktopSceneNode[],
  width: number,
  height: number,
): Scene {
  const rustCommands: SceneCommand[] = [];
  for (const node of nodes) {
    const translated = translateCommand(node);
    if (translated !== null) {
      rustCommands.push(translated);
    }
  }
  return { width, height, commands: rustCommands };
}
