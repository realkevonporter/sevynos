import type { FocusTargetId } from "../input/focus-state.js";

export class FocusTargetNotRegisteredError extends Error {
  public readonly targetId: FocusTargetId;

  public constructor(targetId: FocusTargetId) {
    super(`Focus target "${targetId}" is not registered.`);

    this.name = "FocusTargetNotRegisteredError";

    this.targetId = targetId;
  }
}

export class FocusTargetAlreadyRegisteredError extends Error {
  public readonly targetId: FocusTargetId;

  public constructor(targetId: FocusTargetId) {
    super(`Focus target "${targetId}" is already registered.`);

    this.name = "FocusTargetAlreadyRegisteredError";

    this.targetId = targetId;
  }
}
