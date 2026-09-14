import { describe, expect, it } from "vitest";

import type { CursorManagerEvent } from "./cursor-manager-events.js";
import { CursorManager } from "./cursor-manager.js";

function createManager(
  options: {
    readonly onEvent?: (event: CursorManagerEvent) => void;
  } = {},
): CursorManager {
  let now = 100;

  return new CursorManager({
    now: () => {
      now += 1;

      return now;
    },

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });
}

describe("CursorManager", () => {
  it("starts with a visible default cursor", () => {
    const manager = createManager();

    expect(manager.state.kind).toBe("default");

    expect(manager.state.position).toEqual({
      x: 0,
      y: 0,
    });

    expect(manager.state.visible).toBe(true);
  });

  it("changes cursor kind", () => {
    const manager = createManager();

    const state = manager.setKind("pointer");

    expect(state.kind).toBe("pointer");

    expect(state.visible).toBe(true);
  });

  it("moves the cursor", () => {
    const manager = createManager();

    const state = manager.moveTo({
      x: 250,
      y: 175,
    });

    expect(state.position).toEqual({
      x: 250,
      y: 175,
    });

    expect(state.kind).toBe("default");
  });

  it("updates position and kind atomically", () => {
    const manager = createManager();

    const state = manager.update({
      kind: "resize-ew",

      position: {
        x: 500,
        y: 300,
      },
    });

    expect(state.kind).toBe("resize-ew");

    expect(state.position).toEqual({
      x: 500,
      y: 300,
    });
  });

  it("hides the cursor", () => {
    const manager = createManager();

    const state = manager.hide();

    expect(state.kind).toBe("hidden");

    expect(state.visible).toBe(false);
  });

  it("shows a hidden cursor as default", () => {
    const manager = createManager();

    manager.hide();

    const state = manager.show();

    expect(state.kind).toBe("default");

    expect(state.visible).toBe(true);
  });

  it("resets the cursor", () => {
    const manager = createManager();

    manager.setKind("move");

    const state = manager.reset();

    expect(state.kind).toBe("default");

    expect(state.visible).toBe(true);
  });

  it("returns the existing state when nothing changes", () => {
    const manager = createManager();

    const original = manager.state;

    const result = manager.setKind("default");

    expect(result).toBe(original);
  });

  it("emits state changes", () => {
    const events: CursorManagerEvent[] = [];

    const manager = createManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.setKind("text");

    expect(events).toHaveLength(1);

    expect(events[0]?.type).toBe("cursor-state-changed");
  });

  it("does not emit unchanged state", () => {
    const events: CursorManagerEvent[] = [];

    const manager = createManager({
      onEvent: (event) => {
        events.push(event);
      },
    });

    manager.setKind("default");

    expect(events).toEqual([]);
  });

  it("creates immutable state", () => {
    const manager = createManager();

    expect(Object.isFrozen(manager.state)).toBe(true);

    expect(Object.isFrozen(manager.state.position)).toBe(true);
  });

  it("rejects invalid positions", () => {
    const manager = createManager();

    expect(() => {
      manager.moveTo({
        x: Number.NaN,

        y: 0,
      });
    }).toThrow("Cursor position must contain finite coordinates.");
  });
});
