import { describe, expect, it, vi } from "vitest";
import { installNativeAdapters } from "./native-adapter-contracts.js";
import { NativeModules } from "./native-modules.js";

describe("upstream NativeModules hardware bridge", () => {
  it("routes hardware modules through installed host adapters", async () => {
    const capture = vi.fn(async () => await Promise.resolve({ path: "/tmp/frame.jpg" }));
    const scan = vi.fn(async () => await Promise.resolve([{ name: "Keyboard" }]));
    installNativeAdapters({ camera: { capture }, bluetooth: { scan } });
    await expect(NativeModules.HardwareModules.camera.capture()).resolves.toEqual({
      path: "/tmp/frame.jpg",
    });
    await expect(NativeModules.HardwareModules.bluetooth.scan()).resolves.toEqual([
      { name: "Keyboard" },
    ]);
    expect(capture).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledOnce();
  });
});
