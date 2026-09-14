import { describe, expect, it } from "vitest";

import type { ApplicationSessionId } from "../application-session-id.js";
import type { ApplicationLifecycleController } from "./application-lifecycle-controller.js";
import { GenesisWindowManager } from "./genesis-window-manager.js";
import { WindowRegistry } from "./window-registry.js";
import { WindowZOrderManager } from "./window-z-order-manager.js";

interface ManagerTestContext {
  readonly manager: GenesisWindowManager;

  readonly registry: WindowRegistry;

  readonly foregrounded: ApplicationSessionId[];

  readonly backgrounded: ApplicationSessionId[];
}

function createManager(): ManagerTestContext {
  let windowNumber = 0;

  const registry = new WindowRegistry();

  const foregrounded: ApplicationSessionId[] = [];

  const backgrounded: ApplicationSessionId[] = [];

  const now = (): Date => new Date("2026-07-28T12:00:00.000Z");

  const applications: ApplicationLifecycleController = {
    foregroundApplication: (sessionId) => {
      foregrounded.push(sessionId);

      return {
        id: sessionId,
      } as never;
    },

    backgroundApplication: (sessionId) => {
      backgrounded.push(sessionId);

      return {
        id: sessionId,
      } as never;
    },
  };

  const zOrder = new WindowZOrderManager({
    windows: registry,

    now,
  });

  const manager = new GenesisWindowManager({
    windows: registry,

    applications,

    zOrder,

    createWindowId: () => {
      windowNumber += 1;

      return `window-${String(windowNumber)}`;
    },

    now,
  });

  return {
    manager,
    registry,
    foregrounded,
    backgrounded,
  };
}

const DEFAULT_BOUNDS = {
  x: 0,
  y: 0,
  width: 800,
  height: 600,
} as const;

