import type { GenesisWindowId } from "../window/genesis-window.js";
import type { WindowBounds } from "../window/window-bounds.js";
import type { SceneNodeId } from "./scene-id.js";

export interface SceneTransform {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDegrees: number;
}

export interface SceneNodeBase {
  readonly id: SceneNodeId;
  readonly opacity: number;
  readonly visible: boolean;
  readonly transform: SceneTransform;
}

export interface WindowSceneNode extends SceneNodeBase {
  readonly kind: "window";
  readonly windowId: GenesisWindowId;
  readonly bounds: WindowBounds;
  readonly zIndex: number;
  readonly focused: boolean;
}

export interface SceneGroupNode extends SceneNodeBase {
  readonly kind: "group";
  readonly children: readonly SceneNode[];
}

export type SceneNode = WindowSceneNode | SceneGroupNode;

export const IDENTITY_SCENE_TRANSFORM: SceneTransform = Object.freeze({
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
  rotationDegrees: 0,
});
