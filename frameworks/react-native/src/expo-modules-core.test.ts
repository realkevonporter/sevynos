import { describe, expect, it, vi } from "vitest";
import { installNativeAdapters } from "./native-adapter-contracts.js";
import {
  PermissionStatus,
  requireNativeModule,
  requireOptionalNativeModule,
} from "./expo-modules-core.js";

describe("expo-modules-core compatibility", () => {
  it("resolves brokered native modules and reports optional absence", async () => {
    const invoke = vi.fn(async () => {
      await Promise.resolve();
      return { ready: true };
    });
    installNativeAdapters({ nativeModules: { invoke } });
    const module = requireNativeModule<{ ping(): Promise<unknown> }>("SevynTestModule");
    await expect(module.ping()).resolves.toEqual({ ready: true });
    expect(invoke).toHaveBeenCalledWith("SevynTestModule", "ping", []);
    expect(requireOptionalNativeModule("SevynTestModule")).toBeDefined();
    expect(PermissionStatus.GRANTED).toBe("granted");
  });
});
