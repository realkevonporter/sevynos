import { describe, expect, it } from "vitest";

import { DisplayRenderPlan } from "../display/display-render-plan.js";
import type { DisplayId } from "../display/display-id.js";
import {
  FrameExecutionResult,
  type FrameRenderFailure,
} from "./frame-execution-result.js";
import type { GenesisRenderer, RendererState } from "./genesis-renderer.js";
import { GenesisFrameExecutor } from "./genesis-frame-executor.js";
import { RenderResult } from "./render-result.js";

interface TestScene {
  readonly id: string;
}

const FIRST_TIME = new Date("2026-07-30T23:00:00.000Z");

const SECOND_TIME = new Date("2026-07-30T23:00:00.016Z");

function createPlan(displayId: DisplayId): DisplayRenderPlan<TestScene> {
  return new DisplayRenderPlan({
    displayId,

    displayBounds: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },

    displayMode: {
      width: 1920,
      height: 1080,
      refreshRate: 60,
    },

    scaleFactor: 1,

    orientation: "landscape",

    scene: {
      id: "scene-1",
    },

    createdAt: FIRST_TIME,
  });
}

class TestRenderer implements GenesisRenderer<TestScene> {
  public state: RendererState = "initialized";

  public readonly renderedDisplayIds: DisplayId[] = [];

  public readonly failingDisplayIds = new Set<DisplayId>();

  #nextFrameNumber = 1;

  public initialize(): void {
    this.state = "initialized";
  }

  public render(plan: DisplayRenderPlan<TestScene>): RenderResult {
    this.renderedDisplayIds.push(plan.displayId);

    if (this.failingDisplayIds.has(plan.displayId)) {
      throw new Error(`Unable to render "${plan.displayId}".`);
    }

    const result = new RenderResult({
      frameNumber: this.#nextFrameNumber,

      displayId: plan.displayId,

      status: "rendered",

      startedAt: FIRST_TIME,

      completedAt: SECOND_TIME,

      commandCount: 1,
    });

    this.#nextFrameNumber += 1;

    return result;
  }

  public shutdown(): void {
    this.state = "shutdown";
  }
}

describe("GenesisFrameExecutor", () => {
  it("executes one render plan", () => {
    const renderer = new TestRenderer();

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [createPlan("display-1")],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    expect(renderer.renderedDisplayIds).toEqual(["display-1"]);

    expect(result.executionNumber).toBe(1);

    expect(result.renderResults).toHaveLength(1);

    expect(result.failures).toHaveLength(0);

    expect(result.succeeded).toBe(true);
  });

  it("renders every planned display in order", () => {
    const renderer = new TestRenderer();

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [
        createPlan("display-1"),

        createPlan("display-2"),

        createPlan("display-3"),
      ],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    expect(renderer.renderedDisplayIds).toEqual(["display-1", "display-2", "display-3"]);

    expect(result.renderResults.map((renderResult) => renderResult.displayId)).toEqual([
      "display-1",
      "display-2",
      "display-3",
    ]);

    expect(result.displayCount).toBe(3);

    expect(result.renderedDisplayCount).toBe(3);

    expect(result.failedDisplayCount).toBe(0);
  });

  it("composes render plans once per execution", () => {
    const renderer = new TestRenderer();

    let calls = 0;

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => {
        calls += 1;

        return [createPlan("display-1"), createPlan("display-2")];
      },

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    executor.executeFrame();

    expect(calls).toBe(1);
  });

  it("returns an empty successful result when no displays require rendering", () => {
    const renderer = new TestRenderer();

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    expect(result.renderResults).toEqual([]);

    expect(result.failures).toEqual([]);

    expect(result.hadWork).toBe(false);

    expect(result.succeeded).toBe(true);

    expect(result.partiallySucceeded).toBe(false);

    expect(result.completelyFailed).toBe(false);
  });

  it("records a failed display without aborting later displays", () => {
    const renderer = new TestRenderer();

    renderer.failingDisplayIds.add("display-2");

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [
        createPlan("display-1"),

        createPlan("display-2"),

        createPlan("display-3"),
      ],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    expect(renderer.renderedDisplayIds).toEqual(["display-1", "display-2", "display-3"]);

    expect(result.renderResults.map((renderResult) => renderResult.displayId)).toEqual([
      "display-1",
      "display-3",
    ]);

    expect(result.failures).toHaveLength(1);

    expect(result.failures[0]?.displayId).toBe("display-2");

    expect(result.succeeded).toBe(false);

    expect(result.partiallySucceeded).toBe(true);

    expect(result.completelyFailed).toBe(false);
  });

  it("reports complete failure when every display fails", () => {
    const renderer = new TestRenderer();

    renderer.failingDisplayIds.add("display-1");

    renderer.failingDisplayIds.add("display-2");

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [createPlan("display-1"), createPlan("display-2")],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    expect(result.renderResults).toHaveLength(0);

    expect(result.failures).toHaveLength(2);

    expect(result.succeeded).toBe(false);

    expect(result.partiallySucceeded).toBe(false);

    expect(result.completelyFailed).toBe(true);
  });

  it("preserves the thrown error", () => {
    const renderer = new TestRenderer();

    renderer.failingDisplayIds.add("display-1");

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [createPlan("display-1")],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const result = executor.executeFrame();

    const error = result.failures[0]?.error;

    expect(error).toBeInstanceOf(Error);

    expect(error).toHaveProperty("message", 'Unable to render "display-1".');
  });

  it("increments execution numbers", () => {
    const renderer = new TestRenderer();

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [createPlan("display-1")],

      renderer,

      now: () => new Date(FIRST_TIME),
    });

    const first = executor.executeFrame();

    const second = executor.executeFrame();

    expect(first.executionNumber).toBe(1);

    expect(second.executionNumber).toBe(2);
  });

  it("measures the complete frame execution duration", () => {
    const renderer = new TestRenderer();

    let calls = 0;

    const executor = new GenesisFrameExecutor({
      createRenderPlans: () => [createPlan("display-1")],

      renderer,

      now: () => {
        calls += 1;

        return new Date(calls === 1 ? FIRST_TIME : SECOND_TIME);
      },
    });

    const result = executor.executeFrame();

    expect(result.startedAt).toEqual(FIRST_TIME);

    expect(result.completedAt).toEqual(SECOND_TIME);

    expect(result.durationMilliseconds).toBe(16);
  });

  it("copies result collections", () => {
    const renderResults = [
      new RenderResult({
        frameNumber: 1,

        displayId: "display-1",

        status: "rendered",

        startedAt: FIRST_TIME,

        completedAt: SECOND_TIME,

        commandCount: 1,
      }),
    ];

    const failures: FrameRenderFailure[] = [];

    const result = new FrameExecutionResult({
      executionNumber: 1,

      startedAt: FIRST_TIME,

      completedAt: SECOND_TIME,

      renderResults,

      failures,
    });

    renderResults.length = 0;

    expect(result.renderResults).toHaveLength(1);
  });
});
