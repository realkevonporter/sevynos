import { describe, expect, it } from "vitest";

import { SurfaceAlreadyAttachedError } from "../errors/surface-already-attached-error.js";
import { WindowAlreadyHasSurfaceError } from "../errors/window-already-has-surface-error.js";
import { WindowSurfaceAttachmentAlreadyExistsError } from "../errors/window-surface-attachment-already-exists-error.js";
import { WindowSurfaceAttachmentNotFoundError } from "../errors/window-surface-attachment-not-found-error.js";
import { WindowSurfaceAttachment } from "./window-surface-attachment.js";
import { WindowSurfaceAttachmentRegistry } from "./window-surface-attachment-registry.js";

const ATTACHED_AT = new Date("2026-07-30T14:00:00.000Z");

const UPDATED_AT = new Date("2026-07-30T14:01:00.000Z");

function createAttachment(
  id: `window-surface-attachment-${string}`,
  windowId: `window-${string}`,
  surfaceId: `surface-${string}`,
): WindowSurfaceAttachment {
  return new WindowSurfaceAttachment({
    id,
    windowId,
    surfaceId,
    attachedAt: ATTACHED_AT,
  });
}

describe("WindowSurfaceAttachmentRegistry", () => {
  it("adds and retrieves an attachment", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    const attachment = createAttachment(
      "window-surface-attachment-1",
      "window-1",
      "surface-1",
    );

    registry.add(attachment);

    expect(registry.get(attachment.id)).toBe(attachment);

    expect(registry.getByWindow("window-1")).toBe(attachment);

    expect(registry.getBySurface("surface-1")).toBe(attachment);

    expect(registry.count()).toBe(1);
  });

  it("rejects duplicate attachment identifiers", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    registry.add(
      createAttachment("window-surface-attachment-1", "window-1", "surface-1"),
    );

    expect(() => {
      registry.add(
        createAttachment("window-surface-attachment-1", "window-2", "surface-2"),
      );
    }).toThrow(WindowSurfaceAttachmentAlreadyExistsError);
  });

  it("rejects attaching two surfaces to one window", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    registry.add(
      createAttachment("window-surface-attachment-1", "window-1", "surface-1"),
    );

    expect(() => {
      registry.add(
        createAttachment("window-surface-attachment-2", "window-1", "surface-2"),
      );
    }).toThrow(WindowAlreadyHasSurfaceError);
  });

  it("rejects attaching one surface to two windows", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    registry.add(
      createAttachment("window-surface-attachment-1", "window-1", "surface-1"),
    );

    expect(() => {
      registry.add(
        createAttachment("window-surface-attachment-2", "window-2", "surface-1"),
      );
    }).toThrow(SurfaceAlreadyAttachedError);
  });

  it("updates an attachment surface", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    const attachment = createAttachment(
      "window-surface-attachment-1",
      "window-1",
      "surface-1",
    );

    registry.add(attachment);

    const updated = attachment.withSurface("surface-2", UPDATED_AT);

    registry.update(updated);

    expect(registry.getByWindow("window-1")).toBe(updated);

    expect(registry.getBySurface("surface-1")).toBeUndefined();

    expect(registry.getBySurface("surface-2")).toBe(updated);
  });

  it("rejects updating an unknown attachment", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    expect(() => {
      registry.update(
        createAttachment("window-surface-attachment-missing", "window-1", "surface-1"),
      );
    }).toThrow(WindowSurfaceAttachmentNotFoundError);
  });

  it("rejects changing an attachment window", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    registry.add(
      createAttachment("window-surface-attachment-1", "window-1", "surface-1"),
    );

    const invalid = createAttachment(
      "window-surface-attachment-1",
      "window-2",
      "surface-2",
    );

    expect(() => {
      registry.update(invalid);
    }).toThrow(
      'Window surface attachment "window-surface-attachment-1" cannot change its window.',
    );
  });

  it("rejects replacing with an already attached surface", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    const first = createAttachment(
      "window-surface-attachment-1",
      "window-1",
      "surface-1",
    );

    const second = createAttachment(
      "window-surface-attachment-2",
      "window-2",
      "surface-2",
    );

    registry.add(first);
    registry.add(second);

    expect(() => {
      registry.update(first.withSurface("surface-2", UPDATED_AT));
    }).toThrow(SurfaceAlreadyAttachedError);
  });

  it("removes an attachment and its indexes", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    const attachment = createAttachment(
      "window-surface-attachment-1",
      "window-1",
      "surface-1",
    );

    registry.add(attachment);

    const removed = registry.remove(attachment.id);

    expect(removed).toBe(attachment);

    expect(registry.get(attachment.id)).toBeUndefined();

    expect(registry.getByWindow("window-1")).toBeUndefined();

    expect(registry.getBySurface("surface-1")).toBeUndefined();

    expect(registry.count()).toBe(0);
  });

  it("rejects removing an unknown attachment", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    expect(() => {
      registry.remove("window-surface-attachment-missing");
    }).toThrow(WindowSurfaceAttachmentNotFoundError);
  });

  it("lists attachments in insertion order", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    const first = createAttachment(
      "window-surface-attachment-1",
      "window-1",
      "surface-1",
    );

    const second = createAttachment(
      "window-surface-attachment-2",
      "window-2",
      "surface-2",
    );

    registry.add(first);
    registry.add(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("does not expose its internal collection", () => {
    const registry = new WindowSurfaceAttachmentRegistry();

    registry.add(
      createAttachment("window-surface-attachment-1", "window-1", "surface-1"),
    );

    expect(registry.list()).not.toBe(registry.list());

    expect(registry.count()).toBe(1);
  });
});
