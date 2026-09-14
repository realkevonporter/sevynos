import type { SurfaceId } from "../surface/surface-id.js";

export class SurfaceNotFoundError extends Error {
  public readonly surfaceId: SurfaceId;

  public constructor(surfaceId: SurfaceId) {
    super(`Surface "${surfaceId}" was not found.`);

    this.name = "SurfaceNotFoundError";

    this.surfaceId = surfaceId;
  }
}
