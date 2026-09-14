import type { SurfaceId } from "../surface/surface-id.js";

export class WindowSurfaceAttachmentForSurfaceNotFoundError extends Error {
  public readonly surfaceId: SurfaceId;

  public constructor(surfaceId: SurfaceId) {
    super(`No window attachment was found for surface "${surfaceId}".`);

    this.name = "WindowSurfaceAttachmentForSurfaceNotFoundError";

    this.surfaceId = surfaceId;
  }
}
