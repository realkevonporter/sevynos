import type { SurfaceId } from "../surface/surface-id.js";
import type { GenesisWindowId } from "../window/genesis-window.js";
import type { WindowSurfaceAttachmentId } from "./window-surface-attachment-id.js";

export interface WindowSurfaceAttachmentProperties {
  readonly id: WindowSurfaceAttachmentId;

  readonly windowId: GenesisWindowId;

  readonly surfaceId: SurfaceId;

  readonly attachedAt: Date;

  readonly updatedAt?: Date;
}

export class WindowSurfaceAttachment {
  public readonly id: WindowSurfaceAttachmentId;

  public readonly windowId: GenesisWindowId;

  public readonly surfaceId: SurfaceId;

  public readonly attachedAt: Date;

  public readonly updatedAt: Date;

  public constructor(properties: WindowSurfaceAttachmentProperties) {
    this.id = properties.id;

    this.windowId = properties.windowId;

    this.surfaceId = properties.surfaceId;

    this.attachedAt = new Date(properties.attachedAt);

    this.updatedAt = new Date(properties.updatedAt ?? properties.attachedAt);
  }

  public withSurface(surfaceId: SurfaceId, updatedAt: Date): WindowSurfaceAttachment {
    if (surfaceId === this.surfaceId) {
      return this;
    }

    return new WindowSurfaceAttachment({
      id: this.id,
      windowId: this.windowId,
      surfaceId,
      attachedAt: this.attachedAt,
      updatedAt,
    });
  }
}
