import { SurfaceNotFoundError } from "../errors/surface-not-found-error.js";
import { WindowNotFoundError } from "../errors/window-not-found-error.js";
import { WindowSurfaceAttachmentForSurfaceNotFoundError } from "../errors/window-surface-attachment-for-surface-not-found-error.js";
import { WindowSurfaceAttachmentForWindowNotFoundError } from "../errors/window-surface-attachment-for-window-not-found-error.js";
import { WindowSurfaceAttachmentNotFoundError } from "../errors/window-surface-attachment-not-found-error.js";
import { WindowSurfaceSessionMismatchError } from "../errors/window-surface-session-mismatch-error.js";
import type { GenesisSurface } from "../surface/genesis-surface.js";
import type { SurfaceId } from "../surface/surface-id.js";
import type { SurfaceRegistry } from "../surface/surface-registry.js";
import type { GenesisWindow, GenesisWindowId } from "../window/genesis-window.js";
import type { WindowRegistry } from "../window/window-registry.js";
import { WindowSurfaceAttachment } from "./window-surface-attachment.js";
import type { WindowSurfaceAttachmentId } from "./window-surface-attachment-id.js";
import type { WindowSurfaceAttachmentRegistry } from "./window-surface-attachment-registry.js";

export interface AttachSurfaceRequest {
  readonly windowId: GenesisWindowId;

  readonly surfaceId: SurfaceId;
}

export interface GenesisWindowSurfaceManagerDependencies {
  readonly windows: WindowRegistry;

  readonly surfaces: SurfaceRegistry;

  readonly attachments: WindowSurfaceAttachmentRegistry;

  readonly createAttachmentId: () => WindowSurfaceAttachmentId;

  readonly now: () => Date;
}

export class GenesisWindowSurfaceManager {
  readonly #windows: WindowRegistry;

  readonly #surfaces: SurfaceRegistry;

  readonly #attachments: WindowSurfaceAttachmentRegistry;

  readonly #createAttachmentId: () => WindowSurfaceAttachmentId;

  readonly #now: () => Date;

  public constructor(dependencies: GenesisWindowSurfaceManagerDependencies) {
    this.#windows = dependencies.windows;

    this.#surfaces = dependencies.surfaces;

    this.#attachments = dependencies.attachments;

    this.#createAttachmentId = dependencies.createAttachmentId;

    this.#now = dependencies.now;
  }

  public attachSurface(request: AttachSurfaceRequest): WindowSurfaceAttachment {
    const window = this.#requireWindow(request.windowId);

    const surface = this.#requireSurface(request.surfaceId);

    this.#validateSameSession(window, surface);

    const attachedAt = this.#now();

    const attachment = new WindowSurfaceAttachment({
      id: this.#createAttachmentId(),
      windowId: window.id,
      surfaceId: surface.id,
      attachedAt,
      updatedAt: attachedAt,
    });

    this.#attachments.add(attachment);

    return attachment;
  }

  public replaceSurface(
    windowId: GenesisWindowId,
    surfaceId: SurfaceId,
  ): WindowSurfaceAttachment {
    const window = this.#requireWindow(windowId);

    const surface = this.#requireSurface(surfaceId);

    this.#validateSameSession(window, surface);

    const attachment = this.#attachments.getByWindow(windowId);

    if (!attachment) {
      throw new WindowSurfaceAttachmentForWindowNotFoundError(windowId);
    }

    const updatedAttachment = attachment.withSurface(surfaceId, this.#now());

    if (updatedAttachment === attachment) {
      return attachment;
    }

    this.#attachments.update(updatedAttachment);

    return updatedAttachment;
  }

  public detachSurfaceFromWindow(windowId: GenesisWindowId): WindowSurfaceAttachment {
    this.#requireWindow(windowId);

    const attachment = this.#attachments.getByWindow(windowId);

    if (!attachment) {
      throw new WindowSurfaceAttachmentForWindowNotFoundError(windowId);
    }

    return this.#attachments.remove(attachment.id);
  }

  public detachSurface(surfaceId: SurfaceId): WindowSurfaceAttachment {
    this.#requireSurface(surfaceId);

    const attachment = this.#attachments.getBySurface(surfaceId);

    if (!attachment) {
      throw new WindowSurfaceAttachmentForSurfaceNotFoundError(surfaceId);
    }

    return this.#attachments.remove(attachment.id);
  }

  public getAttachment(attachmentId: WindowSurfaceAttachmentId): WindowSurfaceAttachment {
    const attachment = this.#attachments.get(attachmentId);

    if (!attachment) {
      throw new WindowSurfaceAttachmentNotFoundError(attachmentId);
    }

    return attachment;
  }

  public getWindowAttachment(
    windowId: GenesisWindowId,
  ): WindowSurfaceAttachment | undefined {
    return this.#attachments.getByWindow(windowId);
  }

  public getSurfaceAttachment(surfaceId: SurfaceId): WindowSurfaceAttachment | undefined {
    return this.#attachments.getBySurface(surfaceId);
  }

  public listAttachments(): readonly WindowSurfaceAttachment[] {
    return this.#attachments.list();
  }

  #requireWindow(windowId: GenesisWindowId): GenesisWindow {
    const window = this.#windows.get(windowId);

    if (!window) {
      throw new WindowNotFoundError(windowId);
    }

    return window;
  }

  #requireSurface(surfaceId: SurfaceId): GenesisSurface {
    const surface = this.#surfaces.get(surfaceId);

    if (!surface) {
      throw new SurfaceNotFoundError(surfaceId);
    }

    return surface;
  }

  #validateSameSession(window: GenesisWindow, surface: GenesisSurface): void {
    if (window.sessionId === surface.sessionId) {
      return;
    }

    throw new WindowSurfaceSessionMismatchError({
      windowId: window.id,
      windowSessionId: window.sessionId,
      surfaceId: surface.id,
      surfaceSessionId: surface.sessionId,
    });
  }
}
