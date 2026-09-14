import { SurfaceAlreadyAttachedError } from "../errors/surface-already-attached-error.js";
import { WindowAlreadyHasSurfaceError } from "../errors/window-already-has-surface-error.js";
import { WindowSurfaceAttachmentAlreadyExistsError } from "../errors/window-surface-attachment-already-exists-error.js";
import { WindowSurfaceAttachmentNotFoundError } from "../errors/window-surface-attachment-not-found-error.js";
import type { SurfaceId } from "../surface/surface-id.js";
import type { WindowSurfaceAttachment } from "./window-surface-attachment.js";
import type { WindowSurfaceAttachmentId } from "./window-surface-attachment-id.js";
import type { GenesisWindowId } from "../window/genesis-window.js";

export class WindowSurfaceAttachmentRegistry {
  readonly #attachments = new Map<WindowSurfaceAttachmentId, WindowSurfaceAttachment>();

  readonly #attachmentIdsByWindow = new Map<GenesisWindowId, WindowSurfaceAttachmentId>();

  readonly #attachmentIdsBySurface = new Map<SurfaceId, WindowSurfaceAttachmentId>();

  public add(attachment: WindowSurfaceAttachment): void {
    if (this.#attachments.has(attachment.id)) {
      throw new WindowSurfaceAttachmentAlreadyExistsError(attachment.id);
    }

    if (this.#attachmentIdsByWindow.has(attachment.windowId)) {
      throw new WindowAlreadyHasSurfaceError(attachment.windowId);
    }

    if (this.#attachmentIdsBySurface.has(attachment.surfaceId)) {
      throw new SurfaceAlreadyAttachedError(attachment.surfaceId);
    }

    this.#attachments.set(attachment.id, attachment);

    this.#attachmentIdsByWindow.set(attachment.windowId, attachment.id);

    this.#attachmentIdsBySurface.set(attachment.surfaceId, attachment.id);
  }

  public update(attachment: WindowSurfaceAttachment): void {
    const existing = this.#attachments.get(attachment.id);

    if (!existing) {
      throw new WindowSurfaceAttachmentNotFoundError(attachment.id);
    }

    if (attachment.windowId !== existing.windowId) {
      throw new Error(
        `Window surface attachment "${attachment.id}" cannot change its window.`,
      );
    }

    const surfaceAttachmentId = this.#attachmentIdsBySurface.get(attachment.surfaceId);

    if (surfaceAttachmentId && surfaceAttachmentId !== attachment.id) {
      throw new SurfaceAlreadyAttachedError(attachment.surfaceId);
    }

    if (existing.surfaceId !== attachment.surfaceId) {
      this.#attachmentIdsBySurface.delete(existing.surfaceId);

      this.#attachmentIdsBySurface.set(attachment.surfaceId, attachment.id);
    }

    this.#attachments.set(attachment.id, attachment);
  }

  public remove(attachmentId: WindowSurfaceAttachmentId): WindowSurfaceAttachment {
    const attachment = this.#attachments.get(attachmentId);

    if (!attachment) {
      throw new WindowSurfaceAttachmentNotFoundError(attachmentId);
    }

    this.#attachments.delete(attachmentId);

    this.#attachmentIdsByWindow.delete(attachment.windowId);

    this.#attachmentIdsBySurface.delete(attachment.surfaceId);

    return attachment;
  }

  public get(
    attachmentId: WindowSurfaceAttachmentId,
  ): WindowSurfaceAttachment | undefined {
    return this.#attachments.get(attachmentId);
  }

  public getByWindow(windowId: GenesisWindowId): WindowSurfaceAttachment | undefined {
    const attachmentId = this.#attachmentIdsByWindow.get(windowId);

    if (!attachmentId) {
      return undefined;
    }

    return this.#attachments.get(attachmentId);
  }

  public getBySurface(surfaceId: SurfaceId): WindowSurfaceAttachment | undefined {
    const attachmentId = this.#attachmentIdsBySurface.get(surfaceId);

    if (!attachmentId) {
      return undefined;
    }

    return this.#attachments.get(attachmentId);
  }

  public has(attachmentId: WindowSurfaceAttachmentId): boolean {
    return this.#attachments.has(attachmentId);
  }

  public list(): readonly WindowSurfaceAttachment[] {
    return [...this.#attachments.values()];
  }

  public count(): number {
    return this.#attachments.size;
  }
}
