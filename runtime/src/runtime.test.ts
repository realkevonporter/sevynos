import { describe, expect, it } from "vitest";

import type {
  ApplicationHost,
  ApplicationHostStartResult,
} from "./application/application-host.js";
import type { ApplicationPackage } from "./application/application-package.js";
import type {
  ApplicationSession,
  ApplicationSessionId,
} from "./application/application-session.js";
import { InvalidApplicationManifestError } from "./errors/invalid-application-manifest-error.js";
import { InvalidApplicationPackageError } from "./errors/invalid-application-package-error.js";
import { InvalidRuntimeStateError } from "./errors/invalid-runtime-state-error.js";
import { RuntimeShutdownError } from "./errors/runtime-shutdown-error.js";
import type { RuntimeLogger } from "./logger.js";
import { SevynRuntime } from "./runtime.js";

const JAVASCRIPT_HOST_ID = "sevyn.host.javascript";
const REACT_NATIVE_HOST_ID = "sevyn.host.react-native";

const logger: RuntimeLogger = {
  log(level, event, context): void {
    void level;
    void event;
    void context;
  },
};

const application: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "dev.sevyn.hello",
    name: "Hello SevynOS",
    version: "0.1.0",
    hostId: JAVASCRIPT_HOST_ID,
    entrypoint: "index.js",
  },

  files: {
    "index.js": `
      export async function start() {
        return {};
      }

      export async function stop() {}
    `,
  },
};

const secondApplication: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "dev.sevyn.second",
    name: "Second SevynOS Application",
    version: "0.1.0",
    hostId: REACT_NATIVE_HOST_ID,
    entrypoint: "index.js",
  },

  files: {
    "index.js": `
      export async function start() {
        return {};
      }

      export async function stop() {}
    `,
  },
};

class TestApplicationHost implements ApplicationHost {
  public readonly startedSessions: ApplicationSession[] = [];
  public readonly stoppedSessions: ApplicationSession[] = [];

  readonly #failStop: boolean;

  public constructor(
    public readonly id = JAVASCRIPT_HOST_ID,
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

    await expect(
      runtime.startApplication(application.manifest.id),
    ).rejects.toBeInstanceOf(InvalidRuntimeStateError);

    expect(host.startedSessions).toEqual([]);
    expect(runtime.listApplicationSessions()).toEqual([]);
  });

  it("starts an application through the runtime", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const result = await runtime.startApplication(application.manifest.id);

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

    const started = await runtime.startApplication(application.manifest.id);

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

    const started = await runtime.startApplication(application.manifest.id);

    expect(runtime.listApplicationSessions()).toEqual([started.session]);
  });

  it("stops running applications during runtime shutdown", async () => {
    const host = new TestApplicationHost();
    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(host);

    await runtime.start();

    const started = await runtime.startApplication(application.manifest.id);

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

    const started = await runtime.startApplication(application.manifest.id);

    await runtime.stopApplication(started.session.id);

    expect(host.stoppedSessions).toHaveLength(1);

    await runtime.stop("test shutdown");

    expect(host.stoppedSessions).toHaveLength(1);
    expect(runtime.state).toBe("stopped");
  });

  it("attempts to stop every running session when one stop fails", async () => {
    const failingHost = new TestApplicationHost(JAVASCRIPT_HOST_ID, true);

    const successfulHost = new TestApplicationHost(REACT_NATIVE_HOST_ID);

    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplication(secondApplication);

    runtime.registerApplicationHost(failingHost);
    runtime.registerApplicationHost(successfulHost);

    await runtime.start();

    const first = await runtime.startApplication(application.manifest.id);

    const second = await runtime.startApplication(secondApplication.manifest.id);

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
    const failingHost = new TestApplicationHost(JAVASCRIPT_HOST_ID, true);

    const runtime = createRuntime();

    runtime.registerApplication(application);
    runtime.registerApplicationHost(failingHost);

    await runtime.start();

    const started = await runtime.startApplication(application.manifest.id);

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

  it("rejects an invalid application package", () => {
    const runtime = createRuntime();

    expect(() => {
      runtime.registerApplication(null);
    }).toThrow(InvalidApplicationPackageError);
  });

  it("rejects an application package without a manifest", () => {
    const runtime = createRuntime();

    expect(() => {
      runtime.registerApplication({});
    }).toThrow(InvalidApplicationPackageError);
  });

  it("rejects a package with an invalid manifest", () => {
    const runtime = createRuntime();

    expect(() => {
      runtime.registerApplication({
        manifest: {
          manifestVersion: 1,
          id: "Invalid Application",
          name: "Invalid",
          version: "1.0.0",
          hostId: JAVASCRIPT_HOST_ID,
          entrypoint: "index.js",
        },

        files: {
          "index.js": "export async function start() { return {}; }",
        },
      });
    }).toThrow(InvalidApplicationManifestError);
  });

  it("delegates manifest validation to the application registry", () => {
    const runtime = createRuntime();

    expect(() => {
      runtime.registerApplication({
        manifest: {
          manifestVersion: 1,
          id: "Invalid Application",
          name: "Invalid",
          version: "1.0.0",
          hostId: JAVASCRIPT_HOST_ID,
          entrypoint: "index.js",
        },

        files: {
          "index.js": "export async function start() { return {}; }",
        },
      });
    }).toThrow(InvalidApplicationManifestError);
  });
});
