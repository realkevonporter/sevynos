import { describe, expect, it } from "vitest";

import { WindowResizeEdgeDetector } from "./window-resize-edge-detector.js";

const BOUNDS = {
  x: 100,
  y: 50,
  width: 800,
  height: 600,
} as const;

describe("WindowResizeEdgeDetector", () => {
  it("detects the top edge", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 500,
          y: 52,
        },
        BOUNDS,
      ),
    ).toBe("top");
  });

  it("detects the right edge", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 897,
          y: 300,
        },
        BOUNDS,
      ),
    ).toBe("right");
  });

  it("detects the bottom edge", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 500,
          y: 647,
        },
        BOUNDS,
      ),
    ).toBe("bottom");
  });

  it("detects the left edge", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 102,
          y: 300,
        },
        BOUNDS,
      ),
    ).toBe("left");
  });

  it.each([
    {
      point: {
        x: 102,
        y: 52,
      },

      edge: "top-left",
    },
    {
      point: {
        x: 897,
        y: 52,
      },

      edge: "top-right",
    },
    {
      point: {
        x: 102,
        y: 647,
      },

      edge: "bottom-left",
    },
    {
      point: {
        x: 897,
        y: 647,
      },

      edge: "bottom-right",
    },
  ] as const)("detects $edge", ({ point, edge }) => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(detector.detect(point, BOUNDS)).toBe(edge);
  });

  it("returns undefined inside the content region", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 500,
          y: 300,
        },
        BOUNDS,
      ),
    ).toBeUndefined();
  });

  it("returns undefined outside the window", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 50,
          y: 50,
        },
        BOUNDS,
      ),
    ).toBeUndefined();
  });

  it("includes the left and top boundaries", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 100,
          y: 50,
        },
        BOUNDS,
      ),
    ).toBe("top-left");
  });

  it("excludes the right and bottom boundaries", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(
      detector.detect(
        {
          x: 900,
          y: 300,
        },
        BOUNDS,
      ),
    ).toBeUndefined();

    expect(
      detector.detect(
        {
          x: 500,
          y: 650,
        },
        BOUNDS,
      ),
    ).toBeUndefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid border size %s",
    (borderSize) => {
      expect(() => {
        new WindowResizeEdgeDetector({
          borderSize,
        });
      }).toThrow("Window resize border size must be a positive finite number.");
    },
  );

  it("rejects invalid pointer coordinates", () => {
    const detector = new WindowResizeEdgeDetector({
      borderSize: 8,
    });

    expect(() => {
      detector.detect(
        {
          x: Number.NaN,

          y: 100,
        },
        BOUNDS,
      );
    }).toThrow("Window resize point must contain finite coordinates.");
  });
});
