import { describe, expect, it } from "vitest";
import { installNativeAdapters } from "./native-adapter-contracts.js";
import { SevynOS, UnsupportedSevynFeatureError } from "./public.js";

describe("React Native platform capability detection", () => {
  it("reports implemented and unsupported capabilities truthfully", () => {
    installNativeAdapters({});
    expect(SevynOS.supports("pointer")).toBe(true);
    expect(SevynOS.supports("camera")).toBe(false);
    expect(() => {
      SevynOS.require("camera");
    }).toThrow(UnsupportedSevynFeatureError);
    expect(() => {
      SevynOS.require("view");
    }).not.toThrow();
  });

  it("reports capabilities supplied by the active host", () => {
    installNativeAdapters({
      camera: { capture: () => Promise.resolve({}) },
      media: { play: () => Promise.resolve(), stop: () => Promise.resolve() },
    });
    expect(SevynOS.supports("camera")).toBe(true);
    expect(SevynOS.supports("video")).toBe(true);
    expect(SevynOS.capabilities()).toContain("camera");
    expect(() => {
      SevynOS.require("camera");
    }).not.toThrow();
  });
});
