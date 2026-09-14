import { describe, expect, it } from "vitest";
import { GenesisScene } from "./genesis-scene.js";
import { IDENTITY_SCENE_TRANSFORM } from "./scene-node.js";

describe("GenesisScene", () => {
  it("returns windows in root order", () => {
    const scene = new GenesisScene({
      id: "scene-test",
      sequence: 1,
      createdAt: new Date("2026-07-28T12:00:00.000Z"),
      root: {
        id: "scene-node-root",
        kind: "group",
        opacity: 1,
        visible: true,
        transform: IDENTITY_SCENE_TRANSFORM,
        children: [
          {
            id: "scene-node-first",
            kind: "window",
            windowId: "window-first",
            bounds: {
              x: 0,
              y: 0,
              width: 800,
              height: 600,
            },
            zIndex: 1,
            focused: false,
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
          },
          {
            id: "scene-node-second",
            kind: "window",
            windowId: "window-second",
            bounds: {
              x: 20,
              y: 20,
              width: 800,
              height: 600,
            },
            zIndex: 2,
            focused: true,
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
          },
        ],
      },
    });

    expect(scene.listWindows().map((window) => window.windowId)).toEqual([
      "window-first",
      "window-second",
    ]);
  });

  it("returns the highest window as the top window", () => {
    const scene = new GenesisScene({
      id: "scene-test",
      sequence: 1,
      createdAt: new Date(),
      root: {
        id: "scene-node-root",
        kind: "group",
        opacity: 1,
        visible: true,
        transform: IDENTITY_SCENE_TRANSFORM,
        children: [
          {
            id: "scene-node-first",
            kind: "window",
            windowId: "window-first",
            bounds: {
              x: 0,
              y: 0,
              width: 800,
              height: 600,
            },
            zIndex: 1,
            focused: false,
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
          },
          {
            id: "scene-node-second",
            kind: "window",
            windowId: "window-second",
            bounds: {
              x: 20,
              y: 20,
              width: 800,
              height: 600,
            },
            zIndex: 2,
            focused: true,
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
          },
        ],
      },
    });

    expect(scene.getTopWindow()?.windowId).toBe("window-second");
  });

  it("returns the focused window", () => {
    const scene = new GenesisScene({
      id: "scene-test",
      sequence: 1,
      createdAt: new Date(),
      root: {
        id: "scene-node-root",
        kind: "group",
        opacity: 1,
        visible: true,
        transform: IDENTITY_SCENE_TRANSFORM,
        children: [
          {
            id: "scene-node-window",
            kind: "window",
            windowId: "window-focused",
            bounds: {
              x: 0,
              y: 0,
              width: 800,
              height: 600,
            },
            zIndex: 1,
            focused: true,
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
          },
        ],
      },
    });

    expect(scene.getFocusedWindow()?.windowId).toBe("window-focused");
  });

  it("rejects invalid scene sequences", () => {
    expect(
      () =>
        new GenesisScene({
          id: "scene-invalid",
          sequence: 0,
          createdAt: new Date(),
          root: {
            id: "scene-node-root",
            kind: "group",
            opacity: 1,
            visible: true,
            transform: IDENTITY_SCENE_TRANSFORM,
            children: [],
          },
        }),
    ).toThrow(RangeError);
  });
});
