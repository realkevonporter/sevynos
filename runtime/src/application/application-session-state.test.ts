import { describe, expect, it } from "vitest";

import {
  assertApplicationSessionTransition,
  canTransitionApplicationSession,
} from "./application-session-state.js";

describe("ApplicationSessionState", () => {
  it("allows valid lifecycle transitions", () => {
    expect(canTransitionApplicationSession("created", "starting")).toBe(true);

    expect(canTransitionApplicationSession("starting", "running")).toBe(true);

    expect(canTransitionApplicationSession("running", "stopping")).toBe(true);

    expect(canTransitionApplicationSession("stopping", "stopped")).toBe(true);
  });

  it("allows active lifecycle states to fail", () => {
    expect(canTransitionApplicationSession("created", "failed")).toBe(true);

    expect(canTransitionApplicationSession("starting", "failed")).toBe(true);

    expect(canTransitionApplicationSession("running", "failed")).toBe(true);

    expect(canTransitionApplicationSession("stopping", "failed")).toBe(true);
  });

  it("rejects transitions from terminal states", () => {
    expect(canTransitionApplicationSession("stopped", "running")).toBe(false);

    expect(canTransitionApplicationSession("failed", "starting")).toBe(false);
  });

  it("throws when a transition is invalid", () => {
    expect(() => {
      assertApplicationSessionTransition("created", "running");
    }).toThrow('Invalid application session transition: "created" → "running".');
  });
});
