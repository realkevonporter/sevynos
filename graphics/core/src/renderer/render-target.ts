import type { DisplayId } from "../display/display-id.js";

export interface RenderTargetOptions {
  readonly displayId: DisplayId;

  readonly width: number;

  readonly height: number;

  readonly scaleFactor: number;
}

export class RenderTarget {
  public readonly displayId: DisplayId;

  public readonly width: number;

  public readonly height: number;

  public readonly scaleFactor: number;

  public constructor(options: RenderTargetOptions) {
    if (!Number.isInteger(options.width) || options.width <= 0) {
      throw new RangeError("Render target width must be a positive integer.");
    }

    if (!Number.isInteger(options.height) || options.height <= 0) {
      throw new RangeError("Render target height must be a positive integer.");
    }

    if (!Number.isFinite(options.scaleFactor) || options.scaleFactor <= 0) {
      throw new RangeError("Render target scale factor must be greater than zero.");
    }

    this.displayId = options.displayId;

    this.width = options.width;

    this.height = options.height;

    this.scaleFactor = options.scaleFactor;
  }
}
