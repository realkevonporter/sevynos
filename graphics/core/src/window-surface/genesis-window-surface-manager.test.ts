import { beforeEach, describe, expect, it } from "vitest";

import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import { WindowNotFoundError } from "../errors/window-not-found-error.js";
import { WindowSurfaceAttachmentForSurfaceNotFoundError } from "../errors/window-surface-attachment-for-surface-not-found-error.js";
import { WindowSurfaceAttachmentForWindowNotFoundError } from "../errors/window-surface-attachment-for-window-not-found-error.js";
import { WindowSurfaceSessionMismatchError } from "../errors/window-surface-session-mismatch-error.js";
import { GenesisSurface } from "../surface/genesis-surface.js";
import { SurfaceRegistry } from "../surface/surface-registry.js";
import { GenesisWindow } from "../window/genesis-window.js";
import { WindowRegistry } from "../window/window-registry.js";
import { GenesisWindowSurfaceManager } from "./genesis-window-surface-manager.js";
import type { WindowSurfaceAttachmentId } from "./window-surface-attachment-id.js";
import { WindowSurfaceAttachmentRegistry } from "./window-surface-attachment-registry.js";

const FIRST_TIME = new Date("2026-07-30T15:00:00.000Z");

const SECOND_TIME = new Date("2026-07-30T15:01:00.000Z");

