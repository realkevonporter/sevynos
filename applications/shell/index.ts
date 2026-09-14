import type { SystemApplicationModule } from "@sevynos/shell-core";
import { appDrawerSystemApplication } from "./app-drawer/index.js";
import { desktopHomeSystemApplication } from "./desktop-home/index.js";
import { dockSystemApplication } from "./dock/index.js";
import { launcherSystemApplication } from "./launcher/index.js";
import { lockScreenSystemApplication } from "./lock-screen/index.js";
import { mobileHomeSystemApplication } from "./mobile-home/index.js";
import { notificationsSystemApplication } from "./notifications/index.js";
import { quickSettingsSystemApplication } from "./quick-settings/index.js";
import { splitViewSystemApplication } from "./split-view/index.js";
import { statusBarSystemApplication } from "./status-bar/index.js";
import { tabletHomeSystemApplication } from "./tablet-home/index.js";
import { wallpaperSystemApplication } from "./wallpaper/index.js";
import { windowSwitcherSystemApplication } from "./window-switcher/index.js";

export { DeviceProfileId, SystemApplicationId } from "./identifiers.js";
export {
  BUILTIN_DEVICE_PROFILES,
  DESKTOP_DEVICE_PROFILE,
  MOBILE_DEVICE_PROFILE,
  TABLET_DEVICE_PROFILE,
  selectDeviceProfile,
} from "./profiles.js";
export { SevynShellTheme, type SevynShellThemeDefinition } from "./theme.js";
export {
  createReactNativeSystemApplication,
  createSystemApplication,
  systemApplicationManifest,
  type SystemApplicationOptions,
} from "./create-system-application.js";
export { dockSystemApplication } from "./dock/index.js";
export { launcherSystemApplication } from "./launcher/index.js";
export { statusBarSystemApplication } from "./status-bar/index.js";
export { wallpaperSystemApplication } from "./wallpaper/index.js";

export const BUILTIN_SYSTEM_APPLICATIONS: readonly SystemApplicationModule[] =
  Object.freeze([
    wallpaperSystemApplication,
    desktopHomeSystemApplication,
    tabletHomeSystemApplication,
    mobileHomeSystemApplication,
    dockSystemApplication,
    statusBarSystemApplication,
    launcherSystemApplication,
    appDrawerSystemApplication,
    notificationsSystemApplication,
    quickSettingsSystemApplication,
    lockScreenSystemApplication,
    splitViewSystemApplication,
    windowSwitcherSystemApplication,
  ]);
