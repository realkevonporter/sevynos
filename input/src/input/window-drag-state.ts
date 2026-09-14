import type { GenesisWindowId, WindowBounds } from "@sevynos/graphics";
import type { HitTestPoint } from "./hit-test-point.js";
import type { PointerCaptureId } from "./pointer-capture.js";

export interface ActiveWindowDragOptions {
  readonly pointerId: PointerCaptureId;

  readonly windowId: GenesisWindowId;

  readonly initialPointerPosition: HitTestPoint;

  readonly initialWindowBounds: WindowBounds;

  readonly startedAt: number;
}

export class ActiveWindowDrag {
  public readonly pointerId: PointerCaptureId;

  public readonly windowId: GenesisWindowId;

  public readonly initialPointerPosition: HitTestPoint;

  public readonly initialWindowBounds: WindowBounds;

  public readonly startedAt: number;

  public constructor(options: ActiveWindowDragOptions) {
    if (!Number.isSafeInteger(options.pointerId) || options.pointerId < 0) {
      throw new RangeError("Window drag pointer ID must be a non-negative safe integer.");
    }

    if (!Number.isFinite(options.startedAt) || options.startedAt < 0) {
      throw new RangeError("Window drag timestamp must be a non-negative finite number.");
    }

    this.pointerId = options.pointerId;

    this.windowId = options.windowId;

    this.initialPointerPosition = Object.freeze({
      x: options.initialPointerPosition.x,

      y: options.initialPointerPosition.y,
    });

    this.initialWindowBounds = Object.freeze({
      x: options.initialWindowBounds.x,

      y: options.initialWindowBounds.y,

      width: options.initialWindowBounds.width,

      height: options.initialWindowBounds.height,
    });

    this.startedAt = options.startedAt;

    Object.freeze(this);
  }
}
