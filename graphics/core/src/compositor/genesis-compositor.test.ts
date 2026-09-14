import { describe, expect, it } from "vitest";
import { GenesisWindow } from "../window/genesis-window.js";
import { WindowRegistry } from "../window/window-registry.js";
import { GenesisCompositor } from "./genesis-compositor.js";

function createCompositor(): {
  readonly compositor: GenesisCompositor;

  readonly windows: WindowRegistry;
} {
  let sceneNumber = 0;
  let nodeNumber = 0;

  const windows = new WindowRegistry();

  const compositor = new GenesisCompositor({
    windows,

    createSceneId: () => {
      sceneNumber += 1;

      return `scene-${String(sceneNumber)}`;
    },

    createSceneNodeId: () => {
      nodeNumber += 1;

      return `scene-node-${String(nodeNumber)}`;
    },

    now: () => new Date("2026-07-28T12:00:00.000Z"),
  });

  return {
    compositor,
    windows,
  };
}

function createWindow(id: string, zIndex: number): GenesisWindow {
  return new GenesisWindow({
    id,
    sessionId: "session-1",
    title: id,
    bounds: {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    },
    zIndex,
    createdAt: new Date("2026-07-28T12:00:00.000Z"),
  });
}

describe("GenesisCompositor", () => {
  it("creates an empty scene", () => {
    const { compositor } = createCompositor();

    const scene = compositor.compose();

    expect(scene.listWindows()).toEqual([]);

    expect(scene.sequence).toBe(1);
  });

  it("includes visible and focused windows", () => {
    const { compositor, windows } = createCompositor();

    const first = createWindow("window-first", 1);

    const second = createWindow("window-second", 2);

    windows.add(first);
    windows.add(second);

    windows.transition(first.id, "visible");

    windows.transition(second.id, "visible");

    windows.transition(second.id, "focused");

    const scene = compositor.compose();

    expect(scene.listWindows().map((window) => window.windowId)).toEqual([
      "window-first",
      "window-second",
    ]);
  });

  it("excludes minimized and hidden windows", () => {
    const { compositor, windows } = createCompositor();

    const minimized = createWindow("window-minimized", 1);

    const hidden = createWindow("window-hidden", 2);

    windows.add(minimized);
    windows.add(hidden);

    windows.transition(minimized.id, "visible");

    windows.transition(minimized.id, "minimized");

    windows.transition(hidden.id, "visible");

    windows.transition(hidden.id, "hidden");

    expect(compositor.compose().listWindows()).toEqual([]);
  });

  it("orders windows from lowest to highest z-index", () => {
    const { compositor, windows } = createCompositor();

    const top = createWindow("window-top", 3);

    const bottom = createWindow("window-bottom", 1);

    const middle = createWindow("window-middle", 2);

    windows.add(top);
    windows.add(bottom);
    windows.add(middle);

    windows.transition(top.id, "visible");

    windows.transition(bottom.id, "visible");

    windows.transition(middle.id, "visible");

    expect(
      compositor
        .compose()
        .listWindows()
        .map((window) => window.windowId),
    ).toEqual(["window-bottom", "window-middle", "window-top"]);
  });

  it("increments the scene sequence", () => {
    const { compositor } = createCompositor();

    const first = compositor.compose();

    const second = compositor.compose();

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });

  it("marks the focused window", () => {
    const { compositor, windows } = createCompositor();

    const window = createWindow("window-focused", 1);

    windows.add(window);

    windows.transition(window.id, "visible");

    windows.transition(window.id, "focused");

    const focusedWindow = compositor.compose().getFocusedWindow();

    expect(focusedWindow?.windowId).toBe("window-focused");

    expect(focusedWindow?.focused).toBe(true);
  });
});
