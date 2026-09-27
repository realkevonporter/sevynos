import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopRuntime } from "./desktop-runtime.js";
import {
  DESKTOP_SESSION_VERSION,
  DesktopPersistenceController,
  captureDesktopSession,
  clampWindowBounds,
  restoreDesktopSession,
  validateDesktopSession,
  type DesktopPersistenceAdapter,
  type PersistedDesktopSessionV1,
} from "./desktop-persistence.js";

class MemoryAdapter implements DesktopPersistenceAdapter {
  public value: unknown;
  public readonly saves: PersistedDesktopSessionV1[] = [];
  public clearCount = 0;
  public load(): Promise<unknown> {
    return Promise.resolve(this.value);
  }
  public save(session: PersistedDesktopSessionV1): Promise<void> {
    this.value = session;
    this.saves.push(session);
    return Promise.resolve();
  }
  public clear(): Promise<void> {
    this.value = undefined;
    this.clearCount += 1;
    return Promise.resolve();
  }
}

afterEach(() => vi.useRealTimers());

describe("Genesis desktop persistence", () => {
  it("saves running applications, window lifecycle, geometry, and z-order", async () => {
    const runtime = await createDesktopRuntime();
    runtime.windows.moveWindow({ windowId: "window-2", x: 640, y: 300 });
    runtime.windows.minimizeWindow("window-1");
    const session = captureDesktopSession(runtime);
    expect(session.version).toBe(DESKTOP_SESSION_VERSION);
    expect(session.viewport).toEqual({ width: 1200, height: 800 });
    expect(session.windows.map((window) => window.applicationId)).toEqual([
      "org.sevynos.welcome",
      "org.sevynos.console",
    ]);
    expect(session.windows[0]?.state).toBe("minimized");
    expect(session.windows[1]?.bounds.x).toBe(640);
    expect(session.windows[1]?.zIndex).toBeGreaterThan(session.windows[0]?.zIndex ?? 0);
  });

  it("restores applications once with bounds and z-order", async () => {
    const source = await createDesktopRuntime();
    source.windows.resizeWindow({
      windowId: "window-1",
      bounds: { x: 40, y: 70, width: 550, height: 450 },
    });
    source.windows.focusWindow("window-1");
    const target = await createDesktopRuntime({ launchDefaults: false });
    expect(
      await restoreDesktopSession(target, captureDesktopSession(source), {
        width: 1200,
        height: 800,
      }),
    ).toBe(true);
    expect(target.applications.listRunning()).toHaveLength(2);
    const welcome = target.applications.getByApplicationId("org.sevynos.welcome");
    const consoleApplication =
      target.applications.getByApplicationId("org.sevynos.console");
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.bounds).toEqual({
      x: 40,
      y: 70,
      width: 550,
      height: 450,
    });
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.state).toBe("focused");
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.zIndex).toBeGreaterThan(
      target.windows.getWindow(consoleApplication?.windowId ?? "")?.zIndex ?? 0,
    );
  });

  it("scales saved window geometry when the display viewport changes", async () => {
    const source = await createDesktopRuntime();
    source.windows.resizeWindow({
      windowId: "window-1",
      bounds: { x: 120, y: 80, width: 600, height: 400 },
    });
    const target = await createDesktopRuntime({ launchDefaults: false });
    target.environment.configureHostDisplays([
      {
        id: "display-wayland-1",
        name: "Wayland Output",
        bounds: { x: 0, y: 0, width: 960, height: 640 },
        pixelWidth: 960,
        pixelHeight: 640,
        scaleFactor: 1,
        refreshRate: 60,
        primary: true,
      },
    ]);

    await restoreDesktopSession(target, captureDesktopSession(source), {
      width: 960,
      height: 640,
    });

    const welcome = target.applications.getByApplicationId("org.sevynos.welcome");
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.bounds).toEqual({
      x: 96,
      y: 64,
      width: 480,
      height: 320,
    });
  });

  it("migrates legacy sessions without reusing geometry from an obsolete viewport", async () => {
    const source = await createDesktopRuntime();
    const current = captureDesktopSession(source);
    const legacy = {
      ...current,
      version: 2,
      viewport: undefined,
      windows: current.windows.map((window) => ({
        ...window,
        bounds: { x: 0, y: 54, width: 720, height: 328 },
      })),
    };
    const target = await createDesktopRuntime({ launchDefaults: false });
    target.environment.configureHostDisplays([
      {
        id: "display-wayland-1",
        name: "Wayland Output",
        bounds: { x: 0, y: 0, width: 1280, height: 720 },
        pixelWidth: 1280,
        pixelHeight: 720,
        scaleFactor: 1,
        refreshRate: 60,
        primary: true,
      },
    ]);

    await restoreDesktopSession(target, legacy, { width: 1280, height: 720 });

    const welcome = target.applications.getByApplicationId("org.sevynos.welcome");
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.bounds).toEqual({
      x: 330,
      y: 102,
      width: 620,
      height: 420,
    });
  });

  it("restores minimized and focused windows", async () => {
    const source = await createDesktopRuntime();
    source.windows.minimizeWindow("window-2");
    const target = await createDesktopRuntime({ launchDefaults: false });
    await restoreDesktopSession(target, captureDesktopSession(source), {
      width: 1200,
      height: 800,
    });
    const consoleApplication =
      target.applications.getByApplicationId("org.sevynos.console");
    const welcome = target.applications.getByApplicationId("org.sevynos.welcome");
    expect(target.windows.getWindow(consoleApplication?.windowId ?? "")?.state).toBe(
      "minimized",
    );
    expect(target.windows.getWindow(welcome?.windowId ?? "")?.state).toBe("focused");
  });

  it("preserves host-owned display geometry while restoring a simulated layout", async () => {
    const source = await createDesktopRuntime();
    source.environment.configure(1200, 800, 1, "side-by-side");
    const target = await createDesktopRuntime({ launchDefaults: false });
    target.environment.configureHostDisplays([
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

    await restoreDesktopSession(target, captureDesktopSession(source), {
      width: 1024,
      height: 640,
    });

    expect(target.environment.listDisplays()).toHaveLength(1);
    expect(target.environment.listDisplays()[0]).toMatchObject({
      id: "display-wayland-1",
      bounds: { x: 0, y: 0, width: 1024, height: 640 },
      pixelWidth: 1024,
      pixelHeight: 640,
    });
    expect(target.environment.layoutMode).toBe("side-by-side");
  });

  it("restores Console history and input", async () => {
    const source = await createDesktopRuntime();
    source.surfaces.restoreConsole("window-2", ["one", "two"], "pending");
    const target = await createDesktopRuntime({ launchDefaults: false });
    await restoreDesktopSession(target, captureDesktopSession(source), {
      width: 1200,
      height: 800,
    });
    expect(target.surfaces.get("window-2")).toMatchObject({
      kind: "console",
      history: ["one", "two"],
      input: "pending",
    });
  });

  it("rejects malformed and unsupported persisted data", () => {
    expect(validateDesktopSession(null)).toBeUndefined();
    expect(validateDesktopSession({ version: 99, windows: [] })).toBeUndefined();
    expect(
      validateDesktopSession({
        version: 1,
        windows: [
          {
            applicationId: "x",
            bounds: { x: 0, y: 0, width: -1, height: 2 },
            state: "focused",
            zIndex: 1,
          },
        ],
      })?.windows,
    ).toEqual([]);
  });

  it("ignores invalid and duplicate application identifiers", async () => {
    const target = await createDesktopRuntime({ launchDefaults: false });
    const valid = captureDesktopSession(await createDesktopRuntime()).windows[0];
    await restoreDesktopSession(
      target,
      { version: 1, windows: [{ ...valid, applicationId: "unknown" }, valid, valid] },
      { width: 1200, height: 800 },
    );
    expect(target.applications.listRunning()).toHaveLength(1);
  });

  it("clamps off-screen windows while keeping title bars reachable", () => {
    expect(
      clampWindowBounds(
        { x: 5000, y: -900, width: 2000, height: 1400 },
        { width: 1000, height: 700 },
      ),
    ).toEqual({ x: 920, y: 0, width: 1000, height: 700 });
  });

  it("debounces meaningful changes into one save", async () => {
    vi.useFakeTimers();
    const runtime = await createDesktopRuntime();
    const adapter = new MemoryAdapter();
    const controller = new DesktopPersistenceController({ runtime, adapter, delay: 100 });
    controller.connect();
    runtime.windows.moveWindow({ windowId: "window-2", x: 600, y: 300 });
    runtime.windows.moveWindow({ windowId: "window-2", x: 620, y: 320 });
    await vi.advanceTimersByTimeAsync(100);
    expect(adapter.saves).toHaveLength(1);
    controller.disconnect();
  });

  it("flushes a pending save during controlled shutdown", async () => {
    vi.useFakeTimers();
    const runtime = await createDesktopRuntime();
    const adapter = new MemoryAdapter();
    const controller = new DesktopPersistenceController({ runtime, adapter });
    controller.connect();
    runtime.windows.moveWindow({ windowId: "window-2", x: 700, y: 350 });
    runtime.beginShutdown();
    await controller.flush();
    expect(adapter.saves).toHaveLength(1);
    expect(adapter.saves[0]?.windows[1]?.bounds.x).toBe(700);
    await runtime.closeForShutdown();
  });

  it("reset clears storage and returns to the default desktop", async () => {
    const runtime = await createDesktopRuntime();
    await runtime.applications.launch("org.sevynos.system-monitor");
    const adapter = new MemoryAdapter();
    const controller = new DesktopPersistenceController({ runtime, adapter });
    await controller.reset();
    expect(adapter.clearCount).toBe(1);
    expect(
      runtime.applications.listRunning().map((running) => running.definition.name),
    ).toEqual(["Welcome", "Genesis Console"]);
  });
});
