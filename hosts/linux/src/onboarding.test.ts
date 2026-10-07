import { describe, expect, it } from "vitest";
import { createOnboardingRecord, isOnboardingComplete } from "./onboarding.js";

describe("isOnboardingComplete", () => {
  it("accepts only an explicit setupComplete flag", () => {
    expect(isOnboardingComplete({ setupComplete: true })).toBe(true);
    expect(isOnboardingComplete({ setupComplete: false })).toBe(false);
    expect(isOnboardingComplete({})).toBe(false);
    expect(isOnboardingComplete(undefined)).toBe(false);
    expect(isOnboardingComplete(null)).toBe(false);
    expect(isOnboardingComplete("yes")).toBe(false);
    expect(isOnboardingComplete({ setupComplete: "true" })).toBe(false);
  });
});

describe("createOnboardingRecord", () => {
  it("marks setup complete with a timestamp", () => {
    const record = createOnboardingRecord(() => "2026-10-07T00:00:00.000Z");
    expect(record.setupComplete).toBe(true);
    expect(record.completedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(isOnboardingComplete(record)).toBe(true);
  });
});
