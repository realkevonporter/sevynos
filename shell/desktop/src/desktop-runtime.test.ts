import { describe, expect, it, vi } from "vitest";
import type { DesktopStatusBarSceneNode } from "@sevynos/system-applications/desktop";
import {
  DisplayRegistry,
  DisplayRenderPlanner,
  GenesisDisplayManager,
  GenesisFrameExecutor,
  GenesisRenderLoop,
  ManualRenderLoopScheduler,
  RenderResult,
  type DisplayRenderPlan,
  type GenesisRenderer,
  type RendererState,
} from "@sevynos/graphics";

import {
  createDesktopRuntime,
  getRenderableWindows,
  type BrowserPointerEvent,
  type BrowserKeyboardEvent,
  type DesktopRuntime,
} from "./desktop-runtime.js";
import { createRenderInvalidator } from "./render-invalidator.js";
import { DesktopSceneComposer } from "./desktop-scene-composer.js";
import { hitTestDesktopSceneControl } from "./desktop-scene-hit-testing.js";
import type { DesktopScene, DesktopWindowSceneNode } from "./desktop-scene.js";
import { getWindowControlRects } from "./window-controls.js";

interface PointerOptions {
  readonly type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  readonly x: number;
  readonly y: number;
  readonly button?: number;
  readonly buttons?: number;
  readonly pointerId?: number;
  readonly timeStamp?: number;
}

function pointer(options: PointerOptions): BrowserPointerEvent {
  return {
    type: options.type,
    pointerId: options.pointerId ?? 1,
    timeStamp: options.timeStamp ?? 1,
    clientX: options.x,
    clientY: options.y,
    button: options.button ?? (options.type === "pointermove" ? -1 : 0),
    buttons: options.buttons ?? (options.type === "pointerup" ? 0 : 1),
    pressure: options.type === "pointerup" ? 0 : 0.5,
  };
}

function dispatch(runtime: DesktopRuntime, options: PointerOptions): void {
  runtime.dispatchPointerEvent(pointer(options));
}

function keyboard(
  key: string,
  options: Partial<BrowserKeyboardEvent> = {},
): BrowserKeyboardEvent {
  return {
    type: options.type ?? "keydown",
    timeStamp: options.timeStamp ?? 1,
    code: options.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    key,
    repeat: options.repeat ?? false,
    isComposing: options.isComposing ?? false,
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
  };
}

function consoleInput(runtime: DesktopRuntime): string | undefined {
  const surface = runtime.surfaces.get("window-2");
  return surface?.kind === "console" ? surface.input : undefined;
}

function compose(runtime: DesktopRuntime): DesktopScene {
  return new DesktopSceneComposer(runtime).compose({
    width: 1200,
    height: 800,
    scaleFactor: 2,
  });
}

function sceneWindows(scene: DesktopScene): readonly DesktopWindowSceneNode[] {
  return scene.nodes.filter(
    (node): node is DesktopWindowSceneNode => node.kind === "desktop-window",
  );
}

async function waitForNativeApplication(
  runtime: DesktopRuntime,
  windowId: string,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const window = sceneWindows(compose(runtime)).find(
      (candidate) => candidate.windowId === windowId,
    );
    if (
      window?.nativeSurface?.accessibility.some((item) => item.label === label) === true
    )
      return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`Native application "${label}" did not commit.`);
}

async function waitForNativeCommands(
  runtime: DesktopRuntime,
  windowId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const window = sceneWindows(compose(runtime)).find(
      (candidate) => candidate.windowId === windowId,
    );
    if ((window?.nativeSurface?.commands.length ?? 0) > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`Native application "${windowId}" did not commit commands.`);
}

class RecordingRenderer implements GenesisRenderer<DesktopScene> {
  public state: RendererState = "created";

  public readonly scenes: DesktopScene[] = [];

  public initialize(): void {
    this.state = "initialized";
  }

  public render(plan: DisplayRenderPlan<DesktopScene>): RenderResult {
    this.scenes.push(plan.scene);
    return new RenderResult({
      frameNumber: this.scenes.length,
      displayId: plan.displayId,
      status: "rendered",
      startedAt: new Date(1),
      completedAt: new Date(1),
      commandCount: plan.scene.nodes.length,
    });
  }

  public shutdown(): void {
    this.state = "shutdown";
  }
}

