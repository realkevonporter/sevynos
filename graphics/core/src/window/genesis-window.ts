import { InvalidWindowStateTransitionError } from "../errors/invalid-window-state-transition-error.js";

import type { ApplicationSessionId } from "../application-session-id.js";
import type { WindowBounds } from "./window-bounds.js";
import type { WindowState } from "./window-state.js";
import { canTransitionWindowState } from "./window-state-transition.js";

export type GenesisWindowId = string;

export interface GenesisWindowOptions {
  readonly id: GenesisWindowId;
  readonly sessionId: ApplicationSessionId;
  readonly title: string;
  readonly bounds: WindowBounds;
  readonly state?: WindowState;
  readonly zIndex?: number;
  readonly createdAt: Date;
  readonly updatedAt?: Date;
}

export class GenesisWindow {
  public readonly id: GenesisWindowId;
  public readonly sessionId: ApplicationSessionId;
  public readonly title: string;
  public readonly bounds: WindowBounds;
  public readonly state: WindowState;
  public readonly zIndex: number;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  public constructor(options: GenesisWindowOptions) {
    this.id = options.id;
    this.sessionId = options.sessionId;
    this.title = options.title;

    this.bounds = {
      ...options.bounds,
    };

    this.state = options.state ?? "created";

    this.zIndex = options.zIndex ?? 0;

    this.createdAt = new Date(options.createdAt);

    this.updatedAt = new Date(options.updatedAt ?? options.createdAt);
  }

  public withBounds(bounds: WindowBounds, updatedAt: Date): GenesisWindow {
    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: this.title,
      bounds,
      state: this.state,
      zIndex: this.zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }

  public transitionTo(
    targetState: WindowState,
    updatedAt: Date = new Date(),
  ): GenesisWindow {
    if (!canTransitionWindowState(this.state, targetState)) {
      throw new InvalidWindowStateTransitionError(this.id, this.state, targetState);
    }

    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: this.title,
      bounds: this.bounds,
      state: targetState,
      zIndex: this.zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }

  public moveTo(x: number, y: number, updatedAt: Date = new Date()): GenesisWindow {
    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: this.title,
      bounds: {
        ...this.bounds,
        x,
        y,
      },
      state: this.state,
      zIndex: this.zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }

  public resizeTo(
    width: number,
    height: number,
    updatedAt: Date = new Date(),
  ): GenesisWindow {
    if (width <= 0 || height <= 0) {
      throw new RangeError("Window width and height must be greater than zero.");
    }

    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: this.title,
      bounds: {
        ...this.bounds,
        width,
        height,
      },
      state: this.state,
      zIndex: this.zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }

  public withZIndex(zIndex: number, updatedAt: Date = new Date()): GenesisWindow {
    if (!Number.isSafeInteger(zIndex)) {
      throw new TypeError("Window z-index must be a safe integer.");
    }

    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: this.title,
      bounds: this.bounds,
      state: this.state,
      zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }

  public withTitle(title: string, updatedAt: Date = new Date()): GenesisWindow {
    const normalizedTitle = title.trim();

    if (normalizedTitle.length === 0) {
      throw new TypeError("Window title cannot be empty.");
    }

    return new GenesisWindow({
      id: this.id,
      sessionId: this.sessionId,
      title: normalizedTitle,
      bounds: this.bounds,
      state: this.state,
      zIndex: this.zIndex,
      createdAt: this.createdAt,
      updatedAt,
    });
  }
}
