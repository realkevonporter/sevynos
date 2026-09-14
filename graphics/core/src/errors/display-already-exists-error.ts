import type { DisplayId } from "../display/display-id.js";

export class DisplayAlreadyExistsError extends Error {
  public readonly displayId: DisplayId;

  public constructor(displayId: DisplayId) {
    super(`Display "${displayId}" already exists.`);

    this.name = "DisplayAlreadyExistsError";

    this.displayId = displayId;
  }
}
