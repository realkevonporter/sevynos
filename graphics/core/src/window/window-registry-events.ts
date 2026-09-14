import type { GenesisWindow, GenesisWindowId } from "./genesis-window.js";

export type WindowRegistryOperation = "added" | "updated" | "transitioned" | "removed";

export interface WindowRegistryChangedEvent {
  readonly type: "window-registry-changed";

  readonly operation: WindowRegistryOperation;

  readonly windowId: GenesisWindowId;

  readonly window: GenesisWindow | undefined;
}

export interface WindowRegistryClearedEvent {
  readonly type: "window-registry-cleared";

  readonly windowIds: readonly GenesisWindowId[];
}

export type WindowRegistryEvent = WindowRegistryChangedEvent | WindowRegistryClearedEvent;

export type WindowRegistryEventListener = (event: WindowRegistryEvent) => void;
