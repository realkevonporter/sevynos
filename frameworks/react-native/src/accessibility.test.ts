import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessibilityInfo } from "./accessibility.js";
import { installNativeAdapters } from "./native-adapter-contracts.js";

afterEach(() => {
  installNativeAdapters({});
});

describe("AccessibilityInfo", () => {
  it("reads host state, emits changes, and routes announcements", async () => {
    let screenReaderEnabled = false;
    let changed: (() => void) | undefined;
    const announce = vi.fn(() => Promise.resolve());
    installNativeAdapters({
      accessibility: {
        getState: () =>
          Promise.resolve({
            accessibilityServiceEnabled: screenReaderEnabled,
            screenReaderEnabled,
            boldTextEnabled: false,
            grayscaleEnabled: false,
            invertColorsEnabled: false,
            reduceMotionEnabled: false,
            reduceTransparencyEnabled: false,
          }),
        subscribe: (listener) => {
          changed = listener;
          return () => {
            changed = undefined;
          };
        },
        announce,
      },
    });
    expect(await AccessibilityInfo.isScreenReaderEnabled()).toBe(false);
    const listener = vi.fn();
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      listener,
    );
    screenReaderEnabled = true;
    changed?.();
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(true);
    });
    expect(await AccessibilityInfo.getRecommendedTimeoutMillis(1_000)).toBe(2_000);
    AccessibilityInfo.announceForAccessibility("Ready");
    await vi.waitFor(() => {
      expect(announce).toHaveBeenCalledWith("Ready");
    });
    subscription.remove();
  });
});
