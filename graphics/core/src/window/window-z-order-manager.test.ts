import { describe, expect, it } from "vitest";

import { GenesisWindow } from "./genesis-window.js";
import type { WindowZOrderManagerEvent } from "./window-z-order-events.js";
import { WindowZOrderManager } from "./window-z-order-manager.js";
import { WindowRegistry } from "./window-registry.js";

const NOW = new Date("2026-08-01T22:00:00.000Z");

function createWindow(
  id: `window-${string}`,
  zIndex: number,
  state:
    | "created"
    | "visible"
    | "focused"
    | "minimized"
    | "hidden"
    | "closing"
    | "closed" = "visible",
): GenesisWindow {
  return new GenesisWindow({
    id,

    sessionId: `session-${id}`,

    title: id,

    bounds: {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    },

    state,

    zIndex,

    createdAt: NOW,

    updatedAt: NOW,
  });
}

function createFixture(
  windows: readonly GenesisWindow[],
  onEvent?: (event: WindowZOrderManagerEvent) => void,
) {
  const registry = new WindowRegistry();

  for (const window of windows) {
    registry.add(window);
  }

  const manager = new WindowZOrderManager({
    windows: registry,

    now: () => new Date(NOW),

    ...(onEvent === undefined
      ? {}
      : {
          onEvent,
        }),
  });

  return {
    registry,
    manager,
  };
}

describe("WindowZOrderManager", () => {
  it("lists windows from back to front", () => {
    const { manager } = createFixture([
      createWindow("window-3", 3),
      createWindow("window-1", 1),
      createWindow("window-2", 2),
    ]);

    expect(manager.list().map((window) => window.id)).toEqual([
      "window-1",
      "window-2",
      "window-3",
    ]);
  });

  it("brings a window to the front", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2),
      createWindow("window-3", 3),
    ]);

    const window = manager.bringToFront("window-1");

    expect(window.zIndex).toBe(3);

    expect(manager.list().map((candidate) => candidate.id)).toEqual([
      "window-2",
      "window-3",
      "window-1",
    ]);
  });

  it("sends a window to the back", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2),
      createWindow("window-3", 3),
    ]);

    manager.sendToBack("window-3");

    expect(manager.list().map((window) => window.id)).toEqual([
      "window-3",
      "window-1",
      "window-2",
    ]);
  });

  it("raises a window directly above another window", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2),
      createWindow("window-3", 3),
    ]);

    manager.raiseAbove("window-1", "window-2");

    expect(manager.list().map((window) => window.id)).toEqual([
      "window-2",
      "window-1",
      "window-3",
    ]);
  });

  it("lowers a window directly below another window", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2),
      createWindow("window-3", 3),
    ]);

    manager.lowerBelow("window-3", "window-2");

    expect(manager.list().map((window) => window.id)).toEqual([
      "window-1",
      "window-3",
      "window-2",
    ]);
  });

  it("normalizes duplicate and sparse z-indexes", () => {
    const { manager } = createFixture([
      createWindow("window-1", 10),
      createWindow("window-2", 10),
      createWindow("window-3", 50),
    ]);

    manager.normalize();

    expect(manager.list().map((window) => window.zIndex)).toEqual([1, 2, 3]);
  });

  it("excludes closing and closed windows", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2, "closing"),
      createWindow("window-3", 3, "closed"),
    ]);

    expect(manager.list().map((window) => window.id)).toEqual(["window-1"]);
  });

  it("rejects ordering a closed window", () => {
    const { manager } = createFixture([createWindow("window-1", 1, "closed")]);

    expect(() => {
      manager.bringToFront("window-1");
    }).toThrow('Window "window-1" cannot participate in z-order from state "closed".');
  });

  it("rejects ordering a window relative to itself", () => {
    const { manager } = createFixture([createWindow("window-1", 1)]);

    expect(() => {
      manager.raiseAbove("window-1", "window-1");
    }).toThrow('Window "window-1" cannot be ordered relative to itself.');
  });

  it("returns the top window", () => {
    const { manager } = createFixture([
      createWindow("window-1", 1),
      createWindow("window-2", 2),
    ]);

    expect(manager.getTopWindow()?.id).toBe("window-2");
  });

  it("emits immutable ordered IDs", () => {
    const events: WindowZOrderManagerEvent[] = [];

    const { manager } = createFixture(
      [createWindow("window-1", 1), createWindow("window-2", 2)],
      (event) => {
        events.push(event);
      },
    );

    manager.bringToFront("window-1");

    expect(events).toHaveLength(1);

    expect(events[0]?.type).toBe("window-z-order-changed");

    expect(Object.isFrozen(events[0]?.orderedWindowIds)).toBe(true);
  });
});
