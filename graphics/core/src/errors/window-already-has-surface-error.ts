import type { GenesisWindowId } from "../window/genesis-window.js";

export class WindowAlreadyHasSurfaceError extends Error {
  public readonly windowId: GenesisWindowId;

  public constructor(windowId: GenesisWindowId) {
    super(`Window "${windowId}" already has an attached surface.`);

    this.name = "WindowAlreadyHasSurfaceError";

    this.windowId = windowId;
  }
}
