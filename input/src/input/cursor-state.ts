import type { HitTestPoint } from "./hit-test-point.js";
import type { CursorKind } from "./cursor-kind.js";

export interface CursorStateOptions {
  readonly kind: CursorKind;

  readonly position: HitTestPoint;

  readonly visible: boolean;

  readonly updatedAt: number;
}

export class CursorState {
  public readonly kind: CursorKind;

  public readonly position: HitTestPoint;

  public readonly visible: boolean;

  public readonly updatedAt: number;

  public constructor(options: CursorStateOptions) {
    if (!Number.isFinite(options.position.x) || !Number.isFinite(options.position.y)) {
      throw new RangeError("Cursor position must contain finite coordinates.");
    }

    if (!Number.isFinite(options.updatedAt) || options.updatedAt < 0) {
      throw new RangeError("Cursor timestamp must be a non-negative finite number.");
    }

    this.kind = options.kind;

    this.position = Object.freeze({
      x: options.position.x,

      y: options.position.y,
    });

    this.visible = options.visible;

    this.updatedAt = options.updatedAt;

    Object.freeze(this);
  }
}
