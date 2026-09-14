import { describe, expect, it } from "vitest";
import { computeYogaLayout } from "./yoga-engine.js";
import type { NativeHostNode, NativeBounds } from "./native-types.js";

describe("Meta Yoga Layout Engine Integration", () => {
  it("calculates exact Flexbox layout with row direction, gap, and flexGrow", () => {
    const parent: NativeHostNode = {
      id: "root",
      kind: "host",
      type: "view",
      props: {},
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    const c1: NativeHostNode = {
      id: "c1",
      kind: "host",
      type: "view",
      props: { style: { width: 150, height: 80 } },
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    const c2: NativeHostNode = {
      id: "c2",
      kind: "host",
      type: "view",
      props: { style: { flexGrow: 1, height: 80 } },
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    const content: NativeBounds = { x: 50, y: 100, width: 600, height: 400 };
    const style = {
      flexDirection: "row" as const,
      gap: 20,
      alignItems: "center" as const,
    };

    const layoutMap = computeYogaLayout(parent, content, style, [c1, c2]);

    expect(layoutMap.size).toBe(2);

    const b1 = layoutMap.get("c1");
    expect(b1).toBeDefined();
    expect(b1?.x).toBe(50);
    expect(b1?.width).toBe(150);
    expect(b1?.height).toBe(80);
    expect(b1?.y).toBe(260);

    const b2 = layoutMap.get("c2");
    expect(b2).toBeDefined();
    expect(b2?.x).toBe(220);
    expect(b2?.width).toBe(430);
    expect(b2?.y).toBe(260);
  });

  it("does not squish children inside a scroll view container", () => {
    const parent: NativeHostNode = {
      id: "scroll-parent",
      kind: "host",
      type: "scroll",
      props: {},
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    const c1: NativeHostNode = {
      id: "item1",
      kind: "host",
      type: "view",
      props: { style: { height: 300, width: 400 } },
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    const c2: NativeHostNode = {
      id: "item2",
      kind: "host",
      type: "view",
      props: { style: { height: 400, width: 400 } },
      children: [],
      dirty: false,
      hidden: false,
      revision: 1,
    };

    // Parent container viewport is only 200px tall
    const content: NativeBounds = { x: 0, y: 0, width: 400, height: 200 };
    const style = {
      flexDirection: "column" as const,
      overflow: "scroll" as const,
    };

    const layoutMap = computeYogaLayout(parent, content, style, [c1, c2]);

    expect(layoutMap.size).toBe(2);

    const b1 = layoutMap.get("item1");
    expect(b1).toBeDefined();
    expect(b1?.y).toBe(0);
    expect(b1?.height).toBe(300); // Retains full 300px height, not shrunk to fit 200px

    const b2 = layoutMap.get("item2");
    expect(b2).toBeDefined();
    expect(b2?.y).toBe(300); // Positioned directly after item1
    expect(b2?.height).toBe(400); // Retains full 400px height
  });
});
