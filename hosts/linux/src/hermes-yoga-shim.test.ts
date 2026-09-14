import { describe, expect, it } from "vitest";
import Yoga, {
  Align,
  Direction,
  FlexDirection,
  Gutter,
  Justify,
  Edge,
  Wrap,
} from "./hermes-yoga-shim.js";

describe("Hermes Yoga compatibility runtime", () => {
  it("lays out flex rows with growth, gaps, alignment, and percentages", () => {
    const root = Yoga.Node.create();
    root.setWidth(300);
    root.setHeight(100);
    root.setFlexDirection(FlexDirection.Row);
    root.setJustifyContent(Justify.FlexStart);
    root.setAlignItems(Align.Center);
    root.setGap(Gutter.Column, 10);
    const fixed = Yoga.Node.create();
    fixed.setWidth(80);
    fixed.setHeightPercent(50);
    const flexible = Yoga.Node.create();
    flexible.setFlexGrow(1);
    flexible.setHeight(20);
    root.insertChild(fixed, 0);
    root.insertChild(flexible, 1);
    root.calculateLayout(300, 100, Direction.LTR);
    expect(fixed.getComputedLayout()).toEqual({
      left: 0,
      top: 25,
      width: 80,
      height: 50,
    });
    expect(flexible.getComputedLayout()).toEqual({
      left: 90,
      top: 40,
      width: 210,
      height: 20,
    });
  });

  it("preserves aspect ratios, margins, and wrapped line gaps", () => {
    const root = Yoga.Node.create();
    root.setWidth(200);
    root.setHeight(100);
    root.setFlexDirection(FlexDirection.Row);
    root.setAlignItems(Align.FlexStart);
    root.setFlexWrap(Wrap.Wrap);
    root.setGap(Gutter.Column, 10);
    root.setGap(Gutter.Row, 8);
    const first = Yoga.Node.create();
    first.setWidth(120);
    first.setHeight(20);
    first.setMargin(Edge.Right, 5);
    const second = Yoga.Node.create();
    second.setWidth(90);
    second.setAspectRatio(3);
    second.setMargin(Edge.Left, 4);
    root.insertChild(first, 0);
    root.insertChild(second, 1);

    root.calculateLayout(200, 100, Direction.LTR);

    expect(first.getComputedLayout()).toEqual({
      left: 0,
      top: 0,
      width: 120,
      height: 20,
    });
    expect(second.getComputedLayout()).toEqual({
      left: 4,
      top: 28,
      width: 90,
      height: 30,
    });
  });
});
