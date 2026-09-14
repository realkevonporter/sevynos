import { describe, expect, it } from "vitest";

import { GenesisSurface } from "./genesis-surface.js";

const CREATED_AT = new Date("2026-07-28T12:00:00.000Z");

const UPDATED_AT = new Date("2026-07-28T12:01:00.000Z");

function createSurface(): GenesisSurface {
  return new GenesisSurface({
    id: "surface-1",
    sessionId: "session-1",
    size: {
      width: 800,
      height: 600,
    },
    pixelFormat: "rgba8888",
    createdAt: CREATED_AT,
  });
}

describe("GenesisSurface", () => {
  it("creates a surface", () => {
    const surface = createSurface();

    expect(surface.id).toBe("surface-1");

    expect(surface.sessionId).toBe("session-1");

    expect(surface.size).toEqual({
      width: 800,
      height: 600,
    });

    expect(surface.pixelFormat).toBe("rgba8888");

    expect(surface.state).toBe("created");

    expect(surface.damagedRegions).toEqual([]);
  });

  it("copies mutable constructor values", () => {
    const size = {
      width: 800,
      height: 600,
    };

    const createdAt = new Date(CREATED_AT);

    const surface = new GenesisSurface({
      id: "surface-1",
      sessionId: "session-1",
      size,
      pixelFormat: "rgba8888",
      createdAt,
    });

    size.width = 400;

    createdAt.setFullYear(2030);

    expect(surface.size.width).toBe(800);

    expect(surface.createdAt).toEqual(CREATED_AT);
  });

  it("transitions to ready", () => {
    const surface = createSurface();

    const ready = surface.withState("ready", UPDATED_AT);

    expect(ready.state).toBe("ready");

    expect(ready.updatedAt).toEqual(UPDATED_AT);

    expect(surface.state).toBe("created");
  });

  it("transitions to destroyed", () => {
    const destroyed = createSurface().withState("destroyed", UPDATED_AT);

    expect(destroyed.state).toBe("destroyed");
  });

  it("does not revive a destroyed surface", () => {
    const destroyed = createSurface().withState("destroyed", UPDATED_AT);

    expect(() => destroyed.withState("ready", UPDATED_AT)).toThrow(
      'Destroyed surface "surface-1" cannot transition to "ready".',
    );
  });

  it("resizes a surface immutably", () => {
    const surface = createSurface();

    const resized = surface.withSize(
      {
        width: 1024,
        height: 768,
      },
      UPDATED_AT,
    );

    expect(resized.size).toEqual({
      width: 1024,
      height: 768,
    });

    expect(surface.size).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("adds a damaged region", () => {
    const damaged = createSurface().addDamage(
      {
        x: 20,
        y: 30,
        width: 100,
        height: 80,
      },
      UPDATED_AT,
    );

    expect(damaged.damagedRegions).toEqual([
      {
        x: 20,
        y: 30,
        width: 100,
        height: 80,
      },
    ]);
  });

  it("replaces damaged regions", () => {
    const surface = createSurface().addDamage(
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      UPDATED_AT,
    );

    const replaced = surface.withDamage(
      [
        {
          x: 200,
          y: 200,
          width: 50,
          height: 50,
        },
      ],
      UPDATED_AT,
    );

    expect(replaced.damagedRegions).toEqual([
      {
        x: 200,
        y: 200,
        width: 50,
        height: 50,
      },
    ]);
  });

  it("clears damaged regions", () => {
    const damaged = createSurface().addDamage(
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      UPDATED_AT,
    );

    const cleared = damaged.clearDamage(UPDATED_AT);

    expect(cleared.damagedRegions).toEqual([]);
  });

  it("returns the same instance when damage is already empty", () => {
    const surface = createSurface();

    expect(surface.clearDamage(UPDATED_AT)).toBe(surface);
  });

  it("rejects invalid surface sizes", () => {
    expect(
      () =>
        new GenesisSurface({
          id: "surface-1",
          sessionId: "session-1",
          size: {
            width: 0,
            height: 600,
          },
          pixelFormat: "rgba8888",
          createdAt: CREATED_AT,
        }),
    ).toThrow(RangeError);
  });

  it("rejects damage outside surface bounds", () => {
    const surface = createSurface();

    expect(() =>
      surface.addDamage(
        {
          x: 750,
          y: 0,
          width: 100,
          height: 100,
        },
        UPDATED_AT,
      ),
    ).toThrow("Damaged region exceeds the surface width.");
  });

  it("prevents resizing a destroyed surface", () => {
    const destroyed = createSurface().withState("destroyed", UPDATED_AT);

    expect(() =>
      destroyed.withSize(
        {
          width: 1024,
          height: 768,
        },
        UPDATED_AT,
      ),
    ).toThrow('Destroyed surface "surface-1" cannot be resized.');
  });

  it("prevents adding damage to a destroyed surface", () => {
    const destroyed = createSurface().withState("destroyed", UPDATED_AT);

    expect(() =>
      destroyed.addDamage(
        {
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        },
        UPDATED_AT,
      ),
    ).toThrow('Destroyed surface "surface-1" cannot receive damage.');
  });

  it("clears damage after resizing", () => {
    const damaged = createSurface().addDamage(
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      UPDATED_AT,
    );

    const resized = damaged.withSize(
      {
        width: 1024,
        height: 768,
      },
      UPDATED_AT,
    );

    expect(resized.damagedRegions).toEqual([]);
  });
});
