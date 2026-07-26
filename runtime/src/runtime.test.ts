import { describe, expect, it } from "vitest";

import type { ApplicationDescriptor } from "./application/application-descriptor.js";
import type {
  ApplicationHost,
  ApplicationHostStartResult,
} from "./application/application-host.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "./application/application-session.js";
import { InvalidRuntimeStateError } from "./errors/invalid-runtime-state-error.js";
import type { RuntimeLogger } from "./logger.js";
import { SevynRuntime } from "./runtime.js";

const logger: RuntimeLogger = {
  log(level, event, context): void {
    void level;
    void event;
    void context;
  },
};

const application: ApplicationDescriptor = {
  id: "dev.sevyn.hello",
  name: "Hello SevynOS",
  version: "0.1.0",
  hostId: "sevyn.host.test",
  entrypoint: "index.js",
};

class TestApplicationHost implements ApplicationHost {
  public readonly id = "sevyn.host.test";

  public startedSession?: ApplicationSession;
  public stoppedSession?: ApplicationSession;

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    await Promise.resolve();

    this.startedSession = session;

    return {
      instanceId: `test:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    await Promise.resolve();

    this.stoppedSession = session;
  }
}

function createRuntime(): SevynRuntime {
  return new SevynRuntime({
    logger,
    createSessionId: (): ApplicationSessionId => "session-1",
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

    expect(host.startedSession).toBeUndefined();
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
    expect(host.startedSession?.state).toBe("starting");
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
    expect(host.stoppedSession?.state).toBe("stopping");
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
    expect(host.stoppedSession?.id).toBe(started.session.id);
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

    const stoppedBeforeShutdown = host.stoppedSession;

    await runtime.stop("test shutdown");

    expect(host.stoppedSession).toBe(stoppedBeforeShutdown);
    expect(runtime.state).toBe("stopped");
  });
});
