import { describe, expect, it } from "vitest";

import { canTransitionWindowState } from "./window-state-transition.js";

describe("canTransitionWindowState", () => {
  it.each([
    ["created", "visible"],
    ["visible", "focused"],
    ["focused", "visible"],
    ["focused", "minimized"],
    ["minimized", "focused"],
    ["visible", "hidden"],
    ["hidden", "visible"],
    ["focused", "closing"],
    ["closing", "closed"],
  ] as const)("allows %s to transition to %s", (currentState, targetState) => {
    expect(canTransitionWindowState(currentState, targetState)).toBe(true);
  });

  it.each([
    ["created", "focused"],
    ["created", "closed"],
    ["visible", "closed"],
    ["focused", "created"],
    ["closing", "visible"],
    ["closed", "visible"],
    ["closed", "closing"],
  ] as const)("rejects %s transitioning to %s", (currentState, targetState) => {
    expect(canTransitionWindowState(currentState, targetState)).toBe(false);
  });
});
