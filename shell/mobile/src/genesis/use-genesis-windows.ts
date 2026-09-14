import type { GenesisWindow, GenesisWindowManager } from "@sevynos/genesis";
import { useSyncExternalStore } from "react";

export function useGenesisWindows(
  windowManager: GenesisWindowManager,
): readonly GenesisWindow[] {
  useSyncExternalStore(
    windowManager.subscribe.bind(windowManager),
    windowManager.getSnapshot.bind(windowManager),
    windowManager.getSnapshot.bind(windowManager),
  );

  return windowManager.getWindows();
}
