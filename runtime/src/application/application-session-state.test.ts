import { describe, expect, it } from "vitest";

import {
  assertApplicationSessionTransition,
  canTransitionApplicationSession,
} from "./application-session-state.js";

describe("ApplicationSessionState", () => {
  it("allows valid lifecycle transitions", () => {
    expect(canTransitionApplicationSession("created", "starting")).toBe(true);

    expect(canTransitionApplicationSession("starting", "foreground")).toBe(true);

    expect(canTransitionApplicationSession("foreground", "background")).toBe(true);

    expect(canTransitionApplicationSession("background", "suspended")).toBe(true);

    expect(canTransitionApplicationSession("suspended", "foreground")).toBe(true);

    expect(canTransitionApplicationSession("foreground", "stopping")).toBe(true);

    expect(canTransitionApplicationSession("stopping", "stopped")).toBe(true);
  });

  it("allows active lifecycle states to fail", () => {
    expect(canTransitionApplicationSession("created", "failed")).toBe(true);

    expect(canTransitionApplicationSession("starting", "failed")).toBe(true);

    expect(canTransitionApplicationSession("foreground", "failed")).toBe(true);

    expect(canTransitionApplicationSession("background", "failed")).toBe(true);

    expect(canTransitionApplicationSession("suspended", "failed")).toBe(true);

    expect(canTransitionApplicationSession("stopping", "failed")).toBe(true);
  });

  it("allows background applications to return to foreground", () => {
    expect(canTransitionApplicationSession("background", "foreground")).toBe(true);
  });

  it("allows suspended applications to resume in the background", () => {
    expect(canTransitionApplicationSession("suspended", "background")).toBe(true);
  });

  it("rejects transitions from terminal states", () => {
    expect(canTransitionApplicationSession("stopped", "foreground")).toBe(false);

    expect(canTransitionApplicationSession("failed", "starting")).toBe(false);
  });

  it("rejects invalid lifecycle transitions", () => {
    expect(canTransitionApplicationSession("created", "foreground")).toBe(false);

    expect(canTransitionApplicationSession("foreground", "suspended")).toBe(false);

    expect(canTransitionApplicationSession("starting", "background")).toBe(false);
  });

  it("throws when a transition is invalid", () => {
    expect(() => {
      assertApplicationSessionTransition("created", "foreground");
    }).toThrow('Invalid application session transition: "created" → "foreground".');
  });
});
