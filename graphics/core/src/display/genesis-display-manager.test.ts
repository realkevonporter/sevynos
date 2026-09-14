import { beforeEach, describe, expect, it } from "vitest";

import { DisplayNotFoundError } from "../errors/display-not-found-error.js";
import type { DisplayId } from "./display-id.js";
import { DisplayRegistry } from "./display-registry.js";
import { GenesisDisplayManager } from "./genesis-display-manager.js";

const FIRST_TIME = new Date("2026-07-30T18:00:00.000Z");

const SECOND_TIME = new Date("2026-07-30T18:01:00.000Z");

const THIRD_TIME = new Date("2026-07-30T18:02:00.000Z");

describe("GenesisDisplayManager", () => {
  let displays: DisplayRegistry;

  let currentTime: Date;

  let nextDisplayNumber: number;

  let manager: GenesisDisplayManager;

  beforeEach(() => {
    displays = new DisplayRegistry();

    currentTime = new Date(FIRST_TIME);

    nextDisplayNumber = 1;

    manager = new GenesisDisplayManager({
      displays,

      createDisplayId: (): DisplayId => {
        const id: DisplayId = `display-${String(nextDisplayNumber)}`;

        nextDisplayNumber += 1;

        return id;
      },

      now: () => new Date(currentTime),
    });
  });

  function connectDisplay(name = "Test Display") {
    return manager.connectDisplay({
      name,

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
    });
  }

  it("connects a display", () => {
    const display = connectDisplay();

    expect(display.id).toBe("display-1");

    expect(display.name).toBe("Test Display");

    expect(display.state).toBe("connected");

    expect(display.createdAt).toEqual(FIRST_TIME);

    expect(displays.get(display.id)).toBe(display);
  });

  it("creates unique display identifiers", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    expect(first.id).toBe("display-1");

    expect(second.id).toBe("display-2");
  });

  it("makes the first connected display primary", () => {
    const display = connectDisplay();

    expect(display.primary).toBe(true);

    expect(manager.getPrimaryDisplay()).toBe(display);
  });

  it("does not make later displays primary automatically", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    expect(first.primary).toBe(true);

    expect(second.primary).toBe(false);

    expect(manager.getPrimaryDisplay()?.id).toBe(first.id);
  });

  it("gets a display", () => {
    const display = connectDisplay();

    expect(manager.getDisplay(display.id)).toBe(display);
  });

  it("rejects getting an unknown display", () => {
    expect(() => manager.getDisplay("display-missing")).toThrow(DisplayNotFoundError);
  });

  it("activates a display", () => {
    const display = connectDisplay();

    currentTime = new Date(SECOND_TIME);

    const active = manager.activateDisplay(display.id);

    expect(active.state).toBe("active");

    expect(active.updatedAt).toEqual(SECOND_TIME);

    expect(displays.get(display.id)).toBe(active);
  });

  it("returns the same active display when activation is repeated", () => {
    const display = connectDisplay();

    const active = manager.activateDisplay(display.id);

    currentTime = new Date(SECOND_TIME);

    const result = manager.activateDisplay(display.id);

    expect(result).toBe(active);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("updates display configuration", () => {
    const display = connectDisplay();

    currentTime = new Date(SECOND_TIME);

    const updated = manager.updateDisplayConfiguration(display.id, {
      bounds: {
        x: -2560,
        y: 0,
        width: 2560,
        height: 1440,
      },

      mode: {
        width: 2560,
        height: 1440,
        refreshRate: 144,
      },

      scaleFactor: 2,

      orientation: "portrait",
    });

    expect(updated.bounds).toEqual({
      x: -2560,
      y: 0,
      width: 2560,
      height: 1440,
    });

    expect(updated.mode).toEqual({
      width: 2560,
      height: 1440,
      refreshRate: 144,
    });

    expect(updated.scaleFactor).toBe(2);

    expect(updated.orientation).toBe("portrait");

    expect(updated.updatedAt).toEqual(SECOND_TIME);
  });

  it("returns the same display when configuration is unchanged", () => {
    const display = connectDisplay();

    currentTime = new Date(SECOND_TIME);

    const result = manager.updateDisplayConfiguration(display.id, {
      bounds: display.bounds,

      mode: display.mode,

      scaleFactor: display.scaleFactor,

      orientation: display.orientation,
    });

    expect(result).toBe(display);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("changes the primary display", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    currentTime = new Date(SECOND_TIME);

    const primary = manager.setPrimaryDisplay(second.id);

    expect(primary.primary).toBe(true);

    expect(displays.get(first.id)?.primary).toBe(false);

    expect(manager.getPrimaryDisplay()?.id).toBe(second.id);
  });

  it("returns the same display when it is already primary", () => {
    const display = connectDisplay();

    currentTime = new Date(SECOND_TIME);

    const result = manager.setPrimaryDisplay(display.id);

    expect(result).toBe(display);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("disconnects a non-primary display", () => {
    const primary = connectDisplay("Primary");

    const secondary = connectDisplay("Secondary");

    currentTime = new Date(SECOND_TIME);

    const disconnected = manager.disconnectDisplay(secondary.id);

    expect(disconnected.state).toBe("disconnected");

    expect(disconnected.primary).toBe(false);

    expect(manager.getPrimaryDisplay()?.id).toBe(primary.id);
  });

  it("promotes an active display when the primary disconnects", () => {
    const primary = connectDisplay("Primary");

    const connected = connectDisplay("Connected");

    const active = connectDisplay("Active");

    manager.activateDisplay(active.id);

    currentTime = new Date(SECOND_TIME);

    const disconnected = manager.disconnectDisplay(primary.id);

    expect(disconnected.state).toBe("disconnected");

    expect(disconnected.primary).toBe(false);

    expect(manager.getPrimaryDisplay()?.id).toBe(active.id);

    expect(displays.get(connected.id)?.primary).toBe(false);
  });

  it("promotes the first connected display when no active display exists", () => {
    const primary = connectDisplay("Primary");

    const second = connectDisplay("Second");

    connectDisplay("Third");

    currentTime = new Date(SECOND_TIME);

    manager.disconnectDisplay(primary.id);

    expect(manager.getPrimaryDisplay()?.id).toBe(second.id);
  });

  it("has no primary when the last display disconnects", () => {
    const display = connectDisplay();

    manager.disconnectDisplay(display.id);

    expect(manager.getPrimaryDisplay()).toBeUndefined();
  });

  it("returns the same display when disconnect is repeated", () => {
    const display = connectDisplay();

    const disconnected = manager.disconnectDisplay(display.id);

    currentTime = new Date(SECOND_TIME);

    const result = manager.disconnectDisplay(display.id);

    expect(result).toBe(disconnected);

    expect(result.updatedAt).toEqual(FIRST_TIME);
  });

  it("rejects activating a disconnected display", () => {
    const display = connectDisplay();

    manager.disconnectDisplay(display.id);

    expect(() => manager.activateDisplay(display.id)).toThrow(
      `Disconnected display "${display.id}" cannot change state.`,
    );
  });

  it("rejects making a disconnected display primary", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    manager.disconnectDisplay(second.id);

    expect(() => manager.setPrimaryDisplay(second.id)).toThrow(
      `Disconnected display "${second.id}" cannot become primary.`,
    );

    expect(manager.getPrimaryDisplay()?.id).toBe(first.id);
  });

  it("lists all displays", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    expect(manager.listDisplays()).toEqual([first, second]);
  });

  it("lists only non-disconnected displays", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    const third = connectDisplay("Third");

    manager.disconnectDisplay(second.id);

    expect(manager.listConnectedDisplays().map((display) => display.id)).toEqual([
      first.id,
      third.id,
    ]);
  });

  it("preserves exactly one primary display across multiple changes", () => {
    const first = connectDisplay("First");

    const second = connectDisplay("Second");

    const third = connectDisplay("Third");

    manager.setPrimaryDisplay(second.id);

    currentTime = new Date(SECOND_TIME);

    manager.setPrimaryDisplay(third.id);

    currentTime = new Date(THIRD_TIME);

    const primaryDisplays = manager.listDisplays().filter((display) => display.primary);

    expect(primaryDisplays).toHaveLength(1);

    expect(primaryDisplays[0]?.id).toBe(third.id);

    expect(displays.get(first.id)?.primary).toBe(false);

    expect(displays.get(second.id)?.primary).toBe(false);
  });
});
