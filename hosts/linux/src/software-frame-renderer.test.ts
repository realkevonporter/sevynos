import {
  createDesktopRuntime,
  DesktopSceneComposer,
  type DesktopRuntime,
  type DesktopScene,
  type DesktopWindowSceneNode,
} from "@sevynos/desktop-shell";
import type { NativeRuntimeSnapshot } from "@sevynos/react-native/internal";
import { afterEach, describe, expect, it } from "vitest";
import { IncrementalFrameRenderer } from "./incremental-frame-renderer.js";
import { renderDesktopScene } from "./software-frame-renderer.js";

const runtimes: DesktopRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeForShutdown()));
});

describe("Linux software frame renderer", () => {
  it("renders a complete 1280x720 shell with native application content", async () => {
    const { runtime, scene } = await createScene(1280, 720);
    const frame = renderDesktopScene(scene, 1280, 720);

    expect(frame).toMatchObject({ width: 1280, height: 720, stride: 5120 });
    expect(frame.pixels).toHaveLength(1280 * 720 * 4);
    expect(new Set(samplePackedColors(frame.pixels, 16)).size).toBeGreaterThan(24);

    const windows = scene.nodes.filter((node) => node.kind === "desktop-window");
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(
      windows.some((window) =>
        window.nativeSurface?.commands.some(
          (command) => command.kind === "text" && command.text.length > 0,
        ),
      ),
    ).toBe(true);
    for (const window of windows) {
      const commandBounds = window.nativeSurface?.commands.map(
        (command) => command.bounds,
      );
      expect(commandBounds?.length).toBeGreaterThan(0);
      expect(
        Math.max(...(commandBounds?.map((bounds) => bounds.width) ?? [0])),
      ).toBeGreaterThan(1);
      expect(
        Math.max(...(commandBounds?.map((bounds) => bounds.height) ?? [0])),
      ).toBeGreaterThan(1);
      expect(window.base.bounds.x + window.base.bounds.width).toBeLessThanOrEqual(1280);
      expect(window.base.bounds.y + window.base.bounds.height).toBeLessThanOrEqual(720);
    }

    expect(runtime.applications.listRunning().length).toBeGreaterThanOrEqual(2);
  });

  it("recreates exact framebuffer dimensions for a resized scene", async () => {
    const { runtime } = await createScene(1280, 720);
    configureDisplay(runtime, 1024, 640);
    const resizedScene = new DesktopSceneComposer(runtime).compose({
      width: 1024,
      height: 640,
      scaleFactor: 1,
    });
    const frame = renderDesktopScene(resizedScene, 1024, 640);

    expect(frame).toMatchObject({ width: 1024, height: 640, stride: 4096 });
    expect(frame.pixels).toHaveLength(1024 * 640 * 4);
    const taskbar = resizedScene.nodes.find((node) => node.kind === "desktop-taskbar");
    expect(taskbar).toBeDefined();
    if (taskbar?.kind !== "desktop-taskbar") return;
    expect(taskbar.bounds.x + taskbar.bounds.width).toBeLessThanOrEqual(1024);
    expect(taskbar.bounds.y + taskbar.bounds.height).toBeLessThanOrEqual(640);
  });

  it("draws an outlined arrow cursor with its hotspot at the pointer position", async () => {
    const { scene } = await createScene(640, 480);
    const pointer = { x: 220, y: 140 };
    const nodesWithoutCursor = scene.nodes.filter(
      (node) => node.kind !== "desktop-cursor",
    );
    const cursorNode = scene.nodes.find((node) => node.kind === "desktop-cursor");
    if (cursorNode?.kind !== "desktop-cursor")
      throw new Error("The desktop scene did not contain a cursor.");
    const baseScene: DesktopScene = Object.freeze({
      ...scene,
      nodes: Object.freeze(nodesWithoutCursor),
    });
    const cursorScene: DesktopScene = Object.freeze({
      ...scene,
      nodes: Object.freeze([
        ...nodesWithoutCursor,
        Object.freeze({ ...cursorNode, position: pointer, visible: true }),
      ]),
    });
    const base = renderDesktopScene(baseScene, 640, 480);
    const withCursor = renderDesktopScene(cursorScene, 640, 480);

    expect(pixel(withCursor, pointer.x, pointer.y)).not.toEqual(
      pixel(base, pointer.x, pointer.y),
    );
    expect(pixel(withCursor, pointer.x + 14, pointer.y + 12)).not.toEqual(
      pixel(base, pointer.x + 14, pointer.y + 12),
    );
    expect(pixel(withCursor, pointer.x + 10, pointer.y + 18)).toEqual(
      pixel(base, pointer.x + 10, pointer.y + 18),
    );
  });

  it("translates local native commands once and clips them to window content", async () => {
    const { scene } = await createScene(640, 480);
    const target = scene.nodes.find(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    if (target === undefined) throw new Error("The scene did not contain a window.");
    const emptySurface = nativeSurface([]);
    const paintedSurface = nativeSurface([
      {
        id: "translated-red",
        kind: "material",
        bounds: { x: 4, y: 5, width: 20, height: 20 },
        color: "#ff0000",
        radius: 0,
      },
      {
        id: "clipped-green",
        kind: "material",
        bounds: {
          x: target.contentBounds.width - 10,
          y: 10,
          width: 30,
          height: 20,
        },
        color: "#00ff00",
        radius: 0,
      },
    ]);
    const base = renderDesktopScene(
      sceneWithSingleWindow(scene, target, emptySurface),
      640,
      480,
    );
    const painted = renderDesktopScene(
      sceneWithSingleWindow(scene, target, paintedSurface),
      640,
      480,
    );

    expect(
      pixel(painted, target.contentBounds.x + 5, target.contentBounds.y + 6),
    ).toEqual([255, 0, 0, 255]);
    expect(pixel(painted, 5, 6)).toEqual(pixel(base, 5, 6));
    expect(
      pixel(
        painted,
        target.contentBounds.x + target.contentBounds.width - 5,
        target.contentBounds.y + 15,
      ),
    ).toEqual([0, 255, 0, 255]);
    expect(
      pixel(
        painted,
        target.contentBounds.x + target.contentBounds.width + 5,
        target.contentBounds.y + 15,
      ),
    ).toEqual(
      pixel(
        base,
        target.contentBounds.x + target.contentBounds.width + 5,
        target.contentBounds.y + 15,
      ),
    );
  });

  it("matches a full repaint while limiting focus damage to changed windows and controls", async () => {
    const { runtime, scene } = await createScene(1280, 720);
    const incremental = new IncrementalFrameRenderer();
    incremental.render(scene, 1280, 720, new Uint8Array(1280 * 720 * 4));

    runtime.windows.focusWindow("window-1");
    const focused = new DesktopSceneComposer(runtime).compose({
      width: 1280,
      height: 720,
      scaleFactor: 1,
    });
    const actual = incremental.render(focused, 1280, 720, new Uint8Array(1280 * 720 * 4));
    const expected = renderDesktopScene(focused, 1280, 720);

    expect(pixelDifferenceBounds(actual, expected)).toBeUndefined();
    expect(
      actual.damage.reduce((area, bounds) => area + bounds.width * bounds.height, 0),
    ).toBeLessThan(1280 * 720);
  });

  it("restores the old cursor pixels and repaints only the cursor damage", async () => {
    const { scene } = await createScene(640, 480);
    const incremental = new IncrementalFrameRenderer();
    incremental.render(scene, 640, 480, new Uint8Array(640 * 480 * 4));
    const moved: DesktopScene = Object.freeze({
      ...scene,
      nodes: Object.freeze(
        scene.nodes.map((node) =>
          node.kind === "desktop-cursor"
            ? Object.freeze({ ...node, position: { x: 100, y: 80 } })
            : node,
        ),
      ),
    });
    const actual = incremental.render(moved, 640, 480, new Uint8Array(640 * 480 * 4));
    const expected = renderDesktopScene(moved, 640, 480);

    expect(Buffer.compare(Buffer.from(actual.pixels), Buffer.from(expected.pixels))).toBe(
      0,
    );
    expect(
      actual.damage.reduce((area, bounds) => area + bounds.width * bounds.height, 0),
    ).toBeLessThan(3_000);
  });

  it("renders per-corner radii and custom border widths", async () => {
    const { scene } = await createScene(640, 480);
    const target = scene.nodes.find(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    if (target === undefined) throw new Error("The scene did not contain a window.");

    const surface = nativeSurface([
      {
        id: "corner-box",
        kind: "material",
        bounds: { x: 10, y: 10, width: 80, height: 60 },
        color: "#ff0000",
        radius: 0,
        radii: { topLeft: 16, topRight: 0, bottomLeft: 0, bottomRight: 16 },
        borderColor: "#00ff00",
        borderWidth: 2,
      },
    ]);

    const rendered = renderDesktopScene(
      sceneWithSingleWindow(scene, target, surface),
      640,
      480,
    );

    const originX = target.contentBounds.x + 10;
    const originY = target.contentBounds.y + 10;

    // Top-left is rounded with radius 16: pixel at (originX + 1, originY + 1) is outside the corner curve
    const cornerPixel = pixel(rendered, originX + 1, originY + 1);
    expect(cornerPixel[0]).not.toBe(255); // not full red fill

    // Top-right is sharp (radius 0): pixel at (originX + 78, originY + 1) is border
    const topRightBorder = pixel(rendered, originX + 78, originY + 1);
    expect(topRightBorder).toEqual([0, 255, 0, 255]); // green border

    // Interior pixel is filled with red
    const interiorPixel = pixel(rendered, originX + 40, originY + 30);
    expect(interiorPixel).toEqual([255, 0, 0, 255]);
  });

  it("renders linear and radial gradients with stops", async () => {
    const { scene } = await createScene(640, 480);
    const target = scene.nodes.find(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    if (target === undefined) throw new Error("The scene did not contain a window.");

    const surface = nativeSurface([
      {
        id: "linear-grad",
        kind: "gradient",
        bounds: { x: 10, y: 10, width: 100, height: 40 },
        radius: 0,
        gradient: {
          kind: "linear",
          angle: 90, // Left to right
          stops: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ],
        },
      },
      {
        id: "radial-grad",
        kind: "gradient",
        bounds: { x: 10, y: 60, width: 80, height: 80 },
        radius: 0,
        gradient: {
          kind: "radial",
          stops: [
            { offset: 0, color: "#ffffff" },
            { offset: 1, color: "#000000" },
          ],
        },
      },
    ]);

    const rendered = renderDesktopScene(
      sceneWithSingleWindow(scene, target, surface),
      640,
      480,
    );

    const linX = target.contentBounds.x + 10;
    const linY = target.contentBounds.y + 10;

    // Linear gradient: left is predominantly red, right is predominantly blue
    const leftPixel = pixel(rendered, linX + 5, linY + 20);
    const rightPixel = pixel(rendered, linX + 95, linY + 20);
    expect(leftPixel[0]).toBeGreaterThan(200);
    expect(leftPixel[2]).toBeLessThan(50);
    expect(rightPixel[0]).toBeLessThan(50);
    expect(rightPixel[2]).toBeGreaterThan(200);

    // Radial gradient: center is bright white, outer corner is darker
    const radX = target.contentBounds.x + 10;
    const radY = target.contentBounds.y + 60;
    const centerPixel = pixel(rendered, radX + 40, radY + 40);
    const edgePixel = pixel(rendered, radX + 5, radY + 5);
    expect(centerPixel[0]).toBeGreaterThan(240);
    expect(centerPixel[1]).toBeGreaterThan(240);
    expect(centerPixel[2]).toBeGreaterThan(240);
    expect(edgePixel[0]).toBeLessThan(100);
  });

  it("renders soft shadows with offset and opacity", async () => {
    const { scene } = await createScene(640, 480);
    const target = scene.nodes.find(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    if (target === undefined) throw new Error("The scene did not contain a window.");

    const emptySurface = nativeSurface([]);
    const shadowSurface = nativeSurface([
      {
        id: "shadow-element",
        kind: "material",
        bounds: { x: 30, y: 30, width: 60, height: 40 },
        color: "#ffffff",
        radius: 4,
        shadow: {
          color: "#000000",
          blur: 12,
          x: 6,
          y: 8,
          opacity: 0.8,
        },
      },
    ]);

    const base = renderDesktopScene(
      sceneWithSingleWindow(scene, target, emptySurface),
      640,
      480,
    );
    const withShadow = renderDesktopScene(
      sceneWithSingleWindow(scene, target, shadowSurface),
      640,
      480,
    );

    const originX = target.contentBounds.x + 30;
    const originY = target.contentBounds.y + 30;

    // Inside the material bounds: pure white fill
    expect(pixel(withShadow, originX + 20, originY + 20)).toEqual([255, 255, 255, 255]);

    // Outside the material bounds but within the offset shadow cast region (e.g. x + 63, y + 44)
    // The shadow darkens the base desktop pixel
    const shadowPoint = pixel(withShadow, originX + 63, originY + 44);
    const basePoint = pixel(base, originX + 63, originY + 44);
    expect(shadowPoint).not.toEqual(basePoint);
    const b0 = basePoint[0] ?? 0;
    const b1 = basePoint[1] ?? 0;
    const b2 = basePoint[2] ?? 0;
    expect(shadowPoint[0]).toBeLessThanOrEqual(b0);
    expect(shadowPoint[1]).toBeLessThanOrEqual(b1);
    expect(shadowPoint[2]).toBeLessThanOrEqual(b2);
  });

  it("renders frosted-glass backdrop blur on materials", async () => {
    const { scene } = await createScene(640, 480);
    const target = scene.nodes.find(
      (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
    );
    if (target === undefined) throw new Error("The scene did not contain a window.");

    const surfaceWithoutBlur = nativeSurface([
      {
        id: "stripe-red",
        kind: "material",
        bounds: { x: 10, y: 10, width: 40, height: 60 },
        color: "#ff0000",
        radius: 0,
      },
      {
        id: "stripe-blue",
        kind: "material",
        bounds: { x: 50, y: 10, width: 40, height: 60 },
        color: "#0000ff",
        radius: 0,
      },
      {
        id: "glass-card",
        kind: "material",
        bounds: { x: 20, y: 20, width: 60, height: 40 },
        color: "rgba(0, 0, 0, 0.2)",
        radius: 0,
      },
    ]);

    const surfaceWithBlur = nativeSurface([
      {
        id: "stripe-red",
        kind: "material",
        bounds: { x: 10, y: 10, width: 40, height: 60 },
        color: "#ff0000",
        radius: 0,
      },
      {
        id: "stripe-blue",
        kind: "material",
        bounds: { x: 50, y: 10, width: 40, height: 60 },
        color: "#0000ff",
        radius: 0,
      },
      {
        id: "glass-card",
        kind: "material",
        bounds: { x: 20, y: 20, width: 60, height: 40 },
        color: "rgba(0, 0, 0, 0.2)",
        radius: 0,
        backdropBlur: 8,
      },
    ]);

    const renderedNoBlur = renderDesktopScene(
      sceneWithSingleWindow(scene, target, surfaceWithoutBlur),
      640,
      480,
    );
    const renderedBlur = renderDesktopScene(
      sceneWithSingleWindow(scene, target, surfaceWithBlur),
      640,
      480,
    );

    const boundaryX = target.contentBounds.x + 50;
    const midY = target.contentBounds.y + 35;

    // At the boundary x = 50, without blur there is an abrupt step from red to blue.
    // With backdrop blur, the pixels right at and near the boundary are smoothed together.
    const blurBoundaryPixel = pixel(renderedBlur, boundaryX, midY);
    const noBlurBoundaryPixel = pixel(renderedNoBlur, boundaryX, midY);

    expect(blurBoundaryPixel).not.toEqual(noBlurBoundaryPixel);
    // Both red and blue channels should be blended at the blurred boundary
    expect(blurBoundaryPixel[0]).toBeGreaterThan(30);
    expect(blurBoundaryPixel[2]).toBeGreaterThan(30);
  });
});

async function createScene(width: number, height: number) {
  const runtime = await createDesktopRuntime({ launchDefaults: true });
  runtimes.push(runtime);
  configureDisplay(runtime, width, height);
  const composer = new DesktopSceneComposer(runtime);
  let scene = composer.compose({ width, height, scaleFactor: 1 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const windows = scene.nodes.filter((node) => node.kind === "desktop-window");
    if (
      windows.length > 0 &&
      windows.every((window) => (window.nativeSurface?.commands.length ?? 0) > 0)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
    scene = composer.compose({ width, height, scaleFactor: 1 });
  }
  return { runtime, scene };
}

function configureDisplay(runtime: DesktopRuntime, width: number, height: number): void {
  runtime.layout.configureHostDisplays([
    {
      id: "display-test",
      name: "Test Display",
      bounds: { x: 0, y: 0, width, height },
      pixelWidth: width,
      pixelHeight: height,
      scaleFactor: 1,
      refreshRate: 60,
      primary: true,
    },
  ]);
}

function nativeSurface(
  commands: NativeRuntimeSnapshot["commands"],
): NativeRuntimeSnapshot {
  return Object.freeze({
    revision: 1,
    commands: Object.freeze([...commands]),
    accessibility: Object.freeze([]),
    overlays: Object.freeze([]),
    changedNodeIds: Object.freeze([]),
  });
}

function sceneWithSingleWindow(
  scene: DesktopScene,
  window: DesktopWindowSceneNode,
  nativeSurfaceSnapshot: NativeRuntimeSnapshot,
): DesktopScene {
  return Object.freeze({
    ...scene,
    nodes: Object.freeze(
      scene.nodes
        .filter(
          (node) =>
            node.kind === "desktop-background" ||
            (node.kind === "desktop-window" && node.windowId === window.windowId),
        )
        .map((node) =>
          node.kind === "desktop-window"
            ? Object.freeze({ ...node, nativeSurface: nativeSurfaceSnapshot })
            : node,
        ),
    ),
  });
}

function samplePackedColors(pixels: Uint8Array, spacing: number): number[] {
  const colors: number[] = [];
  for (let offset = 0; offset < pixels.length; offset += 4 * spacing) {
    colors.push(
      ((pixels[offset] ?? 0) << 24) |
        ((pixels[offset + 1] ?? 0) << 16) |
        ((pixels[offset + 2] ?? 0) << 8) |
        (pixels[offset + 3] ?? 0),
    );
  }
  return colors;
}

function pixel(
  frame: ReturnType<typeof renderDesktopScene>,
  x: number,
  y: number,
): readonly number[] {
  const offset = (y * frame.width + x) * 4;
  return Array.from(frame.pixels.slice(offset, offset + 4));
}

function pixelDifferenceBounds(
  actual: ReturnType<typeof renderDesktopScene>,
  expected: ReturnType<typeof renderDesktopScene>,
) {
  let left = actual.width;
  let top = actual.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < actual.height; y += 1)
    for (let x = 0; x < actual.width; x += 1) {
      const offset = (y * actual.width + x) * 4;
      if (
        actual.pixels[offset] === expected.pixels[offset] &&
        actual.pixels[offset + 1] === expected.pixels[offset + 1] &&
        actual.pixels[offset + 2] === expected.pixels[offset + 2] &&
        actual.pixels[offset + 3] === expected.pixels[offset + 3]
      )
        continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  return right < 0 ? undefined : { x: left, y: top, right, bottom };
}
