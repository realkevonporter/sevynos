import { beforeEach, describe, expect, it } from "vitest";

import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import { GenesisSurfaceManager } from "./genesis-surface-manager.js";
import type { SurfaceId } from "./surface-id.js";
import { SurfaceRegistry } from "./surface-registry.js";

const FIRST_TIME = new Date("2026-07-30T12:00:00.000Z");

const SECOND_TIME = new Date("2026-07-30T12:01:00.000Z");

describe("GenesisSurfaceManager", () => {
  let registry: SurfaceRegistry;

  let currentTime: Date;

  let nextSurfaceNumber: number;

  let manager: GenesisSurfaceManager;

  beforeEach(() => {
    registry = new SurfaceRegistry();

    currentTime = new Date(FIRST_TIME);

    nextSurfaceNumber = 1;

    manager = new GenesisSurfaceManager({
      surfaces: registry,

      createSurfaceId: (): SurfaceId => {
        const id: SurfaceId = `surface-${String(nextSurfaceNumber)}`;

        nextSurfaceNumber += 1;

        return id;
      },

      now: () => new Date(currentTime),
    });
  });

  function createSurface() {
    return manager.createSurface({
      sessionId: "session-1",
      size: {
        width: 800,
        height: 600,
      },
      pixelFormat: "rgba8888",
    });
  }

  it("creates and registers a surface", () => {
    const surface = createSurface();

    expect(surface.id).toBe("surface-1");

    expect(surface.sessionId).toBe("session-1");

    expect(surface.state).toBe("created");

    expect(surface.size).toEqual({
      width: 800,
      height: 600,
    });

    expect(surface.createdAt).toEqual(FIRST_TIME);

    expect(surface.updatedAt).toEqual(FIRST_TIME);

    expect(registry.get(surface.id)).toBe(surface);
  });

  it("creates unique surface identifiers", () => {
    const first = createSurface();

    const second = createSurface();

    expect(first.id).toBe("surface-1");

    expect(second.id).toBe("surface-2");
  });

  it("gets a registered surface", () => {
    const surface = createSurface();

    expect(manager.getSurface(surface.id)).toBe(surface);
  });

  it("rejects getting an unknown surface", () => {
    expect(() => manager.getSurface("surface-missing")).toThrow(SurfaceNotFoundError);
  });

  it("marks a surface as ready", () => {
    const surface = createSurface();

    currentTime = new Date(SECOND_TIME);

    const readySurface = manager.readySurface(surface.id);

    expect(readySurface.state).toBe("ready");

    expect(readySurface.updatedAt).toEqual(SECOND_TIME);

    expect(registry.get(surface.id)).toBe(readySurface);

    expect(surface.state).toBe("created");
  });

  it("returns the same surface when already ready", () => {
    const surface = createSurface();

    const readySurface = manager.readySurface(surface.id);

    currentTime = new Date(SECOND_TIME);

    const result = manager.readySurface(surface.id);

    expect(result).toBe(readySurface);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("resizes a surface", () => {
    const surface = createSurface();

    currentTime = new Date(SECOND_TIME);

    const resizedSurface = manager.resizeSurface(surface.id, {
      width: 1024,
      height: 768,
    });

    expect(resizedSurface.size).toEqual({
      width: 1024,
      height: 768,
    });

    expect(resizedSurface.updatedAt).toEqual(SECOND_TIME);

    expect(surface.size).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("marks the entire surface as damaged after resizing", () => {
    const surface = createSurface();

    const resizedSurface = manager.resizeSurface(surface.id, {
      width: 1024,
      height: 768,
    });

    expect(resizedSurface.damagedRegions).toEqual([
      {
        x: 0,
        y: 0,
        width: 1024,
        height: 768,
      },
    ]);
  });

  it("adds surface damage", () => {
    const surface = createSurface();

    const damagedSurface = manager.damageSurface(surface.id, {
      x: 20,
      y: 30,
      width: 100,
      height: 80,
    });

    expect(damagedSurface.damagedRegions).toEqual([
      {
        x: 20,
        y: 30,
        width: 100,
        height: 80,
      },
    ]);

    expect(registry.get(surface.id)).toBe(damagedSurface);
  });

  it("accumulates surface damage", () => {
    const surface = createSurface();

    manager.damageSurface(surface.id, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });

    const damagedSurface = manager.damageSurface(surface.id, {
      x: 200,
      y: 200,
      width: 50,
      height: 50,
    });

    expect(damagedSurface.damagedRegions).toEqual([
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      {
        x: 200,
        y: 200,
        width: 50,
        height: 50,
      },
    ]);
  });

  it("replaces surface damage", () => {
    const surface = createSurface();

    manager.damageSurface(surface.id, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });

    const replacedSurface = manager.replaceDamage(surface.id, [
      {
        x: 300,
        y: 300,
        width: 40,
        height: 40,
      },
    ]);

    expect(replacedSurface.damagedRegions).toEqual([
      {
        x: 300,
        y: 300,
        width: 40,
        height: 40,
      },
    ]);
  });

  it("clears surface damage", () => {
    const surface = createSurface();

    manager.damageSurface(surface.id, {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });

    currentTime = new Date(SECOND_TIME);

    const clearedSurface = manager.clearSurfaceDamage(surface.id);

    expect(clearedSurface.damagedRegions).toEqual([]);

    expect(clearedSurface.updatedAt).toEqual(SECOND_TIME);
  });

  it("returns the same surface when damage is already empty", () => {
    const surface = createSurface();

    currentTime = new Date(SECOND_TIME);

    const result = manager.clearSurfaceDamage(surface.id);

    expect(result).toBe(surface);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("destroys and unregisters a surface", () => {
    const surface = createSurface();

    currentTime = new Date(SECOND_TIME);

    const destroyedSurface = manager.destroySurface(surface.id);

    expect(destroyedSurface.state).toBe("destroyed");

    expect(destroyedSurface.updatedAt).toEqual(SECOND_TIME);

    expect(registry.has(surface.id)).toBe(false);
  });

  it("rejects destroying an unknown surface", () => {
    expect(() => manager.destroySurface("surface-missing")).toThrow(SurfaceNotFoundError);
  });

  it("lists all registered surfaces", () => {
    const first = createSurface();

    const second = manager.createSurface({
      sessionId: "session-2",
      size: {
        width: 400,
        height: 300,
      },
      pixelFormat: "bgra8888",
    });

    expect(manager.listSurfaces()).toEqual([first, second]);
  });

  it("lists surfaces belonging to a session", () => {
    const first = createSurface();

    const second = createSurface();

    manager.createSurface({
      sessionId: "session-2",
      size: {
        width: 400,
        height: 300,
      },
      pixelFormat: "bgra8888",
    });

    expect(manager.listSessionSurfaces("session-1")).toEqual([first, second]);
  });

  it("destroys every surface belonging to a session", () => {
    const first = createSurface();

    const second = createSurface();

    const otherSurface = manager.createSurface({
      sessionId: "session-2",
      size: {
        width: 400,
        height: 300,
      },
      pixelFormat: "bgra8888",
    });

    currentTime = new Date(SECOND_TIME);

    const destroyedSurfaces = manager.destroySessionSurfaces("session-1");

    expect(
      destroyedSurfaces.map((surface) => ({
        id: surface.id,
        state: surface.state,
      })),
    ).toEqual([
      {
        id: first.id,
        state: "destroyed",
      },
      {
        id: second.id,
        state: "destroyed",
      },
    ]);

    expect(registry.has(first.id)).toBe(false);

    expect(registry.has(second.id)).toBe(false);

    expect(registry.get(otherSurface.id)).toBe(otherSurface);
  });

  it("returns an empty list when a session has no surfaces", () => {
    expect(manager.destroySessionSurfaces("session-missing")).toEqual([]);
  });

  it("rejects operations on unknown surfaces", () => {
    expect(() => manager.readySurface("surface-missing")).toThrow(SurfaceNotFoundError);

    expect(() =>
      manager.resizeSurface("surface-missing", {
        width: 100,
        height: 100,
      }),
    ).toThrow(SurfaceNotFoundError);

    expect(() =>
      manager.damageSurface("surface-missing", {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    ).toThrow(SurfaceNotFoundError);

    expect(() => manager.clearSurfaceDamage("surface-missing")).toThrow(
      SurfaceNotFoundError,
    );
  });
});
