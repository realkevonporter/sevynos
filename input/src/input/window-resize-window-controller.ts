import type { GenesisWindow, GenesisWindowId, WindowBounds } from "@sevynos/graphics";

export interface WindowResizeWindowController {
  getWindow(windowId: GenesisWindowId): GenesisWindow | undefined;

  resizeWindow(options: {
    readonly windowId: GenesisWindowId;

    readonly bounds: WindowBounds;

    readonly minimumWidth?: number;

    readonly minimumHeight?: number;
  }): GenesisWindow;
}
