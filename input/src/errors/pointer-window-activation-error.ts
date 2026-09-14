import type { FocusTargetId } from "../input/focus-state.js";

export class PointerWindowActivationError extends Error {
  public readonly targetId: FocusTargetId;

  public override readonly cause: unknown;

  public constructor(targetId: FocusTargetId, cause: unknown) {
    super(`Pointer could not activate window "${targetId}".`, {
      cause,
    });

    this.name = "PointerWindowActivationError";

    this.targetId = targetId;

    this.cause = cause;
  }
}
