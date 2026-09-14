import { validateDisplayBounds } from "./display-bounds.js";
import type { DisplayBounds } from "./display-bounds.js";
import type { DisplayId } from "./display-id.js";
import { validateDisplayMode } from "./display-mode.js";
import type { DisplayMode } from "./display-mode.js";
import type { DisplayOrientation } from "./display-orientation.js";
import type { DisplayState } from "./display-state.js";

export interface GenesisDisplayOptions {
  readonly id: DisplayId;

  readonly name: string;

  readonly bounds: DisplayBounds;

  readonly mode: DisplayMode;

  readonly scaleFactor: number;

  readonly orientation: DisplayOrientation;

  readonly state: DisplayState;

  readonly primary: boolean;

  readonly createdAt: Date;

  readonly updatedAt?: Date;
}

export class GenesisDisplay {
  public readonly id: DisplayId;

  public readonly name: string;

  public readonly bounds: DisplayBounds;

  public readonly mode: DisplayMode;

  public readonly scaleFactor: number;

  public readonly orientation: DisplayOrientation;

  public readonly state: DisplayState;

  public readonly primary: boolean;

  public readonly createdAt: Date;

  public readonly updatedAt: Date;

  public constructor(options: GenesisDisplayOptions) {
    const name = options.name.trim();

    if (name.length === 0) {
      throw new RangeError("Display name must not be empty.");
    }

    validateDisplayBounds(options.bounds);

    validateDisplayMode(options.mode);

    GenesisDisplay.validateScaleFactor(options.scaleFactor);

    this.id = options.id;

    this.name = name;

    this.bounds = {
      ...options.bounds,
    };

    this.mode = {
      ...options.mode,
    };

    this.scaleFactor = options.scaleFactor;

    this.orientation = options.orientation;

    this.state = options.state;

    this.primary = options.primary;

    this.createdAt = new Date(options.createdAt);

    this.updatedAt = new Date(options.updatedAt ?? options.createdAt);
  }

  public withState(state: DisplayState, updatedAt: Date): GenesisDisplay {
    if (state === this.state) {
      return this;
    }

    if (this.state === "disconnected") {
      throw new Error(`Disconnected display "${this.id}" cannot change state.`);
    }

    return this.copy({
      state,
      updatedAt,
    });
  }

  public withBounds(bounds: DisplayBounds, updatedAt: Date): GenesisDisplay {
    validateDisplayBounds(bounds);

    if (
      bounds.x === this.bounds.x &&
      bounds.y === this.bounds.y &&
      bounds.width === this.bounds.width &&
      bounds.height === this.bounds.height
    ) {
      return this;
    }

    return this.copy({
      bounds,
      updatedAt,
    });
  }

  public withMode(mode: DisplayMode, updatedAt: Date): GenesisDisplay {
    validateDisplayMode(mode);

    if (
      mode.width === this.mode.width &&
      mode.height === this.mode.height &&
      mode.refreshRate === this.mode.refreshRate
    ) {
      return this;
    }

    return this.copy({
      mode,
      updatedAt,
    });
  }

  public withScaleFactor(scaleFactor: number, updatedAt: Date): GenesisDisplay {
    GenesisDisplay.validateScaleFactor(scaleFactor);

    if (scaleFactor === this.scaleFactor) {
      return this;
    }

    return this.copy({
      scaleFactor,
      updatedAt,
    });
  }

  public withOrientation(
    orientation: DisplayOrientation,
    updatedAt: Date,
  ): GenesisDisplay {
    if (orientation === this.orientation) {
      return this;
    }

    return this.copy({
      orientation,
      updatedAt,
    });
  }

  public withPrimary(primary: boolean, updatedAt: Date): GenesisDisplay {
    if (primary === this.primary) {
      return this;
    }

    return this.copy({
      primary,
      updatedAt,
    });
  }

  private copy(changes: Partial<GenesisDisplayOptions>): GenesisDisplay {
    return new GenesisDisplay({
      id: changes.id ?? this.id,

      name: changes.name ?? this.name,

      bounds: changes.bounds ?? this.bounds,

      mode: changes.mode ?? this.mode,

      scaleFactor: changes.scaleFactor ?? this.scaleFactor,

      orientation: changes.orientation ?? this.orientation,

      state: changes.state ?? this.state,

      primary: changes.primary ?? this.primary,

      createdAt: changes.createdAt ?? this.createdAt,

      updatedAt: changes.updatedAt ?? this.updatedAt,
    });
  }

  private static validateScaleFactor(scaleFactor: number): void {
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
      throw new RangeError("Display scale factor must be a positive finite number.");
    }
  }
}
