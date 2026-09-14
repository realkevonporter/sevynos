import type { HitTestPoint } from "./hit-test-point.js";
import { createHitTestPoint } from "./hit-test-point.js";
import { SceneHitTestResult } from "./scene-hit-test-result.js";

export interface SceneHitTestBounds {
  readonly x: number;

  readonly y: number;

  readonly width: number;

  readonly height: number;
}

export interface SceneHitTestNodeAdapter<TNode> {
  getId(node: TNode): string;

  getBounds(node: TNode): SceneHitTestBounds | undefined;

  getZIndex(node: TNode): number;

  getChildren(node: TNode): readonly TNode[];

  isVisible(node: TNode): boolean;

  acceptsPointerInput(node: TNode): boolean;
}

export interface SceneHitTesterDependencies<TNode> {
  readonly getRootNodes: () => readonly TNode[];

  readonly adapter: SceneHitTestNodeAdapter<TNode>;
}

interface SceneHitCandidate<TNode> {
  readonly node: TNode;

  readonly nodeId: string;

  readonly bounds: SceneHitTestBounds;

  readonly zIndex: number;

  readonly depth: number;

  readonly traversalIndex: number;
}

export class SceneHitTester<TNode> {
  readonly #getRootNodes: () => readonly TNode[];

  readonly #adapter: SceneHitTestNodeAdapter<TNode>;

  public constructor(dependencies: SceneHitTesterDependencies<TNode>) {
    this.#getRootNodes = dependencies.getRootNodes;

    this.#adapter = dependencies.adapter;
  }

  public hitTest(point: HitTestPoint): SceneHitTestResult<TNode> | undefined {
    return this.hitTestAll(point)[0];
  }

  public hitTestAll(point: HitTestPoint): readonly SceneHitTestResult<TNode>[] {
    const validPoint = createHitTestPoint(point);

    const candidates: SceneHitCandidate<TNode>[] = [];

    let traversalIndex = 0;

    for (const rootNode of this.#getRootNodes()) {
      traversalIndex = this.#collectCandidates({
        node: rootNode,

        parentOrigin: {
          x: 0,
          y: 0,
        },

        point: validPoint,

        depth: 0,

        traversalIndex,

        candidates,
      });
    }

    const orderedCandidates = candidates.sort((left, right) => {
      if (left.zIndex !== right.zIndex) {
        return right.zIndex - left.zIndex;
      }

      if (left.depth !== right.depth) {
        return right.depth - left.depth;
      }

      return right.traversalIndex - left.traversalIndex;
    });

    return Object.freeze(
      orderedCandidates.map(
        (candidate) =>
          new SceneHitTestResult({
            node: candidate.node,

            nodeId: candidate.nodeId,

            point: validPoint,

            localPoint: {
              x: validPoint.x - candidate.bounds.x,

              y: validPoint.y - candidate.bounds.y,
            },

            zIndex: candidate.zIndex,

            depth: candidate.depth,
          }),
      ),
    );
  }

  #collectCandidates(options: {
    readonly node: TNode;

    readonly parentOrigin: HitTestPoint;

    readonly point: HitTestPoint;

    readonly depth: number;

    readonly traversalIndex: number;

    readonly candidates: SceneHitCandidate<TNode>[];
  }): number {
    const { node, parentOrigin, point, depth, candidates } = options;

    let traversalIndex = options.traversalIndex;

    if (!this.#adapter.isVisible(node)) {
      return traversalIndex;
    }

    const nodeBounds = this.#adapter.getBounds(node);

    const globalBounds =
      nodeBounds === undefined
        ? undefined
        : {
            x: parentOrigin.x + nodeBounds.x,

            y: parentOrigin.y + nodeBounds.y,

            width: nodeBounds.width,

            height: nodeBounds.height,
          };

    if (globalBounds !== undefined && !this.#containsPoint(globalBounds, point)) {
      return traversalIndex;
    }

    traversalIndex += 1;

    if (globalBounds !== undefined && this.#adapter.acceptsPointerInput(node)) {
      candidates.push({
        node,

        nodeId: this.#adapter.getId(node),

        bounds: globalBounds,

        zIndex: this.#adapter.getZIndex(node),

        depth,

        traversalIndex,
      });
    }

    const childOrigin =
      globalBounds === undefined
        ? parentOrigin
        : {
            x: globalBounds.x,

            y: globalBounds.y,
          };

    for (const child of this.#adapter.getChildren(node)) {
      traversalIndex = this.#collectCandidates({
        node: child,

        parentOrigin: childOrigin,

        point,

        depth: depth + 1,

        traversalIndex,

        candidates,
      });
    }

    return traversalIndex;
  }

  #containsPoint(bounds: SceneHitTestBounds, point: HitTestPoint): boolean {
    return (
      point.x >= bounds.x &&
      point.y >= bounds.y &&
      point.x < bounds.x + bounds.width &&
      point.y < bounds.y + bounds.height
    );
  }
}
