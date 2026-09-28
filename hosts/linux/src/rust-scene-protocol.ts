// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Scene protocol: TypeScript definitions mirroring the Rust compositor.
 *
 * Node.js composes scenes as lists of draw commands and serializes them
 * to the Rust compositor for rasterization. This keeps pixel buffers out
 * of the V8 heap — the OOM failure mode of the Node.js software renderer.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type SceneCommand =
  | {
      kind: "color";
      bounds: Rect;
      color: Color;
      radius: number;
      opacity: number;
    }
  | {
      kind: "gradient";
      bounds: Rect;
      start: Color;
      end: Color;
      angle: number;
      opacity: number;
    }
  | {
      kind: "bitmap";
      bounds: Rect;
      width: number;
      height: number;
      /** Raw RGBA8888 bytes, base64-encoded for JSON transport. */
      pixels_base64: string;
      opacity: number;
    }
  | {
      kind: "text";
      bounds: Rect;
      text: string;
      size: number;
      color: Color;
      align: "start" | "center" | "end";
      opacity: number;
    }
  | {
      kind: "icon";
      bounds: Rect;
      name: string;
      size: number;
      color: Color;
      opacity: number;
    }
  | {
      kind: "material";
      bounds: Rect;
      material: "ultra-thin" | "thin" | "regular" | "thick";
      radius: number;
      opacity: number;
    }
  | { kind: "separator"; bounds: Rect; color: Color; vertical: boolean }
  | { kind: "clip-start"; bounds: Rect; radius: number }
  | { kind: "clip-end" }
  | { kind: "desktop-background"; bounds: Rect; color: Color }
  | { kind: "desktop-status-bar"; bounds: Rect }
  | {
      kind: "desktop-window";
      bounds: Rect;
      title: string;
      focused: boolean;
    }
  | { kind: "desktop-taskbar"; bounds: Rect }
  | { kind: "desktop-cursor"; x: number; y: number; cursor_kind: string };

export interface Scene {
  width: number;
  height: number;
  commands: SceneCommand[];
}
