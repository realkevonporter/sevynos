import { describe, expect, it } from "vitest";
import { DesktopSceneComposer } from "@sevynos/desktop-shell";
import { SimulatedWaylandBridgeTransport } from "./simulated-wayland-bridge.js";
import { startWaylandHost, type RunningWaylandHost } from "./wayland.js";

const pause = (milliseconds = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
describe("interactive Wayland host", () => {
  it("discovers a display, presents frames, translates input, resizes, and shuts down", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const markers: string[] = [];
    const starting = startWaylandHost(bridge, { marker: (value) => markers.push(value) });
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await pause();
    const firstFrame = bridge.frames[0];
    expect(firstFrame).toBeDefined();
    if (firstFrame === undefined) throw new Error("Expected a presented frame.");
    expect(firstFrame.width).toBe(1280);
    expect(firstFrame.height).toBe(720);
    expect(firstFrame.pixels).toHaveLength(firstFrame.stride * firstFrame.height);
    expect(firstFrame.pixels.some((byte) => byte !== 0)).toBe(true);
    expect(markers).toContain("SEVYN_GENESIS_VISIBLE_SURFACE_CONFIGURED");
    expect(markers).toContain("SEVYN_GENESIS_INPUT_DEVICES_INITIALIZED");
    expect(markers).toContain("GENESIS_FRAME_RENDER_REQUESTED");
    expect(markers).toContain("SEVYN_GENESIS_FIRST_COMPOSITOR_FRAME_PRESENTED");
    expect(markers.some((value) => value.startsWith("GENESIS_FRAME_RENDERED "))).toBe(
      true,
    );
    expect(markers).toContain("GENESIS_PRESENT_MESSAGE_SENT frameId=1");
    expect(markers).toContain(
      "TYPESCRIPT DISPLAY SIZE width=1280 height=720 scale=1 reason=initial",
    );
    expect(markers).toContain(
      "FRAMEBUFFER SIZE width=1280 height=720 stride=5120 bytes=3686400",
    );
    expect(markers).toContain(
      "GENESIS_DISPLAY_BOUNDS reason=initial id=display-wayland-output-1 x=0 y=0 width=1280 height=720 scale=1",
    );
    expect(markers).toContain(
      "GENESIS_WORKSPACE_BOUNDS reason=initial id=display-wayland-output-1 x=0 y=0 width=1280 height=648",
    );
    expect(
      markers.some((value) =>
        value.startsWith(
          "GENESIS_WINDOW_CONTENT_BOUNDS reason=initial windowId=window-1 coordinateSpace=desktop-logical ",
        ),
      ),
    ).toBe(true);
    expect(
      markers.some((value) =>
        /^GENESIS_NATIVE_COMMAND_BOUNDS reason=(initial|surface-sync) windowId=window-1 coordinateSpace=window-content-local index=/.test(
          value,
        ),
      ),
    ).toBe(true);
    bridge.pointer("move", 140, 120);
    bridge.keyboard("down", "a", "KeyA");
    const framesBeforeResize = bridge.frames.length;
    bridge.resize(1024, 640, 1);
    bridge.pointer("move", 900, 500);
    await pause(25);
    expect(host.runtime.cursor.state.position).toEqual({ x: 900, y: 500 });
    expect(host.runtime.environment.listDisplays()[0]).toMatchObject({
      id: "display-wayland-output-1",
      bounds: { width: 1024, height: 640 },
      scaleFactor: 1,
    });
    const resizedFrames = bridge.frames.slice(framesBeforeResize);
    expect(resizedFrames.length).toBeGreaterThan(0);
    expect(
      resizedFrames.every(
        (message) =>
          message.width === 1024 && message.height === 640 && message.stride === 4096,
      ),
    ).toBe(true);
    expect(markers).toContain(
      "TYPESCRIPT DISPLAY SIZE width=1024 height=640 scale=1 reason=resize",
    );
    expect(markers).toContain(
      "FRAMEBUFFER SIZE width=1024 height=640 stride=4096 bytes=2621440",
    );
    expect(markers).toContain(
      "GENESIS_DISPLAY_BOUNDS reason=resize id=display-wayland-output-1 x=0 y=0 width=1024 height=640 scale=1",
    );
    expect(markers).toContain(
      "GENESIS_WORKSPACE_BOUNDS reason=resize id=display-wayland-output-1 x=0 y=0 width=1024 height=568",
    );
    await host.shutdown();
    expect(bridge.sent.at(-1)?.type).toBe("shutdown-complete");
  });
  it("round-trips clipboard text through the native boundary", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const starting = startWaylandHost(bridge);
    bridge.ready();
    const host = await starting;
    await host.clipboard.writeText("Sevyn clipboard");
    await expect(host.clipboard.readText()).resolves.toBe("Sevyn clipboard");
    await host.shutdown();
  });

  it("changes the desktop theme through the Settings surface", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const starting = startWaylandHost(bridge);
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await host.runtime.applications.launch("org.sevynos.settings");
    const composer = new DesktopSceneComposer(host.runtime);
    let themeControl = composer
      .compose({ width: 1280, height: 720, scaleFactor: 1 })
      .nodes.find(
        (node) => node.kind === "desktop-settings-control" && node.action === "theme",
      );
    for (let attempt = 0; themeControl === undefined && attempt < 100; attempt += 1) {
      await pause(5);
      themeControl = composer
        .compose({ width: 1280, height: 720, scaleFactor: 1 })
        .nodes.find(
          (node) => node.kind === "desktop-settings-control" && node.action === "theme",
        );
    }
    if (themeControl?.kind !== "desktop-settings-control")
      throw new Error("Settings did not expose its theme control.");
    await pause(20);
    bridge.pointer(
      "down",
      themeControl.bounds.x + themeControl.bounds.width / 2,
      themeControl.bounds.y + themeControl.bounds.height / 2,
    );
    expect(host.runtime.settings.snapshot.theme).toBe("light");
    await host.shutdown();
  });

  it("focuses on pointer-down and keeps presentation backlog to one latest frame", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const markers: string[] = [];
    const starting = startWaylandHost(bridge, { marker: (value) => markers.push(value) });
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await pause(30);
    bridge.autoPresentFrames = false;
    const baseline = bridge.frames.length;

    bridge.pointer("down", 340, 200, "focus-welcome");
    expect(
      host.runtime.windows.listWindows().find((window) => window.state === "focused")?.id,
    ).toBe("window-1");
    await pause();
    expect(bridge.frames).toHaveLength(baseline + 1);
    const welcomeFrame = bridge.frames.at(-1);
    expect(welcomeFrame?.traceId).toBe("focus-welcome");

    bridge.pointer("down", 965, 300, "focus-console");
    bridge.keyboard("down", "z", "KeyZ");
    expect(
      host.runtime.windows.listWindows().find((window) => window.state === "focused")?.id,
    ).toBe("window-2");
    expect(host.runtime.surfaces.get("window-2")).toMatchObject({
      kind: "console",
      input: "z",
    });
    await pause();
    expect(bridge.frames).toHaveLength(baseline + 1);

    if (welcomeFrame === undefined)
      throw new Error("The welcome focus frame was not sent.");
    bridge.presentFrame(welcomeFrame.frameId);
    await pause();
    expect(bridge.frames).toHaveLength(baseline + 2);
    expect(bridge.frames.at(-1)?.traceId).toBe("focus-console");
    expect(
      markers.filter((value) =>
        value.startsWith("TS_FRAME_STARTED traceId=focus-console "),
      ),
    ).toHaveLength(1);

    await host.shutdown();
  });

  it("bounds sustained pointer rendering while control messages remain responsive", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const starting = startWaylandHost(bridge);
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await pause(30);
    bridge.autoPresentFrames = false;
    const baseline = bridge.frames.length;

    for (let index = 0; index < 1_000; index += 1)
      bridge.pointer("move", 400 + (index % 200), 300);
    await pause(25);
    expect(bridge.frames).toHaveLength(baseline + 1);
    for (let index = 0; index < 1_000; index += 1)
      bridge.pointer("move", 600 + (index % 200), 320);
    await pause(25);
    expect(bridge.frames).toHaveLength(baseline + 1);

    await host.clipboard.writeText("control-path-remains-live");
    await expect(host.clipboard.readText()).resolves.toBe("control-path-remains-live");
    expect(host.runtime.cursor.state.position.x).toBe(799);
    await host.shutdown();
  }, 15_000);

  it("keeps drag motion and release captured by the pointer-down window", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const markers: string[] = [];
    const starting = startWaylandHost(bridge, { marker: (value) => markers.push(value) });
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await pause(30);

    const { source, sourceId, otherId, outside } = dragFixture(markers, host);
    const { calls } = spyNativePointer(host);

    // Press in the topmost window, drag outside every window, release there.
    bridge.pointer("down", source.x, source.y);
    bridge.pointer("move", outside.x, outside.y, undefined, 1);
    await pause();
    bridge.pointer("up", outside.x, outside.y);
    await pause();

    // The drag's move and release stay captured by the pointer-down window
    // even though the cursor left it; nothing leaks to the other window.
    expect(typesFor(calls, sourceId)).toEqual(["enter", "down", "move", "up", "leave"]);
    expect(typesFor(calls, otherId)).toEqual([]);

    await host.shutdown();
  });

  it("releases pointer capture on pointer-cancel", async () => {
    const bridge = new SimulatedWaylandBridgeTransport();
    const markers: string[] = [];
    const starting = startWaylandHost(bridge, { marker: (value) => markers.push(value) });
    bridge.ready(1280, 720, 1);
    const host = await starting;
    await pause(30);

    const { source, sourceId, otherId, outside } = dragFixture(markers, host);
    const { calls } = spyNativePointer(host);

    bridge.pointer("down", source.x, source.y);
    bridge.pointer("cancel", outside.x, outside.y);
    await pause();
    // Capture is gone: hovering the desktop routes nowhere, and hovering the
    // source window re-enters it like a fresh hover.
    bridge.pointer("move", outside.x, outside.y);
    await pause();
    bridge.pointer("move", source.x, source.y);
    await pause();

    expect(typesFor(calls, sourceId)).toEqual([
      "enter",
      "down",
      "cancel",
      "leave",
      "enter",
      "move",
    ]);
    expect(typesFor(calls, otherId)).toEqual([]);

    await host.shutdown();
  });
});

interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Builds a drag fixture from the host's window markers: the press point is
 * the focused (topmost) window's content center so the hit test is
 * unambiguous, and the drag point sits outside every window's full bounds.
 */
function dragFixture(
  markers: readonly string[],
  host: RunningWaylandHost,
): {
  source: { x: number; y: number };
  sourceId: string;
  otherId: string;
  outside: { x: number; y: number };
} {
  const full = parseWindowBounds(markers, "GENESIS_WINDOW_BOUNDS ");
  const content = parseWindowBounds(markers, "GENESIS_WINDOW_CONTENT_BOUNDS ");
  const ids = [...full.keys()];
  if (ids.length < 2) throw new Error("Expected at least two windows.");
  const focusedId =
    host.runtime.windows.listWindows().find((window) => window.state === "focused")?.id ??
    ids[0];
  if (focusedId === undefined) throw new Error("Expected a window id.");
  const otherId = ids.find((id) => id !== focusedId);
  if (otherId === undefined) throw new Error("Expected a second window.");
  const sourceBounds = content.get(focusedId);
  if (sourceBounds === undefined) throw new Error(`No content bounds for ${focusedId}.`);
  const maxRight = Math.max(
    ...ids.map((id) => {
      const bounds = full.get(id);
      if (bounds === undefined) throw new Error(`No full bounds for ${id}.`);
      return bounds.x + bounds.width;
    }),
  );
  const outside = { x: maxRight + 80, y: 360 };
  if (outside.x >= 1280) throw new Error("No room outside the windows.");
  for (const id of ids) {
    const bounds = full.get(id);
    if (bounds !== undefined && pointInBounds(outside, bounds))
      throw new Error("The drag point landed inside a window.");
  }
  return {
    source: {
      x: sourceBounds.x + sourceBounds.width / 2,
      y: sourceBounds.y + sourceBounds.height / 2,
    },
    sourceId: focusedId,
    otherId,
    outside,
  };
}

