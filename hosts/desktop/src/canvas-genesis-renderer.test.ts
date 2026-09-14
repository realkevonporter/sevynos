import { describe, expect, it, vi } from "vitest";
import { DisplayRenderPlan } from "@sevynos/graphics";
import { CanvasGenesisRenderer } from "./canvas-genesis-renderer.js";
import type { DesktopScene } from "@sevynos/desktop-shell/internal";
import type { NativeApplicationSurfaceSnapshot } from "@sevynos/react-native/internal";

function createTestPlan(scene: DesktopScene): DisplayRenderPlan<DesktopScene> {
  return new DisplayRenderPlan({
    displayId: "display-1",
    displayBounds: { x: 0, y: 0, width: 1280, height: 720 },
    displayMode: { width: 1280, height: 720, refreshRate: 60 },
    scaleFactor: 1,
    orientation: "landscape",
    scene,
    createdAt: new Date(),
  });
}

function createMockContext(): {
  readonly context: CanvasRenderingContext2D;
  readonly calls: {
    roundRect: unknown[][];
    createLinearGradient: unknown[][];
    createRadialGradient: unknown[][];
    setLineDash: unknown[][];
    drawImage: unknown[][];
    fillCount: number;
  };
} {
  const calls = {
    roundRect: [] as unknown[][],
    createLinearGradient: [] as unknown[][],
    createRadialGradient: [] as unknown[][],
    setLineDash: [] as unknown[][],
    drawImage: [] as unknown[][],
    fillCount: 0,
  };

  const mockGradient = {
    addColorStop: vi.fn(),
  };

  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(() => {
      calls.fillCount += 1;
    }),
    stroke: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn((...args: unknown[]) => {
      calls.roundRect.push(args);
    }),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 50 })),
    setTransform: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn((...args: unknown[]) => {
      calls.setLineDash.push(args);
    }),
    createLinearGradient: vi.fn((...args: unknown[]) => {
      calls.createLinearGradient.push(args);
      return mockGradient;
    }),
    createRadialGradient: vi.fn((...args: unknown[]) => {
      calls.createRadialGradient.push(args);
      return mockGradient;
    }),
    drawImage: vi.fn((...args: unknown[]) => {
      calls.drawImage.push(args);
    }),
    globalAlpha: 1,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: "none",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;

  return { context, calls };
}

