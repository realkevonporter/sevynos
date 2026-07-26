import { describe, expect, it } from "vitest";

import {
  InvalidRuntimeTransitionError,
  assertRuntimeTransition,
  canTransitionRuntime,
} from "./runtime-state.js";

describe("Runtime state transitions", () => {
  it("allows the normal startup path", () => {
    expect(canTransitionRuntime("created", "starting")).toBe(true);
    expect(canTransitionRuntime("starting", "running")).toBe(true);
  });

  it("allows the normal shutdown path", () => {
    expect(canTransitionRuntime("running", "stopping")).toBe(true);
    expect(canTransitionRuntime("stopping", "stopped")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => {
      assertRuntimeTransition("created", "running");
    }).toThrow(InvalidRuntimeTransitionError);
  });

  it("keeps terminal states terminal", () => {
    expect(canTransitionRuntime("stopped", "starting")).toBe(false);
    expect(canTransitionRuntime("failed", "starting")).toBe(false);
  });
});
