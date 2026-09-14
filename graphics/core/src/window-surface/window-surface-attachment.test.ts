import { describe, expect, it } from "vitest";

import { WindowSurfaceAttachment } from "./window-surface-attachment.js";

const ATTACHED_AT = new Date("2026-07-30T14:00:00.000Z");

const UPDATED_AT = new Date("2026-07-30T14:01:00.000Z");

function createAttachment(): WindowSurfaceAttachment {
  return new WindowSurfaceAttachment({
    id: "window-surface-attachment-1",
    windowId: "window-1",
    surfaceId: "surface-1",
    attachedAt: ATTACHED_AT,
  });
}

describe("WindowSurfaceAttachment", () => {
  it("creates an attachment", () => {
    const attachment = createAttachment();

    expect(attachment.id).toBe("window-surface-attachment-1");

    expect(attachment.windowId).toBe("window-1");

    expect(attachment.surfaceId).toBe("surface-1");

    expect(attachment.attachedAt).toEqual(ATTACHED_AT);

    expect(attachment.updatedAt).toEqual(ATTACHED_AT);
  });

  it("copies date values", () => {
    const attachedAt = new Date(ATTACHED_AT);

    const attachment = new WindowSurfaceAttachment({
      id: "window-surface-attachment-1",
      windowId: "window-1",
      surfaceId: "surface-1",
      attachedAt,
    });

    attachedAt.setFullYear(2030);

    expect(attachment.attachedAt).toEqual(ATTACHED_AT);
  });

  it("replaces a surface immutably", () => {
    const attachment = createAttachment();

    const updated = attachment.withSurface("surface-2", UPDATED_AT);

    expect(updated.id).toBe(attachment.id);

    expect(updated.windowId).toBe(attachment.windowId);

    expect(updated.surfaceId).toBe("surface-2");

    expect(updated.updatedAt).toEqual(UPDATED_AT);

    expect(attachment.surfaceId).toBe("surface-1");
  });

  it("returns the same attachment when the surface is unchanged", () => {
    const attachment = createAttachment();

    expect(attachment.withSurface("surface-1", UPDATED_AT)).toBe(attachment);
  });
});
