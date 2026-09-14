import type { SceneNode } from "@sevynos/graphics";
import type { SceneHitTestBounds, SceneHitTestNodeAdapter } from "./scene-hit-tester.js";

export interface SceneNodeHitTestAdapterOptions {
  readonly acceptsPointerInput?: (node: SceneNode) => boolean;

  readonly isVisible?: (node: SceneNode) => boolean;
}

function hasBounds(node: SceneNode): node is SceneNode & {
  readonly bounds: SceneHitTestBounds;
} {
  return "bounds" in node;
}

function hasZIndex(node: SceneNode): node is SceneNode & {
  readonly zIndex: number;
} {
  return "zIndex" in node;
}

function hasChildren(node: SceneNode): node is SceneNode & {
  readonly children: readonly SceneNode[];
} {
  return "children" in node;
}

function hasVisibility(node: SceneNode): node is SceneNode & {
  readonly visible: boolean;
} {
  return "visible" in node;
}

function defaultAcceptsPointerInput(node: SceneNode): boolean {
  return hasBounds(node);
}

function defaultIsVisible(node: SceneNode): boolean {
  if (!hasVisibility(node)) {
    return true;
  }

  return node.visible;
}

export function createSceneNodeHitTestAdapter(
  options: SceneNodeHitTestAdapterOptions = {},
): SceneHitTestNodeAdapter<SceneNode> {
  const acceptsPointerInput = options.acceptsPointerInput ?? defaultAcceptsPointerInput;

  const isVisible = options.isVisible ?? defaultIsVisible;

  return {
    getId: (node) => node.id,

    getBounds: (node) => (hasBounds(node) ? node.bounds : undefined),

    getZIndex: (node) => (hasZIndex(node) ? node.zIndex : 0),

    getChildren: (node) => (hasChildren(node) ? node.children : []),

    isVisible,

    acceptsPointerInput,
  };
}