function parseWindowBounds(
  markers: readonly string[],
  prefix: string,
): Map<string, WindowBounds> {
  const bounds = new Map<string, WindowBounds>();
  for (const marker of markers) {
    if (!marker.startsWith(prefix)) continue;
    const fields: Record<string, string> = {};
    for (const part of marker.split(" ")) {
      const [key, value] = part.split("=");
      if (key !== undefined && value !== undefined) fields[key] = value;
    }
    const { windowId, x, y, width, height } = fields;
    if (
      windowId === undefined ||
      x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined
    )
      continue;
    bounds.set(windowId, {
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    });
  }
  return bounds;
}

function pointInBounds(point: { x: number; y: number }, bounds: WindowBounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function spyNativePointer(host: RunningWaylandHost): {
  calls: { windowId: string; type: string }[];
} {
  const calls: { windowId: string; type: string }[] = [];
  const surfaces = host.runtime.surfaces;
  const original = surfaces.dispatchNativePointer.bind(surfaces);
  surfaces.dispatchNativePointer = (
    windowId: Parameters<typeof original>[0],
    type: Parameters<typeof original>[1],
    event: Parameters<typeof original>[2],
  ) => {
    calls.push({ windowId, type });
    original(windowId, type, event);
  };
  return { calls };
}

function typesFor(
  calls: readonly { windowId: string; type: string }[],
  windowId: string,
): string[] {
  return calls.filter((call) => call.windowId === windowId).map((call) => call.type);
}
