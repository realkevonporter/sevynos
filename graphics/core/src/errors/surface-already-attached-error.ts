import type { SurfaceId } from "../surface/surface-id.js";

export class SurfaceAlreadyAttachedError extends Error {
  public readonly surfaceId: SurfaceId;

  public constructor(surfaceId: SurfaceId) {
    super(`Surface "${surfaceId}" is already attached to a window.`);

    this.name = "SurfaceAlreadyAttachedError";

    this.surfaceId = surfaceId;
  }
}
