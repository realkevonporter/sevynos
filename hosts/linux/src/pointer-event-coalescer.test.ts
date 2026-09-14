import { createPointerInputEvent } from "@sevynos/input";
import { describe, expect, it } from "vitest";
import { PointerEventCoalescer } from "./pointer-event-coalescer.js";

describe("pointer event coalescer", () => {
  it("dispatches the latest motion once per scheduled visual update", () => {
    const callbacks: (() => void)[] = [];
    const positions: number[] = [];
    const coalescer = new PointerEventCoalescer({
      dispatch: (event) => positions.push(event.position.x),
      schedule: (callback) => callbacks.push(callback),
    });
    for (let x = 0; x < 500; x += 1) coalescer.push(pointer("pointer-move", x));
    expect(callbacks).toHaveLength(1);
    expect(positions).toEqual([]);
    callbacks.shift()?.();
    expect(positions).toEqual([499]);
    expect(coalescer.pendingMotion).toBe(false);
  });

  it("flushes the latest position before an immediate pointer-down", () => {
    const events: string[] = [];
    const coalescer = new PointerEventCoalescer({
      dispatch: (event) => events.push(`${event.type}:${String(event.position.x)}`),
      schedule: () => 1,
    });
    coalescer.push(pointer("pointer-move", 40));
    coalescer.push(pointer("pointer-move", 90));
    coalescer.push(pointer("pointer-down", 90));
    expect(events).toEqual(["pointer-move:90", "pointer-down:90"]);
  });
});

function pointer(type: "pointer-move" | "pointer-down", x: number) {
  return createPointerInputEvent({
    type,
    eventId: `${type}-${String(x)}`,
    deviceId: "pointer",
    deviceKind: "mouse",
    timestamp: x,
    pointerId: 1,
    position: { x, y: 20 },
    button: type === "pointer-down" ? "primary" : "none",
    buttons: type === "pointer-down" ? ["primary"] : [],
    pressure: type === "pointer-down" ? 1 : 0,
  });
}
