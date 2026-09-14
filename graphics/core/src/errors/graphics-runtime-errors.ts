import type { GraphicsRuntimeState } from "../renderer/graphics-runtime-state.js";

export class GraphicsRuntimeInvalidStateError extends Error {
  public readonly operation: "start" | "stop";

  public readonly state: GraphicsRuntimeState;

  public constructor(operation: "start" | "stop", state: GraphicsRuntimeState) {
    super(`Cannot ${operation} graphics runtime while it is in the "${state}" state.`);

    this.name = "GraphicsRuntimeInvalidStateError";

    this.operation = operation;

    this.state = state;
  }
}

export interface GraphicsRuntimeStartupFailureOptions {
  readonly cause: unknown;

  readonly rollbackErrors: readonly unknown[];
}

export class GraphicsRuntimeStartupError extends Error {
  public readonly rollbackErrors: readonly unknown[];

  public constructor(options: GraphicsRuntimeStartupFailureOptions) {
    super("Graphics runtime failed to start.", {
      cause: options.cause,
    });

    this.name = "GraphicsRuntimeStartupError";

    this.rollbackErrors = Object.freeze([...options.rollbackErrors]);
  }
}

export interface GraphicsRuntimeShutdownFailure {
  readonly component: "scheduler" | "render-loop" | "renderer";

  readonly error: unknown;
}

export class GraphicsRuntimeShutdownError extends Error {
  public readonly failures: readonly GraphicsRuntimeShutdownFailure[];

  public constructor(failures: readonly GraphicsRuntimeShutdownFailure[]) {
    super("Graphics runtime failed to shut down cleanly.");

    this.name = "GraphicsRuntimeShutdownError";

    this.failures = Object.freeze([...failures]);
  }
}
