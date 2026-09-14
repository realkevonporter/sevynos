import type { GenesisWindow } from "@sevynos/graphics";
import type { HitTestPoint } from "./hit-test-point.js";
import { createHitTestPoint } from "./hit-test-point.js";
import { WindowHitTestResult } from "./window-hit-test-result.js";

export interface WindowHitTesterDependencies {
  readonly listWindows: () => readonly GenesisWindow[];
}

export class WindowHitTester {
  readonly #listWindows: () => readonly GenesisWindow[];

  public constructor(dependencies: WindowHitTesterDependencies) {
    this.#listWindows = dependencies.listWindows;
  }

  public hitTest(point: HitTestPoint): WindowHitTestResult | undefined {
    const validPoint = createHitTestPoint(point);

    const windows = this.#listWindows();

    const target = windows
      .filter(
        (window) => this.#isEligible(window) && this.#containsPoint(window, validPoint),
      )
      .sort((left, right) => {
        if (left.zIndex !== right.zIndex) {
          return right.zIndex - left.zIndex;
        }

        return right.id.localeCompare(left.id);
      })[0];

    if (target === undefined) {
      return undefined;
    }

    return new WindowHitTestResult({
      point: validPoint,

      window: target,

      localPoint: {
        x: validPoint.x - target.bounds.x,

        y: validPoint.y - target.bounds.y,
      },
    });
  }

  public hitTestAll(point: HitTestPoint): readonly WindowHitTestResult[] {
    const validPoint = createHitTestPoint(point);

    return Object.freeze(
      this.#listWindows()
        .filter(
          (window) => this.#isEligible(window) && this.#containsPoint(window, validPoint),
        )
        .sort((left, right) => {
          if (left.zIndex !== right.zIndex) {
            return right.zIndex - left.zIndex;
          }

          return right.id.localeCompare(left.id);
        })
        .map(
          (window) =>
            new WindowHitTestResult({
              point: validPoint,

              window,

              localPoint: {
                x: validPoint.x - window.bounds.x,

                y: validPoint.y - window.bounds.y,
              },
            }),
        ),
    );
  }

  #isEligible(window: GenesisWindow): boolean {
    return window.state === "visible" || window.state === "focused";
  }

  #containsPoint(window: GenesisWindow, point: HitTestPoint): boolean {
    const { x, y, width, height } = window.bounds;

    return point.x >= x && point.y >= y && point.x < x + width && point.y < y + height;
  }
}
