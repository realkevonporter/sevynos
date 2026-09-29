/**
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import type { ComponentType } from "react";
import { SystemApplicationId } from "@sevynos/system-applications";
import { DesktopWallpaper } from "@sevynos/system-applications/desktop/wallpaper";
import { DesktopStatusBar } from "@sevynos/system-applications/desktop/status-bar";
import { DesktopDock } from "@sevynos/system-applications/desktop/dock";
import { DesktopLauncher } from "@sevynos/system-applications/desktop/launcher";
import { DesktopWindowSwitcher } from "@sevynos/system-applications/desktop/window-switcher";
import { DesktopLockScreen } from "@sevynos/system-applications/desktop/lock-screen";
import { DesktopWorkspace } from "@sevynos/system-applications/desktop/desktop-home";
import { WindowChrome } from "@sevynos/system-applications/desktop/window-chrome";
import { DesktopNotifications } from "@sevynos/system-applications/desktop/notifications";
import { DesktopQuickSettings } from "@sevynos/system-applications/desktop/quick-settings";
import { DesktopAppDrawer } from "@sevynos/system-applications/desktop/app-drawer";

/**
 * React Native shell components keyed by application ID.
 *
 * This module statically imports the desktop components, which pull in
 * `react-native`. It is loaded only by the real host entrypoint (wayland.ts);
 * unit tests never import it, so `react-native` stays out of the test bundle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ShellComponent = ComponentType<any>;
export function createShellComponentRegistry(): ReadonlyMap<string, ShellComponent> {
  const entries: [string, ShellComponent][] = [
    [SystemApplicationId.Wallpaper, DesktopWallpaper],
    [SystemApplicationId.StatusBar, DesktopStatusBar],
    [SystemApplicationId.Dock, DesktopDock],
    [SystemApplicationId.Launcher, DesktopLauncher],
    [SystemApplicationId.WindowSwitcher, DesktopWindowSwitcher],
    [SystemApplicationId.LockScreen, DesktopLockScreen],
    [SystemApplicationId.DesktopHome, DesktopWorkspace],
    [SystemApplicationId.WindowChrome, WindowChrome],
    [SystemApplicationId.Notifications, DesktopNotifications],
    [SystemApplicationId.QuickSettings, DesktopQuickSettings],
    [SystemApplicationId.AppDrawer, DesktopAppDrawer],
  ];
  return new Map(entries);
}
