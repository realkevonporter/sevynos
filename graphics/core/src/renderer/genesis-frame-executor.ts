import type { DisplayRenderPlan } from "../display/display-render-plan.js";
import type { GenesisRenderer } from "./genesis-renderer.js";
import { FrameExecutionResult, FrameRenderFailure } from "./frame-execution-result.js";
import type { RenderResult } from "./render-result.js";

export interface GenesisFrameExecutorDependencies<TScene> {
  readonly createRenderPlans: () => readonly DisplayRenderPlan<TScene>[];

  readonly renderer: GenesisRenderer<TScene>;

  readonly now: () => Date;
}

export class GenesisFrameExecutor<TScene> {
  readonly #createRenderPlans: () => readonly DisplayRenderPlan<TScene>[];

  readonly #renderer: GenesisRenderer<TScene>;

  readonly #now: () => Date;

  #nextExecutionNumber = 1;

  public constructor(dependencies: GenesisFrameExecutorDependencies<TScene>) {
    this.#createRenderPlans = dependencies.createRenderPlans;

    this.#renderer = dependencies.renderer;

    this.#now = dependencies.now;
  }

  public executeFrame(): FrameExecutionResult {
    const executionNumber = this.#nextExecutionNumber;

    const startedAt = this.#now();

    const plans = this.#createRenderPlans();

    const renderResults: RenderResult[] = [];

    const failures: FrameRenderFailure[] = [];

    for (const plan of plans) {
      try {
        const result = this.#renderer.render(plan);

        renderResults.push(result);
      } catch (error: unknown) {
        failures.push(
          new FrameRenderFailure({
            displayId: plan.displayId,

            error,
          }),
        );
      }
    }

    const completedAt = this.#now();

    const result = new FrameExecutionResult({
      executionNumber,

      startedAt,

      completedAt,

      renderResults,

      failures,
    });

    this.#nextExecutionNumber += 1;

    return result;
  }
}
