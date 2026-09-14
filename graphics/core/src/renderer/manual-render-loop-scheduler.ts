import type { RenderLoopTickResult } from "./genesis-render-loop.js";
import type { RenderLoopFrameDriver } from "./render-loop-frame-driver.js";
import type { RenderLoopScheduler } from "./render-loop-scheduler.js";
import {
  RenderLoopSchedulerAlreadyRunningError,
  RenderLoopSchedulerNotRunningError,
  RenderLoopSchedulerStoppedError,
} from "../errors/render-loop-scheduler-errors.js";
import type {
  RenderLoopSchedulerEvent,
  RenderLoopSchedulerEventListener,
} from "./render-loop-scheduler-events.js";
import type { RenderLoopSchedulerState } from "./render-loop-scheduler-state.js";

export interface ManualRenderLoopSchedulerDependencies {
  readonly frameDriver: RenderLoopFrameDriver;

  readonly onEvent?: RenderLoopSchedulerEventListener;
}

export class ManualRenderLoopScheduler implements RenderLoopScheduler {
  readonly #frameDriver: RenderLoopFrameDriver;

  readonly #onEvent: RenderLoopSchedulerEventListener | undefined;

  #state: RenderLoopSchedulerState = "created";

  #nextStepNumber = 1;

  #successfulStepCount = 0;

  #failedStepCount = 0;

  public constructor(dependencies: ManualRenderLoopSchedulerDependencies) {
    this.#frameDriver = dependencies.frameDriver;

    this.#onEvent = dependencies.onEvent;
  }

  public get state(): RenderLoopSchedulerState {
    return this.#state;
  }

  public get stepCount(): number {
    return this.#successfulStepCount + this.#failedStepCount;
  }

  public get successfulStepCount(): number {
    return this.#successfulStepCount;
  }

  public get failedStepCount(): number {
    return this.#failedStepCount;
  }

  public start(): void {
    if (this.#state === "running") {
      throw new RenderLoopSchedulerAlreadyRunningError();
    }

    if (this.#state === "stopped") {
      throw new RenderLoopSchedulerStoppedError();
    }

    this.#state = "running";

    this.#emit({
      type: "started",
    });
  }

  public step(): RenderLoopTickResult {
    this.#assertRunning();

    const stepNumber = this.#nextStepNumber;

    this.#nextStepNumber += 1;

    this.#emit({
      type: "step-started",
      stepNumber,
    });

    try {
      const tickResult = this.#frameDriver.tick();

      this.#successfulStepCount += 1;

      this.#emit({
        type: "step-completed",
        stepNumber,
        tickResult,
      });

      return tickResult;
    } catch (error: unknown) {
      this.#failedStepCount += 1;

      this.#emit({
        type: "step-failed",
        stepNumber,
        error,
      });

      throw error;
    }
  }

  public stop(): void {
    if (this.#state === "stopped") {
      throw new RenderLoopSchedulerStoppedError();
    }

    if (this.#state !== "running") {
      throw new RenderLoopSchedulerNotRunningError();
    }

    this.#state = "stopped";

    this.#emit({
      type: "stopped",

      stepCount: this.stepCount,

      successfulStepCount: this.#successfulStepCount,

      failedStepCount: this.#failedStepCount,
    });
  }

  #assertRunning(): void {
    if (this.#state === "stopped") {
      throw new RenderLoopSchedulerStoppedError();
    }

    if (this.#state !== "running") {
      throw new RenderLoopSchedulerNotRunningError();
    }
  }

  #emit(event: RenderLoopSchedulerEvent): void {
    this.#onEvent?.(event);
  }
}
