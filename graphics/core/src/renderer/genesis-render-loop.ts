import type { FrameExecutionResult } from "./frame-execution-result.js";
import type { RenderLoopEvent, RenderLoopEventListener } from "./render-loop-events.js";
import {
  RenderLoopAlreadyRunningError,
  RenderLoopNotRunningError,
  RenderLoopStoppedError,
} from "../errors/render-loop-errors.js";
import type { RenderLoopState } from "./render-loop-state.js";

import type { RenderLoopFrameDriver } from "./render-loop-frame-driver.js";

export interface GenesisRenderLoopDependencies {
  readonly executeFrame: () => FrameExecutionResult;

  readonly onEvent?: RenderLoopEventListener;
}

export interface RenderLoopTickResult {
  readonly tickNumber: number;

  readonly executed: boolean;

  readonly result?: FrameExecutionResult;

  readonly error?: unknown;
}

export class GenesisRenderLoop implements RenderLoopFrameDriver {
  readonly #executeFrame: () => FrameExecutionResult;

  readonly #onEvent: RenderLoopEventListener | undefined;

  #state: RenderLoopState = "created";

  #framePending = false;

  #nextTickNumber = 1;

  #completedFrameCount = 0;

  #failedFrameCount = 0;

  public constructor(dependencies: GenesisRenderLoopDependencies) {
    this.#executeFrame = dependencies.executeFrame;

    this.#onEvent = dependencies.onEvent;
  }

  public get state(): RenderLoopState {
    return this.#state;
  }

  public get framePending(): boolean {
    return this.#framePending;
  }

  public get completedFrameCount(): number {
    return this.#completedFrameCount;
  }

  public get failedFrameCount(): number {
    return this.#failedFrameCount;
  }

  public start(): void {
    if (this.#state === "running") {
      throw new RenderLoopAlreadyRunningError();
    }

    if (this.#state === "stopped") {
      throw new RenderLoopStoppedError();
    }

    this.#state = "running";

    this.#emit({
      type: "started",
    });
  }

  public requestFrame(): boolean {
    this.#assertRunning();

    const wasAlreadyPending = this.#framePending;

    this.#framePending = true;

    this.#emit({
      type: "frame-requested",

      wasAlreadyPending,
    });

    return !wasAlreadyPending;
  }

  public tick(): RenderLoopTickResult {
    this.#assertRunning();

    const tickNumber = this.#nextTickNumber;

    this.#nextTickNumber += 1;

    if (!this.#framePending) {
      return {
        tickNumber,
        executed: false,
      };
    }

    this.#framePending = false;

    this.#emit({
      type: "frame-started",

      tickNumber,
    });

    try {
      const result = this.#executeFrame();

      this.#completedFrameCount += 1;

      this.#emit({
        type: "frame-completed",

        tickNumber,

        result,
      });

      return {
        tickNumber,
        executed: true,
        result,
      };
    } catch (error: unknown) {
      this.#failedFrameCount += 1;

      this.#emit({
        type: "frame-failed",

        tickNumber,

        error,
      });

      return {
        tickNumber,
        executed: true,
        error,
      };
    }
  }

  public stop(): void {
    if (this.#state === "stopped") {
      throw new RenderLoopStoppedError();
    }

    if (this.#state !== "running") {
      throw new RenderLoopNotRunningError();
    }

    this.#framePending = false;

    this.#state = "stopped";

    this.#emit({
      type: "stopped",

      completedFrameCount: this.#completedFrameCount,

      failedFrameCount: this.#failedFrameCount,
    });
  }

  #assertRunning(): void {
    if (this.#state === "stopped") {
      throw new RenderLoopStoppedError();
    }

    if (this.#state !== "running") {
      throw new RenderLoopNotRunningError();
    }
  }

  #emit(event: RenderLoopEvent): void {
    this.#onEvent?.(event);
  }
}
