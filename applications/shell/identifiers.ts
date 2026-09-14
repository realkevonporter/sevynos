export const SystemApplicationId = Object.freeze({
  DesktopHome: "org.sevynos.shell.desktop-home",
  TabletHome: "org.sevynos.shell.tablet-home",
  MobileHome: "org.sevynos.shell.mobile-home",
  Wallpaper: "org.sevynos.shell.wallpaper",
  Dock: "org.sevynos.shell.dock",
  StatusBar: "org.sevynos.shell.status-bar",
  Launcher: "org.sevynos.shell.launcher",
  AppDrawer: "org.sevynos.shell.app-drawer",
  Notifications: "org.sevynos.shell.notifications",
  QuickSettings: "org.sevynos.shell.quick-settings",
  LockScreen: "org.sevynos.shell.lock-screen",
  SplitView: "org.sevynos.shell.split-view",
  WindowSwitcher: "org.sevynos.shell.window-switcher",
} as const);

export const DeviceProfileId = Object.freeze({
  Desktop: "org.sevynos.profile.desktop",
  Tablet: "org.sevynos.profile.tablet",
  Mobile: "org.sevynos.profile.mobile",
} as const);
