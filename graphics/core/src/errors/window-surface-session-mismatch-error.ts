import type { ApplicationSessionId } from "../application-session-id.js";
import type { SurfaceId } from "../surface/surface-id.js";
import type { GenesisWindowId } from "../window/genesis-window.js";

export class WindowSurfaceSessionMismatchError extends Error {
  public readonly windowId: GenesisWindowId;

  public readonly windowSessionId: ApplicationSessionId;

  public readonly surfaceId: SurfaceId;

  public readonly surfaceSessionId: ApplicationSessionId;

  public constructor(properties: {
    readonly windowId: GenesisWindowId;

    readonly windowSessionId: ApplicationSessionId;

    readonly surfaceId: SurfaceId;

    readonly surfaceSessionId: ApplicationSessionId;
  }) {
    super(
      `Window "${properties.windowId}" and surface "${properties.surfaceId}" belong to different application sessions.`,
    );

    this.name = "WindowSurfaceSessionMismatchError";

    this.windowId = properties.windowId;

    this.windowSessionId = properties.windowSessionId;

    this.surfaceId = properties.surfaceId;

    this.surfaceSessionId = properties.surfaceSessionId;
  }
}
