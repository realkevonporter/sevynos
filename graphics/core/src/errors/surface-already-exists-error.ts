import type { SurfaceId } from "../surface/surface-id.js";

export class SurfaceAlreadyExistsError extends Error {
  public readonly surfaceId: SurfaceId;

  public constructor(surfaceId: SurfaceId) {
    super(`Surface "${surfaceId}" already exists.`);

    this.name = "SurfaceAlreadyExistsError";

    this.surfaceId = surfaceId;
  }
}
