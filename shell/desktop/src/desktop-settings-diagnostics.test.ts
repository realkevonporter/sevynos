import { describe, expect, it, vi } from "vitest";
import { createDesktopRuntime } from "./desktop-runtime.js";
import { DesktopSceneComposer } from "./desktop-scene-composer.js";
import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsService,
  validateDesktopSettings,
} from "./desktop-settings.js";
import {
  RuntimeDiagnosticsService,
  createDiagnosticsSnapshot,
} from "./runtime-diagnostics.js";
import { createRenderInvalidator } from "./render-invalidator.js";

describe("Genesis settings and diagnostics", () => {
  it("loads, repairs, and migrates settings", () => {
    expect(validateDesktopSettings(null)).toBe(DEFAULT_DESKTOP_SETTINGS);
    expect(
      validateDesktopSettings({
        version: 0,
        theme: "light",
        workspaceCount: 99,
        cursorSize: -4,
      }),
    ).toMatchObject({ version: 1, theme: "light", workspaceCount: 8, cursorSize: 0.5 });
  });
  it("publishes settings for persistence and applies theme and accent live", () => {
    const service = new DesktopSettingsService();
    const listener = vi.fn();
    service.subscribe(listener);
    service.update({ theme: "light", accentColor: "#6ea8fe" });
    expect(service.snapshot).toMatchObject({ theme: "light", accentColor: "#6ea8fe" });
    expect(listener).toHaveBeenCalledOnce();
  });
  it("updates taskbar work areas and safely reduces workspace count", async () => {
    const runtime = await createDesktopRuntime();
    runtime.environment.moveWindowToWorkspace("window-2", "workspace-4");
    runtime.settings.update({ taskbarPosition: "top", workspaceCount: 2 });
    expect(runtime.environment.listDisplays()[0]?.workArea.y).toBe(72);
    expect(runtime.environment.getWindowWorkspace("window-2")).toBe("workspace-2");
  });
  it("does not replace host-owned display geometry when settings change", async () => {
    const runtime = await createDesktopRuntime();
    runtime.environment.configureHostDisplays([
      {
        id: "display-wayland-1",
        name: "Wayland Output",
        bounds: { x: 0, y: 0, width: 1024, height: 640 },
        pixelWidth: 1024,
        pixelHeight: 640,
        scaleFactor: 1,
        refreshRate: 60,
        primary: true,
      },
    ]);

    runtime.settings.update({ displayLayout: "vertical" });

    expect(runtime.environment.listDisplays()).toHaveLength(1);
    expect(runtime.environment.listDisplays()[0]).toMatchObject({
      id: "display-wayland-1",
      bounds: { x: 0, y: 0, width: 1024, height: 640 },
      pixelWidth: 1024,
      pixelHeight: 640,
    });
    expect(runtime.environment.layoutMode).toBe("vertical");
  });
  it("exposes reduced-motion without changing lifecycle", async () => {
    const runtime = await createDesktopRuntime();
    runtime.settings.update({ reducedMotion: true });
    expect(runtime.settings.snapshot.reducedMotion).toBe(true);
    expect(runtime.applications.listRunning()).toHaveLength(2);
  });
  it("bounds diagnostics and updates frame metrics", () => {
    const diagnostics = new RuntimeDiagnosticsService(2);
    diagnostics.record({
      severity: "info",
      subsystem: "test",
      event: "one",
      message: "One",
    });
    diagnostics.record({
      severity: "info",
      subsystem: "test",
      event: "two",
      message: "Two",
    });
    diagnostics.record({
      severity: "error",
      subsystem: "test",
      event: "three",
      message: "Three",
    });
    diagnostics.recordFrame(4);
    diagnostics.recordFrame(8, true);
    expect(diagnostics.list().map((entry) => entry.event)).toEqual(["two", "three"]);
    expect(diagnostics.frames).toEqual({
      count: 2,
      latestDuration: 8,
      averageDuration: 6,
      failedFrames: 1,
    });
  });
  it("exports runtime diagnostics without Console content", async () => {
    const runtime = await createDesktopRuntime();
    runtime.surfaces.restoreConsole("window-2", ["SECRET"], "PRIVATE");
    const snapshot = createDiagnosticsSnapshot({
      settings: runtime.settings.snapshot,
      displays: runtime.environment.listDisplays(),
      workspaces: { active: runtime.environment.activeWorkspace },
      sessions: 2,
      windows: 2,
      diagnostics: runtime.diagnostics,
    });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  });
  it("composes recovery controls after a graphics failure", async () => {
    const runtime = await createDesktopRuntime();
    runtime.recovery.enter("Simulated graphics failure");
    const scene = new DesktopSceneComposer(runtime).compose({
      width: 1200,
      height: 800,
      scaleFactor: 1,
    });
    expect(scene.nodes.some((node) => node.kind === "desktop-recovery")).toBe(true);
    expect(
      scene.nodes.filter((node) => node.kind === "desktop-recovery-control"),
    ).toHaveLength(2);
  });
  it("coalesces meaningful settings changes into one frame", async () => {
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
    runtime.settings.update({ theme: "light" });
    runtime.settings.update({ accentColor: "#6ea8fe" });
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(frames).toBe(1);
  });

  it("does not map custom or third-party button actions to desktop settings controls", async () => {
    const runtime = await createDesktopRuntime();
    const notes = await runtime.applications.launch("org.sevynos.notes");
    runtime.surfaces.attachIsolatedSurface(
      notes.windowId,
      Object.freeze({
        revision: 1,
        commands: Object.freeze([
          {
            id: "theme-ctrl",
            kind: "control" as const,
            bounds: { x: 10, y: 10, width: 80, height: 30 },
            action: "theme" as const,
            label: "Theme",
            value: "dark",
            state: "idle" as const,
            accent: "#D7AC57",
            foreground: "#FFF",
            background: "#222",
            radius: 8,
          },
          {
            id: "custom-btn-ctrl",
            kind: "control" as const,
            bounds: { x: 10, y: 50, width: 80, height: 30 },
            action: "custom" as const,
            label: "Submit",
            value: "",
            state: "idle" as const,
            accent: "#D7AC57",
            foreground: "#FFF",
            background: "#222",
            radius: 8,
          },
          {
            id: "ext-btn-ctrl",
            kind: "control" as const,
            bounds: { x: 10, y: 90, width: 80, height: 30 },
            action: "app.custom.action",
            label: "Custom",
            value: "",
            state: "idle" as const,
            accent: "#D7AC57",
            foreground: "#FFF",
            background: "#222",
            radius: 8,
          },
        ]),
        accessibility: Object.freeze([]),
        overlays: Object.freeze([]),
        changedNodeIds: Object.freeze([]),
      }),
      () => undefined,
    );

    const composer = new DesktopSceneComposer(runtime);
    const scene = composer.compose({ width: 1024, height: 768, scaleFactor: 1 });

    const settingsControls = scene.nodes.filter(
      (node) => node.kind === "desktop-settings-control",
    );

    // Only the known "theme" action should be mapped to desktop-settings-control
    expect(settingsControls).toHaveLength(1);
    expect(settingsControls[0]).toMatchObject({
      kind: "desktop-settings-control",
      action: "theme",
    });
  });
});
