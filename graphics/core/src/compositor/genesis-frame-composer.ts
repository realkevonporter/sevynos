import type { DisplayRenderPlan } from "../display/display-render-plan.js";
import type { DisplayRenderPlanner } from "../display/display-render-planner.js";
import type { GenesisScene } from "./genesis-scene.js";

export interface GenesisFrameComposerDependencies {
  readonly createScene: () => GenesisScene;

  readonly displayRenderPlanner: DisplayRenderPlanner;
}

export class GenesisFrameComposer {
  readonly #createScene: () => GenesisScene;

  readonly #displayRenderPlanner: DisplayRenderPlanner;

  public constructor(dependencies: GenesisFrameComposerDependencies) {
    this.#createScene = dependencies.createScene;

    this.#displayRenderPlanner = dependencies.displayRenderPlanner;
  }

  public composeFrame(): readonly DisplayRenderPlan<GenesisScene>[] {
    const scene = this.#createScene();

    return this.#displayRenderPlanner.createRenderPlans(scene);
  }
}
