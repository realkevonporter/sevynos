import {
  DeviceProfileRegistry,
  defineDeviceProfile,
  type DeviceDescriptor,
  type DeviceProfile,
} from "@sevynos/shell-core";
import { DeviceProfileId, SystemApplicationId } from "./identifiers.js";

export const DESKTOP_DEVICE_PROFILE = defineDeviceProfile({
  id: DeviceProfileId.Desktop,
  name: "Desktop",
  priority: 100,
  match: { deviceClasses: ["desktop", "laptop"] },
  applications: [
    mount(SystemApplicationId.Wallpaper, "background", 0),
    mount(SystemApplicationId.DesktopHome, "workspace", 10),
    mount(SystemApplicationId.Dock, "dock", 100),
    mount(SystemApplicationId.StatusBar, "status", 110),
    mount(SystemApplicationId.Launcher, "launcher", 200),
    mount(SystemApplicationId.WindowSwitcher, "overlay", 250),
    mount(SystemApplicationId.Notifications, "notifications", 300),
    mount(SystemApplicationId.LockScreen, "lock-screen", 400),
  ],
});

export const TABLET_DEVICE_PROFILE = defineDeviceProfile({
  id: DeviceProfileId.Tablet,
  name: "Tablet",
  priority: 100,
  match: { deviceClasses: ["tablet"] },
  applications: [
    mount(SystemApplicationId.Wallpaper, "background", 0),
    mount(SystemApplicationId.TabletHome, "workspace", 10),
    mount(SystemApplicationId.Dock, "dock", 100),
    mount(SystemApplicationId.StatusBar, "status", 110),
    mount(SystemApplicationId.SplitView, "multitasking", 150),
    mount(SystemApplicationId.Notifications, "notifications", 300),
    mount(SystemApplicationId.LockScreen, "lock-screen", 400),
  ],
});

export const MOBILE_DEVICE_PROFILE = defineDeviceProfile({
  id: DeviceProfileId.Mobile,
  name: "Mobile",
  priority: 100,
  match: { deviceClasses: ["mobile"] },
  applications: [
    mount(SystemApplicationId.Wallpaper, "background", 0),
    mount(SystemApplicationId.MobileHome, "workspace", 10),
    mount(SystemApplicationId.StatusBar, "status", 110),
    mount(SystemApplicationId.Dock, "dock", 120),
    mount(SystemApplicationId.AppDrawer, "app-drawer", 200),
    mount(SystemApplicationId.QuickSettings, "quick-settings", 250),
    mount(SystemApplicationId.Notifications, "notifications", 300),
    mount(SystemApplicationId.LockScreen, "lock-screen", 400),
  ],
});

export const BUILTIN_DEVICE_PROFILES: readonly DeviceProfile[] = Object.freeze([
  DESKTOP_DEVICE_PROFILE,
  TABLET_DEVICE_PROFILE,
  MOBILE_DEVICE_PROFILE,
]);

export function selectDeviceProfile(
  device: DeviceDescriptor,
  requestedProfileId?: string,
): DeviceProfile {
  const registry = new DeviceProfileRegistry();
  for (const profile of BUILTIN_DEVICE_PROFILES) registry.register(profile);
  return registry.select(device, requestedProfileId);
}

function mount(applicationId: string, slot: string, layer: number) {
  return Object.freeze({
    applicationId,
    slot,
    layer,
  });
}
