import { describe, expect, it } from "vitest";

import { SceneHitTester, type SceneHitTestNodeAdapter } from "./scene-hit-tester.js";

interface TestSceneNode {
  readonly id: string;

  readonly bounds: {
    readonly x: number;

    readonly y: number;

    readonly width: number;

    readonly height: number;
  };

  readonly zIndex: number;

  readonly visible: boolean;

  readonly interactive: boolean;

  readonly children: readonly TestSceneNode[];
}

function createNode(options: {
  readonly id: string;

  readonly x?: number;

  readonly y?: number;

  readonly width?: number;

  readonly height?: number;

  readonly zIndex?: number;

  readonly visible?: boolean;

  readonly interactive?: boolean;

  readonly children?: readonly TestSceneNode[];
}): TestSceneNode {
  return {
    id: options.id,

    bounds: {
      x: options.x ?? 0,

      y: options.y ?? 0,

      width: options.width ?? 400,

      height: options.height ?? 300,
    },

    zIndex: options.zIndex ?? 0,

    visible: options.visible ?? true,

    interactive: options.interactive ?? true,

    children: options.children ?? [],
  };
}

const adapter: SceneHitTestNodeAdapter<TestSceneNode> = {
  getId: (node) => node.id,

  getBounds: (node) => node.bounds,

  getZIndex: (node) => node.zIndex,

  getChildren: (node) => node.children,

  isVisible: (node) => node.visible,

  acceptsPointerInput: (node) => node.interactive,
};

describe("SceneHitTester", () => {
  it("returns undefined when nothing is hit", () => {
    const tester = new SceneHitTester({
      getRootNodes: () => [
        createNode({
          id: "window",
        }),
      ],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 1000,

        y: 1000,
      }),
    ).toBeUndefined();
  });

  it("returns a root node under the point", () => {
    const window = createNode({
      id: "window",
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [window],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 100,

        y: 100,
      })?.node,
    ).toBe(window);
  });

  it("returns coordinates local to the hit node", () => {
    const node = createNode({
      id: "window",

      x: 100,

      y: 50,
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [node],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 125,

        y: 90,
      })?.localPoint,
    ).toEqual({
      x: 25,

      y: 40,
    });
  });

  it("traverses child nodes using parent-relative coordinates", () => {
    const button = createNode({
      id: "button",

      x: 20,

      y: 30,

      width: 100,

      height: 40,
    });

    const window = createNode({
      id: "window",

      x: 100,

      y: 50,

      children: [button],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [window],

      adapter,
    });

    const result = tester.hitTest({
      x: 140,

      y: 100,
    });

    expect(result?.nodeId).toBe("button");

    expect(result?.localPoint).toEqual({
      x: 20,

      y: 20,
    });
  });

  it("prefers deeper descendants when z-indexes match", () => {
    const button = createNode({
      id: "button",

      x: 20,

      y: 20,

      width: 100,

      height: 50,
    });

    const window = createNode({
      id: "window",

      children: [button],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [window],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 40,

        y: 40,
      })?.nodeId,
    ).toBe("button");
  });

  it("prefers the highest z-index", () => {
    const lower = createNode({
      id: "lower",

      zIndex: 1,
    });

    const upper = createNode({
      id: "upper",

      zIndex: 10,
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [upper, lower],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 100,

        y: 100,
      })?.nodeId,
    ).toBe("upper");
  });

  it("ignores invisible nodes and their descendants", () => {
    const button = createNode({
      id: "button",
    });

    const hiddenWindow = createNode({
      id: "window",

      visible: false,

      children: [button],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [hiddenWindow],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 100,

        y: 100,
      }),
    ).toBeUndefined();
  });

  it("allows non-interactive containers to contain interactive children", () => {
    const button = createNode({
      id: "button",

      x: 20,

      y: 20,

      width: 100,

      height: 50,
    });

    const container = createNode({
      id: "container",

      interactive: false,

      children: [button],
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [container],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 40,

        y: 40,
      })?.nodeId,
    ).toBe("button");
  });

  it("returns all hits from top to bottom", () => {
    const first = createNode({
      id: "first",

      zIndex: 1,
    });

    const second = createNode({
      id: "second",

      zIndex: 2,
    });

    const third = createNode({
      id: "third",

      zIndex: 3,
    });

    const tester = new SceneHitTester({
      getRootNodes: () => [first, third, second],

      adapter,
    });

    expect(
      tester
        .hitTestAll({
          x: 100,

          y: 100,
        })
        .map((result) => result.nodeId),
    ).toEqual(["third", "second", "first"]);
  });

  it("includes left and top edges", () => {
    const tester = new SceneHitTester({
      getRootNodes: () => [
        createNode({
          id: "node",

          x: 100,

          y: 50,

          width: 200,

          height: 100,
        }),
      ],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 100,

        y: 50,
      })?.nodeId,
    ).toBe("node");
  });

  it("excludes right and bottom edges", () => {
    const tester = new SceneHitTester({
      getRootNodes: () => [
        createNode({
          id: "node",

          x: 100,

          y: 50,

          width: 200,

          height: 100,
        }),
      ],

      adapter,
    });

    expect(
      tester.hitTest({
        x: 300,

        y: 100,
      }),
    ).toBeUndefined();

    expect(
      tester.hitTest({
        x: 200,

        y: 150,
      }),
    ).toBeUndefined();
  });

  it("returns immutable results", () => {
    const tester = new SceneHitTester({
      getRootNodes: () => [
        createNode({
          id: "node",
        }),
      ],

      adapter,
    });

    const results = tester.hitTestAll({
      x: 100,

      y: 100,
    });

    expect(Object.isFrozen(results)).toBe(true);

    expect(Object.isFrozen(results[0])).toBe(true);

    expect(Object.isFrozen(results[0]?.point)).toBe(true);

    expect(Object.isFrozen(results[0]?.localPoint)).toBe(true);
  });

  it.each([
    {
      x: Number.NaN,

      y: 0,
    },
    {
      x: 0,

      y: Number.POSITIVE_INFINITY,
    },
  ])("rejects invalid point $x, $y", (point) => {
    const tester = new SceneHitTester({
      getRootNodes: () => [],

      adapter,
    });

    expect(() => {
      tester.hitTest(point);
    }).toThrow("Hit-test coordinates must be finite numbers.");
  });
});
