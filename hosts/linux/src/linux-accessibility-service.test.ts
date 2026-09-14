import { afterEach, describe, expect, it } from "vitest";
import { LinuxAccessibilityService } from "./linux-accessibility-service.js";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe("LinuxAccessibilityService", () => {
  it("reports SevynOS accessibility preferences", async () => {
    process.env["SEVYN_SCREEN_READER"] = "1";
    process.env["SEVYN_REDUCE_MOTION"] = "1";
    const state = await new LinuxAccessibilityService().getState();
    expect(state.screenReaderEnabled).toBe(true);
    expect(state.accessibilityServiceEnabled).toBe(true);
    expect(state.reduceMotionEnabled).toBe(true);
  });
});
