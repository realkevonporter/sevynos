import type { DisplayBounds } from "./display-bounds.js";
import type { DisplayId } from "./display-id.js";
import type { DisplayMode } from "./display-mode.js";
import type { DisplayOrientation } from "./display-orientation.js";

export interface DisplayRenderPlanOptions<TScene> {
  readonly displayId: DisplayId;

  readonly displayBounds: DisplayBounds;

  readonly displayMode: DisplayMode;

  readonly scaleFactor: number;

  readonly orientation: DisplayOrientation;

  readonly scene: TScene;

  readonly createdAt: Date;
}

export class DisplayRenderPlan<TScene> {
  public readonly displayId: DisplayId;

  public readonly displayBounds: DisplayBounds;

  public readonly displayMode: DisplayMode;

  public readonly scaleFactor: number;

  public readonly orientation: DisplayOrientation;

  public readonly scene: TScene;

  public readonly createdAt: Date;

  public constructor(options: DisplayRenderPlanOptions<TScene>) {
    this.displayId = options.displayId;

    this.displayBounds = {
      ...options.displayBounds,
    };

    this.displayMode = {
      ...options.displayMode,
    };

    this.scaleFactor = options.scaleFactor;

    this.orientation = options.orientation;

    this.scene = options.scene;

    this.createdAt = new Date(options.createdAt);
  }

  public containsPoint(x: number, y: number): boolean {
    return (
      x >= this.displayBounds.x &&
      y >= this.displayBounds.y &&
      x < this.displayBounds.x + this.displayBounds.width &&
      y < this.displayBounds.y + this.displayBounds.height
    );
  }

  public toDisplayCoordinates(
    x: number,
    y: number,
  ): {
    readonly x: number;

    readonly y: number;
  } {
    return {
      x: x - this.displayBounds.x,

      y: y - this.displayBounds.y,
    };
  }

  public toPhysicalCoordinates(
    x: number,
    y: number,
  ): {
    readonly x: number;

    readonly y: number;
  } {
    const displayCoordinates = this.toDisplayCoordinates(x, y);

    return {
      x: displayCoordinates.x * this.scaleFactor,

      y: displayCoordinates.y * this.scaleFactor,
    };
  }
}
