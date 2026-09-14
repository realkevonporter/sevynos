import { describe, expect, it } from "vitest";

import { FrameExecutionResult } from "./frame-execution-result.js";
import { GenesisRenderLoop } from "./genesis-render-loop.js";
import type { RenderLoopEvent } from "./render-loop-events.js";
import {
  RenderLoopAlreadyRunningError,
  RenderLoopNotRunningError,
  RenderLoopStoppedError,
} from "../errors/render-loop-errors.js";

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

describe("GenesisRenderLoop", () => {
  it("starts in the created state", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    expect(loop.state).toBe("created");

    expect(loop.framePending).toBe(false);

    expect(loop.completedFrameCount).toBe(0);

    expect(loop.failedFrameCount).toBe(0);
  });

  it("starts the render loop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();

    expect(loop.state).toBe("running");
  });

  it("rejects repeated starts", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();

    expect(() => {
      loop.start();
    }).toThrow(RenderLoopAlreadyRunningError);
  });

  it("rejects frame requests before start", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    expect(() => {
      loop.requestFrame();
    }).toThrow(RenderLoopNotRunningError);
  });

  it("queues a frame request", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();

    const accepted = loop.requestFrame();

    expect(accepted).toBe(true);

    expect(loop.framePending).toBe(true);
  });

  it("coalesces repeated frame requests", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();

    const first = loop.requestFrame();

    const second = loop.requestFrame();

    const third = loop.requestFrame();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);

    expect(loop.framePending).toBe(true);
  });

  it("does not execute without a pending frame", () => {
    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        return createExecutionResult();
      },
    });

    loop.start();

    const tick = loop.tick();

    expect(tick.executed).toBe(false);

    expect(executions).toBe(0);
  });

  it("executes one pending frame", () => {
    let executions = 0;

    const expected = createExecutionResult();

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        return expected;
      },
    });

    loop.start();
    loop.requestFrame();

    const tick = loop.tick();

    expect(tick.executed).toBe(true);

    expect(tick.result).toBe(expected);

    expect(executions).toBe(1);

    expect(loop.framePending).toBe(false);

    expect(loop.completedFrameCount).toBe(1);

    expect(loop.failedFrameCount).toBe(0);
  });

  it("executes only once for coalesced requests", () => {
    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        return createExecutionResult(executions);
      },
    });

    loop.start();

    loop.requestFrame();
    loop.requestFrame();
    loop.requestFrame();

    const firstTick = loop.tick();

    const secondTick = loop.tick();

    expect(firstTick.executed).toBe(true);

    expect(secondTick.executed).toBe(false);

    expect(executions).toBe(1);
  });

  it("executes later requested frames", () => {
    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        return createExecutionResult(executions);
      },
    });

    loop.start();

    loop.requestFrame();

    const first = loop.tick();

    loop.requestFrame();

    const second = loop.tick();

    expect(first.result?.executionNumber).toBe(1);

    expect(second.result?.executionNumber).toBe(2);

    expect(loop.completedFrameCount).toBe(2);
  });

  it("increments tick numbers even when no frame executes", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();

    const first = loop.tick();

    loop.requestFrame();

    const second = loop.tick();

    const third = loop.tick();

    expect(first.tickNumber).toBe(1);

    expect(second.tickNumber).toBe(2);

    expect(third.tickNumber).toBe(3);
  });

  it("captures frame execution failures", () => {
    const expectedError = new Error("Frame execution failed.");

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        throw expectedError;
      },
    });

    loop.start();
    loop.requestFrame();

    const tick = loop.tick();

    expect(tick.executed).toBe(true);

    expect(tick.result).toBeUndefined();

    expect(tick.error).toBe(expectedError);

    expect(loop.completedFrameCount).toBe(0);

    expect(loop.failedFrameCount).toBe(1);

    expect(loop.framePending).toBe(false);

    expect(loop.state).toBe("running");
  });

  it("continues after a failed frame", () => {
    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        if (executions === 1) {
          throw new Error("First frame failed.");
        }

        return createExecutionResult(executions);
      },
    });

    loop.start();

    loop.requestFrame();

    const first = loop.tick();

    loop.requestFrame();

    const second = loop.tick();

    expect(first.error).toBeInstanceOf(Error);

    expect(second.result?.executionNumber).toBe(2);

    expect(loop.completedFrameCount).toBe(1);

    expect(loop.failedFrameCount).toBe(1);
  });

  it("emits lifecycle and frame events", () => {
    const events: RenderLoopEvent[] = [];

    const result = createExecutionResult();

    const loop = new GenesisRenderLoop({
      executeFrame: () => result,

      onEvent: (event) => {
        events.push(event);
      },
    });

    loop.start();
    loop.requestFrame();
    loop.tick();
    loop.stop();

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "frame-requested",
      "frame-started",
      "frame-completed",
      "stopped",
    ]);
  });

  it("reports whether a request was already pending", () => {
    const events: RenderLoopEvent[] = [];

    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),

      onEvent: (event) => {
        events.push(event);
      },
    });

    loop.start();

    loop.requestFrame();
    loop.requestFrame();

    const requests = events.filter(
      (
        event,
      ): event is Extract<
        RenderLoopEvent,
        {
          readonly type: "frame-requested";
        }
      > => event.type === "frame-requested",
    );

    expect(requests).toHaveLength(2);

    expect(requests[0]?.wasAlreadyPending).toBe(false);

    expect(requests[1]?.wasAlreadyPending).toBe(true);
  });

  it("emits a failed frame event", () => {
    const events: RenderLoopEvent[] = [];

    const expectedError = new Error("Unable to execute frame.");

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        throw expectedError;
      },

      onEvent: (event) => {
        events.push(event);
      },
    });

    loop.start();
    loop.requestFrame();
    loop.tick();

    const failure = events.find(
      (
        event,
      ): event is Extract<
        RenderLoopEvent,
        {
          readonly type: "frame-failed";
        }
      > => event.type === "frame-failed",
    );

    expect(failure?.tickNumber).toBe(1);

    expect(failure?.error).toBe(expectedError);
  });

  it("stops the render loop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();
    loop.requestFrame();
    loop.stop();

    expect(loop.state).toBe("stopped");

    expect(loop.framePending).toBe(false);
  });

  it("rejects stopping before start", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    expect(() => {
      loop.stop();
    }).toThrow(RenderLoopNotRunningError);
  });

  it("rejects repeated stops", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();
    loop.stop();

    expect(() => {
      loop.stop();
    }).toThrow(RenderLoopStoppedError);
  });

  it("rejects restarting after stop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();
    loop.stop();

    expect(() => {
      loop.start();
    }).toThrow(RenderLoopStoppedError);
  });

  it("rejects requests after stop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();
    loop.stop();

    expect(() => {
      loop.requestFrame();
    }).toThrow(RenderLoopStoppedError);
  });

  it("rejects ticks after stop", () => {
    const loop = new GenesisRenderLoop({
      executeFrame: () => createExecutionResult(),
    });

    loop.start();
    loop.stop();

    expect(() => {
      loop.tick();
    }).toThrow(RenderLoopStoppedError);
  });

  it("includes frame counts in the stopped event", () => {
    const events: RenderLoopEvent[] = [];

    let executions = 0;

    const loop = new GenesisRenderLoop({
      executeFrame: () => {
        executions += 1;

        if (executions === 2) {
          throw new Error("Second frame failed.");
        }

        return createExecutionResult(executions);
      },

      onEvent: (event) => {
        events.push(event);
      },
    });

    loop.start();

    loop.requestFrame();
    loop.tick();

    loop.requestFrame();
    loop.tick();

    loop.stop();

    const stopped = events.find(
      (
        event,
      ): event is Extract<
        RenderLoopEvent,
        {
          readonly type: "stopped";
        }
      > => event.type === "stopped",
    );

    expect(stopped?.completedFrameCount).toBe(1);

    expect(stopped?.failedFrameCount).toBe(1);
  });
});
