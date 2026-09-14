import { describe, expect, it } from "vitest";

import { GenesisDisplay } from "./genesis-display.js";

const CREATED_AT = new Date("2026-07-30T16:00:00.000Z");

const UPDATED_AT = new Date("2026-07-30T16:01:00.000Z");

function createDisplay(): GenesisDisplay {
  return new GenesisDisplay({
    id: "display-1",

    name: "Primary Display",

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

    state: "connected",

    primary: true,

    createdAt: CREATED_AT,
  });
}

describe("GenesisDisplay", () => {
  it("creates a display", () => {
    const display = createDisplay();

    expect(display.id).toBe("display-1");

    expect(display.name).toBe("Primary Display");

    expect(display.bounds).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });

    expect(display.mode).toEqual({
      width: 1920,
      height: 1080,
      refreshRate: 60,
    });

    expect(display.scaleFactor).toBe(1);

    expect(display.orientation).toBe("landscape");

    expect(display.state).toBe("connected");

    expect(display.primary).toBe(true);

    expect(display.createdAt).toEqual(CREATED_AT);

    expect(display.updatedAt).toEqual(CREATED_AT);
  });

  it("trims the display name", () => {
    const display = new GenesisDisplay({
      id: "display-1",

      name: "  Primary Display  ",

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

      state: "connected",

      primary: true,

      createdAt: CREATED_AT,
    });

    expect(display.name).toBe("Primary Display");
  });

  it("copies mutable values", () => {
    const bounds = {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    };

    const mode = {
      width: 1920,
      height: 1080,
      refreshRate: 60,
    };

    const createdAt = new Date(CREATED_AT);

    const display = new GenesisDisplay({
      id: "display-1",

      name: "Display",

      bounds,
      mode,

      scaleFactor: 1,

      orientation: "landscape",

      state: "connected",

      primary: true,

      createdAt,
    });

    bounds.width = 800;
    mode.width = 800;

    createdAt.setFullYear(2030);

    expect(display.bounds.width).toBe(1920);

    expect(display.mode.width).toBe(1920);

    expect(display.createdAt).toEqual(CREATED_AT);
  });

  it("changes state immutably", () => {
    const display = createDisplay();

    const active = display.withState("active", UPDATED_AT);

    expect(active).not.toBe(display);

    expect(active.state).toBe("active");

    expect(active.updatedAt).toEqual(UPDATED_AT);

    expect(display.state).toBe("connected");
  });

  it("returns the same display when state is unchanged", () => {
    const display = createDisplay();

    expect(display.withState("connected", UPDATED_AT)).toBe(display);
  });

  it("prevents a disconnected display from changing state", () => {
    const disconnected = createDisplay().withState("disconnected", UPDATED_AT);

    expect(() =>
      disconnected.withState("active", new Date("2026-07-30T16:02:00.000Z")),
    ).toThrow('Disconnected display "display-1" cannot change state.');
  });

  it("changes bounds immutably", () => {
    const display = createDisplay();

    const updated = display.withBounds(
      {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
      },
      UPDATED_AT,
    );

    expect(updated.bounds).toEqual({
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    });

    expect(display.bounds.x).toBe(0);
  });

  it("changes display mode immutably", () => {
    const display = createDisplay();

    const updated = display.withMode(
      {
        width: 2560,
        height: 1440,
        refreshRate: 144,
      },
      UPDATED_AT,
    );

    expect(updated.mode).toEqual({
      width: 2560,
      height: 1440,
      refreshRate: 144,
    });

    expect(display.mode.width).toBe(1920);
  });

  it("supports fractional refresh rates", () => {
    const display = createDisplay();

    const updated = display.withMode(
      {
        width: 1920,
        height: 1080,
        refreshRate: 59.94,
      },
      UPDATED_AT,
    );

    expect(updated.mode.refreshRate).toBe(59.94);
  });

  it("changes scale factor immutably", () => {
    const display = createDisplay();

    const updated = display.withScaleFactor(2, UPDATED_AT);

    expect(updated.scaleFactor).toBe(2);

    expect(display.scaleFactor).toBe(1);
  });

  it("changes orientation immutably", () => {
    const display = createDisplay();

    const updated = display.withOrientation("portrait", UPDATED_AT);

    expect(updated.orientation).toBe("portrait");

    expect(display.orientation).toBe("landscape");
  });

  it("changes primary status immutably", () => {
    const display = createDisplay();

    const updated = display.withPrimary(false, UPDATED_AT);

    expect(updated.primary).toBe(false);

    expect(display.primary).toBe(true);
  });

  it.each(["", "   "])("rejects invalid display name %j", (name) => {
    expect(
      () =>
        new GenesisDisplay({
          id: "display-1",

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

          state: "connected",

          primary: true,

          createdAt: CREATED_AT,
        }),
    ).toThrow("Display name must not be empty.");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid bounds width %s",
    (width) => {
      expect(() =>
        createDisplay().withBounds(
          {
            x: 0,
            y: 0,
            width,
            height: 1080,
          },
          UPDATED_AT,
        ),
      ).toThrow();
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid refresh rate %s",
    (refreshRate) => {
      expect(() =>
        createDisplay().withMode(
          {
            width: 1920,
            height: 1080,
            refreshRate,
          },
          UPDATED_AT,
        ),
      ).toThrow("Display mode refresh rate must be a positive finite number.");
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid scale factor %s",
    (scaleFactor) => {
      expect(() => createDisplay().withScaleFactor(scaleFactor, UPDATED_AT)).toThrow(
        "Display scale factor must be a positive finite number.",
      );
    },
  );
});
