import type { GenesisWindowId } from "@sevynos/graphics";
import type { PointerCaptureId } from "../input/pointer-capture.js";

export class WindowDragAlreadyActiveError extends Error {
  public readonly pointerId: PointerCaptureId;

  public readonly windowId: GenesisWindowId;

  public constructor(pointerId: PointerCaptureId, windowId: GenesisWindowId) {
    super(`Pointer "${String(pointerId)}" is already dragging window "${windowId}".`);

    this.name = "WindowDragAlreadyActiveError";

    this.pointerId = pointerId;

    this.windowId = windowId;
  }
}

export class WindowDragNotFoundError extends Error {
  public readonly pointerId: PointerCaptureId;

  public constructor(pointerId: PointerCaptureId) {
    super(`No active window drag exists for pointer "${String(pointerId)}".`);

    this.name = "WindowDragNotFoundError";

    this.pointerId = pointerId;
  }
}

export class WindowDragWindowNotFoundError extends Error {
  public readonly windowId: GenesisWindowId;

  public constructor(windowId: GenesisWindowId) {
    super(`Window "${windowId}" was not found while starting a drag.`);

    this.name = "WindowDragWindowNotFoundError";

    this.windowId = windowId;
  }
}

export class WindowDragPointerCaptureError extends Error {
  public readonly pointerId: PointerCaptureId;

  public readonly windowId: GenesisWindowId;

  public override readonly cause: unknown;

  public constructor(
    pointerId: PointerCaptureId,
    windowId: GenesisWindowId,
    cause: unknown,
  ) {
    super(
      `Pointer "${String(pointerId)}" could not capture window "${windowId}" for dragging.`,
      {
        cause,
      },
    );

    this.name = "WindowDragPointerCaptureError";

    this.pointerId = pointerId;

    this.windowId = windowId;

    this.cause = cause;
  }
}

export class WindowDragMoveError extends Error {
  public readonly pointerId: PointerCaptureId;

  public readonly windowId: GenesisWindowId;

  public override readonly cause: unknown;

  public constructor(
    pointerId: PointerCaptureId,
    windowId: GenesisWindowId,
    cause: unknown,
  ) {
    super(`Window "${windowId}" could not be moved for pointer "${String(pointerId)}".`, {
      cause,
    });

    this.name = "WindowDragMoveError";

    this.pointerId = pointerId;

    this.windowId = windowId;

    this.cause = cause;
  }
}
