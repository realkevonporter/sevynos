import type { FocusTargetId } from "../input/focus-state.js";

export class PointerFocusTargetNotRegisteredError extends Error {
  public readonly targetId: FocusTargetId;

  public constructor(targetId: FocusTargetId) {
    super(
      `Pointer hit window "${targetId}", but it is not registered as a focus target.`,
    );

    this.name = "PointerFocusTargetNotRegisteredError";

    this.targetId = targetId;
  }
}