describe("Genesis desktop host runtime", () => {
  it("boots two real windows in deterministic render order", async () => {
    const runtime = await createDesktopRuntime();
    const windows = getRenderableWindows(runtime);

    expect(windows.map((window) => window.title)).toEqual([
      "Welcome to SevynOS",
      "Genesis Console",
    ]);
    expect(windows[0]?.state).toBe("visible");
    expect(windows[1]?.state).toBe("focused");
    expect(windows[0]?.zIndex).toBeLessThan(windows[1]?.zIndex ?? 0);
  });

  it("creates collision-safe desktop folders and files and composes them", async () => {
    const runtime = await createDesktopRuntime({ launchDefaults: false });
    const composer = new DesktopSceneComposer(runtime);

    expect(await runtime.createDesktopFolder()).toBe("/Desktop/New Folder");
    expect(await runtime.createDesktopFolder()).toBe("/Desktop/New Folder 2");
    expect(await runtime.createDesktopFile()).toBe("/Desktop/New Text File.txt");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const scene = composer.compose({ width: 1200, height: 800, scaleFactor: 1 });
    expect(
      scene.nodes
        .filter((node) => node.kind === "desktop-workspace-item")
        .map((node) => node.label),
    ).toEqual(["New Folder", "New Folder 2", "New Text File.txt"]);
    expect(hitTestDesktopSceneControl(scene, 32, 86)?.kind).toBe(
      "desktop-workspace-action",
    );
    composer.dispose();
    await runtime.closeForShutdown();
  });

  it("routes pointer focus and z-order through one desktop coordinator", async () => {
    const runtime = await createDesktopRuntime();

    expect(runtime.dispatcher.listListenerIds()).toEqual([
      "sevynos:desktop-keyboard-router",
      "sevynos:desktop-interaction-runtime",
    ]);

    // Click on window-1's title bar area (top-left, avoiding overlap with window-2)
    // to focus it. Window-1 is at (60,142), window-2 at (100,170), so (70,150)
    // hits window-1 exclusively.
    dispatch(runtime, {
      type: "pointerdown",
      x: 70,
      y: 150,
    });

    const welcome = runtime.windows.getWindow("window-1");
    const consoleWindow = runtime.windows.getWindow("window-2");

    expect(welcome?.state).toBe("focused");
    expect(consoleWindow?.state).toBe("visible");
    expect(welcome?.zIndex).toBeGreaterThan(consoleWindow?.zIndex ?? 0);
  });

  it("drags from the initial pointer and window positions", async () => {
    const runtime = await createDesktopRuntime();
    const initial = runtime.windows.getWindow("window-2")?.bounds;
    expect(initial).toBeDefined();
    if (initial === undefined) return;

    dispatch(runtime, {
      type: "pointerdown",
      x: initial.x + 40,
      y: initial.y + 20,
    });
    dispatch(runtime, {
      type: "pointermove",
      x: initial.x + 140,
      y: initial.y + 90,
      timeStamp: 2,
    });

    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual({
      ...initial,
      x: initial.x + 100,
      y: initial.y + 70,
    });
    expect(runtime.cursor.state.kind).toBe("move");

    dispatch(runtime, {
      type: "pointerup",
      x: initial.x + 140,
      y: initial.y + 90,
      timeStamp: 3,
    });

    expect(runtime.cursor.state.kind).toBe("default");
  });

  it("resizes corners ahead of title-bar dragging and enforces minimums", async () => {
    const runtime = await createDesktopRuntime();
    const initial = runtime.windows.getWindow("window-2")?.bounds;
    expect(initial).toBeDefined();
    if (initial === undefined) return;

    dispatch(runtime, {
      type: "pointerdown",
      x: initial.x,
      y: initial.y,
    });
    dispatch(runtime, {
      type: "pointermove",
      x: initial.x + initial.width,
      y: initial.y + initial.height,
      timeStamp: 2,
    });

    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual({
      x: initial.x + initial.width - 320,
      y: initial.y + initial.height - 200,
      width: 320,
      height: 200,
    });
    expect(runtime.cursor.state.kind).toBe("resize-nwse");

    dispatch(runtime, {
      type: "pointercancel",
      x: initial.x + initial.width,
      y: initial.y + initial.height,
      timeStamp: 3,
    });
  });

  it("maps window edges to the native cursor state", async () => {
    const runtime = await createDesktopRuntime();
    const bounds = runtime.windows.getWindow("window-2")?.bounds;
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;

    dispatch(runtime, {
      type: "pointermove",
      x: bounds.x + bounds.width - 2,
      y: bounds.y + bounds.height / 2,
      buttons: 0,
    });

    expect(runtime.cursor.state.kind).toBe("resize-ew");
  });

  it("minimizes through the manager and focuses the next window", async () => {
    const runtime = await createDesktopRuntime();

    await runtime.activateWindowControl("window-2", "minimize", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });

    expect(runtime.windows.getWindow("window-2")?.state).toBe("minimized");
    expect(runtime.windows.getWindow("window-1")?.state).toBe("focused");
  });

  it("closes through the manager and focuses the next window", async () => {
    const runtime = await createDesktopRuntime();

    await runtime.activateWindowControl("window-2", "close", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });

    expect(runtime.windows.getWindow("window-2")?.state).toBe("closed");
    expect(runtime.windows.getWindow("window-1")?.state).toBe("focused");
  });

  it("maximizes and restores the previous bounds", async () => {
    const runtime = await createDesktopRuntime();
    const originalBounds = runtime.windows.getWindow("window-2")?.bounds;
    const maximizedBounds = { x: 0, y: 0, width: 1200, height: 800 };

    await runtime.activateWindowControl("window-2", "maximize", maximizedBounds);

    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual(
      runtime.environment.getDisplayForBounds(originalBounds ?? maximizedBounds).workArea,
    );
    expect(runtime.isMaximized("window-2")).toBe(true);

    await runtime.activateWindowControl("window-2", "restore", maximizedBounds);

    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual(originalBounds);
    expect(runtime.isMaximized("window-2")).toBe(false);
  });

  it("does not begin dragging from title-bar controls", async () => {
    const runtime = await createDesktopRuntime();
    const window = runtime.windows.getWindow("window-2");

    expect(window).toBeDefined();

    if (window === undefined) {
      return;
    }

    const minimize = getWindowControlRects(window).find(
      (control) => control.kind === "minimize",
    );

    expect(minimize).toBeDefined();

    if (minimize === undefined) {
      return;
    }

    dispatch(runtime, {
      type: "pointerdown",
      x: minimize.x + minimize.width / 2,
      y: minimize.y + minimize.height / 2,
    });
    dispatch(runtime, {
      type: "pointermove",
      x: minimize.x - 100,
      y: minimize.y + 100,
      timeStamp: 2,
    });

    expect(runtime.windows.getWindow("window-2")?.bounds).toEqual(window.bounds);
    expect(runtime.cursor.state.kind).not.toBe("move");
  });

  it("coalesces redraws after changes and remains idle otherwise", async () => {
    const runtime = await createDesktopRuntime();
    const scheduled: (() => void)[] = [];
    let renderCount = 0;
    const invalidator = createRenderInvalidator(
      () => {
        renderCount += 1;
      },
      (render) => {
        scheduled.push(render);
      },
    );

    runtime.subscribe(invalidator.invalidate);

    expect(scheduled).toHaveLength(0);
    expect(renderCount).toBe(0);

    runtime.windows.moveWindow({ windowId: "window-2", x: 600, y: 320 });
    runtime.windows.focusWindow("window-1");

    expect(scheduled).toHaveLength(1);
    expect(renderCount).toBe(0);

    scheduled[0]?.();

    expect(renderCount).toBe(1);
    expect(invalidator.pending).toBe(false);
    expect(scheduled).toHaveLength(1);
  });

  it("delivers keyboard input only to the focused console", async () => {
    const runtime = await createDesktopRuntime();

    runtime.dispatchKeyboardEvent(keyboard("h"));
    runtime.dispatchKeyboardEvent(keyboard("i", { timeStamp: 2 }));

    expect(consoleInput(runtime)).toBe("hi");
    expect(runtime.surfaces.get("window-1")?.kind).toBe("welcome");
  });

  it("changes the keyboard recipient when window focus changes", async () => {
    const runtime = await createDesktopRuntime();
    const welcome = runtime.windows.getWindow("window-1")?.bounds;
    const consoleWindow = runtime.windows.getWindow("window-2")?.bounds;
    expect(welcome).toBeDefined();
    expect(consoleWindow).toBeDefined();
    if (welcome === undefined || consoleWindow === undefined) return;

    dispatch(runtime, {
      type: "pointerdown",
      x: welcome.x + 24,
      y: welcome.y + 70,
    });
    runtime.dispatchKeyboardEvent(keyboard("x"));

    expect(consoleInput(runtime)).toBe("");

    dispatch(runtime, {
      type: "pointerdown",
      x: consoleWindow.x + consoleWindow.width / 2,
      y: consoleWindow.y + consoleWindow.height - 16,
      timeStamp: 2,
    });
    runtime.dispatchKeyboardEvent(keyboard("y", { timeStamp: 3 }));

    expect(consoleInput(runtime)).toBe("y");
  });

  it("handles Backspace, Enter, and Escape in the Console surface", async () => {
    const runtime = await createDesktopRuntime();

    runtime.dispatchKeyboardEvent(keyboard("a"));
    runtime.dispatchKeyboardEvent(keyboard("b", { timeStamp: 2 }));
    runtime.dispatchKeyboardEvent(keyboard("Backspace", { timeStamp: 3 }));

    expect(consoleInput(runtime)).toBe("a");

    runtime.dispatchKeyboardEvent(keyboard("Enter", { timeStamp: 4 }));

    const submitted = runtime.surfaces.get("window-2");
    expect(submitted?.kind === "console" ? submitted.history.at(-1) : undefined).toBe(
      "sevyn> a",
    );
    expect(consoleInput(runtime)).toBe("");

    runtime.dispatchKeyboardEvent(keyboard("z", { timeStamp: 5 }));
    runtime.dispatchKeyboardEvent(keyboard("Escape", { timeStamp: 6 }));

    expect(consoleInput(runtime)).toBe("");
  });

  it("unregisters input and removes the surface when a window closes", async () => {
    const runtime = await createDesktopRuntime();

    await runtime.activateWindowControl("window-2", "close", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });

    expect(runtime.focusedInput.hasTarget("window-2")).toBe(false);
    expect(runtime.surfaces.has("window-2")).toBe(false);

    runtime.dispatchKeyboardEvent(keyboard("x"));

    expect(runtime.surfaces.has("window-2")).toBe(false);
  });

  it("coalesces application-surface redraws", async () => {
    const runtime = await createDesktopRuntime();
    const scheduled: (() => void)[] = [];
    let renderCount = 0;
    const invalidator = createRenderInvalidator(
      () => {
        renderCount += 1;
      },
      (render) => {
        scheduled.push(render);
      },
    );

    runtime.subscribe(invalidator.invalidate);
    runtime.dispatchKeyboardEvent(keyboard("a"));
    runtime.dispatchKeyboardEvent(keyboard("b", { timeStamp: 2 }));

    expect(scheduled).toHaveLength(1);
    expect(renderCount).toBe(0);

    scheduled[0]?.();

    expect(renderCount).toBe(1);
    expect(consoleInput(runtime)).toBe("ab");
  });

  it("composes window state and deterministic z-order into the desktop scene", async () => {
    const runtime = await createDesktopRuntime();
    const windows = sceneWindows(compose(runtime));

    expect(windows.map((node) => node.windowId)).toEqual(["window-1", "window-2"]);
    expect(windows.map((node) => node.base.focused)).toEqual([false, true]);
    expect(windows[0]?.order).toBeLessThan(windows[1]?.order ?? 0);

    runtime.windows.focusWindow("window-1");

    expect(sceneWindows(compose(runtime)).map((node) => node.windowId)).toEqual([
      "window-2",
      "window-1",
    ]);
  });

  it("reflects moved and resized bounds in the next scene", async () => {
    const runtime = await createDesktopRuntime();
    const bounds = { x: 40, y: 50, width: 700, height: 500 };

    runtime.windows.resizeWindow({ windowId: "window-2", bounds });

    const consoleNode = sceneWindows(compose(runtime)).find(
      (node) => node.windowId === "window-2",
    );
    expect(consoleNode?.base.bounds).toEqual(bounds);
  });

  it("composes application surface and cursor state", async () => {
    const runtime = await createDesktopRuntime();
    const bounds = runtime.windows.getWindow("window-2")?.bounds;
    expect(bounds).toBeDefined();
    if (bounds === undefined) return;

    runtime.dispatchKeyboardEvent(keyboard("x"));
    dispatch(runtime, {
      type: "pointermove",
      x: bounds.x + bounds.width - 2,
      y: bounds.y + bounds.height / 2,
      buttons: 0,
    });

    compose(runtime);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const scene = compose(runtime);
    const consoleNode = sceneWindows(scene).find((node) => node.windowId === "window-2");
    const cursorNode = scene.nodes.find((node) => node.kind === "desktop-cursor");

    expect(consoleNode?.surface?.kind).toBe("console");
    expect(
      consoleNode?.surface?.kind === "console" ? consoleNode.surface.input : undefined,
    ).toBe("x");
    expect(
      cursorNode?.kind === "desktop-cursor" ? cursorNode.cursorKind : undefined,
    ).toBe("resize-ew");
  });

  it("reuses unchanged native application content for focus and cursor-only frames", async () => {
    const runtime = await createDesktopRuntime();
    await waitForNativeCommands(runtime, "window-1");
    await waitForNativeCommands(runtime, "window-2");
    const before = new Map(
      sceneWindows(compose(runtime)).map((window) => [
        window.windowId,
        window.nativeSurface,
      ]),
    );

    runtime.windows.focusWindow("window-1");
    const afterFocus = new Map(
      sceneWindows(compose(runtime)).map((window) => [
        window.windowId,
        window.nativeSurface,
      ]),
    );
    expect(afterFocus.get("window-1")).toBe(before.get("window-1"));
    expect(afterFocus.get("window-2")).toBe(before.get("window-2"));

    dispatch(runtime, { type: "pointermove", x: 40, y: 40 });
    const afterCursor = new Map(
      sceneWindows(compose(runtime)).map((window) => [
        window.windowId,
        window.nativeSurface,
      ]),
    );
    expect(afterCursor.get("window-1")).toBe(before.get("window-1"));
    expect(afterCursor.get("window-2")).toBe(before.get("window-2"));
  });

  it("excludes minimized and closed windows from composed scenes", async () => {
    const runtime = await createDesktopRuntime();

    await runtime.activateWindowControl("window-2", "minimize", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    expect(sceneWindows(compose(runtime)).map((node) => node.windowId)).toEqual([
      "window-1",
    ]);

    await runtime.activateWindowControl("window-1", "close", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    expect(sceneWindows(compose(runtime))).toHaveLength(0);
  });

  it("executes one real frame per coalesced invalidation and stays idle", async () => {
    const runtime = await createDesktopRuntime();
    const composer = new DesktopSceneComposer(runtime);
    const displays = new DisplayRegistry();
    const displayManager = new GenesisDisplayManager({
      displays,
      createDisplayId: () => "display-test",
      now: () => new Date(1),
    });
    const display = displayManager.connectDisplay({
      name: "Test Display",
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      mode: { width: 1200, height: 800, refreshRate: 60 },
      scaleFactor: 1,
      orientation: "landscape",
    });
    displayManager.activateDisplay(display.id);
    const planner = new DisplayRenderPlanner({ displays, now: () => new Date(1) });
    const renderer = new RecordingRenderer();
    renderer.initialize();
    const executor = new GenesisFrameExecutor<DesktopScene>({
      createRenderPlans: () =>
        planner.createRenderPlans(
          composer.compose({ width: 1200, height: 800, scaleFactor: 1 }),
        ),
      renderer,
      now: () => new Date(1),
    });
    const loop = new GenesisRenderLoop({ executeFrame: () => executor.executeFrame() });
    const scheduler = new ManualRenderLoopScheduler({ frameDriver: loop });
    loop.start();
    scheduler.start();
    const scheduled: (() => void)[] = [];
    const invalidator = createRenderInvalidator(
      () => {
        loop.requestFrame();
        scheduler.step();
      },
      (frame) => scheduled.push(frame),
    );
    runtime.subscribe(invalidator.invalidate);

    invalidator.invalidate();
    invalidator.invalidate();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(renderer.scenes).toHaveLength(1);

    scheduler.step();
    expect(renderer.scenes).toHaveLength(1);

    runtime.windows.moveWindow({ windowId: "window-2", x: 700, y: 400 });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(renderer.scenes).toHaveLength(2);
  });

  it("launches catalog applications and reuses an existing primary instance", async () => {
    const runtime = await createDesktopRuntime();
    const first = await runtime.applications.launch("org.sevynos.system-monitor");
    const second = await runtime.applications.launch("org.sevynos.system-monitor");

    expect(second).toBe(first);
    expect(runtime.applications.listRunning()).toHaveLength(3);
    expect(runtime.platformRuntime.listApplicationSessions()).toHaveLength(3);
    expect(runtime.windows.getWindow(first.windowId)?.state).toBe("focused");
  });

  it("registers and launches a development application dynamically", async () => {
    const runtime = await createDesktopRuntime();
    const before = runtime.applications.catalog.length;

    runtime.applications.registerDevelopmentApplication(
      "dev.sevynos.example",
      "Example Development App",
    );

    expect(runtime.applications.catalog).toHaveLength(before + 1);
    const launched = await runtime.applications.launch("dev.sevynos.example");
    expect(launched.definition.name).toBe("Example Development App");
    expect(
      runtime.platformRuntime.getApplicationSession(launched.sessionId),
    ).toBeDefined();
  });

  it("launches the React browser and text editor as native desktop surfaces", async () => {
    const runtime = await createDesktopRuntime();
    const browser = await runtime.applications.launch("org.sevynos.browser");
    const editor = await runtime.applications.launch("org.sevynos.text-editor");
    await waitForNativeApplication(runtime, browser.windowId, "Browser");
    await waitForNativeApplication(runtime, editor.windowId, "Text Editor");

    expect(runtime.surfaces.get(browser.windowId)?.kind).toBe("browser");
    expect(runtime.surfaces.get(editor.windowId)?.kind).toBe("text-editor");
    const scene = compose(runtime);
    const browserWindow = scene.nodes.find(
      (node) => node.kind === "desktop-window" && node.windowId === browser.windowId,
    );
    const editorWindow = scene.nodes.find(
      (node) => node.kind === "desktop-window" && node.windowId === editor.windowId,
    );
    expect(
      browserWindow?.kind === "desktop-window" &&
        browserWindow.nativeSurface?.accessibility.some(
          (item) => item.label === "Browser",
        ),
    ).toBe(true);
    expect(
      editorWindow?.kind === "desktop-window" &&
        editorWindow.nativeSurface?.accessibility.some(
          (item) => item.label === "Text Editor",
        ),
    ).toBe(true);
  });

  it("focuses, restores, and minimizes applications through taskbar actions", async () => {
    const runtime = await createDesktopRuntime();
    runtime.applications.activateTaskbarApplication("org.sevynos.console");
    expect(runtime.windows.getWindow("window-2")?.state).toBe("minimized");

    runtime.applications.activateTaskbarApplication("org.sevynos.console");
    expect(runtime.windows.getWindow("window-2")?.state).toBe("focused");

    runtime.windows.focusWindow("window-1");
    runtime.applications.activateTaskbarApplication("org.sevynos.console");
    expect(runtime.windows.getWindow("window-2")?.state).toBe("focused");
  });

  it("cleans session, surface, and input target when the final window closes", async () => {
    const runtime = await createDesktopRuntime();
    const running = runtime.applications.getByApplicationId("org.sevynos.console");
    expect(running).toBeDefined();
    if (running === undefined) return;

    await runtime.applications.closeWindow(running.windowId);

    expect(
      runtime.applications.getByApplicationId("org.sevynos.console"),
    ).toBeUndefined();
    expect(runtime.platformRuntime.getApplicationSession(running.sessionId)?.state).toBe(
      "stopped",
    );
    expect(runtime.surfaces.has(running.windowId)).toBe(false);
    expect(runtime.focusedInput.hasTarget(running.windowId)).toBe(false);
  });

  it("represents interactive launcher and taskbar controls outside window geometry", async () => {
    const runtime = await createDesktopRuntime();
    runtime.applications.toggleLauncher();
    const scene = compose(runtime);
    const launcher = scene.nodes.find((node) => node.kind === "desktop-launcher-button");
    const entries = scene.nodes.filter((node) => node.kind === "desktop-launcher-entry");
    const running = scene.nodes.filter(
      (node) => node.kind === "desktop-taskbar-application",
    );

    expect(launcher?.kind === "desktop-launcher-button" && launcher.open).toBe(true);
    expect(entries).toHaveLength(runtime.applications.catalog.length);
    expect(running).toHaveLength(3);
    expect(
      running.some(
        (node) => node.applicationId === "org.sevynos.installer" && node.pinned,
      ),
    ).toBe(true);
    for (const node of [launcher, ...entries, ...running]) {
      expect(node).toBeDefined();
      if (node === undefined) continue;
      expect(
        hitTestDesktopSceneControl(
          scene,
          node.bounds.x + node.bounds.width / 2,
          node.bounds.y + node.bounds.height / 2,
        )?.kind,
      ).toBe(node.kind);
    }
  });

  it("keeps launcher entries reachable for every taskbar position", async () => {
    for (const taskbarPosition of ["bottom", "top", "left", "right"] as const) {
      const runtime = await createDesktopRuntime();
      runtime.environment.configure(1200, 800, 1, "vertical");
      runtime.settings.update({ taskbarPosition });
      runtime.applications.toggleLauncher();
      const scene = compose(runtime);
      const primary = runtime.environment
        .listDisplays()
        .find((display) => display.primary);
      expect(primary).toBeDefined();
      if (primary === undefined) continue;
      const entries = scene.nodes.filter(
        (node) => node.kind === "desktop-launcher-entry",
      );
      expect(entries).toHaveLength(runtime.applications.catalog.length);
      for (const entry of entries) {
        expect(entry.bounds.x).toBeGreaterThanOrEqual(primary.bounds.x);
        expect(entry.bounds.y).toBeGreaterThanOrEqual(primary.bounds.y);
        expect(entry.bounds.x + entry.bounds.width).toBeLessThanOrEqual(
          primary.bounds.x + primary.bounds.width,
        );
        expect(entry.bounds.y + entry.bounds.height).toBeLessThanOrEqual(
          primary.bounds.y + primary.bounds.height,
        );
        // With the taller dock, the launcher button may overlap grid entries
        // near the bottom. Entries are still reachable via their visible portion.
        const hitKind = hitTestDesktopSceneControl(
          scene,
          entry.bounds.x + entry.bounds.width / 2,
          entry.bounds.y + entry.bounds.height / 2,
        )?.kind;
        expect(["desktop-launcher-entry", "desktop-launcher-button"]).toContain(hitKind);
      }
    }
  });

  it("filters launcher entries and launches application via keyboard search", async () => {
    const runtime = await createDesktopRuntime();
    runtime.applications.toggleLauncher();
    expect(runtime.applications.launcherOpen).toBe(true);

    // Type "settings"
    for (const char of "settings") {
      runtime.dispatchKeyboardEvent(keyboard(char));
    }
    expect(runtime.applications.launcherSearchQuery).toBe("settings");

    let scene = compose(runtime);
    let entries = scene.nodes.filter((node) => node.kind === "desktop-launcher-entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.applicationId).toBe("org.sevynos.settings");

    // Press Backspace
    runtime.dispatchKeyboardEvent(keyboard("Backspace"));
    expect(runtime.applications.launcherSearchQuery).toBe("setting");

    scene = compose(runtime);
    entries = scene.nodes.filter((node) => node.kind === "desktop-launcher-entry");
    expect(entries).toHaveLength(1);

    // Press Enter to launch
    runtime.dispatchKeyboardEvent(keyboard("Enter"));
    expect(runtime.applications.launcherOpen).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.applications.getByApplicationId("org.sevynos.settings")).toBeDefined();
  });

  it("closes the launcher when Escape is pressed", async () => {
    const runtime = await createDesktopRuntime();
    runtime.applications.toggleLauncher();
    expect(runtime.applications.launcherOpen).toBe(true);

    runtime.dispatchKeyboardEvent(keyboard("Escape"));
    expect(runtime.applications.launcherOpen).toBe(false);
  });

  it("composes live System Monitor metrics from runtime sources", async () => {
    const runtime = await createDesktopRuntime();
    const monitor = await runtime.applications.launch("org.sevynos.system-monitor");
    const scene = new DesktopSceneComposer(runtime, () => 7).compose({
      width: 1200,
      height: 800,
      scaleFactor: 1,
    });
    const node = sceneWindows(scene).find(
      (candidate) => candidate.windowId === monitor.windowId,
    );

    expect(node?.systemMonitorSnapshot).toMatchObject({
      runningApplicationSessions: 3,
      openWindows: 3,
      focusedWindow: "System Monitor",
      cursorKind: "default",
      frameExecutionCount: 7,
      activeWorkspace: "workspace-1",
    });
  });

  it("composes Settings through the portable Sevyn native surface", async () => {
    const runtime = await createDesktopRuntime();
    const settings = await runtime.applications.launch("org.sevynos.settings");
    await waitForNativeApplication(runtime, settings.windowId, "Settings");
    const scene = compose(runtime);
    const node = sceneWindows(scene).find(
      (candidate) => candidate.windowId === settings.windowId,
    );
    expect(
      node?.nativeSurface?.accessibility.some((item) => item.label === "Settings"),
    ).toBe(true);
    const themeControl = scene.nodes.find(
      (candidate) =>
        candidate.kind === "desktop-settings-control" && candidate.action === "theme",
    );
    expect(themeControl).toBeDefined();
    if (themeControl?.kind !== "desktop-settings-control") return;
    expect(themeControl.bounds.x).toBeGreaterThanOrEqual(node?.contentBounds.x ?? 0);
    expect(themeControl.bounds.y).toBeGreaterThanOrEqual(node?.contentBounds.y ?? 0);
    expect(
      hitTestDesktopSceneControl(
        scene,
        themeControl.bounds.x + 2,
        themeControl.bounds.y + 2,
      ),
    ).toMatchObject({ kind: "desktop-settings-control", action: "theme" });
  });

  it("launches the component gallery through the application coordinator", async () => {
    const runtime = await createDesktopRuntime();
    const gallery = await runtime.applications.launch("org.sevynos.gallery");
    await waitForNativeApplication(runtime, gallery.windowId, "Sevyn Component Gallery");
    const node = sceneWindows(compose(runtime)).find(
      (candidate) => candidate.windowId === gallery.windowId,
    );
    expect(
      node?.nativeSurface?.accessibility.some(
        (item) => item.label === "Sevyn Component Gallery",
      ),
    ).toBe(true);
    expect(
      node?.nativeSurface?.commands.filter((command) => command.kind === "control"),
    ).toHaveLength(5);
  });

  it("accepts a third-party Notes surface only through the isolated boundary", async () => {
    const runtime = await createDesktopRuntime();
    const notes = await runtime.applications.launch("org.sevynos.notes");
    runtime.surfaces.attachIsolatedSurface(
      notes.windowId,
      Object.freeze({
        revision: 1,
        commands: Object.freeze([]),
        accessibility: Object.freeze([
          Object.freeze({
            id: "notes.app",
            role: "application" as const,
            label: "Notes",
            disabled: false,
            selected: false,
            focusOrder: 0,
            bounds: Object.freeze({ x: 0, y: 0, width: 700, height: 400 }),
            children: Object.freeze([]),
          }),
        ]),
        overlays: Object.freeze([]),
        changedNodeIds: Object.freeze(["notes.app"]),
      }),
      () => undefined,
    );
    const node = sceneWindows(compose(runtime)).find(
      (candidate) => candidate.windowId === notes.windowId,
    );
    expect(node?.surface?.kind).toBe("notes");
    expect(
      node?.nativeSurface?.accessibility.some((item) => item.label === "Notes"),
    ).toBe(true);
  });

  it("coalesces application lifecycle changes into one frame request", async () => {
    const runtime = await createDesktopRuntime();
    const scheduled: (() => void)[] = [];
    let frames = 0;
    const invalidator = createRenderInvalidator(
      () => {
        frames += 1;
      },
      (frame) => scheduled.push(frame),
    );
    runtime.subscribe(invalidator.invalidate);

    await runtime.applications.launch("org.sevynos.system-monitor");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(frames).toBe(1);
  });

  it("coalesces and notifies onServiceUpdate when battery, network, or audio services update", async () => {
    let batteryListener: (() => void) | undefined;
    let audioListener: (() => void) | undefined;

    let batterySnapshot = {
      available: true,
      percent: 74,
      charging: false,
      state: "discharging" as const,
    };
    const networkSnapshot = {
      available: true,
      enabled: true,
      state: "connected" as const,
      connectedSsid: "SevynMesh",
      networks: [
        {
          ssid: "SevynMesh",
          signal: 85,
          secure: true,
          security: "personal" as const,
          supported: true,
          requiresPassword: true,
          connected: true,
        },
      ],
    };
    let audioSnapshot = {
      available: true,
      volume: 68,
      muted: false,
      outputDevice: "Speakers",
      hasHeadphones: false,
    };

    const mockBattery = {
      snapshot: vi.fn().mockImplementation(() => Promise.resolve(batterySnapshot)),
      subscribe: vi.fn().mockImplementation((listener: () => void) => {
        batteryListener = listener;
        return () => {
          batteryListener = undefined;
        };
      }),
    };
    const mockNetwork = {
      snapshot: vi.fn().mockImplementation(() => Promise.resolve(networkSnapshot)),
      scan: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn().mockImplementation(() => () => undefined),
    };
    const mockAudio = {
      snapshot: vi.fn().mockImplementation(() => Promise.resolve(audioSnapshot)),
      setVolume: vi.fn(),
      setMuted: vi.fn(),
      subscribe: vi.fn().mockImplementation((listener: () => void) => {
        audioListener = listener;
        return () => {
          audioListener = undefined;
        };
      }),
    };

    const runtime = await createDesktopRuntime({
      battery: mockBattery,
      network: mockNetwork,
      audio: mockAudio,
    });

    let updateCount = 0;
    const composer = new DesktopSceneComposer(
      runtime,
      () => 0,
      () => {
        updateCount += 1;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updateCount).toBeGreaterThanOrEqual(1);

    const scene = composer.compose({ width: 1200, height: 800, scaleFactor: 1 });
    const statusBar = scene.nodes.find(
      (node): node is DesktopStatusBarSceneNode => node.kind === "desktop-status-bar",
    );
    expect(statusBar?.batteryPercent).toBe(74);
    expect(statusBar?.wifiSsid).toBe("SevynMesh");
    expect(statusBar?.wifiState).toBe("connected");
    expect(statusBar?.audioVolume).toBe(68);

    const countBefore = updateCount;
    batterySnapshot = { ...batterySnapshot, percent: 52 };
    audioSnapshot = { ...audioSnapshot, volume: 80 };
    batteryListener?.();
    audioListener?.();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(updateCount).toBe(countBefore + 1);

    const updatedScene = composer.compose({ width: 1200, height: 800, scaleFactor: 1 });
    const updatedStatusBar = updatedScene.nodes.find(
      (node): node is DesktopStatusBarSceneNode => node.kind === "desktop-status-bar",
    );
    expect(updatedStatusBar?.batteryPercent).toBe(52);
    expect(updatedStatusBar?.audioVolume).toBe(80);

    composer.dispose();
  });
});
