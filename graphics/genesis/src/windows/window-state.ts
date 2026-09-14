export const GenesisWindowState = {
  Foreground: "foreground",
  Background: "background",
  Minimized: "minimized",
} as const;

export type GenesisWindowState =
  (typeof GenesisWindowState)[keyof typeof GenesisWindowState];

export interface GenesisWindow {
  readonly id: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly bounds: SceneNodeBounds;
  readonly state: GenesisWindowState;
  readonly zIndex: number;
}
import type { SceneNodeBounds } from "../scene";
