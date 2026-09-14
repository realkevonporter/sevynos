import { describe, expect, it } from "vitest";
import { SystemApplicationRuntime } from "@sevynos/shell-core";
import { BUILTIN_SYSTEM_APPLICATIONS } from "./index.js";
import { selectDeviceProfile } from "./profiles.js";

describe("built-in shell profiles", () => {
  it.each([
    ["desktop", "org.sevynos.profile.desktop", 8],
    ["tablet", "org.sevynos.profile.tablet", 7],
    ["mobile", "org.sevynos.profile.mobile", 8],
  ] as const)("activates the %s profile", async (deviceClass, profileId, count) => {
    const runtime = new SystemApplicationRuntime();
    for (const application of BUILTIN_SYSTEM_APPLICATIONS) runtime.register(application);
    const device = {
      deviceClass,
      width: deviceClass === "mobile" ? 390 : 1280,
      height: deviceClass === "mobile" ? 844 : 800,
      pointer: deviceClass === "desktop" ? ("fine" as const) : ("coarse" as const),
      keyboard: deviceClass === "desktop",
      touch: deviceClass !== "desktop",
    };
    const profile = selectDeviceProfile(device);
    await runtime.activate(profile, device);
    expect(profile.id).toBe(profileId);
    expect(runtime.listRunning()).toHaveLength(count);
  });
});
