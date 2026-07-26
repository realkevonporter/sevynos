import { describe, expect, it } from "vitest";

import type {
  ApplicationHost,
  ApplicationHostStartResult,
} from "./application/application-host.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "./application/application-session.js";
import { InvalidRuntimeStateError } from "./errors/invalid-runtime-state-error.js";
import { RuntimeShutdownError } from "./errors/runtime-shutdown-error.js";
import type { RuntimeLogger } from "./logger.js";
import { SevynRuntime } from "./runtime.js";
import type { ApplicationManifest } from "./application/application-manifest.js";

const logger: RuntimeLogger = {
  log(level, event, context): void {
    void level;
    void event;
    void context;
  },
};

const application: ApplicationManifest = {
  manifestVersion: 1,
  id: "dev.sevyn.hello",
  name: "Hello SevynOS",
  version: "0.1.0",
  hostId: "sevyn.host.test",
  entrypoint: "index.js",
};

const secondApplication: ApplicationManifest = {
  manifestVersion: 1,
  id: "dev.sevyn.second",
  name: "Second SevynOS Application",
  version: "0.1.0",
  hostId: "sevyn.host.second",
  entrypoint: "index.js",
};

class TestApplicationHost implements ApplicationHost {
  public readonly startedSessions: ApplicationSession[] = [];
  public readonly stoppedSessions: ApplicationSession[] = [];

  readonly #failStop: boolean;

  public constructor(
    public readonly id = "sevyn.host.test",
    failStop = false,
  ) {
    this.#failStop = failStop;
  }

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    await Promise.resolve();

    this.startedSessions.push(session);

    return {
      instanceId: `test:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    await Promise.resolve();

    this.stoppedSessions.push(session);

    if (this.#failStop) {
      throw new Error(`Host "${this.id}" failed to stop session "${session.id}".`);
    }
  }
}

function createRuntime(): SevynRuntime {
  let sessionNumber = 0;

  return new SevynRuntime({
    logger,
    createSessionId: (): ApplicationSessionId => {
      sessionNumber += 1;

      return `session-${String(sessionNumber)}`;
    },
    now: (): Date => new Date("2026-07-26T12:00:00.000Z"),
  });
}

describe("SevynRuntime application composition", () => {
  it("rejects application startup before the runtime is running", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await expect(runtime.startApplication(application.id)).rejects.toBeInstanceOf(
      InvalidRuntimeStateError,
    );

    expect(host.startedSessions).toEqual([]);
    expect(runtime.listApplicationSessions()).toEqual([]);
  });

  it("starts an application through the runtime", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const result = await runtime.startApplication(application.id);

    expect(runtime.state).toBe("running");
    expect(result.session.state).toBe("running");
    expect(result.session.id).toBe("session-1");
    expect(result.host.instanceId).toBe("test:session-1");
    expect(host.startedSessions[0]?.state).toBe("starting");
    expect(runtime.getApplicationSession("session-1")).toBe(result.session);
  });

  it("stops an application through the runtime", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const started = await runtime.startApplication(application.id);

    const stopped = await runtime.stopApplication(started.session.id);

    expect(stopped.state).toBe("stopped");
    expect(host.stoppedSessions[0]?.state).toBe("stopping");
    expect(runtime.getApplicationSession(stopped.id)).toBe(stopped);
  });

  it("lists application sessions", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const started = await runtime.startApplication(application.id);

    expect(runtime.listApplicationSessions()).toEqual([started.session]);
  });

  it("stops running applications during runtime shutdown", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const started = await runtime.startApplication(application.id);

    await runtime.stop("test shutdown");

    expect(runtime.state).toBe("stopped");
    expect(host.stoppedSessions[0]?.id).toBe(started.session.id);
    expect(runtime.getApplicationSession(started.session.id)?.state).toBe("stopped");
  });

  it("does not stop an application twice during shutdown", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const started = await runtime.startApplication(application.id);

    await runtime.stopApplication(started.session.id);

    expect(host.stoppedSessions).toHaveLength(1);

    await runtime.stop("test shutdown");

    expect(host.stoppedSessions).toHaveLength(1);
    expect(runtime.state).toBe("stopped");
  });

  it("attempts to stop every running session when one stop fails", async () => {
    const failingHost = new TestApplicationHost("sevyn.host.test", true);

    const successfulHost = new TestApplicationHost("sevyn.host.second");

    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplication(secondApplication);

    runtime.registerApplicationHost(failingHost);
    runtime.registerApplicationHost(successfulHost);

    await runtime.start();

    const first = await runtime.startApplication(application.id);

    const second = await runtime.startApplication(secondApplication.id);

    await expect(runtime.stop("test shutdown")).rejects.toBeInstanceOf(
      RuntimeShutdownError,
    );

    expect(failingHost.stoppedSessions).toHaveLength(1);

    expect(successfulHost.stoppedSessions).toHaveLength(1);

    expect(failingHost.stoppedSessions[0]?.id).toBe(first.session.id);

    expect(successfulHost.stoppedSessions[0]?.id).toBe(second.session.id);

    expect(runtime.getApplicationSession(first.session.id)?.state).toBe("failed");

    expect(runtime.getApplicationSession(second.session.id)?.state).toBe("stopped");

    expect(runtime.state).toBe("failed");
  });

  it("reports session failures after shutdown attempts complete", async () => {
    const failingHost = new TestApplicationHost("sevyn.host.test", true);

    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(failingHost);

    await runtime.start();

    const started = await runtime.startApplication(application.id);

    try {
      await runtime.stop("test shutdown");

      expect.fail("Expected runtime shutdown to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RuntimeShutdownError);

      if (!(error instanceof RuntimeShutdownError)) {
        return;
      }

      expect(error.code).toBe("RUNTIME_SHUTDOWN_FAILED");

      expect(error.failures).toHaveLength(1);

      expect(error.failures[0]?.sessionId).toBe(started.session.id);
    }
  });
});
