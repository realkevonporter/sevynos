import type {
  GraphicsRendererLifecycle,
  GraphicsRenderLoopLifecycle,
  GraphicsSchedulerLifecycle,
} from "./graphics-runtime-components.js";
import {
  GraphicsRuntimeInvalidStateError,
  GraphicsRuntimeShutdownError,
  GraphicsRuntimeStartupError,
  type GraphicsRuntimeShutdownFailure,
} from "../errors/graphics-runtime-errors.js";
import type {
  GraphicsRuntimeEvent,
  GraphicsRuntimeEventListener,
} from "./graphics-runtime-events.js";
import type { GraphicsRuntimeState } from "./graphics-runtime-state.js";

export interface GraphicsRuntimeCoordinatorDependencies {
  readonly renderer: GraphicsRendererLifecycle;

  readonly renderLoop: GraphicsRenderLoopLifecycle;

  readonly scheduler: GraphicsSchedulerLifecycle;

  readonly onEvent?: GraphicsRuntimeEventListener;
}

export class GraphicsRuntimeCoordinator {
  readonly #renderer: GraphicsRendererLifecycle;

  readonly #renderLoop: GraphicsRenderLoopLifecycle;

  readonly #scheduler: GraphicsSchedulerLifecycle;

  readonly #onEvent: GraphicsRuntimeEventListener | undefined;

  #state: GraphicsRuntimeState = "created";

  public constructor(dependencies: GraphicsRuntimeCoordinatorDependencies) {
    this.#renderer = dependencies.renderer;

    this.#renderLoop = dependencies.renderLoop;

    this.#scheduler = dependencies.scheduler;

    this.#onEvent = dependencies.onEvent;
  }

  public get state(): GraphicsRuntimeState {
    return this.#state;
  }

  public start(): void {
    if (this.#state !== "created") {
      throw new GraphicsRuntimeInvalidStateError("start", this.#state);
    }

    this.#transitionTo("starting");

    this.#emit({
      type: "starting",
    });

    let rendererInitialized = false;

    let renderLoopStarted = false;

    let schedulerStarted = false;

    try {
      this.#renderer.initialize();

      rendererInitialized = true;

      this.#emit({
        type: "renderer-initialized",
      });

      this.#renderLoop.start();

      renderLoopStarted = true;

      this.#emit({
        type: "render-loop-started",
      });

      this.#scheduler.start();

      schedulerStarted = true;

      this.#emit({
        type: "scheduler-started",
      });

      this.#transitionTo("running");

      this.#emit({
        type: "started",
      });
    } catch (error: unknown) {
      const rollbackErrors: unknown[] = [];

      if (schedulerStarted) {
        try {
          this.#scheduler.stop();
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (renderLoopStarted) {
        try {
          this.#renderLoop.stop();
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
      }

      if (rendererInitialized) {
        try {
          this.#renderer.shutdown();
        } catch (rollbackError: unknown) {
          rollbackErrors.push(rollbackError);
        }
      }

      this.#transitionTo("failed");

      this.#emit({
        type: "startup-failed",

        error,

        rollbackErrors: Object.freeze([...rollbackErrors]),
      });

      throw new GraphicsRuntimeStartupError({
        cause: error,

        rollbackErrors,
      });
    }
  }

  public stop(): void {
    if (this.#state !== "running") {
      throw new GraphicsRuntimeInvalidStateError("stop", this.#state);
    }

    this.#transitionTo("stopping");

    this.#emit({
      type: "stopping",
    });

    const failures: GraphicsRuntimeShutdownFailure[] = [];

    try {
      this.#scheduler.stop();

      this.#emit({
        type: "scheduler-stopped",
      });
    } catch (error: unknown) {
      failures.push({
        component: "scheduler",

        error,
      });
    }

    try {
      this.#renderLoop.stop();

      this.#emit({
        type: "render-loop-stopped",
      });
    } catch (error: unknown) {
      failures.push({
        component: "render-loop",

        error,
      });
    }

    try {
      this.#renderer.shutdown();

      this.#emit({
        type: "renderer-shutdown",
      });
    } catch (error: unknown) {
      failures.push({
        component: "renderer",

        error,
      });
    }

    if (failures.length > 0) {
      this.#transitionTo("failed");

      const immutableFailures = Object.freeze([...failures]);

      this.#emit({
        type: "shutdown-failed",

        failures: immutableFailures,
      });

      throw new GraphicsRuntimeShutdownError(failures);
    }

    this.#transitionTo("stopped");

    this.#emit({
      type: "stopped",
    });
  }

  #transitionTo(state: GraphicsRuntimeState): void {
    const previousState = this.#state;

    this.#state = state;

    this.#emit({
      type: "state-changed",

      previousState,

      state,
    });
  }

  #emit(event: GraphicsRuntimeEvent): void {
    this.#onEvent?.(event);
  }
}
