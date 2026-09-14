import { describe, expect, it } from "vitest";
import { DeviceProfileRegistry, defineDeviceProfile } from "./device-profile.js";

const desktop = defineDeviceProfile({
  id: "desktop",
  name: "Desktop",
  priority: 10,
  match: { deviceClasses: ["desktop", "laptop"] },
  applications: [
    { applicationId: "org.sevynos.wallpaper", slot: "background", layer: 0 },
  ],
});

describe("DeviceProfileRegistry", () => {
  it("selects the highest-priority compatible profile", () => {
    const registry = new DeviceProfileRegistry();
    registry.register({ ...desktop, id: "fallback", priority: 1 });
    registry.register(desktop);
    expect(
      registry.select({
        deviceClass: "desktop",
        width: 1440,
        height: 900,
        pointer: "fine",
        keyboard: true,
        touch: false,
      }).id,
    ).toBe("desktop");
  });

  it("honors an explicit profile override for future devices", () => {
    const registry = new DeviceProfileRegistry();
    registry.register(desktop);
    expect(
      registry.select(
        {
          deviceClass: "automotive",
          width: 1920,
          height: 720,
          pointer: "coarse",
          keyboard: false,
          touch: true,
        },
        "desktop",
      ),
    ).toEqual(desktop);
  });

  it("rejects duplicate application mounts", () => {
    expect(() =>
      defineDeviceProfile({
        ...desktop,
        applications: [
          { applicationId: "org.sevynos.dock", slot: "dock", layer: 10 },
          { applicationId: "org.sevynos.dock", slot: "other", layer: 11 },
        ],
      }),
    ).toThrow(/more than once/);
  });
});
