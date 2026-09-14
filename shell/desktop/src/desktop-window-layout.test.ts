import { afterEach, describe, expect, it } from "vitest";
import type { WindowBounds } from "@sevynos/graphics";
import { createDesktopRuntime, type DesktopRuntime } from "./desktop-runtime.js";
import { DesktopSceneComposer } from "./desktop-scene-composer.js";
import type { DesktopWindowSceneNode } from "./desktop-scene.js";
import { getTaskbarBounds, getWorkspaceBounds } from "./desktop-window-layout.js";

const runtimes: DesktopRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      runtime.beginShutdown();
      await runtime.closeForShutdown();
    }),
  );
});

describe("Genesis desktop window layout", () => {
  it("derives every workspace edge from the same taskbar geometry", () => {
    const display = { x: 0, y: 0, width: 1280, height: 720 };
    expect(getTaskbarBounds(display, "bottom")).toEqual({
      x: 12,
      y: 656,
      width: 1256,
      height: 52,
    });
    expect(getWorkspaceBounds(display, "bottom")).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 648,
    });
    expect(getWorkspaceBounds(display, "top")).toEqual({
      x: 0,
      y: 72,
      width: 1280,
      height: 648,
    });
    expect(getWorkspaceBounds(display, "left")).toEqual({
      x: 72,
      y: 0,
      width: 1208,
      height: 720,
    });
    expect(getWorkspaceBounds(display, "right")).toEqual({
      x: 0,
      y: 0,
      width: 1208,
      height: 720,
    });
  });

  it.each([
    {
      width: 1280,
      height: 720,
      welcome: { x: 330, y: 114, width: 620, height: 420 },
      console: { x: 358, y: 142, width: 620, height: 420 },
    },
    {
      width: 1024,
      height: 640,
      welcome: { x: 202, y: 74, width: 620, height: 420 },
      console: { x: 230, y: 102, width: 620, height: 420 },
    },
  ])(
    "creates responsive, distinct defaults at $width×$height",
    async ({ width, height, welcome, console: consoleBounds }) => {
      const runtime = await createRuntime(width, height);
      expect(runtime.windows.getWindow("window-1")?.bounds).toEqual(welcome);
      expect(runtime.windows.getWindow("window-2")?.bounds).toEqual(consoleBounds);
      expect(welcome).not.toEqual(consoleBounds);
      const workspace = runtime.environment.listDisplays()[0]?.workArea;
      expect(workspace).toBeDefined();
      if (workspace === undefined) return;
      for (const window of runtime.windows.listWindows())
        expect(isInside(window.bounds, workspace)).toBe(true);
    },
  );

  it("reflows existing windows into a resized workspace and preserves restore geometry", async () => {
    const runtime = await createRuntime(1280, 720);
    const original = runtime.windows.getWindow("window-2")?.bounds;
    expect(original).toBeDefined();
    if (original === undefined) return;
    await runtime.activateWindowControl("window-2", "maximize", original);

    runtime.layout.configureHostDisplays([display(1024, 640)]);

    const workspace = runtime.environment.listDisplays()[0]?.workArea;
    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual(workspace);
    await runtime.activateWindowControl("window-2", "restore", original);
    const restored = runtime.windows.getWindow("window-2")?.bounds;
    expect(restored).toBeDefined();
    if (restored !== undefined && workspace !== undefined)
      expect(isInside(restored, workspace)).toBe(true);
  });

  it("keeps minimum usable dimensions on a small display without crossing workspace edges", async () => {
    const runtime = await createRuntime(640, 480);
    const workspace = runtime.environment.listDisplays()[0]?.workArea;
    const welcome = runtime.windows.getWindow("window-1")?.bounds;
    expect(welcome?.width).toBeGreaterThanOrEqual(480);
    expect(welcome?.height).toBeGreaterThanOrEqual(320);
    if (welcome !== undefined && workspace !== undefined)
      expect(isInside(welcome, workspace)).toBe(true);
  });

  it("propagates move and resize geometry into scene and native content bounds", async () => {
    const runtime = await createRuntime(1280, 720);
    runtime.windows.resizeWindow({
      windowId: "window-1",
      bounds: { x: 90, y: 80, width: 700, height: 500 },
    });
    let node = await waitForNativeCommands(runtime, "window-1");
    expect(node?.base.bounds).toEqual({ x: 90, y: 80, width: 700, height: 500 });
    expect(node?.contentBounds).toEqual({ x: 91, y: 126, width: 698, height: 453 });
    expect(runtime.surfaces.getNativeSurfaceBounds("window-1")).toEqual(
      node?.contentBounds,
    );
    expect(node?.nativeSurface?.commands.length).toBeGreaterThan(0);
    for (const command of node?.nativeSurface?.commands ?? []) {
      expect(command.bounds.x).toBeGreaterThanOrEqual(0);
      expect(command.bounds.y).toBeGreaterThanOrEqual(0);
      expect(command.bounds.x + command.bounds.width).toBeLessThanOrEqual(698);
      expect(command.bounds.y + command.bounds.height).toBeLessThanOrEqual(453);
    }

    runtime.windows.moveWindow({ windowId: "window-1", x: 180, y: 120 });
    node = windowNode(runtime, "window-1");
    expect(node?.base.bounds.x).toBe(180);
    expect(node?.contentBounds.x).toBe(181);
  });

  it("keeps logical layout independent from physical display scale", async () => {
    const scaleOne = await createRuntime(1280, 720, 1);
    const scaleTwo = await createRuntime(1280, 720, 2);
    expect(scaleTwo.windows.getWindow("window-1")?.bounds).toEqual(
      scaleOne.windows.getWindow("window-1")?.bounds,
    );
    expect(scaleTwo.environment.listDisplays()[0]).toMatchObject({
      bounds: { width: 1280, height: 720 },
      pixelWidth: 2560,
      pixelHeight: 1440,
      scaleFactor: 2,
    });
  });
});

