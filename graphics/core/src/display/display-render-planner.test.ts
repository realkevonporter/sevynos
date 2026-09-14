import { describe, expect, it } from "vitest";

import { DisplayRegistry } from "./display-registry.js";
import { DisplayRenderPlanner } from "./display-render-planner.js";
import { GenesisDisplay } from "./genesis-display.js";

const CREATED_AT = new Date("2026-07-30T21:00:00.000Z");

interface TestScene {
  readonly id: string;
}

function createDisplay(
  id: `display-${string}`,
  state: "connected" | "active" | "disconnected",
): GenesisDisplay {
  return new GenesisDisplay({
    id,

    name: `Display ${id}`,

    bounds: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },

    mode: {
      width: 1920,
      height: 1080,
      refreshRate: 60,
    },

    scaleFactor: 1,

    orientation: "landscape",

    state,

    primary: id === "display-1",

    createdAt: CREATED_AT,
  });
}

describe("DisplayRenderPlanner", () => {
  it("creates one render plan for every active display", () => {
    const displays = new DisplayRegistry();

    const first = createDisplay("display-1", "active");

    const second = createDisplay("display-2", "connected");

    const third = createDisplay("display-3", "active");

    const fourth = createDisplay("display-4", "disconnected");

    displays.add(first);
    displays.add(second);
    displays.add(third);
    displays.add(fourth);

    const planner = new DisplayRenderPlanner({
      displays,

      now: () => new Date(CREATED_AT),
    });

    const scene: TestScene = {
      id: "scene-1",
    };

    const plans = planner.createRenderPlans(scene);

    expect(plans).toHaveLength(2);

    expect(plans.map((plan) => plan.displayId)).toEqual([first.id, third.id]);

    expect(plans.every((plan) => plan.scene === scene)).toBe(true);
  });

  it("returns no plans when no displays are active", () => {
    const displays = new DisplayRegistry();

    displays.add(createDisplay("display-1", "connected"));

    displays.add(createDisplay("display-2", "disconnected"));

    const planner = new DisplayRenderPlanner({
      displays,

      now: () => new Date(CREATED_AT),
    });

    expect(
      planner.createRenderPlans({
        id: "scene-1",
      }),
    ).toEqual([]);
  });

  it("preserves active display insertion order", () => {
    const displays = new DisplayRegistry();

    const first = createDisplay("display-3", "active");

    const second = createDisplay("display-1", "active");

    displays.add(first);
    displays.add(second);

    const planner = new DisplayRenderPlanner({
      displays,

      now: () => new Date(CREATED_AT),
    });

    expect(
      planner
        .createRenderPlans({
          id: "scene-1",
        })
        .map((plan) => plan.displayId),
    ).toEqual(["display-3", "display-1"]);
  });

  it("uses one timestamp for the entire planning pass", () => {
    const displays = new DisplayRegistry();

    displays.add(createDisplay("display-1", "active"));

    displays.add(createDisplay("display-2", "active"));

    let calls = 0;

    const planner = new DisplayRenderPlanner({
      displays,

      now: () => {
        calls += 1;

        return new Date(CREATED_AT);
      },
    });

    const plans = planner.createRenderPlans({
      id: "scene-1",
    });

    expect(calls).toBe(1);

    expect(plans[0]?.createdAt).toEqual(CREATED_AT);

    expect(plans[1]?.createdAt).toEqual(CREATED_AT);
  });

  it("copies display configuration into each plan", () => {
    const displays = new DisplayRegistry();

    const display = new GenesisDisplay({
      id: "display-1",

      name: "Retina Display",

      bounds: {
        x: -1440,
        y: 0,
        width: 1440,
        height: 900,
      },

      mode: {
        width: 2880,
        height: 1800,
        refreshRate: 60,
      },

      scaleFactor: 2,

      orientation: "landscape",

      state: "active",

      primary: true,

      createdAt: CREATED_AT,
    });

    displays.add(display);

    const planner = new DisplayRenderPlanner({
      displays,

      now: () => new Date(CREATED_AT),
    });

    const plan = planner.createRenderPlans({
      id: "scene-1",
    })[0];

    expect(plan).toBeDefined();

    expect(plan?.displayBounds).toEqual(display.bounds);

    expect(plan?.displayMode).toEqual(display.mode);

    expect(plan?.scaleFactor).toBe(2);

    expect(plan?.orientation).toBe("landscape");
  });
});
