// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Translates desktop scene nodes to the Rust compositor protocol.
 *
 * This is the bridge between the Node.js scene graph and the Rust rasterizer.
 * Each desktop node type is mapped to one or more Rust scene commands.
 */

import type { Scene, SceneCommand, Rect, Color } from "./rust-scene-protocol.js";
import type { DesktopSceneNode } from "@sevynos/desktop-shell/internal";

type BoundsLike = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function toRect(bounds: BoundsLike): Rect {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function toColor(hex: string, opacity = 1): Color {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a: a * opacity };
}

/** Dark theme palette matching the existing Node renderer defaults. */
const PALETTE = {
  background: "#090b11",
  surface: "#14161d",
  surfaceElevated: "#1c1f28",
  text: "#ffffff",
  textDim: "#9aa0ae",
  accent: "#4f7cff",
  border: "#2a2e3a",
} as const;

/**
 * Translate a single desktop scene node to Rust scene commands.
 * Returns an array (nodes like buttons produce background + label).
 */
export function translateNode(node: DesktopSceneNode): SceneCommand[] {
  switch (node.kind) {
    case "desktop-window": {
      return [
        {
          kind: "desktop-window",
          bounds: toRect(node.base.bounds),
          title: node.title,
          focused: node.base.focused,
        },
      ];
    }

    case "desktop-cursor": {
      if (!node.visible) return [];
      return [
        {
          kind: "desktop-cursor",
          x: node.position.x,
          y: node.position.y,
          cursor_kind: node.cursorKind,
        },
      ];
    }

    case "desktop-background": {
      return [
        {
          kind: "desktop-background",
          bounds: toRect(node.bounds),
          color: toColor(PALETTE.background),
        },
      ];
    }

    case "desktop-status-bar": {
      const cmds: SceneCommand[] = [
        { kind: "desktop-status-bar", bounds: toRect(node.bounds) },
      ];
      // Clock text on the right side of the status bar.
      if (node.timeText) {
        cmds.push({
          kind: "text",
          bounds: toRect({
            x: node.bounds.x + node.bounds.width - 120,
            y: node.bounds.y,
            width: 110,
            height: node.bounds.height,
          }),
          text: node.timeText,
          size: 13,
          color: toColor(PALETTE.text),
          align: "end",
          opacity: 1,
        });
      }
      return cmds;
    }

    case "desktop-taskbar": {
      return [{ kind: "desktop-taskbar", bounds: toRect(node.bounds) }];
    }

    // Settings / diagnostics / recovery controls render as labeled buttons.
    case "desktop-settings-control":
    case "desktop-diagnostics-control":
    case "desktop-recovery-control":
    case "desktop-workspace-action":
    case "desktop-reset-action": {
      const bounds = toRect(node.bounds);
      return [
        {
          kind: "color",
          bounds,
          color: toColor(PALETTE.surfaceElevated),
          radius: 8,
          opacity: 1,
        },
        {
          kind: "text",
          bounds,
          text: node.label,
          size: 14,
          color: toColor(PALETTE.text),
          align: "center",
          opacity: 1,
        },
      ];
    }

    case "desktop-recovery": {
      const bounds = toRect(node.bounds);
      return [
        {
          kind: "color",
          bounds,
          color: toColor(PALETTE.surface),
          radius: 0,
          opacity: 1,
        },
        {
          kind: "text",
          bounds: toRect({
            x: bounds.x,
            y: bounds.y + 20,
            width: bounds.width,
            height: 60,
          }),
          text: node.message,
          size: 16,
          color: toColor(PALETTE.text),
          align: "center",
          opacity: 1,
        },
      ];
    }

    // Workspace items (files/folders on the desktop).
    case "desktop-workspace-item": {
      const bounds = toRect(node.bounds);
      return [
        {
          kind: "icon",
          bounds: toRect({ x: bounds.x + 8, y: bounds.y + 8, width: 32, height: 32 }),
          name: node.itemKind === "directory" ? "folder" : "file",
          size: 32,
          color: toColor(PALETTE.accent),
          opacity: 1,
        },
        {
          kind: "text",
          bounds: toRect({
            x: bounds.x,
            y: bounds.y + 44,
            width: bounds.width,
            height: 20,
          }),
          text: node.label,
          size: 12,
          color: toColor(PALETTE.text),
          align: "center",
          opacity: 1,
        },
      ];
    }

    // Launcher surface and entries.
    case "desktop-launcher-surface": {
      return [
        {
          kind: "color",
          bounds: toRect(node.bounds),
          color: toColor(PALETTE.surface),
          radius: 12,
          opacity: 0.98,
        },
      ];
    }

    case "desktop-launcher-button": {
      return [
        {
          kind: "color",
          bounds: toRect(node.bounds),
          color: toColor(node.open ? PALETTE.accent : PALETTE.surfaceElevated),
          radius: 8,
          opacity: 1,
        },
      ];
    }

    case "desktop-launcher-header":
    case "desktop-launcher-search":
    case "desktop-launcher-entry":
    case "desktop-taskbar-application": {
      // These carry label/icon info in their specific shapes; render a
      // generic row. The label property exists on entry nodes.
      const label = "label" in node && typeof node.label === "string" ? node.label : "";
      const bounds = toRect(node.bounds);
      const cmds: SceneCommand[] = [
        {
          kind: "color",
          bounds,
          color: toColor(PALETTE.surface),
          radius: 6,
          opacity: 1,
        },
      ];
      if (label) {
        cmds.push({
          kind: "text",
          bounds,
          text: label,
          size: 14,
          color: toColor(PALETTE.text),
          align: "start",
          opacity: 1,
        });
      }
      return cmds;
    }

    case "desktop-workspace-control": {
      return [
        {
          kind: "color",
          bounds: toRect(node.bounds),
          color: toColor(PALETTE.surfaceElevated),
          radius: 6,
          opacity: 1,
        },
      ];
    }

    // Window switcher.
    case "desktop-window-switcher-surface": {
      return [
        {
          kind: "color",
          bounds: toRect(node.bounds),
          color: toColor(PALETTE.surface),
          radius: 12,
          opacity: 0.95,
        },
      ];
    }

    case "desktop-window-switcher-entry": {
      const label = "label" in node && typeof node.label === "string" ? node.label : "";
      const bounds = toRect(node.bounds);
      const cmds: SceneCommand[] = [
        {
          kind: "color",
          bounds,
          color: toColor(PALETTE.surfaceElevated),
          radius: 8,
          opacity: 1,
        },
      ];
      if (label) {
        cmds.push({
          kind: "text",
          bounds,
          text: label,
          size: 13,
          color: toColor(PALETTE.text),
          align: "center",
          opacity: 1,
        });
      }
      return cmds;
    }

    default: {
      // Exhaustiveness check: if a new node kind is added, TypeScript will
      // error here, forcing an explicit mapping decision.
      const _exhaustive: never = node;
      void _exhaustive;
      return [];
    }
  }
}

/**
 * Translate a full scene's node list, preserving order.
 */
export function translateScene(
  nodes: readonly DesktopSceneNode[],
  width: number,
  height: number,
): Scene {
  const rustCommands: SceneCommand[] = [];
  for (const node of nodes) {
    rustCommands.push(...translateNode(node));
  }
  return { width, height, commands: rustCommands };
}

// Backwards-compatible alias used by the presenter.
export const translateCommand = translateNode;
