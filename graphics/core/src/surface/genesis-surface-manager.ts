import type { ApplicationSessionId } from "../application-session-id.js";
import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import type { DamagedRegion } from "./damaged-region.js";
import { GenesisSurface } from "./genesis-surface.js";
import type { PixelFormat } from "./pixel-format.js";
import type { SurfaceId } from "./surface-id.js";
import type { SurfaceSize } from "./surface-size.js";
import { SurfaceRegistry } from "./surface-registry.js";

export interface CreateSurfaceRequest {
  readonly sessionId: ApplicationSessionId;

  readonly size: SurfaceSize;

  readonly pixelFormat: PixelFormat;
}

export interface GenesisSurfaceManagerDependencies {
  readonly surfaces: SurfaceRegistry;

  readonly createSurfaceId: () => SurfaceId;

  readonly now: () => Date;
}

export class GenesisSurfaceManager {
  readonly #surfaces: SurfaceRegistry;

  readonly #createSurfaceId: () => SurfaceId;

  readonly #now: () => Date;

  public constructor(dependencies: GenesisSurfaceManagerDependencies) {
    this.#surfaces = dependencies.surfaces;

    this.#createSurfaceId = dependencies.createSurfaceId;

    this.#now = dependencies.now;
  }

  public createSurface(request: CreateSurfaceRequest): GenesisSurface {
    const createdAt = this.#now();

    const surface = new GenesisSurface({
      id: this.#createSurfaceId(),
      sessionId: request.sessionId,
      size: request.size,
      pixelFormat: request.pixelFormat,
      state: "created",
      damagedRegions: [],
      createdAt,
      updatedAt: createdAt,
    });

    this.#surfaces.add(surface);

    return surface;
  }

  public getSurface(surfaceId: SurfaceId): GenesisSurface {
    return this.#requireSurface(surfaceId);
  }

  public listSurfaces(): readonly GenesisSurface[] {
    return this.#surfaces.list();
  }

  public listSessionSurfaces(sessionId: ApplicationSessionId): readonly GenesisSurface[] {
    return this.#surfaces.listBySession(sessionId);
  }

  public readySurface(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    if (surface.state === "ready") {
      return surface;
    }

    const readySurface = surface.withState("ready", this.#now());

    this.#surfaces.update(readySurface);

    return readySurface;
  }

  public resizeSurface(surfaceId: SurfaceId, size: SurfaceSize): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    const updatedAt = this.#now();

    const resizedSurface = surface.withSize(size, updatedAt).withDamage(
      [
        {
          x: 0,
          y: 0,
          width: size.width,
          height: size.height,
        },
      ],
      updatedAt,
    );

    this.#surfaces.update(resizedSurface);

    return resizedSurface;
  }

  public damageSurface(surfaceId: SurfaceId, region: DamagedRegion): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    const damagedSurface = surface.addDamage(region, this.#now());

    this.#surfaces.update(damagedSurface);

    return damagedSurface;
  }

  public replaceDamage(
    surfaceId: SurfaceId,
    regions: readonly DamagedRegion[],
  ): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    const damagedSurface = surface.withDamage(regions, this.#now());

    this.#surfaces.update(damagedSurface);

    return damagedSurface;
  }

  public clearSurfaceDamage(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    if (surface.damagedRegions.length === 0) {
      return surface;
    }

    const clearedSurface = surface.clearDamage(this.#now());

    this.#surfaces.update(clearedSurface);

    return clearedSurface;
  }

  public destroySurface(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#requireSurface(surfaceId);

    const destroyedSurface = surface.withState("destroyed", this.#now());

    this.#surfaces.update(destroyedSurface);

    this.#surfaces.remove(surfaceId);

    return destroyedSurface;
  }

  public destroySessionSurfaces(
    sessionId: ApplicationSessionId,
  ): readonly GenesisSurface[] {
    const surfaces = this.#surfaces.listBySession(sessionId);

    return surfaces.map((surface) => this.destroySurface(surface.id));
  }

  #requireSurface(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#surfaces.get(surfaceId);

    if (!surface) {
      throw new SurfaceNotFoundError(surfaceId);
    }

    return surface;
  }
}
