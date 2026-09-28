// Copyright (C) 2026 SevynOS Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Rust-backed frame presenter.
 *
 * Instead of rasterizing scenes to pixels in Node.js (V8 heap), this
 * presenter serializes the scene to the Rust compositor, which rasterizes
 * with no GC pauses and bounded memory.
 *
 * This is the production path. The Node.js software renderer is retained
 * behind a flag for fallback during the migration.
 */

import type { DesktopScene } from "@sevynos/desktop-shell/internal";
import type { DisplayRenderPlan } from "@sevynos/graphics";
import type { RenderResult } from "@sevynos/graphics";
import type { LinuxFramePresenter } from "./host-adapters.js";
import type { WaylandBridgeConnection } from "./wayland-bridge.js";
import { translateScene } from "./rust-scene-translator.js";
import { serializeScene } from "./rust-scene-bridge.js";

/**
 * Presenter that delegates rasterization to the Rust compositor.
 *
 * The Rust bridge process receives scene JSON over the existing IPC channel,
 * rasterizes it, and presents. Node.js never allocates pixel buffers.
 */
export class RustFramePresenter implements LinuxFramePresenter<DesktopScene> {
  public state: "created" | "initialized" | "shutdown" = "created";
  readonly #connection: WaylandBridgeConnection;
  readonly #marker: (name: string, fields?: Record<string, unknown>) => void;
  #frame = 0;
  #lastFrameSubmitted = false;

  public constructor(
    connection: WaylandBridgeConnection,
    marker: (name: string, fields?: Record<string, unknown>) => void,
  ) {
    this.#connection = connection;
    this.#marker = marker;
  }

  public initialize(): void {
    this.state = "initialized";
    this.#marker("SEVYN_RUST_COMPOSITOR_INIT");
  }

  public setHardwareCursor(_enabled: boolean): void {
    // Cursor is rendered by the Rust compositor as a scene command.
  }

  public get lastFrameSubmitted(): boolean {
    return this.#lastFrameSubmitted;
  }

  public traceNextFrame(_traceId: string | undefined): void {
    // Tracing is handled by the Rust compositor.
  }

  public render(plan: DisplayRenderPlan<DesktopScene>): RenderResult {
    if (this.state !== "initialized") {
      throw new Error("Rust presenter is not initialized.");
    }
    const width = plan.displayBounds.width;
    const height = plan.displayBounds.height;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error(
        `Rust render plan ${plan.displayId} has invalid bounds ${String(width)}x${String(height)}.`,
      );
    }
    this.#frame += 1;

    // Extract commands from the desktop scene and translate to Rust protocol.
    // The scene graph structure is traversed here; the translator handles
    // individual command mapping.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = plan.scene as any;
    const commands = scene.commands ?? scene.nodes ?? [];
    const rustScene = translateScene(commands, width, height);
    const payload = serializeScene(rustScene);

    // Send to the Rust compositor via the bridge connection.
    // The Rust side deserializes, rasterizes, and presents.
    this.#connection.sendScene(payload);

    this.#lastFrameSubmitted = true;
    return {
      frameId: this.#frame,
      displayId: plan.displayId,
      submitted: true,
      // Damage tracking is handled by the Rust compositor.
      damage: [],
    } as RenderResult;
  }

  public shutdown(): void {
    this.state = "shutdown";
  }
}
