import type { DisplayRegistry } from "./display-registry.js";
import { DisplayRenderPlan } from "./display-render-plan.js";

export interface DisplayRenderPlannerDependencies {
  readonly displays: DisplayRegistry;

  readonly now: () => Date;
}

export class DisplayRenderPlanner {
  readonly #displays: DisplayRegistry;

  readonly #now: () => Date;

  public constructor(dependencies: DisplayRenderPlannerDependencies) {
    this.#displays = dependencies.displays;

    this.#now = dependencies.now;
  }

  public createRenderPlans<TScene>(scene: TScene): readonly DisplayRenderPlan<TScene>[] {
    const createdAt = this.#now();

    return this.#displays.listByState("active").map(
      (display) =>
        new DisplayRenderPlan({
          displayId: display.id,

          displayBounds: display.bounds,

          displayMode: display.mode,

          scaleFactor: display.scaleFactor,

          orientation: display.orientation,

          scene,

          createdAt,
        }),
    );
  }
}
