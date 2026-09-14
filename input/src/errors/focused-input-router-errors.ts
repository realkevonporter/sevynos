import type { FocusTargetId } from "../input/focus-state.js";

export class FocusedInputTargetAlreadyRegisteredError extends Error {
  public readonly targetId: FocusTargetId;

  public constructor(targetId: FocusTargetId) {
    super(`Focused input target "${targetId}" is already registered.`);

    this.name = "FocusedInputTargetAlreadyRegisteredError";

    this.targetId = targetId;
  }
}

export class FocusedInputTargetNotFoundError extends Error {
  public readonly targetId: FocusTargetId;

  public constructor(targetId: FocusTargetId) {
    super(`Focused input target "${targetId}" was not found.`);

    this.name = "FocusedInputTargetNotFoundError";

    this.targetId = targetId;
  }
}

export class FocusedInputTargetHandlerError extends Error {
  public readonly targetId: FocusTargetId;

  public override readonly cause: unknown;

  public constructor(targetId: FocusTargetId, cause: unknown) {
    super(`Focused input target "${targetId}" failed while handling an event.`, {
      cause,
    });

    this.name = "FocusedInputTargetHandlerError";

    this.targetId = targetId;

    this.cause = cause;
  }
}
