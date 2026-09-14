import { describe, expect, it } from "vitest";

import { SurfaceAlreadyExistsError } from "../errors/surface-already-exists-error.js";
import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import { GenesisSurface } from "./genesis-surface.js";
import { SurfaceRegistry } from "./surface-registry.js";

const CREATED_AT = new Date("2026-07-28T12:00:00.000Z");

const UPDATED_AT = new Date("2026-07-28T12:01:00.000Z");

function createSurface(
  id: `surface-${string}`,
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
    createdAt: CREATED_AT,
  });
}

describe("SurfaceRegistry", () => {
  it("adds and retrieves a surface", () => {
    const registry = new SurfaceRegistry();

    const surface = createSurface("surface-1");

    registry.add(surface);

    expect(registry.get(surface.id)).toBe(surface);

    expect(registry.has(surface.id)).toBe(true);

    expect(registry.count()).toBe(1);
  });

  it("rejects duplicate surface identifiers", () => {
    const registry = new SurfaceRegistry();

    registry.add(createSurface("surface-1"));

    expect(() => {
      registry.add(createSurface("surface-1"));
    }).toThrow(SurfaceAlreadyExistsError);

    expect(registry.count()).toBe(1);
  });

  it("updates an existing surface", () => {
    const registry = new SurfaceRegistry();

    const surface = createSurface("surface-1");

    registry.add(surface);

    const readySurface = surface.withState("ready", UPDATED_AT);

    registry.update(readySurface);

    expect(registry.get(surface.id)).toBe(readySurface);

    expect(registry.get(surface.id)?.state).toBe("ready");
  });

  it("rejects updates for unknown surfaces", () => {
    const registry = new SurfaceRegistry();

    const surface = createSurface("surface-missing");

    expect(() => {
      registry.update(surface);
    }).toThrow(SurfaceNotFoundError);
  });

  it("removes and returns a surface", () => {
    const registry = new SurfaceRegistry();

    const surface = createSurface("surface-1");

    registry.add(surface);

    const removed = registry.remove(surface.id);

    expect(removed).toBe(surface);

    expect(registry.get(surface.id)).toBeUndefined();

    expect(registry.has(surface.id)).toBe(false);

    expect(registry.count()).toBe(0);
  });

  it("rejects removal of an unknown surface", () => {
    const registry = new SurfaceRegistry();

    expect(() => registry.remove("surface-missing")).toThrow(SurfaceNotFoundError);
  });

  it("returns undefined for an unknown surface", () => {
    const registry = new SurfaceRegistry();

    expect(registry.get("surface-missing")).toBeUndefined();
  });

  it("lists all surfaces", () => {
    const registry = new SurfaceRegistry();

    const first = createSurface("surface-1");

    const second = createSurface("surface-2", "session-2");

    registry.add(first);
    registry.add(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("lists surfaces by session", () => {
    const registry = new SurfaceRegistry();

    const first = createSurface("surface-1", "session-1");

    const second = createSurface("surface-2", "session-1");

    const third = createSurface("surface-3", "session-2");

    registry.add(first);
    registry.add(second);
    registry.add(third);

    expect(registry.listBySession("session-1")).toEqual([first, second]);

    expect(registry.listBySession("session-2")).toEqual([third]);
  });

  it("returns an empty list for a session without surfaces", () => {
    const registry = new SurfaceRegistry();

    registry.add(createSurface("surface-1", "session-1"));

    expect(registry.listBySession("session-missing")).toEqual([]);
  });

  it("does not expose the internal collection", () => {
    const registry = new SurfaceRegistry();

    const surface = createSurface("surface-1");

    registry.add(surface);

    const listedSurfaces = registry.list();

    expect(listedSurfaces).not.toBe(registry.list());

    expect(registry.count()).toBe(1);
  });

  it("preserves insertion order when a surface is updated", () => {
    const registry = new SurfaceRegistry();

    const first = createSurface("surface-1");

    const second = createSurface("surface-2");

    registry.add(first);
    registry.add(second);

    const updatedFirst = first.withState("ready", UPDATED_AT);

    registry.update(updatedFirst);

    expect(registry.list().map((surface) => surface.id)).toEqual([
      "surface-1",
      "surface-2",
    ]);
  });
});
