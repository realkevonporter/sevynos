import type { WindowSurfaceAttachmentId } from "../window-surface/window-surface-attachment-id.js";

export class WindowSurfaceAttachmentNotFoundError extends Error {
  public readonly attachmentId: WindowSurfaceAttachmentId;

  public constructor(attachmentId: WindowSurfaceAttachmentId) {
    super(`Window surface attachment "${attachmentId}" was not found.`);

    this.name = "WindowSurfaceAttachmentNotFoundError";

    this.attachmentId = attachmentId;
  }
}
