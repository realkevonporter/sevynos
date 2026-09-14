import { describe, expect, it } from "vitest";
import { DisplayRenderPlanner } from "@sevynos/graphics";
import { createDesktopRuntime } from "./desktop-runtime.js";
import { DesktopSceneComposer } from "./desktop-scene-composer.js";
import { captureDesktopSession, restoreDesktopSession } from "./desktop-persistence.js";
import { createRenderInvalidator } from "./render-invalidator.js";

describe("Genesis multi-display workspaces", () => {
  it("models and plans two active displays", async () => {
    const runtime = await createDesktopRuntime();
    const scene = new DesktopSceneComposer(runtime).compose({
      width: 1200,
      height: 800,
      scaleFactor: 1,
    });
    const plans = new DisplayRenderPlanner({
      displays: runtime.environment.displays,
      now: () => new Date(1),
    }).createRenderPlans(scene);
    expect(runtime.environment.listDisplays()).toHaveLength(2);
    expect(scene.nodes.filter((node) => node.kind === "desktop-background")).toHaveLength(
      2,
    );
    expect(scene.nodes.filter((node) => node.kind === "desktop-taskbar")).toHaveLength(2);
    expect(plans).toHaveLength(2);
  });

  it("moves a window between displays and preserves its size", async () => {
    const runtime = await createDesktopRuntime();
    const before = runtime.windows.getWindow("window-2")?.bounds;
    runtime.environment.moveWindowToDisplay("window-2", "display-simulated-2");
    const after = runtime.windows.getWindow("window-2")?.bounds;
    expect(
      runtime.environment.getDisplayForBounds(
        after ?? { x: 0, y: 0, width: 1, height: 1 },
      ).id,
    ).toBe("display-simulated-2");
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
  });

  it("maximizes to the containing display and restores original placement", async () => {
    const runtime = await createDesktopRuntime();
    runtime.environment.moveWindowToDisplay("window-1", "display-simulated-2");
    const original = runtime.windows.getWindow("window-1")?.bounds;
    await runtime.activateWindowControl("window-1", "maximize", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    expect(runtime.windows.getWindow("window-1")?.bounds).toEqual(
      runtime.environment.listDisplays()[1]?.workArea,
    );
    await runtime.activateWindowControl("window-1", "restore", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    expect(runtime.windows.getWindow("window-1")?.bounds).toEqual(original);
  });

  it("resolves cursor positions and window hits in global display coordinates", async () => {
    const runtime = await createDesktopRuntime();
    expect(runtime.environment.getDisplayAtPoint(900, 300)?.id).toBe(
      "display-simulated-2",
    );
    runtime.dispatchPointerEvent({
      type: "pointermove",
      pointerId: 1,
      timeStamp: 1,
      clientX: 900,
      clientY: 300,
      button: -1,
      buttons: 0,
      pressure: 0,
    });
    expect(runtime.cursor.state.position).toEqual({ x: 900, y: 300 });
  });

  it("switches compositor-visible windows while sessions remain running", async () => {
    const runtime = await createDesktopRuntime();
    runtime.environment.moveWindowToWorkspace("window-2", "workspace-2");
    expect(
      new DesktopSceneComposer(runtime)
        .compose({ width: 1200, height: 800, scaleFactor: 1 })
        .base.listWindows()
        .map((node) => node.windowId),
    ).toEqual(["window-1"]);
    runtime.environment.switchWorkspace("workspace-2");
    expect(
      new DesktopSceneComposer(runtime)
        .compose({ width: 1200, height: 800, scaleFactor: 1 })
        .base.listWindows()
        .map((node) => node.windowId),
    ).toEqual(["window-2"]);
    expect(
      runtime.platformRuntime
        .listApplicationSessions()
        .filter((session) => !session.isTerminal()),
    ).toHaveLength(2);
  });

  it("moves the focused window to another workspace", async () => {
    const runtime = await createDesktopRuntime();
    runtime.environment.moveWindowToWorkspace("window-2", "workspace-3");
    expect(runtime.environment.getWindowWorkspace("window-2")).toBe("workspace-3");
    expect(runtime.windows.getWindow("window-2")?.state).toBe("hidden");
  });

  it("persists and restores display layout, workspace, and maximized placement", async () => {
    const source = await createDesktopRuntime();
    source.environment.configure(1200, 800, 1, "vertical");
    source.environment.moveWindowToWorkspace("window-2", "workspace-2");
    source.environment.switchWorkspace("workspace-2");
    await source.activateWindowControl("window-2", "maximize", {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    const target = await createDesktopRuntime({ launchDefaults: false });
    await restoreDesktopSession(target, captureDesktopSession(source), {
      width: 1200,
      height: 800,
    });
    const consoleApplication =
      target.applications.getByApplicationId("org.sevynos.console");
    expect(target.environment.layoutMode).toBe("vertical");
    expect(target.environment.activeWorkspace).toBe("workspace-2");
    expect(
      target.environment.getWindowWorkspace(consoleApplication?.windowId ?? ""),
    ).toBe("workspace-2");
    expect(target.isMaximized(consoleApplication?.windowId ?? "")).toBe(true);
  });

  it("re-homes windows whose persisted display is missing", async () => {
    const source = await createDesktopRuntime();
    const captured = captureDesktopSession(source);
    const damaged = {
      ...captured,
      windows: captured.windows.map((window) => ({
        ...window,
        displayId: "display-missing",
        bounds: { ...window.bounds, x: 9000 },
      })),
    };
    const target = await createDesktopRuntime({ launchDefaults: false });
    await restoreDesktopSession(target, damaged, { width: 1200, height: 800 });
    for (const running of target.applications.listRunning()) {
      const window = target.windows.getWindow(running.windowId);
      expect(
        window === undefined
          ? undefined
          : target.environment.getDisplayForBounds(window.bounds).primary,
      ).toBe(true);
    }
  });

  it("coalesces display and workspace changes into one frame", async () => {
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
    runtime.environment.configure(1200, 800, 1, "offset");
    runtime.environment.switchWorkspace("workspace-2");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(frames).toBe(1);
  });
});
