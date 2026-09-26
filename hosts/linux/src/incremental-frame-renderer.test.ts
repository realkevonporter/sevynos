import {
  createDesktopRuntime,
  DesktopSceneComposer,
  type DesktopRuntime,
  type DesktopScene,
  type DesktopWindowSceneNode,
} from "@sevynos/desktop-shell";
import type { NativeRuntimeSnapshot } from "@sevynos/react-native/internal";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBlinkDamage,
  IncrementalFrameRenderer,
} from "./incremental-frame-renderer.js";
import { CARET_BLINK_PERIOD_MS, caretBlinkPhase } from "./software-frame-renderer.js";

const runtimes: DesktopRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeForShutdown()));
});

describe("incremental frame renderer caret blink", () => {
  it("computes the blink phase on the shared epoch-anchored grid", () => {
    expect(CARET_BLINK_PERIOD_MS).toBe(530);
    expect(caretBlinkPhase(0)).toBe(0);
    expect(caretBlinkPhase(529)).toBe(0);
    expect(caretBlinkPhase(530)).toBe(1);
    expect(caretBlinkPhase(1059)).toBe(1);
    expect(caretBlinkPhase(1060)).toBe(0);
  });

  it("collects desktop-space damage regions for blink commands", async () => {
    const { scene, window } = await createSceneWithWindow();
    const caret = { x: 12, y: 60, width: 2, height: 18 };
    const blinkScene = sceneWithBlinkCaret(scene, window, caret);

    const regions = collectBlinkDamage(blinkScene);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      x: window.contentBounds.x + caret.x,
      y: window.contentBounds.y + caret.y,
      width: caret.width,
      height: caret.height,
    });
    // The unmodified scene carries no blink commands.
    expect(collectBlinkDamage(scene)).toHaveLength(0);
  });

  it("adds caret damage when the blink phase flips on an unchanged scene", async () => {
    const { scene, window } = await createSceneWithWindow();
    const caret = { x: 12, y: 60, width: 2, height: 18 };
    const blinkScene = sceneWithBlinkCaret(scene, window, caret);
    const renderer = new IncrementalFrameRenderer();
    const target = new Uint8Array(1280 * 720 * 4);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(0);
    const first = renderer.render(blinkScene, 1280, 720, target);
    expect(first.damage).toHaveLength(1);
    expect(first.damage[0]).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });

    const second = renderer.render(blinkScene, 1280, 720, target);
    expect(second.damage).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);

    now.mockReturnValue(CARET_BLINK_PERIOD_MS);
    const third = renderer.render(blinkScene, 1280, 720, target);
    const caretX = window.contentBounds.x + caret.x;
    const caretY = window.contentBounds.y + caret.y;
    expect(
      third.damage.some(
        (region) =>
          region.x <= caretX &&
          region.y <= caretY &&
          region.x + region.width >= caretX + caret.width &&
          region.y + region.height >= caretY + caret.height,
      ),
    ).toBe(true);
  });

  it("emits no blink damage when the phase is unchanged", async () => {
    const { scene, window } = await createSceneWithWindow();
    const blinkScene = sceneWithBlinkCaret(scene, window, {
      x: 12,
      y: 60,
      width: 2,
      height: 18,
    });
    const renderer = new IncrementalFrameRenderer();
    const target = new Uint8Array(1280 * 720 * 4);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(0);
    renderer.render(blinkScene, 1280, 720, target);
    // Same phase twice: the caret region must not be repainted.
    now.mockReturnValue(100);
    const second = renderer.render(blinkScene, 1280, 720, target);
    expect(second.damage).toEqual([{ x: 0, y: 0, width: 1, height: 1 }]);
  });
});

async function createSceneWithWindow(): Promise<{
  scene: DesktopScene;
  window: DesktopWindowSceneNode;
}> {
  const runtime = await createDesktopRuntime({ launchDefaults: true });
  runtimes.push(runtime);
  runtime.layout.configureHostDisplays([
    {
      id: "display-test",
      name: "Test Display",
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      pixelWidth: 1280,
      pixelHeight: 720,
      scaleFactor: 1,
      refreshRate: 60,
      primary: true,
    },
  ]);
  const composer = new DesktopSceneComposer(runtime);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const scene = composer.compose({ width: 1280, height: 720, scaleFactor: 1 });
    const window = scene.nodes.find(
      (node): node is DesktopWindowSceneNode =>
        node.kind === "desktop-window" && node.nativeSurface !== undefined,
    );
    if (window !== undefined) return { scene, window };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No window with a native surface appeared.");
}

function sceneWithBlinkCaret(
  scene: DesktopScene,
  window: DesktopWindowSceneNode,
  caretBounds: { x: number; y: number; width: number; height: number },
): DesktopScene {
  const snapshot: NativeRuntimeSnapshot = Object.freeze({
    revision: (window.nativeSurface?.revision ?? 0) + 1,
    commands: Object.freeze([
      ...(window.nativeSurface?.commands ?? []),
      Object.freeze({
        kind: "material",
        id: "test.caret",
        bounds: caretBounds,
        color: "#ffffff",
        radius: 0,
        blink: true,
      }),
    ]),
    accessibility: Object.freeze([]),
    overlays: Object.freeze([]),
    changedNodeIds: Object.freeze([]),
  });
  return Object.freeze({
    ...scene,
    nodes: Object.freeze(
      scene.nodes.map((node) =>
        node.kind === "desktop-window" && node.windowId === window.windowId
          ? Object.freeze({ ...node, nativeSurface: snapshot })
          : node,
      ),
    ),
  });
}
