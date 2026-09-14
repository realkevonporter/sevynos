import type {
  GenesisScene,
  GenesisWindowId,
  WindowBounds,
  WindowSceneNode,
} from "@sevynos/graphics";
import type {
  DesktopBackgroundSceneNode,
  DesktopLauncherButtonSceneNode,
  DesktopLauncherEntrySceneNode,
  DesktopLauncherHeaderSceneNode,
  DesktopLauncherSearchSceneNode,
  DesktopLauncherSurfaceSceneNode,
  DesktopResetActionSceneNode,
  DesktopStatusBarSceneNode,
  DesktopSystemApplicationSceneNode,
  DesktopTaskbarApplicationSceneNode,
  DesktopTaskbarSceneNode,
  DesktopWorkspaceControlSceneNode,
  DesktopWorkspaceActionSceneNode,
  DesktopWorkspaceItemSceneNode,
  DesktopWindowSwitcherEntrySceneNode,
  DesktopLockScreenUnlockActionSceneNode,
} from "@sevynos/system-applications/desktop";
import type { CursorKind } from "@sevynos/input";
import type {
  DesktopApplicationSurface,
  SystemMonitorSnapshot,
} from "./application-surfaces.js";
import type { WindowControlRect } from "./window-controls.js";
import type { DesktopSettings } from "./desktop-settings.js";
import type { NativeRuntimeSnapshot } from "@sevynos/react-native/internal";

export interface DesktopViewport {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export interface DesktopWindowSceneNode {
  readonly kind: "desktop-window";
  readonly order: number;
  readonly base: WindowSceneNode;
  readonly windowId: GenesisWindowId;
  readonly title: string;
  readonly controls: readonly WindowControlRect[];
  readonly contentBounds: WindowBounds;
  readonly surface: DesktopApplicationSurface | undefined;
  readonly maximized: boolean;
  readonly systemMonitorSnapshot: SystemMonitorSnapshot | undefined;
  readonly settingsSnapshot: DesktopSettings | undefined;
  readonly nativeSurface: NativeRuntimeSnapshot | undefined;
  /** Visual transform applied during window animations (open/close/minimize/etc). */
  readonly animationTransform?:
    | {
        readonly opacity: number;
        readonly scaleX: number;
        readonly scaleY: number;
        readonly translateX: number;
        readonly translateY: number;
      }
    | undefined;
}

export type DesktopSettingsAction =
  | "installer-launch"
  | "theme"
  | "accent"
  | "taskbar-position"
  | "taskbar-behavior"
  | "display-layout"
  | "workspace-count"
  | "cursor-size"
  | "reduced-motion"
  | "restore-session";
export interface DesktopSettingsControlSceneNode {
  readonly kind: "desktop-settings-control";
  readonly order: number;
  readonly bounds: WindowBounds;
  readonly action: DesktopSettingsAction;
  readonly label: string;
}
export interface DesktopDiagnosticsControlSceneNode {
  readonly kind: "desktop-diagnostics-control";
  readonly order: number;
  readonly bounds: WindowBounds;
  readonly action: "clear" | "export" | "test";
  readonly label: string;
}
export interface DesktopRecoverySceneNode {
  readonly kind: "desktop-recovery";
  readonly order: number;
  readonly bounds: WindowBounds;
  readonly message: string;
}
export interface DesktopRecoveryControlSceneNode {
  readonly kind: "desktop-recovery-control";
  readonly order: number;
  readonly bounds: WindowBounds;
  readonly action: "reset" | "quit";
  readonly label: string;
}

export interface DesktopCursorSceneNode {
  readonly kind: "desktop-cursor";
  readonly order: number;
  readonly cursorKind: CursorKind;
  readonly position: { readonly x: number; readonly y: number };
  readonly visible: boolean;
}

export type DesktopSceneNode =
  | DesktopSystemApplicationSceneNode
  | DesktopWindowSceneNode
  | DesktopSettingsControlSceneNode
  | DesktopDiagnosticsControlSceneNode
  | DesktopRecoverySceneNode
  | DesktopRecoveryControlSceneNode
  | DesktopCursorSceneNode
  | DesktopWorkspaceActionSceneNode
  | DesktopWorkspaceItemSceneNode;

export interface DesktopScene {
  readonly base: GenesisScene;
  readonly viewport: DesktopViewport;
  readonly nodes: readonly DesktopSceneNode[];
  readonly settings: DesktopSettings;
}

export type {
  DesktopBackgroundSceneNode,
  DesktopLauncherButtonSceneNode,
  DesktopLauncherEntrySceneNode,
  DesktopLauncherHeaderSceneNode,
  DesktopLauncherSearchSceneNode,
  DesktopLauncherSurfaceSceneNode,
  DesktopResetActionSceneNode,
  DesktopStatusBarSceneNode,
  DesktopTaskbarApplicationSceneNode,
  DesktopTaskbarSceneNode,
  DesktopWorkspaceControlSceneNode,
  DesktopWorkspaceActionSceneNode,
  DesktopWorkspaceItemSceneNode,
  DesktopWindowSwitcherEntrySceneNode,
  DesktopLockScreenUnlockActionSceneNode,
};
