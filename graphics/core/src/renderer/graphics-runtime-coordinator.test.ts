import { describe, expect, it } from "vitest";

import { GraphicsRuntimeCoordinator } from "./graphics-runtime-coordinator.js";
import {
  GraphicsRuntimeInvalidStateError,
  GraphicsRuntimeShutdownError,
  GraphicsRuntimeStartupError,
} from "../errors/graphics-runtime-errors.js";
import type { GraphicsRuntimeEvent } from "./graphics-runtime-events.js";

interface TestComponents {
  readonly calls: string[];

  readonly coordinator: GraphicsRuntimeCoordinator;
}

interface CreateTestComponentsOptions {
  readonly rendererInitializeError?: Error;

  readonly rendererShutdownError?: Error;

  readonly renderLoopStartError?: Error;

  readonly renderLoopStopError?: Error;

  readonly schedulerStartError?: Error;

  readonly schedulerStopError?: Error;

  readonly onEvent?: (event: GraphicsRuntimeEvent) => void;
}

function createTestComponents(options: CreateTestComponentsOptions = {}): TestComponents {
  const calls: string[] = [];

  const coordinator = new GraphicsRuntimeCoordinator({
    renderer: {
      initialize: () => {
        calls.push("renderer.initialize");

        if (options.rendererInitializeError) {
          throw options.rendererInitializeError;
        }
      },

      shutdown: () => {
        calls.push("renderer.shutdown");

        if (options.rendererShutdownError) {
          throw options.rendererShutdownError;
        }
      },
    },

    renderLoop: {
      start: () => {
        calls.push("renderLoop.start");

        if (options.renderLoopStartError) {
          throw options.renderLoopStartError;
        }
      },

      stop: () => {
        calls.push("renderLoop.stop");

        if (options.renderLoopStopError) {
          throw options.renderLoopStopError;
        }
      },
    },

    scheduler: {
      start: () => {
        calls.push("scheduler.start");

        if (options.schedulerStartError) {
          throw options.schedulerStartError;
        }
      },

      stop: () => {
        calls.push("scheduler.stop");

        if (options.schedulerStopError) {
          throw options.schedulerStopError;
        }
      },
    },

    ...(options.onEvent !== undefined
      ? {
          onEvent: options.onEvent,
        }
      : {}),
  });

  return {
    calls,
    coordinator,
  };
}

