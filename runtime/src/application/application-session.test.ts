import { describe, expect, it } from "vitest";

import type { ApplicationManifest } from "./application-manifest.js";
import { ApplicationSession } from "./application-session.js";

const helloApplication: ApplicationManifest = {
  manifestVersion: 1,
  id: "dev.sevyn.hello",
  name: "Hello SevynOS",
  version: "0.1.0",
  hostId: "sevyn.host.react-native",
  entrypoint: "index.js",
};

describe("ApplicationSession", () => {
  it("creates a session in the created state", () => {
    const session = new ApplicationSession({
      application: helloApplication,
    });

    expect(session.id).toBeTruthy();
    expect(session.application).toBe(helloApplication);
    expect(session.state).toBe("created");
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("supports deterministic identity and creation time", () => {
    const createdAt = new Date("2026-07-26T12:00:00.000Z");

    const session = new ApplicationSession({
      id: "session-1",
      application: helloApplication,
      createdAt,
    });

    expect(session.id).toBe("session-1");
    expect(session.createdAt).toBe(createdAt);
  });

  it("returns a new session after a valid transition", () => {
    const createdSession = new ApplicationSession({
      application: helloApplication,
    });

    const startingSession = createdSession.transitionTo("starting");

    expect(startingSession).not.toBe(createdSession);
    expect(createdSession.state).toBe("created");
    expect(startingSession.state).toBe("starting");
  });

  it("preserves identity and metadata during transitions", () => {
    const createdSession = new ApplicationSession({
      application: helloApplication,
    });

    const startingSession = createdSession.transitionTo("starting");

    expect(startingSession.id).toBe(createdSession.id);
    expect(startingSession.application).toBe(createdSession.application);
    expect(startingSession.createdAt).toBe(createdSession.createdAt);
  });

  it("supports the normal session lifecycle", () => {
    const created = new ApplicationSession({
      application: helloApplication,
    });

    const starting = created.transitionTo("starting");
    const running = starting.transitionTo("running");
    const stopping = running.transitionTo("stopping");
    const stopped = stopping.transitionTo("stopped");

    expect(stopped.state).toBe("stopped");
  });

  it("rejects invalid transitions", () => {
    const session = new ApplicationSession({
      application: helloApplication,
    });

    expect(() => session.transitionTo("running")).toThrow(
      'Invalid application session transition: "created" → "running".',
    );
  });
});