async function createRuntime(
  width: number,
  height: number,
  scaleFactor = 1,
): Promise<DesktopRuntime> {
  const runtime = await createDesktopRuntime({ launchDefaults: false });
  runtimes.push(runtime);
  runtime.layout.configureHostDisplays([display(width, height, scaleFactor)]);
  await runtime.applications.resetToDefaults();
  return runtime;
}

function display(width: number, height: number, scaleFactor = 1) {
  return {
    id: "display-wayland",
    name: "Wayland Output",
    bounds: { x: 0, y: 0, width, height },
    pixelWidth: width * scaleFactor,
    pixelHeight: height * scaleFactor,
    scaleFactor,
    refreshRate: 60,
    primary: true,
  } as const;
}

function windowNode(
  runtime: DesktopRuntime,
  windowId: string,
): DesktopWindowSceneNode | undefined {
  const node = new DesktopSceneComposer(runtime)
    .compose({
      width: runtime.environment.listDisplays()[0]?.bounds.width ?? 1,
      height: runtime.environment.listDisplays()[0]?.bounds.height ?? 1,
      scaleFactor: runtime.environment.listDisplays()[0]?.scaleFactor ?? 1,
    })
    .nodes.find((node) => node.kind === "desktop-window" && node.windowId === windowId);
  return node?.kind === "desktop-window" ? node : undefined;
}

async function waitForNativeCommands(
  runtime: DesktopRuntime,
  windowId: string,
): Promise<DesktopWindowSceneNode | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const node = windowNode(runtime, windowId);
    if ((node?.nativeSurface?.commands.length ?? 0) > 0) return node;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return windowNode(runtime, windowId);
}

function isInside(bounds: WindowBounds, workspace: WindowBounds) {
  return (
    bounds.x >= workspace.x &&
    bounds.y >= workspace.y &&
    bounds.x + bounds.width <= workspace.x + workspace.width &&
    bounds.y + bounds.height <= workspace.y + workspace.height
  );
}
