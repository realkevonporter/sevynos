import { describe, expect, it } from "vitest";
import { PresentationFrameScheduler } from "./presentation-frame-scheduler.js";

describe("presentation frame scheduler", () => {
  it("coalesces a focus turn into one submitted latest-state frame", () => {
    const callbacks: (() => void)[] = [];
    const traces: (string | undefined)[] = [];
    const scheduler = new PresentationFrameScheduler({
      executeFrame: (traceId) => {
        traces.push(traceId);
        return true;
      },
      schedule: (callback) => callbacks.push(callback),
    });

    scheduler.invalidate("focus-1");
    scheduler.invalidate("focus-1");
    scheduler.invalidate("focus-1");
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();

    expect(traces).toEqual(["focus-1"]);
    expect(scheduler.snapshot).toMatchObject({
      frameInFlight: true,
      submittedFrameCount: 1,
      maximumScheduledCallbacks: 1,
    });
  });

  it("schedules at most one follow-up when state changes during rendering", () => {
    const callbacks: (() => void)[] = [];
    let executions = 0;
    const scheduler = new PresentationFrameScheduler({
      executeFrame: () => {
        executions += 1;
        scheduler.invalidate();
        scheduler.invalidate();
        return true;
      },
      schedule: (callback) => callbacks.push(callback),
    });
    scheduler.invalidate();
    callbacks.shift()?.();
    expect(callbacks).toHaveLength(0);
    expect(scheduler.snapshot.dirty).toBe(true);

    scheduler.framePresented();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    expect(executions).toBe(2);
  });

  it("keeps an unbounded invalidation burst to one callback and one dirty frame", () => {
    const callbacks: (() => void)[] = [];
    const scheduler = new PresentationFrameScheduler({
      executeFrame: () => true,
      schedule: (callback) => callbacks.push(callback),
    });
    for (let index = 0; index < 10_000; index += 1) scheduler.invalidate();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()?.();
    for (let index = 0; index < 10_000; index += 1) scheduler.invalidate();
    expect(callbacks).toHaveLength(0);
    expect(scheduler.snapshot).toMatchObject({ dirty: true, frameInFlight: true });
    scheduler.framePresented();
    expect(callbacks).toHaveLength(1);
  });
});
