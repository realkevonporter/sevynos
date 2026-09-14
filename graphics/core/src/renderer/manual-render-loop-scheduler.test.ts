import { describe, expect, it } from "vitest";

import { FrameExecutionResult } from "./frame-execution-result.js";
import { GenesisRenderLoop } from "./genesis-render-loop.js";
import { ManualRenderLoopScheduler } from "./manual-render-loop-scheduler.js";
import {
  RenderLoopSchedulerAlreadyRunningError,
  RenderLoopSchedulerNotRunningError,
  RenderLoopSchedulerStoppedError,
} from "../errors/render-loop-scheduler-errors.js";
import type { RenderLoopSchedulerEvent } from "./render-loop-scheduler-events.js";

const STARTED_AT = new Date("2026-07-30T23:30:00.000Z");

const COMPLETED_AT = new Date("2026-07-30T23:30:00.016Z");

function createExecutionResult(executionNumber = 1): FrameExecutionResult {
  return new FrameExecutionResult({
    executionNumber,

    startedAt: STARTED_AT,

    completedAt: COMPLETED_AT,

    renderResults: [],

    failures: [],
  });
}

describe("ManualRenderLoopScheduler", () => {
  it("starts in the created state", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    expect(scheduler.state).toBe("created");

    expect(scheduler.stepCount).toBe(0);

    expect(scheduler.successfulStepCount).toBe(0);

    expect(scheduler.failedStepCount).toBe(0);
  });

  it("starts the scheduler", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();

    expect(scheduler.state).toBe("running");
  });

  it("rejects repeated starts", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();

    expect(() => {
      scheduler.start();
    }).toThrow(RenderLoopSchedulerAlreadyRunningError);
  });

  it("rejects stepping before start", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    expect(() => {
      scheduler.step();
    }).toThrow(RenderLoopSchedulerNotRunningError);
  });

  it("drives an empty render-loop tick", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    loop.start();
    scheduler.start();

    const result = scheduler.step();

    expect(result.executed).toBe(false);

    expect(result.tickNumber).toBe(1);

    expect(scheduler.stepCount).toBe(1);

    expect(scheduler.successfulStepCount).toBe(1);

    expect(scheduler.failedStepCount).toBe(0);
  });

  it("executes a requested frame", () => {
    const expected = createExecutionResult();

    const loop = new GenesisRenderLoop({
      executeFrame: () => expected,
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    loop.start();
    scheduler.start();

    loop.requestFrame();

    const result = scheduler.step();

    expect(result.executed).toBe(true);

    expect(result.result).toBe(expected);

    expect(loop.completedFrameCount).toBe(1);
  });

  it("drives multiple deterministic ticks", () => {
    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        return createExecutionResult(executions);
      },
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    loop.start();
    scheduler.start();

    loop.requestFrame();

    const first = scheduler.step();

    const second = scheduler.step();

    loop.requestFrame();

    const third = scheduler.step();

    expect(first.tickNumber).toBe(1);

    expect(first.executed).toBe(true);

    expect(second.tickNumber).toBe(2);

    expect(second.executed).toBe(false);

    expect(third.tickNumber).toBe(3);

    expect(third.executed).toBe(true);

    expect(executions).toBe(2);

    expect(scheduler.stepCount).toBe(3);
  });

  it("treats a captured frame error as a successful scheduler step", () => {
    const expectedError = new Error("Frame failed.");

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        throw expectedError;
      },
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    loop.start();
    scheduler.start();

    loop.requestFrame();

    const result = scheduler.step();

    expect(result.executed).toBe(true);

    expect(result.error).toBe(expectedError);

    expect(scheduler.successfulStepCount).toBe(1);

    expect(scheduler.failedStepCount).toBe(0);

    expect(loop.failedFrameCount).toBe(1);
  });

  it("records and rethrows unexpected driver errors", () => {
    const expectedError = new Error("Driver contract failed.");

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: {
        tick: () => {
          throw expectedError;
        },
      },
    });

    scheduler.start();

    expect(() => {
      scheduler.step();
    }).toThrow(expectedError);

    expect(scheduler.stepCount).toBe(1);

    expect(scheduler.successfulStepCount).toBe(0);

    expect(scheduler.failedStepCount).toBe(1);
  });

  it("continues after an unexpected driver error", () => {
    let calls = 0;

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: {
        tick: () => {
          calls += 1;

          if (calls === 1) {
            throw new Error("First step failed.");
          }

          return {
            tickNumber: calls,
            executed: false,
          };
        },
      },
    });

    scheduler.start();

    expect(() => {
      scheduler.step();
    }).toThrow("First step failed.");

    const second = scheduler.step();

    expect(second.tickNumber).toBe(2);

    expect(scheduler.state).toBe("running");

    expect(scheduler.successfulStepCount).toBe(1);

    expect(scheduler.failedStepCount).toBe(1);
  });

  it("emits scheduler lifecycle events", () => {
    const events: RenderLoopSchedulerEvent[] = [];

    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,

      onEvent: (event) => {
        events.push(event);
      },
    });

    loop.start();
    scheduler.start();

    scheduler.step();
    scheduler.stop();

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "step-started",
      "step-completed",
      "stopped",
    ]);
  });

  it("emits a step-failed event", () => {
    const events: RenderLoopSchedulerEvent[] = [];

    const expectedError = new Error("Unable to drive frame.");

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: {
        tick: () => {
          throw expectedError;
        },
      },

      onEvent: (event) => {
        events.push(event);
      },
    });

    scheduler.start();

    expect(() => {
      scheduler.step();
    }).toThrow(expectedError);

    const failure = events.find(
      (
        event,
      ): event is Extract<
        RenderLoopSchedulerEvent,
        {
          readonly type: "step-failed";
        }
      > => event.type === "step-failed",
    );

    expect(failure?.stepNumber).toBe(1);

    expect(failure?.error).toBe(expectedError);
  });

  it("stops the scheduler", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();
    scheduler.stop();

    expect(scheduler.state).toBe("stopped");
  });

  it("rejects stopping before start", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    expect(() => {
      scheduler.stop();
    }).toThrow(RenderLoopSchedulerNotRunningError);
  });

  it("rejects repeated stops", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();
    scheduler.stop();

    expect(() => {
      scheduler.stop();
    }).toThrow(RenderLoopSchedulerStoppedError);
  });

  it("rejects restarting after stop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();
    scheduler.stop();

    expect(() => {
      scheduler.start();
    }).toThrow(RenderLoopSchedulerStoppedError);
  });

  it("rejects stepping after stop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: loop,
    });

    scheduler.start();
    scheduler.stop();

    expect(() => {
      scheduler.step();
    }).toThrow(RenderLoopSchedulerStoppedError);
  });

  it("includes counts in the stopped event", () => {
    const events: RenderLoopSchedulerEvent[] = [];

    let calls = 0;

    const scheduler = new ManualRenderLoopScheduler({
      frameDriver: {
        tick: () => {
          calls += 1;

          if (calls === 2) {
            throw new Error("Second step failed.");
          }

          return {
            tickNumber: calls,
            executed: false,
          };
        },
      },

      onEvent: (event) => {
        events.push(event);
      },
    });

    scheduler.start();

    scheduler.step();

    expect(() => {
      scheduler.step();
    }).toThrow("Second step failed.");

    scheduler.stop();

    const stopped = events.find(
      (
        event,
      ): event is Extract<
        RenderLoopSchedulerEvent,
        {
          readonly type: "stopped";
        }
      > => event.type === "stopped",
    );

    expect(stopped?.stepCount).toBe(2);

    expect(stopped?.successfulStepCount).toBe(1);

    expect(stopped?.failedStepCount).toBe(1);
  });
});
