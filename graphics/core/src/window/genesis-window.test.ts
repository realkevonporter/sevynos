import { describe, expect, it } from "vitest";

import { InvalidWindowStateTransitionError } from "../errors/invalid-window-state-transition-error.js";

import { GenesisWindow } from "./genesis-window.js";

const createdAt = new Date("2026-07-28T12:00:00.000Z");

const updatedAt = new Date("2026-07-28T12:05:00.000Z");

function createWindow(): GenesisWindow {
  return new GenesisWindow({
    id: "window-1",
    sessionId: "session-1",
    title: "Hello SevynOS",
    bounds: {
      x: 100,
      y: 80,
      width: 800,
      height: 600,
    },
    createdAt,
  });
}

describe("GenesisWindow", () => {
  it("creates a window in the created state", () => {
    const window = createWindow();

    expect(window.id).toBe("window-1");

    expect(window.sessionId).toBe("session-1");

    expect(window.state).toBe("created");

    expect(window.zIndex).toBe(0);
  });

  it("transitions immutably", () => {
    const createdWindow = createWindow();

    const visibleWindow = createdWindow.transitionTo("visible", updatedAt);

    expect(visibleWindow).not.toBe(createdWindow);

    expect(createdWindow.state).toBe("created");

    expect(visibleWindow.state).toBe("visible");

    expect(visibleWindow.updatedAt).toEqual(updatedAt);
  });

  it("rejects invalid transitions", () => {
    const window = createWindow();

    expect(() => {
      window.transitionTo("focused");
    }).toThrow(InvalidWindowStateTransitionError);
  });

  it("moves a window immutably", () => {
    const original = createWindow();

    const moved = original.moveTo(250, 175, updatedAt);

    expect(moved).not.toBe(original);

    expect(original.bounds).toEqual({
      x: 100,
      y: 80,
      width: 800,
      height: 600,
    });

    expect(moved.bounds).toEqual({
      x: 250,
      y: 175,
      width: 800,
      height: 600,
    });
  });

  it("resizes a window immutably", () => {
    const original = createWindow();

    const resized = original.resizeTo(1280, 720, updatedAt);

    expect(resized.bounds).toEqual({
      x: 100,
      y: 80,
      width: 1280,
      height: 720,
    });
  });

  it("rejects invalid dimensions", () => {
    const window = createWindow();

    expect(() => {
      window.resizeTo(0, 600);
    }).toThrow(RangeError);

    expect(() => {
      window.resizeTo(800, -1);
    }).toThrow(RangeError);
  });

  it("updates stacking order immutably", () => {
    const original = createWindow();

    const raised = original.withZIndex(10, updatedAt);

    expect(original.zIndex).toBe(0);
    expect(raised.zIndex).toBe(10);
  });

  it("updates the title immutably", () => {
    const original = createWindow();

    const renamed = original.withTitle("Sample App", updatedAt);

    expect(original.title).toBe("Hello SevynOS");

    expect(renamed.title).toBe("Sample App");
  });
});
