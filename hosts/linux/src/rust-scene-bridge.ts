// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Rust scene bridge: sends scene descriptions to the Rust compositor
 * instead of rasterizing pixels in Node.js.
 *
 * This is the integration point for the Rust compositor migration.
 * Node.js composes the scene graph; Rust rasterizes it.
 */

import type { Scene, SceneCommand } from "./rust-scene-protocol.js";

/**
 * Converts a DesktopScene to the Rust compositor scene format.
 * This is a transitional adapter; the scene graph will eventually
 * serialize directly to the Rust protocol.
 */
export function sceneToRustScene(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desktopScene: any,
  width: number,
  height: number,
): Scene {
  const commands: SceneCommand[] = [];

  // TODO: Walk the desktop scene graph and emit Rust scene commands.
  // For now, this is a placeholder that emits a background.
  // Full implementation will translate all 40 command types.

  commands.push({
    kind: "desktop-background",
    bounds: { x: 0, y: 0, width, height },
    color: { r: 0.08, g: 0.08, b: 0.1, a: 1.0 },
  });

  return { width, height, commands };
}

/**
 * Serializes a scene for transport to the Rust compositor.
 * Bitmap pixels are base64-encoded for JSON transport.
 */
export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene);
}
