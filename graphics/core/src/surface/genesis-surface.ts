import type { ApplicationSessionId } from "../application-session-id.js";
import type { DamagedRegion } from "./damaged-region.js";
import { validateDamagedRegion } from "./damaged-region.js";
import type { PixelFormat } from "./pixel-format.js";
import type { SurfaceId } from "./surface-id.js";
import type { SurfaceSize } from "./surface-size.js";
import { validateSurfaceSize } from "./surface-size.js";
import type { SurfaceState } from "./surface-state.js";

export interface GenesisSurfaceProperties {
  readonly id: SurfaceId;

  readonly sessionId: ApplicationSessionId;

  readonly size: SurfaceSize;

  readonly pixelFormat: PixelFormat;

  readonly state?: SurfaceState;

  readonly damagedRegions?: readonly DamagedRegion[];

  readonly createdAt: Date;

  readonly updatedAt?: Date;
}

export class GenesisSurface {
  public readonly id: SurfaceId;

  public readonly sessionId: ApplicationSessionId;

  public readonly size: SurfaceSize;

  public readonly pixelFormat: PixelFormat;

  public readonly state: SurfaceState;

  public readonly damagedRegions: readonly DamagedRegion[];

  public readonly createdAt: Date;

  public readonly updatedAt: Date;

  public constructor(properties: GenesisSurfaceProperties) {
    validateSurfaceSize(properties.size);

    const damagedRegions = [...(properties.damagedRegions ?? [])];

    damagedRegions.forEach((region) => {
      validateDamagedRegion(region, properties.size);
    });

    this.id = properties.id;

    this.sessionId = properties.sessionId;

    this.size = Object.freeze({
      ...properties.size,
    });

    this.pixelFormat = properties.pixelFormat;

    this.state = properties.state ?? "created";

    this.damagedRegions = Object.freeze(
      damagedRegions.map((region) =>
        Object.freeze({
          ...region,
        }),
      ),
    );

    this.createdAt = new Date(properties.createdAt);

    this.updatedAt = new Date(properties.updatedAt ?? properties.createdAt);
  }

  public withState(state: SurfaceState, updatedAt: Date): GenesisSurface {
    if (this.state === "destroyed" && state !== "destroyed") {
      throw new Error(`Destroyed surface "${this.id}" cannot transition to "${state}".`);
    }

    return new GenesisSurface({
      ...this.#toProperties(),
      state,
      updatedAt,
    });
  }

  public withSize(size: SurfaceSize, updatedAt: Date): GenesisSurface {
    if (this.state === "destroyed") {
      throw new Error(`Destroyed surface "${this.id}" cannot be resized.`);
    }

    validateSurfaceSize(size);

    return new GenesisSurface({
      ...this.#toProperties(),
      size,
      damagedRegions: [],
      updatedAt,
    });
  }

  public withDamage(regions: readonly DamagedRegion[], updatedAt: Date): GenesisSurface {
    if (this.state === "destroyed") {
      throw new Error(`Destroyed surface "${this.id}" cannot receive damage.`);
    }

    regions.forEach((region) => {
      validateDamagedRegion(region, this.size);
    });

    return new GenesisSurface({
      ...this.#toProperties(),
      damagedRegions: regions,
      updatedAt,
    });
  }

  public addDamage(region: DamagedRegion, updatedAt: Date): GenesisSurface {
    return this.withDamage([...this.damagedRegions, region], updatedAt);
  }

  public clearDamage(updatedAt: Date): GenesisSurface {
    if (this.damagedRegions.length === 0) {
      return this;
    }

    return new GenesisSurface({
      ...this.#toProperties(),
      damagedRegions: [],
      updatedAt,
    });
  }

  #toProperties(): GenesisSurfaceProperties {
    return {
      id: this.id,
      sessionId: this.sessionId,
      size: this.size,
      pixelFormat: this.pixelFormat,
      state: this.state,
      damagedRegions: this.damagedRegions,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
