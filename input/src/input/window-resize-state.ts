import type { GenesisWindowId, WindowBounds } from "@sevynos/graphics";
import type { HitTestPoint } from "./hit-test-point.js";
import type { PointerCaptureId } from "./pointer-capture.js";
import type { WindowResizeEdge } from "./window-resize-edge.js";

export interface ActiveWindowResizeOptions {
  readonly pointerId: PointerCaptureId;

  readonly windowId: GenesisWindowId;

  readonly edge: WindowResizeEdge;

  readonly initialPointerPosition: HitTestPoint;

  readonly initialWindowBounds: WindowBounds;

  readonly startedAt: number;
}

export class ActiveWindowResize {
  public readonly pointerId: PointerCaptureId;

  public readonly windowId: GenesisWindowId;

  public readonly edge: WindowResizeEdge;

  public readonly initialPointerPosition: HitTestPoint;

  public readonly initialWindowBounds: WindowBounds;

  public readonly startedAt: number;

  public constructor(options: ActiveWindowResizeOptions) {
    this.pointerId = options.pointerId;

    this.windowId = options.windowId;

    this.edge = options.edge;

    this.initialPointerPosition = Object.freeze({
      ...options.initialPointerPosition,
    });

    this.initialWindowBounds = Object.freeze({
      ...options.initialWindowBounds,
    });

    this.startedAt = options.startedAt;

    Object.freeze(this);
  }
}
