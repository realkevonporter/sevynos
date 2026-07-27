import { describe, expect, it } from "vitest";

import type { ApplicationPackage } from "./application-package.js";
import { ApplicationSession } from "./application-session.js";
import { SessionRegistry } from "./session-registry.js";

const helloApplicationPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "dev.sevyn.hello",
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

function createSession(id = "session-1"): ApplicationSession {
  return new ApplicationSession({
    id,
    application: helloApplicationPackage,
    createdAt: new Date("2026-07-26T12:00:00.000Z"),
  });
}

describe("SessionRegistry", () => {
  it("adds and retrieves a session", () => {
    const registry = new SessionRegistry();

    const session = createSession();

    registry.add(session);

    expect(registry.get(session.id)).toBe(session);
  });

  it("rejects duplicate sessions", () => {
    const registry = new SessionRegistry();

    const session = createSession();

    registry.add(session);

    expect(() => {
      registry.add(session);
    }).toThrow('Application session "session-1" is already registered.');
  });

  it("updates an existing session", () => {
    const registry = new SessionRegistry();

    const createdSession = createSession();

    registry.add(createdSession);

    const startingSession = createdSession.transitionTo("starting");

    registry.update(startingSession);

    expect(registry.get(createdSession.id)).toBe(startingSession);

    expect(registry.get(createdSession.id)?.state).toBe("starting");
  });

  it("rejects updates for unknown sessions", () => {
    const registry = new SessionRegistry();

    const session = createSession();

    expect(() => {
      registry.update(session);
    }).toThrow('Application session "session-1" is not registered.');
  });

  it("lists sessions", () => {
    const registry = new SessionRegistry();

    const firstSession = createSession("session-1");

    const secondSession = createSession("session-2");

    registry.add(firstSession);
    registry.add(secondSession);

    expect(registry.list()).toEqual([firstSession, secondSession]);
  });

  it("removes a session", () => {
    const registry = new SessionRegistry();

    const session = createSession();

    registry.add(session);

    expect(registry.remove(session.id)).toBe(true);

    expect(registry.get(session.id)).toBeUndefined();
  });

  it("reports whether a session exists", () => {
    const registry = new SessionRegistry();

    const session = createSession();

    registry.add(session);

    expect(registry.has(session.id)).toBe(true);

    expect(registry.has("missing-session")).toBe(false);
  });

  it("clears all sessions", () => {
    const registry = new SessionRegistry();

    registry.add(createSession("session-1"));

    registry.add(createSession("session-2"));

    registry.clear();

    expect(registry.list()).toEqual([]);
  });
});