function createMockCanvas(context: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    width: 1280,
    height: 720,
    style: {
      cursor: "default",
      width: "1280px",
      height: "720px",
    },
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

function createSceneWithNativeSurface(
  nativeSurface: NativeApplicationSurfaceSnapshot,
): DesktopScene {
  return {
    base: { id: "scene-1" },
    viewport: { width: 1280, height: 720, scaleFactor: 1 },
    settings: {
      theme: "dark",
      accentColor: "#d5aa4e",
      cursorSize: 1,
      reducedMotion: false,
    },
    nodes: [
      {
        kind: "desktop-window",
        order: 1,
        title: "Test Window",
        nativeSurface: {
          revision: 1,
          commands: nativeSurface.commands,
          accessibility: [],
        },
        controls: [],
        base: {
          id: "win-1",
          bounds: { x: 50, y: 50, width: 600, height: 400 },
          focused: true,
        },
        contentBounds: { x: 50, y: 80, width: 600, height: 370 },
      },
    ],
  } as unknown as DesktopScene;
}

describe("CanvasGenesisRenderer visual capabilities", () => {
  it("initializes and transitions through renderer lifecycle", () => {
    const { context } = createMockContext();
    const canvas = createMockCanvas(context);
    const renderer = new CanvasGenesisRenderer(canvas, context);

    expect(renderer.state).toBe("created");
    renderer.initialize();
    expect(renderer.state).toBe("initialized");
    expect(canvas.style.cursor).toBe("none");

    renderer.shutdown();
    expect(renderer.state).toBe("shutdown");
  });

  it("renders borders, dashed styles, and per-corner radii on material", () => {
    const { context, calls } = createMockContext();
    const canvas = createMockCanvas(context);
    const renderer = new CanvasGenesisRenderer(canvas, context);
    renderer.initialize();

    const scene = createSceneWithNativeSurface({
      kind: "sevyn-native-surface",
      application: "settings",
      appearance: "dark",
      reducedMotion: false,
      colors: {} as never,
      commands: [
        {
          id: "card-1",
          kind: "material",
          bounds: { x: 10, y: 10, width: 200, height: 100 },
          color: "rgba(255, 255, 255, 0.05)",
          radius: 8,
          radii: { topLeft: 12, topRight: 12, bottomLeft: 4, bottomRight: 4 },
          borderColor: "#D7AC57",
          borderWidth: 2,
          borderStyle: "dashed",
        },
      ],
    });

    const result = renderer.render(createTestPlan(scene));

    expect(result.status).toBe("rendered");
    expect(calls.setLineDash).toContainEqual([[4, 4]]);
    // Check that roundRect was called with the per-corner radii array [12, 12, 4, 4]
    expect(
      calls.roundRect.some((args) => Array.isArray(args[4]) && args[4][0] === 12),
    ).toBe(true);
  });

  it("renders linear and radial gradients on material and gradient commands", () => {
    const { context, calls } = createMockContext();
    const canvas = createMockCanvas(context);
    const renderer = new CanvasGenesisRenderer(canvas, context);
    renderer.initialize();

    const scene = createSceneWithNativeSurface({
      kind: "sevyn-native-surface",
      application: "settings",
      appearance: "dark",
      reducedMotion: false,
      colors: {} as never,
      commands: [
        {
          id: "grad-material",
          kind: "material",
          bounds: { x: 0, y: 0, width: 200, height: 100 },
          color: "transparent",
          radius: 0,
          gradient: {
            kind: "linear",
            angle: 45,
            stops: [
              { offset: 0, color: "#ff0000" },
              { offset: 1, color: "#0000ff" },
            ],
          },
        },
        {
          id: "radial-command",
          kind: "gradient",
          bounds: { x: 50, y: 50, width: 100, height: 100 },
          radius: 50,
          gradient: {
            kind: "radial",
            stops: [
              { offset: 0, color: "#ffffff" },
              { offset: 1, color: "transparent" },
            ],
          },
        },
      ],
    });

    renderer.render(createTestPlan(scene));

    expect(calls.createLinearGradient.length).toBeGreaterThanOrEqual(1);
    expect(calls.createRadialGradient.length).toBeGreaterThanOrEqual(1);
  });

  it("renders shadows with blur, offset, and opacity", () => {
    const { context, calls } = createMockContext();
    const canvas = createMockCanvas(context);
    const renderer = new CanvasGenesisRenderer(canvas, context);
    renderer.initialize();

    const scene = createSceneWithNativeSurface({
      kind: "sevyn-native-surface",
      application: "settings",
      appearance: "dark",
      reducedMotion: false,
      colors: {} as never,
      commands: [
        {
          id: "shadowed-box",
          kind: "material",
          bounds: { x: 20, y: 20, width: 150, height: 80 },
          color: "#22272e",
          radius: 10,
          shadow: {
            color: "rgba(0, 0, 0, 0.8)",
            blur: 16,
            x: 2,
            y: 8,
            opacity: 0.5,
          },
        },
      ],
    });

    renderer.render(createTestPlan(scene));

    expect(calls.fillCount).toBeGreaterThan(0);
  });

  it("renders frosted-glass panel with backdropBlur", () => {
    const { context } = createMockContext();
    const canvas = createMockCanvas(context);
    const renderer = new CanvasGenesisRenderer(canvas, context);
    renderer.initialize();

    const scene = createSceneWithNativeSurface({
      kind: "sevyn-native-surface",
      application: "settings",
      appearance: "dark",
      reducedMotion: false,
      colors: {} as never,
      commands: [
        {
          id: "frosted-glass",
          kind: "material",
          bounds: { x: 10, y: 10, width: 300, height: 200 },
          color: "rgba(255, 255, 255, 0.12)",
          radius: 16,
          backdropBlur: 20,
          borderWidth: 1,
          borderColor: "rgba(255, 255, 255, 0.2)",
        },
      ],
    });

    const result = renderer.render(createTestPlan(scene));

    expect(result.status).toBe("rendered");
  });
});
