import { describe, expect, it } from "vitest";
import type { DesktopScene, DesktopWindowSceneNode } from "@sevynos/desktop-shell";
import { findNativePointerTarget } from "./wayland.js";

function sceneNode(
  windowId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  order: number,
  nativeSurface = true,
): DesktopWindowSceneNode {
  return {
    kind: "desktop-window",
    order,
    base: { bounds: { x, y, width, height } },
    windowId,
    nativeSurface: nativeSurface ? {} : undefined,
  } as unknown as DesktopWindowSceneNode;
}

function scene(...nodes: DesktopWindowSceneNode[]): DesktopScene {
  return { nodes } as unknown as DesktopScene;
}

describe("findNativePointerTarget", () => {
  it("targets the topmost window for a click in its content area", () => {
    const target = findNativePointerTarget(
      scene(
        sceneNode("window-1", 100, 100, 620, 420, 1),
        sceneNode("window-2", 300, 200, 620, 420, 2),
      ),
      400,
      400,
    );
    expect(target?.windowId).toBe("window-2");
  });

  it("does not fall through to a window below when the click is on the top window's title bar", () => {
    // Regression test for the bare-metal click-through bug: the old
    // implementation excluded the top 46px (title bar) from the hit test,
    // so a title-bar click on the top window was delivered to the app
    // underneath it.
    const target = findNativePointerTarget(
      scene(
        sceneNode("window-1", 298, 307, 820, 640, 1),
        sceneNode("window-2", 564, 403, 620, 420, 2),
      ),
      780,
      424,
    );
    expect(target).toBeUndefined();
  });

  it("dispatches nothing for a title-bar click with no window underneath", () => {
    const target = findNativePointerTarget(
      scene(sceneNode("window-1", 678, 322, 620, 420, 1)),
      1045,
      335,
    );
    expect(target).toBeUndefined();
  });

  it("dispatches nothing for a click outside every window", () => {
    const target = findNativePointerTarget(
      scene(sceneNode("window-1", 100, 100, 620, 420, 1)),
      10,
      10,
    );
    expect(target).toBeUndefined();
  });

  it("dispatches nothing for an undefined scene", () => {
    expect(findNativePointerTarget(undefined, 400, 400)).toBeUndefined();
  });

  it("treats the first pixel below the title bar as content", () => {
    const target = findNativePointerTarget(
      scene(sceneNode("window-1", 100, 100, 620, 420, 1)),
      200,
      146,
    );
    expect(target?.windowId).toBe("window-1");
  });

  it("treats the last pixel of the title bar as chrome", () => {
    const target = findNativePointerTarget(
      scene(sceneNode("window-1", 100, 100, 620, 420, 1)),
      200,
      145,
    );
    expect(target).toBeUndefined();
  });

  it("skips windows without a native surface", () => {
    const target = findNativePointerTarget(
      scene(
        sceneNode("window-1", 100, 100, 620, 420, 1),
        sceneNode("window-2", 100, 100, 620, 420, 2, false),
      ),
      200,
      200,
    );
    expect(target?.windowId).toBe("window-1");
  });
});