describe("GraphicsRuntimeCoordinator", () => {
  it("starts in the created state", () => {
    const { coordinator } = createTestComponents();

    expect(coordinator.state).toBe("created");
  });

  it("starts components in the correct order", () => {
    const { calls, coordinator } = createTestComponents();

    coordinator.start();

    expect(calls).toEqual(["renderer.initialize", "renderLoop.start", "scheduler.start"]);

    expect(coordinator.state).toBe("running");
  });

  it("stops components in reverse order", () => {
    const { calls, coordinator } = createTestComponents();

    coordinator.start();

    calls.length = 0;

    coordinator.stop();

    expect(calls).toEqual(["scheduler.stop", "renderLoop.stop", "renderer.shutdown"]);

    expect(coordinator.state).toBe("stopped");
  });

  it("rejects stopping before startup", () => {
    const { coordinator } = createTestComponents();

    expect(() => {
      coordinator.stop();
    }).toThrow(GraphicsRuntimeInvalidStateError);

    expect(coordinator.state).toBe("created");
  });

  it("rejects repeated starts", () => {
    const { coordinator } = createTestComponents();

    coordinator.start();

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeInvalidStateError);
  });

  it("rejects repeated stops", () => {
    const { coordinator } = createTestComponents();

    coordinator.start();
    coordinator.stop();

    expect(() => {
      coordinator.stop();
    }).toThrow(GraphicsRuntimeInvalidStateError);
  });

  it("rejects restarting after stop", () => {
    const { coordinator } = createTestComponents();

    coordinator.start();
    coordinator.stop();

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeInvalidStateError);
  });

  it("does not roll back when renderer initialization fails", () => {
    const expectedError = new Error("Renderer initialization failed.");

    const { calls, coordinator } = createTestComponents({
      rendererInitializeError: expectedError,
    });

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeStartupError);

    expect(calls).toEqual(["renderer.initialize"]);

    expect(coordinator.state).toBe("failed");
  });

  it("shuts down renderer when render-loop startup fails", () => {
    const expectedError = new Error("Render loop failed to start.");

    const { calls, coordinator } = createTestComponents({
      renderLoopStartError: expectedError,
    });

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeStartupError);

    expect(calls).toEqual([
      "renderer.initialize",
      "renderLoop.start",
      "renderer.shutdown",
    ]);

    expect(coordinator.state).toBe("failed");
  });

  it("stops render loop and renderer when scheduler startup fails", () => {
    const expectedError = new Error("Scheduler failed to start.");

    const { calls, coordinator } = createTestComponents({
      schedulerStartError: expectedError,
    });

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeStartupError);

    expect(calls).toEqual([
      "renderer.initialize",
      "renderLoop.start",
      "scheduler.start",
      "renderLoop.stop",
      "renderer.shutdown",
    ]);

    expect(coordinator.state).toBe("failed");
  });

  it("preserves the original startup error", () => {
    const expectedError = new Error("Unable to start scheduler.");

    const { coordinator } = createTestComponents({
      schedulerStartError: expectedError,
    });

    let received: unknown;

    try {
      coordinator.start();
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toBeInstanceOf(GraphicsRuntimeStartupError);

    expect((received as GraphicsRuntimeStartupError).cause).toBe(expectedError);
  });

  it("collects startup rollback errors", () => {
    const startupError = new Error("Scheduler startup failed.");

    const loopStopError = new Error("Render loop rollback failed.");

    const rendererShutdownError = new Error("Renderer rollback failed.");

    const { coordinator } = createTestComponents({
      schedulerStartError: startupError,

      renderLoopStopError: loopStopError,

      rendererShutdownError: rendererShutdownError,
    });

    let received: unknown;

    try {
      coordinator.start();
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toBeInstanceOf(GraphicsRuntimeStartupError);

    const startupFailure = received as GraphicsRuntimeStartupError;

    expect(startupFailure.cause).toBe(startupError);

    expect(startupFailure.rollbackErrors).toEqual([loopStopError, rendererShutdownError]);
  });

  it("attempts every shutdown operation when one fails", () => {
    const schedulerError = new Error("Scheduler shutdown failed.");

    const { calls, coordinator } = createTestComponents({
      schedulerStopError: schedulerError,
    });

    coordinator.start();

    calls.length = 0;

    expect(() => {
      coordinator.stop();
    }).toThrow(GraphicsRuntimeShutdownError);

    expect(calls).toEqual(["scheduler.stop", "renderLoop.stop", "renderer.shutdown"]);

    expect(coordinator.state).toBe("failed");
  });

  it("collects all shutdown failures", () => {
    const schedulerError = new Error("Scheduler failed.");

    const loopError = new Error("Render loop failed.");

    const rendererError = new Error("Renderer failed.");

    const { coordinator } = createTestComponents({
      schedulerStopError: schedulerError,

      renderLoopStopError: loopError,

      rendererShutdownError: rendererError,
    });

    coordinator.start();

    let received: unknown;

    try {
      coordinator.stop();
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toBeInstanceOf(GraphicsRuntimeShutdownError);

    const shutdownFailure = received as GraphicsRuntimeShutdownError;

    expect(shutdownFailure.failures).toEqual([
      {
        component: "scheduler",

        error: schedulerError,
      },
      {
        component: "render-loop",

        error: loopError,
      },
      {
        component: "renderer",

        error: rendererError,
      },
    ]);
  });

  it("emits startup lifecycle events", () => {
    const events: GraphicsRuntimeEvent[] = [];

    const { coordinator } = createTestComponents({
      onEvent: (event) => {
        events.push(event);
      },
    });

    coordinator.start();

    expect(events.map((event) => event.type)).toEqual([
      "state-changed",
      "starting",
      "renderer-initialized",
      "render-loop-started",
      "scheduler-started",
      "state-changed",
      "started",
    ]);
  });

  it("emits shutdown lifecycle events", () => {
    const events: GraphicsRuntimeEvent[] = [];

    const { coordinator } = createTestComponents({
      onEvent: (event) => {
        events.push(event);
      },
    });

    coordinator.start();

    events.length = 0;

    coordinator.stop();

    expect(events.map((event) => event.type)).toEqual([
      "state-changed",
      "stopping",
      "scheduler-stopped",
      "render-loop-stopped",
      "renderer-shutdown",
      "state-changed",
      "stopped",
    ]);
  });

  it("emits state transitions", () => {
    const events: GraphicsRuntimeEvent[] = [];

    const { coordinator } = createTestComponents({
      onEvent: (event) => {
        events.push(event);
      },
    });

    coordinator.start();
    coordinator.stop();

    const transitions = events.filter(
      (
        event,
      ): event is Extract<
        GraphicsRuntimeEvent,
        {
          readonly type: "state-changed";
        }
      > => event.type === "state-changed",
    );

    expect(transitions).toEqual([
      {
        type: "state-changed",

        previousState: "created",

        state: "starting",
      },
      {
        type: "state-changed",

        previousState: "starting",

        state: "running",
      },
      {
        type: "state-changed",

        previousState: "running",

        state: "stopping",
      },
      {
        type: "state-changed",

        previousState: "stopping",

        state: "stopped",
      },
    ]);
  });

  it("emits a startup-failed event", () => {
    const events: GraphicsRuntimeEvent[] = [];

    const expectedError = new Error("Scheduler startup failed.");

    const { coordinator } = createTestComponents({
      schedulerStartError: expectedError,

      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(() => {
      coordinator.start();
    }).toThrow(GraphicsRuntimeStartupError);

    const failure = events.find(
      (
        event,
      ): event is Extract<
        GraphicsRuntimeEvent,
        {
          readonly type: "startup-failed";
        }
      > => event.type === "startup-failed",
    );

    expect(failure?.error).toBe(expectedError);
  });

  it("emits a shutdown-failed event", () => {
    const events: GraphicsRuntimeEvent[] = [];

    const expectedError = new Error("Renderer shutdown failed.");

    const { coordinator } = createTestComponents({
      rendererShutdownError: expectedError,

      onEvent: (event) => {
        events.push(event);
      },
    });

    coordinator.start();

    expect(() => {
      coordinator.stop();
    }).toThrow(GraphicsRuntimeShutdownError);

    const failure = events.find(
      (
        event,
      ): event is Extract<
        GraphicsRuntimeEvent,
        {
          readonly type: "shutdown-failed";
        }
      > => event.type === "shutdown-failed",
    );

    expect(failure?.failures).toEqual([
      {
        component: "renderer",

        error: expectedError,
      },
    ]);
  });
});
