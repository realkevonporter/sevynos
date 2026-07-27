import { describe, expect, it } from "vitest";

import type { ApplicationHost, ApplicationHostStartResult } from "./application-host.js";
import { ApplicationHostRegistry } from "./application-host-registry.js";
import { ApplicationManager } from "./application-manager.js";
import type { ApplicationPackage } from "./application-package.js";
import { ApplicationPackageRegistry } from "./application-package-registry.js";
import { ApplicationSession, type ApplicationSessionId } from "./application-session.js";
import { SessionRegistry } from "./session-registry.js";

const JAVASCRIPT_HOST_ID = "sevyn.host.javascript";

const UNKNOWN_HOST_ID = "sevyn.host.unknown";

const helloApplicationPackage: ApplicationPackage = {
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
        export async function start(context) {
          context.log("Hello from SevynOS!");

          return {
            title: "Hello SevynOS"
          };
        }

        export async function stop(context) {
          context.log("Goodbye from SevynOS!");
        }
      `,
  },
};

class TestApplicationHost implements ApplicationHost {
  public readonly id = JAVASCRIPT_HOST_ID;

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

class FailingApplicationHost implements ApplicationHost {
  public readonly id = JAVASCRIPT_HOST_ID;

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    void session;

    await Promise.resolve();

    throw new Error("Host failed to start.");
  }

  public async stop(session: ApplicationSession): Promise<void> {
    void session;

    await Promise.resolve();
  }
}

class FailingStopApplicationHost implements ApplicationHost {
  public readonly id = JAVASCRIPT_HOST_ID;

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    await Promise.resolve();

    return {
      instanceId: `test:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    void session;

    await Promise.resolve();

    throw new Error("Host failed to stop.");
  }
}

function createManager(host: ApplicationHost): {
  readonly manager: ApplicationManager;
  readonly sessions: SessionRegistry;
} {
  const applications = new ApplicationPackageRegistry();

  const hosts = new ApplicationHostRegistry();

  const sessions = new SessionRegistry();

  applications.register(helloApplicationPackage);

  hosts.register(host);

  const manager = new ApplicationManager({
    applications,
    hosts,
    sessions,

    createSessionId: (): ApplicationSessionId => "session-1",

    now: (): Date => new Date("2026-07-26T12:00:00.000Z"),
  });

  return {
    manager,
    sessions,
  };
}

describe("ApplicationManager", () => {
  it("starts an application through its configured host", async () => {
    const host = new TestApplicationHost();

    const { manager, sessions } = createManager(host);

    const result = await manager.start(helloApplicationPackage.manifest.id);

    expect(result.session.id).toBe("session-1");

    expect(result.session.application).toStrictEqual(helloApplicationPackage);

    expect(result.session.state).toBe("running");

    expect(result.session.createdAt).toEqual(new Date("2026-07-26T12:00:00.000Z"));

    expect(result.host).toEqual({
      instanceId: "test:session-1",
    });

    expect(host.startedSession?.state).toBe("starting");

    expect(sessions.get("session-1")).toBe(result.session);
  });

  it("rejects an unknown application", async () => {
    const host = new TestApplicationHost();

    const { manager, sessions } = createManager(host);

    await expect(manager.start("dev.sevyn.missing")).rejects.toThrow(
      'Application "dev.sevyn.missing" is not registered.',
    );

    expect(sessions.list()).toEqual([]);
  });

  it("rejects an application with an unknown host", async () => {
    const applications = new ApplicationPackageRegistry();

    const hosts = new ApplicationHostRegistry();

    const sessions = new SessionRegistry();

    const unknownHostPackage: ApplicationPackage = {
      ...helloApplicationPackage,

      manifest: {
        ...helloApplicationPackage.manifest,

        hostId: UNKNOWN_HOST_ID,
      },
    };

    applications.register(unknownHostPackage);

    const manager = new ApplicationManager({
      applications,
      hosts,
      sessions,

      createSessionId: (): ApplicationSessionId => "session-1",

      now: (): Date => new Date("2026-07-26T12:00:00.000Z"),
    });

    await expect(manager.start(unknownHostPackage.manifest.id)).rejects.toThrow(
      `Application host "${UNKNOWN_HOST_ID}" is not registered.`,
    );

    expect(sessions.list()).toEqual([]);
  });

  it("marks the session as failed when the host fails", async () => {
    const host = new FailingApplicationHost();

    const { manager, sessions } = createManager(host);

    await expect(manager.start(helloApplicationPackage.manifest.id)).rejects.toThrow(
      "Host failed to start.",
    );

    expect(sessions.get("session-1")?.state).toBe("failed");
  });

  it("stops a running application through its host", async () => {
    const host = new TestApplicationHost();

    const { manager, sessions } = createManager(host);

    const started = await manager.start(helloApplicationPackage.manifest.id);

    const stopped = await manager.stop(started.session.id);

    expect(host.stoppedSession?.state).toBe("stopping");

    expect(stopped.state).toBe("stopped");

    expect(stopped.id).toBe(started.session.id);

    expect(sessions.get(stopped.id)).toBe(stopped);
  });

  it("rejects an unknown session", async () => {
    const host = new TestApplicationHost();

    const { manager, sessions } = createManager(host);

    await expect(manager.stop("missing-session")).rejects.toThrow(
      'Application session "missing-session" is not registered.',
    );

    expect(sessions.list()).toEqual([]);
  });

  it("rejects stopping a session that is not running", async () => {
    const host = new TestApplicationHost();

    const { manager, sessions } = createManager(host);

    const createdSession = new ApplicationSession({
      id: "session-1",

      application: helloApplicationPackage,

      createdAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    sessions.add(createdSession);

    await expect(manager.stop(createdSession.id)).rejects.toThrow(
      'Application session "session-1" cannot be stopped from state "created".',
    );

    expect(sessions.get(createdSession.id)).toBe(createdSession);
  });

  it("marks the session as failed when the host cannot stop it", async () => {
    const host = new FailingStopApplicationHost();

    const { manager, sessions } = createManager(host);

    const started = await manager.start(helloApplicationPackage.manifest.id);

    await expect(manager.stop(started.session.id)).rejects.toThrow(
      "Host failed to stop.",
    );

    expect(sessions.get(started.session.id)?.state).toBe("failed");
  });
});