describe("GenesisWindowManager", () => {
  it("creates and focuses a window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Hello SevynOS",
      bounds: DEFAULT_BOUNDS,
    });

    expect(window.id).toBe("window-1");

    expect(window.state).toBe("focused");

    expect(manager.getWindow(window.id)).toBe(window);
  });

  it("creates a visible unfocused window", () => {
    const { manager, foregrounded } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Background window",
      bounds: DEFAULT_BOUNDS,
      focus: false,
    });

    expect(window.state).toBe("visible");

    expect(foregrounded).toEqual([]);
  });

  it("unfocuses the previously focused window", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 40,
        y: 40,
      },
    });

    expect(second.state).toBe("focused");

    expect(manager.getWindow(first.id)?.state).toBe("visible");
  });

  it("minimizes a focused window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Hello",
      bounds: DEFAULT_BOUNDS,
    });

    const minimized = manager.minimizeWindow(window.id);

    expect(minimized.state).toBe("minimized");
  });

  it("restores and focuses a minimized window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Hello",
      bounds: DEFAULT_BOUNDS,
    });

    manager.minimizeWindow(window.id);

    const restored = manager.restoreWindow(window.id);

    expect(restored.state).toBe("focused");
  });

  it("closes a window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Hello",
      bounds: DEFAULT_BOUNDS,
    });

    const closed = manager.closeWindow(window.id);

    expect(closed.state).toBe("closed");

    expect(manager.getWindow(window.id)).toBe(closed);
  });

  it("lists windows by session", () => {
    const { manager } = createManager();

    manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.createWindow({
      sessionId: "session-1",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.createWindow({
      sessionId: "session-2",
      title: "Third",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 40,
        y: 40,
      },
    });

    expect(manager.listSessionWindows("session-1")).toHaveLength(2);
  });

  it("raises a focused window above other windows", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 40,
        y: 40,
      },
    });

    expect(second.zIndex).toBeGreaterThan(first.zIndex);

    const refocusedFirst = manager.focusWindow(first.id);

    expect(refocusedFirst.zIndex).toBeGreaterThan(
      manager.getWindow(second.id)?.zIndex ?? -1,
    );

    expect(refocusedFirst.state).toBe("focused");

    expect(manager.getWindow(second.id)?.state).toBe("visible");
  });

  it("raises a window without focusing it", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
      focus: false,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 40,
        y: 40,
      },
      focus: false,
    });

    const raisedFirst = manager.raiseWindow(first.id);

    expect(raisedFirst.zIndex).toBeGreaterThan(
      manager.getWindow(second.id)?.zIndex ?? -1,
    );

    expect(raisedFirst.state).toBe("visible");
  });

  it("keeps z-indexes compact after repeated focus changes", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    const third = manager.createWindow({
      sessionId: "session-3",
      title: "Third",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 40,
        y: 40,
      },
    });

    manager.focusWindow(first.id);

    manager.focusWindow(second.id);

    manager.focusWindow(third.id);

    manager.focusWindow(first.id);

    const zIndexes = manager
      .listWindows()
      .map((window) => window.zIndex)
      .sort((firstIndex, secondIndex) => firstIndex - secondIndex);

    expect(zIndexes).toEqual([1, 2, 3]);
  });

  it("focuses the next top visible window after minimizing the focused window", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.minimizeWindow(second.id);

    expect(manager.getWindow(first.id)?.state).toBe("focused");

    expect(manager.getWindow(second.id)?.state).toBe("minimized");
  });

  it("focuses the next top visible window after closing the focused window", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.closeWindow(second.id);

    expect(manager.getWindow(second.id)?.state).toBe("closed");

    expect(manager.getWindow(first.id)?.state).toBe("focused");
  });

  it("removes closed windows from the active z-order", () => {
    const { manager } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.closeWindow(second.id);

    expect(manager.getWindow(first.id)?.zIndex).toBe(1);
  });

  it("foregrounds an application when its window gains focus", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    expect(foregrounded).toEqual(["session-1"]);

    expect(backgrounded).toEqual([]);
  });

  it("transfers lifecycle when focus changes between applications", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    expect(foregrounded).toEqual(["session-1", "session-2"]);

    expect(backgrounded).toEqual(["session-1"]);
  });

  it("does not transition lifecycle when focus moves between windows in the same session", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.createWindow({
      sessionId: "session-1",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.focusWindow(first.id);

    expect(foregrounded).toEqual(["session-1"]);

    expect(backgrounded).toEqual([]);
  });

  it("backgrounds an application when its only focused window is minimized", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.minimizeWindow(window.id);

    expect(foregrounded).toEqual(["session-1"]);

    expect(backgrounded).toEqual(["session-1"]);
  });

  it("backgrounds an application when its only focused window is hidden", () => {
    const { manager, backgrounded } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.hideWindow(window.id);

    expect(backgrounded).toEqual(["session-1"]);
  });

  it("backgrounds an application when its only focused window is closed", () => {
    const { manager, backgrounded } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    manager.closeWindow(window.id);

    expect(backgrounded).toEqual(["session-1"]);
  });

  it("transfers lifecycle when minimizing the focused window reveals another application", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
    });

    const second = manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
    });

    manager.minimizeWindow(second.id);

    expect(foregrounded).toEqual(["session-1", "session-2", "session-1"]);

    expect(backgrounded).toEqual(["session-1", "session-2"]);
  });

  it("does not trigger lifecycle changes when raising an unfocused window", () => {
    const { manager, foregrounded, backgrounded } = createManager();

    const first = manager.createWindow({
      sessionId: "session-1",
      title: "First",
      bounds: DEFAULT_BOUNDS,
      focus: false,
    });

    manager.createWindow({
      sessionId: "session-2",
      title: "Second",
      bounds: {
        ...DEFAULT_BOUNDS,
        x: 20,
        y: 20,
      },
      focus: false,
    });

    manager.raiseWindow(first.id);

    expect(foregrounded).toEqual([]);

    expect(backgrounded).toEqual([]);
  });

  it("moves a window while preserving its size and state", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",

      title: "Movable",

      bounds: {
        x: 100,
        y: 50,
        width: 800,
        height: 600,
      },
    });

    const moved = manager.moveWindow({
      windowId: window.id,

      x: 250,

      y: 175,
    });

    expect(moved.bounds).toEqual({
      x: 250,
      y: 175,
      width: 800,
      height: 600,
    });

    expect(moved.state).toBe(window.state);

    expect(moved.zIndex).toBe(window.zIndex);

    expect(manager.getWindow(window.id)).toBe(moved);
  });

  it("returns the existing window when its position does not change", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",

      title: "Stationary",

      bounds: {
        x: 100,
        y: 50,
        width: 800,
        height: 600,
      },
    });

    const result = manager.moveWindow({
      windowId: window.id,

      x: 100,

      y: 50,
    });

    expect(result).toBe(window);
  });

  it.each([
    {
      x: Number.NaN,

      y: 0,
    },
    {
      x: 0,

      y: Number.POSITIVE_INFINITY,
    },
  ])("rejects invalid window coordinates $x, $y", ({ x, y }) => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",

      title: "Movable",

      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    });

    expect(() => {
      manager.moveWindow({
        windowId: window.id,

        x,

        y,
      });
    }).toThrow("Window coordinates must be finite numbers.");
  });

  it("rejects moving a closed window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",

      title: "Closed",

      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    });

    manager.closeWindow(window.id);

    expect(() => {
      manager.moveWindow({
        windowId: window.id,

        x: 100,

        y: 100,
      });
    }).toThrow(`Window "${window.id}" cannot be moved from state "closed".`);
  });

  it("resizes a window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Resizable",

      bounds: {
        x: 100,
        y: 50,
        width: 800,
        height: 600,
      },
    });

    const resized = manager.resizeWindow({
      windowId: window.id,

      bounds: {
        x: 100,
        y: 50,
        width: 1000,
        height: 700,
      },
    });

    expect(resized.bounds).toEqual({
      x: 100,
      y: 50,
      width: 1000,
      height: 700,
    });

    expect(resized.state).toBe(window.state);

    expect(resized.zIndex).toBe(window.zIndex);

    expect(manager.getWindow(window.id)).toBe(resized);
  });

  it("supports resizing from the top-left corner", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Resizable",

      bounds: {
        x: 100,
        y: 100,
        width: 800,
        height: 600,
      },
    });

    const resized = manager.resizeWindow({
      windowId: window.id,

      bounds: {
        x: 50,
        y: 25,
        width: 850,
        height: 675,
      },
    });

    expect(resized.bounds).toEqual({
      x: 50,
      y: 25,
      width: 850,
      height: 675,
    });
  });

  it("returns the existing window when its bounds do not change", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Resizable",

      bounds: {
        x: 100,
        y: 50,
        width: 800,
        height: 600,
      },
    });

    const result = manager.resizeWindow({
      windowId: window.id,
      bounds: window.bounds,
    });

    expect(result).toBe(window);
  });

  it("enforces minimum window dimensions", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Resizable",

      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    });

    expect(() => {
      manager.resizeWindow({
        windowId: window.id,

        bounds: {
          x: 0,
          y: 0,
          width: 299,
          height: 199,
        },

        minimumWidth: 300,
        minimumHeight: 200,
      });
    }).toThrow("Window dimensions must be at least 300 × 200.");
  });

  it("rejects resizing a closed window", () => {
    const { manager } = createManager();

    const window = manager.createWindow({
      sessionId: "session-1",
      title: "Closed",

      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    });

    manager.closeWindow(window.id);

    expect(() => {
      manager.resizeWindow({
        windowId: window.id,

        bounds: {
          x: 0,
          y: 0,
          width: 900,
          height: 700,
        },
      });
    }).toThrow(`Window "${window.id}" cannot be resized from state "closed".`);
  });
});
