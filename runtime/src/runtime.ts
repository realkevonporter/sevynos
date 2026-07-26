import type { RuntimeLogger } from "./logger.js";
import { RUNTIME_IDENTITY } from "./runtime-identity.js";
import { assertRuntimeTransition } from "./runtime-state.js";
import type { RuntimeState } from "./runtime-state.js";

export interface RuntimeOptions {
  readonly logger: RuntimeLogger;
}

export class SevynRuntime {
  readonly #logger: RuntimeLogger;

  #state: RuntimeState = "created";
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: RuntimeOptions) {
    this.#logger = options.logger;
  }

  public get state(): RuntimeState {
    return this.#state;
  }

  public async start(): Promise<void> {
    this.#transitionTo("starting", "runtime.start.requested");

    try {
      await this.#initialize();

      this.#transitionTo("running", "runtime.start.completed");

      this.#logger.log("info", "runtime.ready", {
        runtimeId: RUNTIME_IDENTITY.id,
        architectureVersion: RUNTIME_IDENTITY.architectureVersion,
        processId: process.pid,
      });
    } catch (error: unknown) {
      this.#transitionTo("failed", "runtime.start.failed");

      this.#logger.log("error", "runtime.failure", {
        error: this.#serializeError(error),
      });

      throw error;
    }
  }

  public stop(reason: string): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = this.#performStop(reason);

    return this.#shutdownPromise;
  }

  async #performStop(reason: string): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }

    if (this.#state === "failed") {
      this.#logger.log("warn", "runtime.stop.skipped", {
        reason,
        state: this.#state,
      });

      return;
    }

    this.#transitionTo("stopping", "runtime.stop.requested", {
      reason,
    });

    try {
      await this.#dispose();

      this.#transitionTo("stopped", "runtime.stop.completed", {
        reason,
      });
    } catch (error: unknown) {
      this.#transitionTo("failed", "runtime.stop.failed", {
        reason,
      });

      this.#logger.log("error", "runtime.failure", {
        reason,
        error: this.#serializeError(error),
      });

      throw error;
    }
  }

  async #initialize(): Promise<void> {
    this.#logger.log("info", "runtime.initializing", {
      processId: process.pid,
    });

    await Promise.resolve();
  }

  async #dispose(): Promise<void> {
    this.#logger.log("info", "runtime.disposing");

    await Promise.resolve();
  }

  #transitionTo(
    requestedState: RuntimeState,
    event: string,
    context: Readonly<Record<string, unknown>> = {},
  ): void {
    const previousState = this.#state;

    assertRuntimeTransition(previousState, requestedState);

    this.#state = requestedState;

    this.#logger.log("info", event, {
      previousState,
      currentState: requestedState,
      ...context,
    });
  }

  #serializeError(error: unknown): Readonly<Record<string, unknown>> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      message: String(error),
    };
  }
}
