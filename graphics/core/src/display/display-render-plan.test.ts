import { describe, expect, it } from "vitest";

import { DisplayRenderPlan } from "./display-render-plan.js";

const CREATED_AT = new Date("2026-07-30T21:00:00.000Z");

interface TestScene {
  readonly name: string;
}

function createPlan(): DisplayRenderPlan<TestScene> {
  return new DisplayRenderPlan({
    displayId: "display-1",

    displayBounds: {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    },

    displayMode: {
      width: 3840,
      height: 2160,
      refreshRate: 60,
    },

    scaleFactor: 2,

    orientation: "landscape",

    scene: {
      name: "test-scene",
    },

    createdAt: CREATED_AT,
  });
}

describe("DisplayRenderPlan", () => {
  it("creates a display render plan", () => {
    const plan = createPlan();

    expect(plan.displayId).toBe("display-1");

    expect(plan.displayBounds).toEqual({
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    });

    expect(plan.displayMode).toEqual({
      width: 3840,
      height: 2160,
      refreshRate: 60,
    });

    expect(plan.scaleFactor).toBe(2);

    expect(plan.orientation).toBe("landscape");

    expect(plan.scene).toEqual({
      name: "test-scene",
    });

    expect(plan.createdAt).toEqual(CREATED_AT);
  });

  it("copies mutable display values", () => {
    const bounds = {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    };

    const mode = {
      width: 1920,
      height: 1080,
      refreshRate: 60,
    };

    const createdAt = new Date(CREATED_AT);

    const plan = new DisplayRenderPlan({
      displayId: "display-1",

      displayBounds: bounds,

      displayMode: mode,

      scaleFactor: 1,

      orientation: "landscape",

      scene: {
        name: "test-scene",
      },

      createdAt,
    });

    bounds.width = 800;
    mode.width = 800;

    createdAt.setFullYear(2030);

    expect(plan.displayBounds.width).toBe(1920);

    expect(plan.displayMode.width).toBe(1920);

    expect(plan.createdAt).toEqual(CREATED_AT);
  });

  it.each([
    {
      x: -1920,
      y: 0,
      expected: true,
    },
    {
      x: -1,
      y: 1079,
      expected: true,
    },
    {
      x: 0,
      y: 0,
      expected: false,
    },
    {
      x: -1921,
      y: 0,
      expected: false,
    },
    {
      x: -100,
      y: 1080,
      expected: false,
    },
  ])(
    "checks whether global point ($x, $y) belongs to the display",
    ({ x, y, expected }) => {
      expect(createPlan().containsPoint(x, y)).toBe(expected);
    },
  );

  it("converts global coordinates to display-local coordinates", () => {
    const plan = createPlan();

    expect(plan.toDisplayCoordinates(-1820, 50)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("converts global coordinates to physical coordinates", () => {
    const plan = createPlan();

    expect(plan.toPhysicalCoordinates(-1820, 50)).toEqual({
      x: 200,
      y: 100,
    });
  });
});
