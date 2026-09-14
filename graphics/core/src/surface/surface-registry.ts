import type { ApplicationSessionId } from "../application-session-id.js";
import { SurfaceAlreadyExistsError } from "../errors/surface-already-exists-error.js";
import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import type { GenesisSurface } from "./genesis-surface.js";
import type { SurfaceId } from "./surface-id.js";

export class SurfaceRegistry {
  readonly #surfaces = new Map<SurfaceId, GenesisSurface>();

  public add(surface: GenesisSurface): void {
    if (this.#surfaces.has(surface.id)) {
      throw new SurfaceAlreadyExistsError(surface.id);
    }

    this.#surfaces.set(surface.id, surface);
  }

  public update(surface: GenesisSurface): void {
    if (!this.#surfaces.has(surface.id)) {
      throw new SurfaceNotFoundError(surface.id);
    }

    this.#surfaces.set(surface.id, surface);
  }

  public remove(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#surfaces.get(surfaceId);

    if (!surface) {
      throw new SurfaceNotFoundError(surfaceId);
    }

    this.#surfaces.delete(surfaceId);

    return surface;
  }

  public get(surfaceId: SurfaceId): GenesisSurface | undefined {
    return this.#surfaces.get(surfaceId);
  }

  public has(surfaceId: SurfaceId): boolean {
    return this.#surfaces.has(surfaceId);
  }

  public list(): readonly GenesisSurface[] {
    return [...this.#surfaces.values()];
  }

  public listBySession(sessionId: ApplicationSessionId): readonly GenesisSurface[] {
    return this.list().filter((surface) => surface.sessionId === sessionId);
  }

  public count(): number {
    return this.#surfaces.size;
  }
}
