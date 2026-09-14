import type { WindowBounds } from "@sevynos/graphics";
import type { HitTestPoint } from "./hit-test-point.js";
import type { WindowResizeEdge } from "./window-resize-edge.js";

export interface WindowResizeEdgeDetectorOptions {
  readonly borderSize: number;
}

export class WindowResizeEdgeDetector {
  readonly #borderSize: number;

  public constructor(options: WindowResizeEdgeDetectorOptions) {
    if (!Number.isFinite(options.borderSize) || options.borderSize <= 0) {
      throw new RangeError("Window resize border size must be a positive finite number.");
    }

    this.#borderSize = options.borderSize;
  }

  public detect(point: HitTestPoint, bounds: WindowBounds): WindowResizeEdge | undefined {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new RangeError("Window resize point must contain finite coordinates.");
    }

    const localX = point.x - bounds.x;

    const localY = point.y - bounds.y;

    const inside =
      localX >= 0 && localY >= 0 && localX < bounds.width && localY < bounds.height;

    if (!inside) {
      return undefined;
    }

    const nearLeft = localX < this.#borderSize;

    const nearRight = localX >= bounds.width - this.#borderSize;

    const nearTop = localY < this.#borderSize;

    const nearBottom = localY >= bounds.height - this.#borderSize;

    if (nearTop && nearLeft) {
      return "top-left";
    }

    if (nearTop && nearRight) {
      return "top-right";
    }

    if (nearBottom && nearLeft) {
      return "bottom-left";
    }

    if (nearBottom && nearRight) {
      return "bottom-right";
    }

    if (nearTop) {
      return "top";
    }

    if (nearRight) {
      return "right";
    }

    if (nearBottom) {
      return "bottom";
    }

    if (nearLeft) {
      return "left";
    }

    return undefined;
  }
}
