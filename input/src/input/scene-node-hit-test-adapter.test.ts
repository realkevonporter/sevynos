import { describe, expect, it, vi } from "vitest";

import type { SceneNode } from "@sevynos/graphics";
import { createSceneNodeHitTestAdapter } from "./scene-node-hit-test-adapter.js";
import { SceneHitTester } from "./scene-hit-tester.js";

function createRenderableNode(
  options: {
    readonly id?: string;

    readonly x?: number;

    readonly y?: number;

    readonly width?: number;

    readonly height?: number;

    readonly zIndex?: number;

    readonly visible?: boolean;
  } = {},
): SceneNode {
  const node = {
    id: options.id ?? "surface-1",

    bounds: {
      x: options.x ?? 0,

      y: options.y ?? 0,

      width: options.width ?? 800,

      height: options.height ?? 600,
    },

    zIndex: options.zIndex ?? 1,

    visible: options.visible ?? true,
  };

  return node as unknown as SceneNode;
}

function createGroupNode(
  options: {
    readonly id?: string;

    readonly children?: readonly SceneNode[];

    readonly visible?: boolean;
  } = {},
): SceneNode {
  const node = {
    id: options.id ?? "group-1",

    children: options.children ?? [],

    visible: options.visible ?? true,
  };

  return node as unknown as SceneNode;
}

describe("createSceneNodeHitTestAdapter", () => {
  it("maps node identity", () => {
    const node = createRenderableNode({
      id: "surface-1",
    });

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getId(node)).toBe("surface-1");
  });

  it("returns bounds for renderable nodes", () => {
    const node = createRenderableNode({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getBounds(node)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it("returns undefined bounds for group nodes", () => {
    const group = createGroupNode();

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getBounds(group)).toBeUndefined();
  });

  it("returns z-index for renderable nodes", () => {
    const node = createRenderableNode({
      zIndex: 25,
    });

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getZIndex(node)).toBe(25);
  });

  it("uses zero z-index for group nodes", () => {
    const group = createGroupNode();

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getZIndex(group)).toBe(0);
  });

  it("returns children from group nodes", () => {
    const child = createRenderableNode({
      id: "child-1",
    });

    const group = createGroupNode({
      children: [child],
    });

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getChildren(group)).toEqual([child]);
  });

  it("returns no children for leaf nodes", () => {
    const node = createRenderableNode();

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.getChildren(node)).toEqual([]);
  });

  it("maps explicit visibility", () => {
    const node = createRenderableNode({
      visible: false,
    });

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.isVisible(node)).toBe(false);
  });

  it("treats bounded nodes as pointer-interactive by default", () => {
    const node = createRenderableNode();

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.acceptsPointerInput(node)).toBe(true);
  });

  it("treats unbounded groups as non-interactive by default", () => {
    const group = createGroupNode();

    const adapter = createSceneNodeHitTestAdapter();

    expect(adapter.acceptsPointerInput(group)).toBe(false);
  });

  it("supports custom pointer-input policy", () => {
    const acceptsPointerInput = vi.fn(
      (node: SceneNode) => node.id === "scene-node-interactive",
    );

    const adapter = createSceneNodeHitTestAdapter({
      acceptsPointerInput,
    });

    const interactive = createRenderableNode({
      id: "scene-node-interactive",
    });

    const passive = createRenderableNode({
      id: "scene-node-passive",
    });

    expect(adapter.acceptsPointerInput(interactive)).toBe(true);

    expect(adapter.acceptsPointerInput(passive)).toBe(false);

    expect(acceptsPointerInput).toHaveBeenCalledTimes(2);
  });

  it("traverses children of an unbounded group", () => {
    const child = createRenderableNode({
      id: "child",

      x: 100,

      y: 50,

      width: 200,

      height: 100,

      zIndex: 10,
    });

    const group = createGroupNode({
      id: "root",

      children: [child],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [group],

      adapter: createSceneNodeHitTestAdapter(),
    });

    const result = tester.hitTest({
      x: 125,
      y: 75,
    });

    expect(result?.nodeId).toBe(child.id);

    expect(result?.localPoint).toEqual({
      x: 25,
      y: 25,
    });
  });

  it("does not return an unbounded group as a hit", () => {
    const group = createGroupNode({
      id: "root",
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [group],

      adapter: createSceneNodeHitTestAdapter(),
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      }),
    ).toBeUndefined();
  });

  it("prefers the highest overlapping renderable node", () => {
    const lower = createRenderableNode({
      id: "lower",

      zIndex: 1,
    });

    const upper = createRenderableNode({
      id: "upper",

      zIndex: 2,
    });

    const group = createGroupNode({
      children: [lower, upper],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [group],

      adapter: createSceneNodeHitTestAdapter(),
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      })?.nodeId,
    ).toBe(upper.id);
  });

  it("ignores invisible renderable nodes", () => {
    const node = createRenderableNode({
      visible: false,
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [node],

      adapter: createSceneNodeHitTestAdapter(),
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      }),
    ).toBeUndefined();
  });

  it("ignores descendants of invisible groups", () => {
    const child = createRenderableNode({
      id: "child",
    });

    const group = createGroupNode({
      visible: false,

      children: [child],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [group],

      adapter: createSceneNodeHitTestAdapter(),
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      }),
    ).toBeUndefined();
  });
});
