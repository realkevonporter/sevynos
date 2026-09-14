import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";

export interface WindowDragWindowController {
  getWindow(windowId: GenesisWindowId): GenesisWindow | undefined;

  moveWindow(options: {
    readonly windowId: GenesisWindowId;

    readonly x: number;

    readonly y: number;
  }): GenesisWindow;
}
