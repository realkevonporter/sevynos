import type { GenesisWindow, GenesisWindowId } from "@sevynos/graphics";
import type { HitTestPoint } from "./hit-test-point.js";

export interface WindowHitTestResultOptions {
  readonly point: HitTestPoint;

  readonly window: GenesisWindow;

  readonly localPoint: HitTestPoint;
}

export class WindowHitTestResult {
  public readonly point: HitTestPoint;

  public readonly window: GenesisWindow;

  public readonly windowId: GenesisWindowId;

  public readonly localPoint: HitTestPoint;

  public constructor(options: WindowHitTestResultOptions) {
    this.point = Object.freeze({
      x: options.point.x,
      y: options.point.y,
    });

    this.window = options.window;

    this.windowId = options.window.id;

    this.localPoint = Object.freeze({
      x: options.localPoint.x,
      y: options.localPoint.y,
    });

    Object.freeze(this);
  }
}
