import type { WindowSurfaceAttachmentId } from "../window-surface/window-surface-attachment-id.js";

export class WindowSurfaceAttachmentAlreadyExistsError extends Error {
  public readonly attachmentId: WindowSurfaceAttachmentId;

  public constructor(attachmentId: WindowSurfaceAttachmentId) {
    super(`Window surface attachment "${attachmentId}" already exists.`);

    this.name = "WindowSurfaceAttachmentAlreadyExistsError";

    this.attachmentId = attachmentId;
  }
}
