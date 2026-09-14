import { describe, expect, it } from "vitest";

import { WindowNotFoundError } from "../errors/window-not-found-error.js";

import { GenesisWindow } from "./genesis-window.js";
import { WindowRegistry } from "./window-registry.js";

function createWindow(id: string, sessionId = "session-1"): GenesisWindow {
  return new GenesisWindow({
    id,
    sessionId,
    title: `Window ${id}`,
    bounds: {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    },
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
  });
}

describe("WindowRegistry", () => {
  it("adds and retrieves a window", () => {
    const registry = new WindowRegistry();

    const window = createWindow("window-1");

    registry.add(window);

    expect(registry.get(window.id)).toBe(window);
  });

  it("rejects duplicate windows", () => {
    const registry = new WindowRegistry();

    const window = createWindow("window-1");

    registry.add(window);

    expect(() => {
      registry.add(window);
    }).toThrow('Window "window-1" is already registered.');
  });

  it("updates a window", () => {
    const registry = new WindowRegistry();

    const original = createWindow("window-1");

    registry.add(original);

    const visible = original.transitionTo("visible");

    registry.update(visible);

    expect(registry.get(original.id)).toBe(visible);
  });

  it("transitions and replaces a window", () => {
    const registry = new WindowRegistry();

    const created = createWindow("window-1");

    registry.add(created);

    const visible = registry.transition(created.id, "visible");

    expect(visible).not.toBe(created);
    expect(created.state).toBe("created");
    expect(visible.state).toBe("visible");

    expect(registry.get(created.id)).toBe(visible);
  });

  it("lists windows by application session", () => {
    const registry = new WindowRegistry();

    const first = createWindow("window-1", "session-1");

    const second = createWindow("window-2", "session-1");

    const third = createWindow("window-3", "session-2");

    registry.add(first);
    registry.add(second);
    registry.add(third);

    expect(registry.listBySession("session-1")).toEqual([first, second]);
  });

  it("returns the focused window", () => {
    const registry = new WindowRegistry();

    const first = createWindow("window-1");

    const second = createWindow("window-2");

    registry.add(first);
    registry.add(second);

    registry.transition(first.id, "visible");

    const focused = registry.transition(second.id, "visible");

    const focusedWindow = registry.transition(focused.id, "focused");

    expect(registry.getFocusedWindow()).toBe(focusedWindow);
  });

  it("returns undefined when no window is focused", () => {
    const registry = new WindowRegistry();

    registry.add(createWindow("window-1"));

    expect(registry.getFocusedWindow()).toBeUndefined();
  });

  it("rejects transitions for unknown windows", () => {
    const registry = new WindowRegistry();

    expect(() => {
      registry.transition("missing-window", "visible");
    }).toThrow(WindowNotFoundError);
  });

  it("removes windows", () => {
    const registry = new WindowRegistry();

    const window = createWindow("window-1");

    registry.add(window);

    expect(registry.remove(window.id)).toBe(true);

    expect(registry.get(window.id)).toBeUndefined();
  });

  it("returns the top window", () => {
    const registry = new WindowRegistry();

    const first = createWindow("window-1");

    const second = createWindow("window-2").withZIndex(5);

    const third = createWindow("window-3").withZIndex(2);

    registry.add(first);
    registry.add(second);
    registry.add(third);

    expect(registry.getTopWindow()).toBe(second);
  });

  it("returns the highest z-index", () => {
    const registry = new WindowRegistry();

    registry.add(createWindow("window-1").withZIndex(3));

    registry.add(createWindow("window-2").withZIndex(8));

    expect(registry.getHighestZIndex()).toBe(8);
  });

  it("returns zero when there are no windows", () => {
    const registry = new WindowRegistry();

    expect(registry.getHighestZIndex()).toBe(0);
  });
});
