import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";

export interface PointerWindowActivationController {
  focusWindow(windowId: GenesisWindowId): GenesisWindow;
}
