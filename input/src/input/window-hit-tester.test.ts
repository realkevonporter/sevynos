import { describe, expect, it } from "vitest";

import { GenesisWindow, type GenesisWindowId, type WindowState } from "@sevynos/graphics";
import { WindowHitTester } from "./window-hit-tester.js";

const CREATED_AT = new Date("2026-07-31T12:00:00.000Z");

function createWindow(options: {
  readonly id: GenesisWindowId;

  readonly x?: number;

  readonly y?: number;

  readonly width?: number;

  readonly height?: number;

  readonly zIndex?: number;

  readonly state?: WindowState;
}): GenesisWindow {
  return new GenesisWindow({
    id: options.id,

    sessionId: `session-${options.id}`,

    title: `Window ${options.id}`,

    bounds: {
      x: options.x ?? 0,

      y: options.y ?? 0,

      width: options.width ?? 800,

      height: options.height ?? 600,
    },

    state: options.state ?? "visible",

    zIndex: options.zIndex ?? 1,

    createdAt: CREATED_AT,

    updatedAt: CREATED_AT,
  });
}

describe("WindowHitTester", () => {
  it("returns undefined when no window contains the point", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 100,

      width: 400,

      height: 300,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: 50,
        y: 50,
      }),
    ).toBeUndefined();
  });

  it("returns a visible window containing the point", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 50,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    const result = tester.hitTest({
      x: 125,
      y: 90,
    });

    expect(result?.window).toBe(window);

    expect(result?.windowId).toBe("window-1");
  });

  it("returns coordinates relative to the window", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 50,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    const result = tester.hitTest({
      x: 125,
      y: 90,
    });

    expect(result?.localPoint).toEqual({
      x: 25,
      y: 40,
    });
  });

  it("returns the top-most overlapping window", () => {
    const bottom = createWindow({
      id: "window-1",

      zIndex: 1,
    });

    const top = createWindow({
      id: "window-2",

      x: 50,

      y: 50,

      zIndex: 2,
    });

    const tester = new WindowHitTester({
      listWindows: () => [top, bottom],
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      })?.windowId,
    ).toBe("window-2");
  });

  it("does not depend on registry insertion order", () => {
    const top = createWindow({
      id: "window-1",

      zIndex: 10,
    });

    const bottom = createWindow({
      id: "window-2",

      zIndex: 1,
    });

    const tester = new WindowHitTester({
      listWindows: () => [top, bottom],
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      })?.windowId,
    ).toBe("window-1");
  });

  it("supports focused windows", () => {
    const window = createWindow({
      id: "window-1",

      state: "focused",
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 100,
      })?.windowId,
    ).toBe(window.id);
  });

  it.each(["created", "minimized", "hidden", "closing", "closed"] as const)(
    "ignores windows in the %s state",
    (state) => {
      const window = createWindow({
        id: "window-1",

        state,
      });

      const tester = new WindowHitTester({
        listWindows: () => [window],
      });

      expect(
        tester.hitTest({
          x: 100,
          y: 100,
        }),
      ).toBeUndefined();
    },
  );

  it("includes the left and top edges", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 50,

      width: 200,

      height: 100,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: 100,
        y: 50,
      })?.windowId,
    ).toBe(window.id);
  });

  it("excludes the right edge", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 50,

      width: 200,

      height: 100,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: 300,
        y: 100,
      }),
    ).toBeUndefined();
  });

  it("excludes the bottom edge", () => {
    const window = createWindow({
      id: "window-1",

      x: 100,

      y: 50,

      width: 200,

      height: 100,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: 200,
        y: 150,
      }),
    ).toBeUndefined();
  });

  it("supports windows at negative coordinates", () => {
    const window = createWindow({
      id: "window-1",

      x: -500,

      y: -200,

      width: 400,

      height: 300,
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    expect(
      tester.hitTest({
        x: -250,
        y: -100,
      })?.windowId,
    ).toBe(window.id);
  });

  it("returns every hit in top-to-bottom order", () => {
    const first = createWindow({
      id: "window-1",

      zIndex: 1,
    });

    const second = createWindow({
      id: "window-2",

      zIndex: 2,
    });

    const third = createWindow({
      id: "window-3",

      zIndex: 3,
    });

    const tester = new WindowHitTester({
      listWindows: () => [first, third, second],
    });

    expect(
      tester
        .hitTestAll({
          x: 100,
          y: 100,
        })
        .map((result) => result.windowId),
    ).toEqual(["window-3", "window-2", "window-1"]);
  });

  it("returns immutable hit-test results", () => {
    const window = createWindow({
      id: "window-1",
    });

    const tester = new WindowHitTester({
      listWindows: () => [window],
    });

    const result = tester.hitTest({
      x: 100,
      y: 100,
    });

    expect(Object.isFrozen(result)).toBe(true);

    expect(Object.isFrozen(result?.point)).toBe(true);

    expect(Object.isFrozen(result?.localPoint)).toBe(true);
  });

  it("returns immutable hit collections", () => {
    const tester = new WindowHitTester({
      listWindows: () => [
        createWindow({
          id: "window-1",
        }),
      ],
    });

    const results = tester.hitTestAll({
      x: 100,
      y: 100,
    });

    expect(Object.isFrozen(results)).toBe(true);
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
  ])("rejects invalid coordinates $x, $y", (point) => {
    const tester = new WindowHitTester({
      listWindows: () => [],
    });

    expect(() => {
      tester.hitTest(point);
    }).toThrow("Hit-test coordinates must be finite numbers.");
  });
});
