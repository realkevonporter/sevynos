import type { FocusTargetId } from "./focus-state.js";

export type PointerCaptureId = number;

export type PointerCaptureReleaseReason =
  "explicit" | "pointer-up" | "pointer-cancel" | "target-removed" | "clear";

export interface PointerCaptureOptions {
  readonly pointerId: PointerCaptureId;

  readonly targetId: FocusTargetId;

  readonly capturedAt: number;
}

export class PointerCapture {
  public readonly pointerId: PointerCaptureId;

  public readonly targetId: FocusTargetId;

  public readonly capturedAt: number;

  public constructor(options: PointerCaptureOptions) {
    if (!Number.isSafeInteger(options.pointerId) || options.pointerId < 0) {
      throw new RangeError("Pointer capture ID must be a non-negative safe integer.");
    }

    if (!Number.isFinite(options.capturedAt) || options.capturedAt < 0) {
      throw new RangeError(
        "Pointer capture timestamp must be a non-negative finite number.",
      );
    }

    this.pointerId = options.pointerId;

    this.targetId = options.targetId;

    this.capturedAt = options.capturedAt;

    Object.freeze(this);
  }
}
