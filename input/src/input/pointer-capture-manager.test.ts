import { describe, expect, it } from "vitest";

import {
  PointerAlreadyCapturedError,
  PointerCaptureNotFoundError,
  PointerCaptureTargetMismatchError,
} from "../errors/pointer-capture-errors.js";
import type { PointerCaptureManagerEvent } from "./pointer-capture-events.js";
import { PointerCaptureManager } from "./pointer-capture-manager.js";
import { createPointerInputEvent } from "./pointer-input-event.js";

function createManager(
  options: {
    readonly onEvent?: (event: PointerCaptureManagerEvent) => void;
  } = {},
): PointerCaptureManager {
  return new PointerCaptureManager({
    now: () => 100,

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });
}

function createPointerEvent(
  type: "pointer-move" | "pointer-down" | "pointer-up" | "pointer-cancel",
  pointerId = 1,
) {
  return createPointerInputEvent({
    type,

    eventId: `event-${type}-${String(pointerId)}`,

    deviceId: "mouse-1",

    deviceKind: "mouse",

    timestamp: 200,

    pointerId,

    position: {
      x: 100,
      y: 100,
    },

    button: type === "pointer-down" ? "primary" : "none",

    buttons: type === "pointer-down" ? ["primary"] : [],

    pressure: 0,
  });
}

describe("PointerCaptureManager", () => {
  it("starts without captures", () => {
    const manager = createManager();

    expect(manager.size).toBe(0);

    expect(manager.list()).toEqual([]);
  });

  it("captures a pointer for a target", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    expect(capture.pointerId).toBe(1);

    expect(capture.targetId).toBe("window-1");

    expect(capture.capturedAt).toBe(100);

    expect(manager.get(1)).toBe(capture);

    expect(manager.size).toBe(1);
  });

  it("creates immutable captures", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    expect(Object.isFrozen(capture)).toBe(true);
  });

  it("rejects capturing an already captured pointer", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    expect(() => {
      manager.capture(1, "window-2");
    }).toThrow(PointerAlreadyCapturedError);
  });

  it("supports captures for different pointers", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    manager.capture(2, "window-2");

    expect(manager.size).toBe(2);

    expect(manager.get(1)?.targetId).toBe("window-1");

    expect(manager.get(2)?.targetId).toBe("window-2");
  });

  it("requires an existing capture", () => {
    const manager = createManager();

    expect(() => {
      manager.require(1);
    }).toThrow(PointerCaptureNotFoundError);
  });

  it("checks capture ownership", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    expect(manager.isCapturedBy(1, "window-1")).toBe(true);

    expect(manager.isCapturedBy(1, "window-2")).toBe(false);
  });

  it("asserts capture ownership", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    expect(manager.assertCapturedBy(1, "window-1")).toBe(capture);
  });

  it("rejects incorrect capture ownership", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    expect(() => {
      manager.assertCapturedBy(1, "window-2");
    }).toThrow(PointerCaptureTargetMismatchError);
  });

  it("releases a capture", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    const released = manager.release(1);

    expect(released).toBe(capture);

    expect(manager.has(1)).toBe(false);

    expect(manager.size).toBe(0);
  });

  it("rejects releasing a missing capture", () => {
    const manager = createManager();

    expect(() => {
      manager.release(1);
    }).toThrow(PointerCaptureNotFoundError);
  });

  it("releases every capture owned by a target", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    manager.capture(2, "window-1");

    manager.capture(3, "window-2");

    const released = manager.releaseForTarget("window-1");

    expect(released.map((capture) => capture.pointerId)).toEqual([1, 2]);

    expect(manager.has(1)).toBe(false);

    expect(manager.has(2)).toBe(false);

    expect(manager.has(3)).toBe(true);
  });

  it("returns an empty collection when a target owns no captures", () => {
    const manager = createManager();

    expect(manager.releaseForTarget("window-1")).toEqual([]);
  });

  it("clears every capture", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    manager.capture(2, "window-2");

    const removed = manager.clear();

    expect(removed).toHaveLength(2);

    expect(manager.size).toBe(0);
  });

  it("returns immutable capture snapshots", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    expect(Object.isFrozen(manager.list())).toBe(true);
  });

  it("returns an active capture for pointer movement", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    const result = manager.handlePointerEvent(createPointerEvent("pointer-move"));

    expect(result).toBe(capture);

    expect(manager.has(1)).toBe(true);
  });

  it("returns undefined for an uncaptured pointer", () => {
    const manager = createManager();

    expect(
      manager.handlePointerEvent(createPointerEvent("pointer-move")),
    ).toBeUndefined();
  });

  it("automatically releases capture on pointer up", () => {
    const manager = createManager();

    const capture = manager.capture(1, "window-1");

    const result = manager.handlePointerEvent(createPointerEvent("pointer-up"));

    expect(result).toBe(capture);

    expect(manager.has(1)).toBe(false);
  });

  it("automatically releases capture on pointer cancel", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    manager.handlePointerEvent(createPointerEvent("pointer-cancel"));

    expect(manager.has(1)).toBe(false);
  });

  it("does not release capture on pointer down", () => {
    const manager = createManager();

    manager.capture(1, "window-1");

    manager.handlePointerEvent(createPointerEvent("pointer-down"));

    expect(manager.has(1)).toBe(true);
  });

  it("emits capture lifecycle events", () => {
    const events: PointerCaptureManagerEvent[] = [];

    const manager = createManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.capture(1, "window-1");

    manager.release(1);

    expect(events.map((event) => event.type)).toEqual([
      "pointer-captured",
      "pointer-capture-released",
    ]);
  });

  it("emits the automatic pointer-up release reason", () => {
    const events: PointerCaptureManagerEvent[] = [];

    const manager = createManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.capture(1, "window-1");

    events.length = 0;

    manager.handlePointerEvent(createPointerEvent("pointer-up"));

    const released = events.find(
      (
        event,
      ): event is Extract<
        PointerCaptureManagerEvent,
        {
          readonly type: "pointer-capture-released";
        }
      > => event.type === "pointer-capture-released",
    );

    expect(released?.reason).toBe("pointer-up");
  });

  it("emits target release details", () => {
    const events: PointerCaptureManagerEvent[] = [];

    const manager = createManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.capture(1, "window-1");

    manager.capture(2, "window-1");

    events.length = 0;

    manager.releaseForTarget("window-1");

    const targetReleased = events.find(
      (
        event,
      ): event is Extract<
        PointerCaptureManagerEvent,
        {
          readonly type: "pointer-capture-target-released";
        }
      > => event.type === "pointer-capture-target-released",
    );

    expect(targetReleased?.pointerIds).toEqual([1, 2]);

    expect(Object.isFrozen(targetReleased?.pointerIds)).toBe(true);
  });
});
