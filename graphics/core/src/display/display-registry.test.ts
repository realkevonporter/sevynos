import { describe, expect, it } from "vitest";

import { DisplayAlreadyExistsError } from "../errors/display-already-exists-error.js";
import { DisplayNotFoundError } from "../errors/display-not-found-error.js";
import { DisplayRegistry } from "./display-registry.js";
import { GenesisDisplay } from "./genesis-display.js";

const CREATED_AT = new Date("2026-07-30T17:00:00.000Z");

const UPDATED_AT = new Date("2026-07-30T17:01:00.000Z");

function createDisplay(
  id: `display-${string}` = "display-1",
  options?: {
    readonly primary?: boolean;

    readonly state?: "connected" | "active" | "disconnected";

    readonly name?: string;
  },
): GenesisDisplay {
  return new GenesisDisplay({
    id,

    name: options?.name ?? `Display ${id}`,

    bounds: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    },

    mode: {
      width: 1920,
      height: 1080,
      refreshRate: 60,
    },

    scaleFactor: 1,

    orientation: "landscape",

    state: options?.state ?? "connected",

    primary: options?.primary ?? false,

    createdAt: CREATED_AT,
  });
}

describe("DisplayRegistry", () => {
  it("adds and retrieves a display", () => {
    const registry = new DisplayRegistry();

    const display = createDisplay();

    registry.add(display);

    expect(registry.get(display.id)).toBe(display);

    expect(registry.has(display.id)).toBe(true);

    expect(registry.count()).toBe(1);
  });

  it("rejects duplicate display identifiers", () => {
    const registry = new DisplayRegistry();

    registry.add(createDisplay("display-1"));

    expect(() => {
      registry.add(createDisplay("display-1"));
    }).toThrow(DisplayAlreadyExistsError);
  });

  it("updates a display", () => {
    const registry = new DisplayRegistry();

    const display = createDisplay();

    registry.add(display);

    const updated = display.withState("active", UPDATED_AT);

    registry.update(updated);

    expect(registry.get(display.id)).toBe(updated);

    expect(registry.get(display.id)?.state).toBe("active");
  });

  it("rejects updating an unknown display", () => {
    const registry = new DisplayRegistry();

    expect(() => {
      registry.update(createDisplay("display-missing"));
    }).toThrow(DisplayNotFoundError);
  });

  it("removes a display", () => {
    const registry = new DisplayRegistry();

    const display = createDisplay();

    registry.add(display);

    const removed = registry.remove(display.id);

    expect(removed).toBe(display);

    expect(registry.get(display.id)).toBeUndefined();

    expect(registry.count()).toBe(0);
  });

  it("rejects removing an unknown display", () => {
    const registry = new DisplayRegistry();

    expect(() => {
      registry.remove("display-missing");
    }).toThrow(DisplayNotFoundError);
  });

  it("gets the primary display", () => {
    const registry = new DisplayRegistry();

    const secondary = createDisplay("display-1");

    const primary = createDisplay("display-2", {
      primary: true,
    });

    registry.add(secondary);

    registry.add(primary);

    expect(registry.getPrimary()).toBe(primary);
  });

  it("returns undefined when there is no primary display", () => {
    const registry = new DisplayRegistry();

    registry.add(createDisplay());

    expect(registry.getPrimary()).toBeUndefined();
  });

  it("lists displays by state", () => {
    const registry = new DisplayRegistry();

    const connected = createDisplay("display-1", {
      state: "connected",
    });

    const active = createDisplay("display-2", {
      state: "active",
    });

    const disconnected = createDisplay("display-3", {
      state: "disconnected",
    });

    registry.add(connected);

    registry.add(active);

    registry.add(disconnected);

    expect(registry.listByState("connected")).toEqual([connected]);

    expect(registry.listByState("active")).toEqual([active]);

    expect(registry.listByState("disconnected")).toEqual([disconnected]);
  });

  it("lists displays in insertion order", () => {
    const registry = new DisplayRegistry();

    const first = createDisplay("display-1");

    const second = createDisplay("display-2");

    const third = createDisplay("display-3");

    registry.add(first);
    registry.add(second);
    registry.add(third);

    expect(registry.list()).toEqual([first, second, third]);
  });

  it("does not expose its internal collection", () => {
    const registry = new DisplayRegistry();

    registry.add(createDisplay());

    const firstList = registry.list();

    const secondList = registry.list();

    expect(firstList).not.toBe(secondList);

    expect(registry.count()).toBe(1);
  });

  it("reflects primary updates", () => {
    const registry = new DisplayRegistry();

    const display = createDisplay();

    registry.add(display);

    expect(registry.getPrimary()).toBeUndefined();

    const primary = display.withPrimary(true, UPDATED_AT);

    registry.update(primary);

    expect(registry.getPrimary()).toBe(primary);
  });
});
