import type {
  DesktopLauncherButtonSceneNode,
  DesktopLauncherEntrySceneNode,
  DesktopLauncherSearchSceneNode,
  DesktopScene,
  DesktopResetActionSceneNode,
  DesktopTaskbarApplicationSceneNode,
  DesktopWorkspaceControlSceneNode,
  DesktopSettingsControlSceneNode,
  DesktopDiagnosticsControlSceneNode,
  DesktopRecoveryControlSceneNode,
  DesktopWorkspaceActionSceneNode,
  DesktopWorkspaceItemSceneNode,
  DesktopWindowSwitcherEntrySceneNode,
  DesktopLockScreenUnlockActionSceneNode,
} from "./desktop-scene.js";

export type DesktopSceneControlNode =
  | DesktopLauncherButtonSceneNode
  | DesktopLauncherEntrySceneNode
  | DesktopLauncherSearchSceneNode
  | DesktopTaskbarApplicationSceneNode
  | DesktopResetActionSceneNode
  | DesktopWorkspaceControlSceneNode
  | DesktopSettingsControlSceneNode
  | DesktopDiagnosticsControlSceneNode
  | DesktopRecoveryControlSceneNode
  | DesktopWorkspaceActionSceneNode
  | DesktopWorkspaceItemSceneNode
  | DesktopWindowSwitcherEntrySceneNode
  | DesktopLockScreenUnlockActionSceneNode;

export function hitTestDesktopSceneControl(
  scene: DesktopScene | undefined,
  x: number,
  y: number,
): DesktopSceneControlNode | undefined {
  const controls =
    scene?.nodes.filter(
      (node): node is DesktopSceneControlNode =>
        node.kind === "desktop-launcher-button" ||
        node.kind === "desktop-launcher-entry" ||
        node.kind === "desktop-launcher-search" ||
        node.kind === "desktop-taskbar-application" ||
        node.kind === "desktop-reset-action" ||
        node.kind === "desktop-workspace-control" ||
        node.kind === "desktop-settings-control" ||
        node.kind === "desktop-diagnostics-control" ||
        node.kind === "desktop-recovery-control" ||
        node.kind === "desktop-workspace-action" ||
        node.kind === "desktop-workspace-item" ||
        node.kind === "desktop-window-switcher-entry" ||
        node.kind === "desktop-lock-screen-unlock",
    ) ?? [];
  // When the launcher is open (modal overlay), prioritize launcher nodes
  // over dock/taskbar nodes that might geometrically overlap.
  // Note: the array is reversed below, so launcher nodes go last here
  // to be checked first.
  const hasLauncherEntries = controls.some(
    (node) => node.kind === "desktop-launcher-entry",
  );
  const prioritized = hasLauncherEntries
    ? [
        ...controls.filter((node) => !node.kind.startsWith("desktop-launcher")),
        ...controls.filter((node) => node.kind.startsWith("desktop-launcher")),
      ]
    : controls;
  return [...prioritized]
    .reverse()
    .find(
      (node) =>
        x >= node.bounds.x &&
        x < node.bounds.x + node.bounds.width &&
        y >= node.bounds.y &&
        y < node.bounds.y + node.bounds.height,
    );
}