describe("GenesisWindowSurfaceManager", () => {
  let windows: WindowRegistry;

  let surfaces: SurfaceRegistry;

  let attachments: WindowSurfaceAttachmentRegistry;

  let currentTime: Date;

  let nextAttachmentNumber: number;

  let manager: GenesisWindowSurfaceManager;

  beforeEach(() => {
    windows = new WindowRegistry();

    surfaces = new SurfaceRegistry();

    attachments = new WindowSurfaceAttachmentRegistry();

    currentTime = new Date(FIRST_TIME);

    nextAttachmentNumber = 1;

    manager = new GenesisWindowSurfaceManager({
      windows,
      surfaces,
      attachments,

      createAttachmentId: (): WindowSurfaceAttachmentId => {
        const id: WindowSurfaceAttachmentId = `window-surface-attachment-${String(
          nextAttachmentNumber,
        )}`;

        nextAttachmentNumber += 1;

        return id;
      },

      now: () => new Date(currentTime),
    });
  });

  function createWindow(
    id: `window-${string}` = "window-1",
    sessionId: `session-${string}` = "session-1",
  ): GenesisWindow {
    return new GenesisWindow({
      id,
      sessionId,

      title: "Test Window",

      bounds: {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },

      state: "visible",

      zIndex: 0,

      createdAt: FIRST_TIME,

      updatedAt: FIRST_TIME,
    });
  }

  function createSurface(
    id: `surface-${string}` = "surface-1",
    sessionId: `session-${string}` = "session-1",
  ): GenesisSurface {
    return new GenesisSurface({
      id,
      sessionId,

      size: {
        width: 800,
        height: 600,
      },

      pixelFormat: "rgba8888",

      state: "ready",

      createdAt: FIRST_TIME,

      updatedAt: FIRST_TIME,
    });
  }

  function registerResources(): {
    readonly window: GenesisWindow;

    readonly surface: GenesisSurface;
  } {
    const window = createWindow();

    const surface = createSurface();

    windows.add(window);
    surfaces.add(surface);

    return {
      window,
      surface,
    };
  }

  it("attaches a surface to a window", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    expect(attachment.id).toBe("window-surface-attachment-1");

    expect(attachment.windowId).toBe(window.id);

    expect(attachment.surfaceId).toBe(surface.id);

    expect(attachment.attachedAt).toEqual(FIRST_TIME);

    expect(attachments.get(attachment.id)).toBe(attachment);
  });

  it("rejects attaching an unknown window", () => {
    const surface = createSurface();

    surfaces.add(surface);

    expect(() =>
      manager.attachSurface({
        windowId: "window-missing",
        surfaceId: surface.id,
      }),
    ).toThrow(WindowNotFoundError);
  });

  it("rejects attaching an unknown surface", () => {
    const window = createWindow();

    windows.add(window);

    expect(() =>
      manager.attachSurface({
        windowId: window.id,
        surfaceId: "surface-missing",
      }),
    ).toThrow(SurfaceNotFoundError);
  });

  it("rejects resources belonging to different sessions", () => {
    const window = createWindow("window-1", "session-1");

    const surface = createSurface("surface-1", "session-2");

    windows.add(window);
    surfaces.add(surface);

    expect(() =>
      manager.attachSurface({
        windowId: window.id,
        surfaceId: surface.id,
      }),
    ).toThrow(WindowSurfaceSessionMismatchError);
  });

  it("replaces a window surface", () => {
    const window = createWindow();

    const firstSurface = createSurface("surface-1");

    const secondSurface = createSurface("surface-2");

    windows.add(window);

    surfaces.add(firstSurface);

    surfaces.add(secondSurface);

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: firstSurface.id,
    });

    currentTime = new Date(SECOND_TIME);

    const updated = manager.replaceSurface(window.id, secondSurface.id);

    expect(updated.id).toBe(attachment.id);

    expect(updated.windowId).toBe(window.id);

    expect(updated.surfaceId).toBe(secondSurface.id);

    expect(updated.updatedAt).toEqual(SECOND_TIME);

    expect(attachments.getBySurface(firstSurface.id)).toBeUndefined();

    expect(attachments.getBySurface(secondSurface.id)).toBe(updated);
  });

  it("returns the same attachment when replacing with the current surface", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    currentTime = new Date(SECOND_TIME);

    const result = manager.replaceSurface(window.id, surface.id);

    expect(result).toBe(attachment);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("rejects replacement when the window has no attachment", () => {
    const { window, surface } = registerResources();

    expect(() => manager.replaceSurface(window.id, surface.id)).toThrow(
      WindowSurfaceAttachmentForWindowNotFoundError,
    );
  });

  it("rejects replacement with a surface from another session", () => {
    const window = createWindow("window-1", "session-1");

    const firstSurface = createSurface("surface-1", "session-1");

    const secondSurface = createSurface("surface-2", "session-2");

    windows.add(window);

    surfaces.add(firstSurface);

    surfaces.add(secondSurface);

    manager.attachSurface({
      windowId: window.id,
      surfaceId: firstSurface.id,
    });

    expect(() => manager.replaceSurface(window.id, secondSurface.id)).toThrow(
      WindowSurfaceSessionMismatchError,
    );
  });

  it("detaches a surface by window", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    const detached = manager.detachSurfaceFromWindow(window.id);

    expect(detached).toBe(attachment);

    expect(attachments.getByWindow(window.id)).toBeUndefined();

    expect(attachments.getBySurface(surface.id)).toBeUndefined();
  });

  it("detaches an attachment by surface", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    const detached = manager.detachSurface(surface.id);

    expect(detached).toBe(attachment);

    expect(attachments.getByWindow(window.id)).toBeUndefined();
  });

  it("gets an attachment by identifier", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    expect(manager.getAttachment(attachment.id)).toBe(attachment);
  });

  it("gets attachments by window and surface", () => {
    const { window, surface } = registerResources();

    const attachment = manager.attachSurface({
      windowId: window.id,
      surfaceId: surface.id,
    });

    expect(manager.getWindowAttachment(window.id)).toBe(attachment);

    expect(manager.getSurfaceAttachment(surface.id)).toBe(attachment);
  });

  it("lists all attachments", () => {
    const firstWindow = createWindow("window-1", "session-1");

    const secondWindow = createWindow("window-2", "session-2");

    const firstSurface = createSurface("surface-1", "session-1");

    const secondSurface = createSurface("surface-2", "session-2");

    windows.add(firstWindow);

    windows.add(secondWindow);

    surfaces.add(firstSurface);

    surfaces.add(secondSurface);

    const first = manager.attachSurface({
      windowId: firstWindow.id,
      surfaceId: firstSurface.id,
    });

    const second = manager.attachSurface({
      windowId: secondWindow.id,
      surfaceId: secondSurface.id,
    });

    expect(manager.listAttachments()).toEqual([first, second]);
  });

  it("rejects detaching a window without an attachment", () => {
    const window = createWindow();

    windows.add(window);

    expect(() => manager.detachSurfaceFromWindow(window.id)).toThrow(
      WindowSurfaceAttachmentForWindowNotFoundError,
    );
  });

  it("rejects detaching a surface without an attachment", () => {
    const surface = createSurface();

    surfaces.add(surface);

    expect(() => manager.detachSurface(surface.id)).toThrow(
      WindowSurfaceAttachmentForSurfaceNotFoundError,
    );
  });

  it("includes the window identifier in the missing window attachment error", () => {
    const window = createWindow();

    windows.add(window);

    try {
      manager.detachSurfaceFromWindow(window.id);

      throw new Error("Expected detaching to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowSurfaceAttachmentForWindowNotFoundError);

      expect((error as WindowSurfaceAttachmentForWindowNotFoundError).windowId).toBe(
        window.id,
      );
    }
  });

  it("includes the surface identifier in the missing surface attachment error", () => {
    const surface = createSurface();

    surfaces.add(surface);

    try {
      manager.detachSurface(surface.id);

      throw new Error("Expected detaching to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowSurfaceAttachmentForSurfaceNotFoundError);

      expect((error as WindowSurfaceAttachmentForSurfaceNotFoundError).surfaceId).toBe(
        surface.id,
      );
    }
  });
});
