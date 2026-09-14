import type { GenesisWindow, GenesisWindowId } from "./genesis-window.js";

export interface WindowZOrderController {
  bringToFront(windowId: GenesisWindowId): GenesisWindow;

  normalize(): readonly GenesisWindow[];

  getTopWindow(): GenesisWindow | undefined;
}
