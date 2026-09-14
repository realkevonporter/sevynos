import { describe, expect, it } from "vitest";

import { DisplayRenderPlan } from "../display/display-render-plan.js";
import {
  RendererAlreadyInitializedError,
  RendererNotInitializedError,
  RendererShutdownError,
} from "../errors/renderer-errors.js";
import { SoftwareRenderer } from "./software-renderer.js";

interface TestScene {
  readonly commands: readonly string[];
}

const FIRST_TIME = new Date("2026-07-30T22:00:00.000Z");

const SECOND_TIME = new Date("2026-07-30T22:00:00.010Z");

function createPlan(
  scene: TestScene = {
    commands: ["clear", "draw-window"],
  },
): DisplayRenderPlan<TestScene> {
  return new DisplayRenderPlan({
    displayId: "display-1",

    displayBounds: {
      x: 0,
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

    scene,

    createdAt: FIRST_TIME,
  });
}

describe("SoftwareRenderer", () => {
  it("starts in the created state", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    expect(renderer.state).toBe("created");
  });

  it("initializes the renderer", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();

    expect(renderer.state).toBe("initialized");
  });

  it("rejects repeated initialization", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();

    expect(() => {
      renderer.initialize();
    }).toThrow(RendererAlreadyInitializedError);
  });

  it("rejects rendering before initialization", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    expect(() => {
      renderer.render(createPlan());
    }).toThrow(RendererNotInitializedError);
  });

  it("renders a display plan", () => {
    let call = 0;

    const renderer = new SoftwareRenderer<TestScene>({
      now: () => {
        call += 1;

        return new Date(call === 1 ? FIRST_TIME : SECOND_TIME);
      },

      buildCommands: (scene) => scene.commands,
    });

    renderer.initialize();

    const result = renderer.render(createPlan());

    expect(result.frameNumber).toBe(1);

    expect(result.displayId).toBe("display-1");

    expect(result.status).toBe("rendered");

    expect(result.commandCount).toBe(2);

    expect(result.durationMilliseconds).toBe(10);
  });

  it("creates a physical render target from the display mode", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();

    renderer.render(createPlan());

    const record = renderer.listRecords()[0];

    expect(record).toBeDefined();

    expect(record?.frame.target.width).toBe(3840);

    expect(record?.frame.target.height).toBe(2160);

    expect(record?.frame.target.scaleFactor).toBe(2);
  });

  it("records generated render commands", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),

      buildCommands: (scene) => scene.commands,
    });

    renderer.initialize();

    renderer.render(
      createPlan({
        commands: ["clear:black", "draw:window-1", "present"],
      }),
    );

    expect(renderer.listRecords()[0]?.commands).toEqual([
      "clear:black",
      "draw:window-1",
      "present",
    ]);
  });

  it("increments frame numbers", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();

    const first = renderer.render(createPlan());

    const second = renderer.render(createPlan());

    expect(first.frameNumber).toBe(1);

    expect(second.frameNumber).toBe(2);
  });

  it("returns independent record arrays", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();

    renderer.render(createPlan());

    const first = renderer.listRecords();

    const second = renderer.listRecords();

    expect(first).not.toBe(second);

    expect(first).toHaveLength(1);
  });

  it("shuts down the renderer", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();
    renderer.shutdown();

    expect(renderer.state).toBe("shutdown");
  });

  it("rejects rendering after shutdown", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();
    renderer.shutdown();

    expect(() => {
      renderer.render(createPlan());
    }).toThrow(RendererNotInitializedError);
  });

  it("rejects repeated shutdown", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.initialize();
    renderer.shutdown();

    expect(() => {
      renderer.shutdown();
    }).toThrow(RendererShutdownError);
  });

  it("rejects initialization after shutdown", () => {
    const renderer = new SoftwareRenderer<TestScene>({
      now: () => new Date(FIRST_TIME),
    });

    renderer.shutdown();

    expect(() => {
      renderer.initialize();
    }).toThrow(RendererShutdownError);
  });
});
