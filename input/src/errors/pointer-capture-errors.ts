import type { PointerCaptureId } from "../input/pointer-capture.js";
import type { FocusTargetId } from "../input/focus-state.js";

export class PointerAlreadyCapturedError extends Error {
  public readonly pointerId: PointerCaptureId;

  public readonly targetId: FocusTargetId;

  public constructor(pointerId: PointerCaptureId, targetId: FocusTargetId) {
    super(`Pointer "${String(pointerId)}" is already captured by target "${targetId}".`);

    this.name = "PointerAlreadyCapturedError";

    this.pointerId = pointerId;

    this.targetId = targetId;
  }
}

export class PointerCaptureNotFoundError extends Error {
  public readonly pointerId: PointerCaptureId;

  public constructor(pointerId: PointerCaptureId) {
    super(`Pointer capture "${String(pointerId)}" was not found.`);

    this.name = "PointerCaptureNotFoundError";

    this.pointerId = pointerId;
  }
}

export class PointerCaptureTargetMismatchError extends Error {
  public readonly pointerId: PointerCaptureId;

  public readonly expectedTargetId: FocusTargetId;

  public readonly receivedTargetId: FocusTargetId;

  public constructor(
    pointerId: PointerCaptureId,
    expectedTargetId: FocusTargetId,
    receivedTargetId: FocusTargetId,
  ) {
    super(
      `Pointer "${String(pointerId)}" is captured by target "${expectedTargetId}", not "${receivedTargetId}".`,
    );

    this.name = "PointerCaptureTargetMismatchError";

    this.pointerId = pointerId;

    this.expectedTargetId = expectedTargetId;

    this.receivedTargetId = receivedTargetId;
  }
}
