import type { DisplayId } from "../display/display-id.js";

export class DisplayNotFoundError extends Error {
  public readonly displayId: DisplayId;

  public constructor(displayId: DisplayId) {
    super(`Display "${displayId}" was not found.`);

    this.name = "DisplayNotFoundError";

    this.displayId = displayId;
  }
}
