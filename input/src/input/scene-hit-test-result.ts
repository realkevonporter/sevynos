import type { HitTestPoint } from "./hit-test-point.js";

export interface SceneHitTestResultOptions<TNode> {
  readonly node: TNode;

  readonly nodeId: string;

  readonly point: HitTestPoint;

  readonly localPoint: HitTestPoint;

  readonly zIndex: number;

  readonly depth: number;
}

export class SceneHitTestResult<TNode> {
  public readonly node: TNode;

  public readonly nodeId: string;

  public readonly point: HitTestPoint;

  public readonly localPoint: HitTestPoint;

  public readonly zIndex: number;

  public readonly depth: number;

  public constructor(options: SceneHitTestResultOptions<TNode>) {
    this.node = options.node;

    this.nodeId = options.nodeId;

    this.point = Object.freeze({
      x: options.point.x,

      y: options.point.y,
    });

    this.localPoint = Object.freeze({
      x: options.localPoint.x,

      y: options.localPoint.y,
    });

    this.zIndex = options.zIndex;

    this.depth = options.depth;

    Object.freeze(this);
  }
}
