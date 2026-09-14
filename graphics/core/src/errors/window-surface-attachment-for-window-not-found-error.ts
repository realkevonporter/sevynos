import type { GenesisWindowId } from "../window/genesis-window.js";

export class WindowSurfaceAttachmentForWindowNotFoundError extends Error {
  public readonly windowId: GenesisWindowId;

  public constructor(windowId: GenesisWindowId) {
    super(`No surface attachment was found for window "${windowId}".`);

    this.name = "WindowSurfaceAttachmentForWindowNotFoundError";

    this.windowId = windowId;
  }
}
