import { describe, expect, it } from "vitest";

import type { ApplicationPackage } from "./application-package.js";
import { ApplicationSession, type ApplicationSessionId } from "./application-session.js";

const helloApplicationPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "org.sevynos.hello",
    name: "Hello SevynOS",
    version: "0.1.0",
    hostId: "sevyn.host.javascript",
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

const defaultCreatedAt = new Date("2026-07-26T12:00:00.000Z");

function createSession(
  options: {
    readonly id?: ApplicationSessionId;
    readonly createdAt?: Date;
  } = {},
): ApplicationSession {
  return new ApplicationSession({
    id: options.id ?? "session-1",
    application: helloApplicationPackage,
    createdAt: options.createdAt ?? defaultCreatedAt,
  });
}

describe("ApplicationSession", () => {
  it("creates a session in the created state", () => {
    const session = createSession();

    expect(session.id).toBe("session-1");
    expect(session.application).toBe(helloApplicationPackage);
    expect(session.state).toBe("created");
    expect(session.createdAt).toBe(defaultCreatedAt);
  });

  it("supports deterministic identity and creation time", () => {
    const createdAt = new Date("2026-07-26T13:00:00.000Z");

    const session = createSession({
      id: "session-2",
      createdAt,
    });

    expect(session.id).toBe("session-2");
    expect(session.createdAt).toBe(createdAt);
  });

  it("returns a new session after a valid transition", () => {
    const createdSession = createSession();

    const startingSession = createdSession.transitionTo("starting");

    expect(startingSession).not.toBe(createdSession);

    expect(createdSession.state).toBe("created");

    expect(startingSession.state).toBe("starting");
  });

  it("preserves identity and metadata during transitions", () => {
    const createdSession = createSession();

    const startingSession = createdSession.transitionTo("starting");

    expect(startingSession.id).toBe(createdSession.id);

    expect(startingSession.application).toBe(createdSession.application);

    expect(startingSession.createdAt).toBe(createdSession.createdAt);
  });

  it("supports the normal foreground lifecycle", () => {
    const created = createSession();

    const starting = created.transitionTo("starting");

    const foreground = starting.transitionTo("foreground");

    const background = foreground.transitionTo("background");

    const restored = background.transitionTo("foreground");

    const stopping = restored.transitionTo("stopping");

    const stopped = stopping.transitionTo("stopped");

    expect(stopped.state).toBe("stopped");
  });

  it("supports suspending a background session", () => {
    const created = createSession();

    const starting = created.transitionTo("starting");

    const foreground = starting.transitionTo("foreground");

    const background = foreground.transitionTo("background");

    const suspended = background.transitionTo("suspended");

    expect(suspended.state).toBe("suspended");
  });

  it("rejects invalid transitions", () => {
    const session = createSession();

    expect(() => {
      session.transitionTo("foreground");
    }).toThrow('Invalid application session transition: "created" → "foreground".');
  });
});
