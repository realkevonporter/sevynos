import type { GenesisWindowId } from "../window/genesis-window.js";

export class WindowNotFoundError extends Error {
  public readonly code = "WINDOW_NOT_FOUND";

  public constructor(windowId: GenesisWindowId) {
    super(`Window "${windowId}" is not registered.`);

    this.name = "WindowNotFoundError";
  }
}
