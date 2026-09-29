export interface DesktopShellBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Spacing tokens aligned with sevynTokens.spacing (xxs:4, xs:8, sm:12, md:16, lg:24, xl:32, xxl:48).
// The shell chrome uses these directly to avoid a dependency on @sevynos/react-native.
const SPACING_MD = 16;
const SPACING_LG = 24;
const SPACING_XL = 32;

export interface DesktopShellDisplay {
  readonly id: string;
  readonly bounds: DesktopShellBounds;
  readonly taskbarBounds: DesktopShellBounds;
}

export interface DesktopShellApplicationSummary {
  readonly applicationId: string;
  readonly label: string;
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly displayId: string;
  readonly pinned?: boolean | undefined;
  readonly running?: boolean | undefined;
}

export interface DesktopShellCatalogEntry {
  readonly applicationId: string;
  readonly label: string;
  readonly running: boolean;
}

export interface DesktopWallpaperRenderInput {
  readonly displays: readonly DesktopShellDisplay[];
}

export interface DesktopStatusBarRenderInput {
  readonly displays: readonly DesktopShellDisplay[];
  readonly activeWorkspace: string;
  readonly order: number;
  readonly timeText?: string | undefined;
  readonly dateText?: string | undefined;
  readonly wifiState?:
    ("connected" | "connecting" | "disconnected" | "unavailable") | undefined;
  readonly wifiSignal?: number | undefined;
  readonly wifiSsid?: string | undefined;
  readonly batteryAvailable?: boolean | undefined;
  readonly batteryPercent?: number | undefined;
  readonly batteryCharging?: boolean | undefined;
  readonly audioVolume?: number | undefined;
  readonly audioMuted?: boolean | undefined;
}

export interface DesktopDockRenderInput {
  readonly displays: readonly DesktopShellDisplay[];
  readonly position: "bottom" | "top" | "left" | "right";
  readonly applications: readonly DesktopShellApplicationSummary[];
  readonly activeWorkspace: string;
  readonly workspaces: readonly string[];
  readonly order: number;
}

export interface DesktopLauncherRenderInput {
  readonly open: boolean;
  readonly taskbarBounds: DesktopShellBounds;
  readonly displayBounds: DesktopShellBounds;
  readonly position: "bottom" | "top" | "left" | "right";
  readonly catalog: readonly DesktopShellCatalogEntry[];
  readonly order: number;
  readonly searchQuery?: string | undefined;
}

export interface DesktopWorkspaceRenderInput {
  readonly display: DesktopShellBounds;
  readonly entries: readonly {
    readonly name: string;
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  readonly order: number;
}

export interface DesktopWindowSwitcherRenderInput {
  readonly open: boolean;
  readonly displayBounds: DesktopShellBounds;
  readonly applications: readonly DesktopShellApplicationSummary[];
  readonly selectedApplicationId?: string | undefined;
  readonly order: number;
}

export interface DesktopLockScreenRenderInput {
  readonly displayBounds: DesktopShellBounds;
  readonly locked: boolean;
  readonly order: number;
  readonly timeText?: string | undefined;
  readonly dateText?: string | undefined;
  readonly username?: string | undefined;
}

export interface DesktopBackgroundSceneNode {
  readonly kind: "desktop-background";
  readonly order: 0;
  readonly bounds: DesktopShellBounds;
  readonly displayId: string;
}

export interface DesktopStatusBarSceneNode {
  readonly kind: "desktop-status-bar";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly displayId: string;
  readonly activeWorkspace: string;
  readonly timeText?: string | undefined;
  readonly dateText?: string | undefined;
  readonly wifiState?:
    ("connected" | "connecting" | "disconnected" | "unavailable") | undefined;
  readonly wifiSignal?: number | undefined;
  readonly wifiSsid?: string | undefined;
  readonly batteryAvailable?: boolean | undefined;
  readonly batteryPercent?: number | undefined;
  readonly batteryCharging?: boolean | undefined;
  readonly audioVolume?: number | undefined;
  readonly audioMuted?: boolean | undefined;
}

export interface DesktopTaskbarSceneNode {
  readonly kind: "desktop-taskbar";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly displayId: string;
  readonly activeWorkspace: string;
}

export interface DesktopLauncherButtonSceneNode {
  readonly kind: "desktop-launcher-button";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly open: boolean;
}

export interface DesktopLauncherSurfaceSceneNode {
  readonly kind: "desktop-launcher-surface";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
}

export interface DesktopLauncherHeaderSceneNode {
  readonly kind: "desktop-launcher-header";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly title: string;
}

export interface DesktopLauncherSearchSceneNode {
  readonly kind: "desktop-launcher-search";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly query: string;
  readonly placeholder: string;
}

export interface DesktopLauncherEntrySceneNode {
  readonly kind: "desktop-launcher-entry";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly applicationId: string;
  readonly label: string;
  readonly iconLabel: string;
  readonly running: boolean;
}

export interface DesktopTaskbarApplicationSceneNode {
  readonly kind: "desktop-taskbar-application";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly applicationId: string;
  readonly label: string;
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly pinned?: boolean | undefined;
  readonly running?: boolean | undefined;
}

export interface DesktopResetActionSceneNode {
  readonly kind: "desktop-reset-action";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly label: string;
}

export interface DesktopWorkspaceControlSceneNode {
  readonly kind: "desktop-workspace-control";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly workspaceId: string;
  readonly active: boolean;
}

export interface DesktopWindowSwitcherSurfaceSceneNode {
  readonly kind: "desktop-window-switcher-surface";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
}

export interface DesktopWindowSwitcherEntrySceneNode {
  readonly kind: "desktop-window-switcher-entry";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly applicationId: string;
  readonly label: string;
  readonly iconLabel: string;
  readonly selected: boolean;
}

export interface DesktopWorkspaceActionSceneNode {
  readonly kind: "desktop-workspace-action";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly action: "new-folder" | "new-file";
  readonly label: string;
}

export interface DesktopWorkspaceItemSceneNode {
  readonly kind: "desktop-workspace-item";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly path: string;
  readonly label: string;
  readonly itemKind: "file" | "directory";
}

export interface DesktopLockScreenSurfaceSceneNode {
  readonly kind: "desktop-lock-screen-surface";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
}

export interface DesktopLockScreenClockSceneNode {
  readonly kind: "desktop-lock-screen-clock";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly timeText: string;
  readonly dateText: string;
}

export interface DesktopLockScreenUnlockActionSceneNode {
  readonly kind: "desktop-lock-screen-unlock";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly label: string;
}

export type DesktopSystemApplicationSceneNode =
  | DesktopBackgroundSceneNode
  | DesktopStatusBarSceneNode
  | DesktopTaskbarSceneNode
  | DesktopLauncherButtonSceneNode
  | DesktopLauncherSurfaceSceneNode
  | DesktopLauncherHeaderSceneNode
  | DesktopLauncherSearchSceneNode
  | DesktopLauncherEntrySceneNode
  | DesktopTaskbarApplicationSceneNode
  | DesktopResetActionSceneNode
  | DesktopWorkspaceControlSceneNode
  | DesktopWindowSwitcherSurfaceSceneNode
  | DesktopWindowSwitcherEntrySceneNode
  | DesktopWorkspaceActionSceneNode
  | DesktopWorkspaceItemSceneNode
  | DesktopLockScreenSurfaceSceneNode
  | DesktopLockScreenClockSceneNode
  | DesktopLockScreenUnlockActionSceneNode
  | DesktopShellSurfaceSceneNode;

/**
 * Generic scene node for React Native shell components.
 * The `nativeSurface` carries the RN-rendered commands; the rasterizer
 * draws them via the standard native surface path.
 */
export interface DesktopShellSurfaceSceneNode {
  readonly kind: "desktop-shell-surface";
  readonly order: number;
  readonly bounds: DesktopShellBounds;
  readonly displayId: string;
  readonly applicationId: string;
  readonly nativeSurface:
    | {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        readonly commands: readonly any[];
      }
    | undefined;
}

export function renderDesktopWorkspace(
  input: DesktopWorkspaceRenderInput,
): readonly (DesktopWorkspaceActionSceneNode | DesktopWorkspaceItemSceneNode)[] {
  const actionY = input.display.y + 70;
  const iconTop = actionY + 52;
  const itemWidth = 104;
  const itemHeight = 92;
  const horizontalGap = 18;
  const verticalGap = 16;
  const columns = Math.max(
    1,
    Math.floor((input.display.width - 48) / (itemWidth + horizontalGap)),
  );
  const nodes: (DesktopWorkspaceActionSceneNode | DesktopWorkspaceItemSceneNode)[] = [
    Object.freeze({
      kind: "desktop-workspace-action",
      order: input.order,
      bounds: { x: input.display.x + 24, y: actionY, width: 132, height: 34 },
      action: "new-folder",
      label: "New folder",
    }),
    Object.freeze({
      kind: "desktop-workspace-action",
      order: input.order,
      bounds: { x: input.display.x + 164, y: actionY, width: 132, height: 34 },
      action: "new-file",
      label: "New text file",
    }),
  ];
  input.entries.forEach((entry, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    nodes.push(
      Object.freeze({
        kind: "desktop-workspace-item",
        order: input.order + 1,
        bounds: {
          x: input.display.x + 24 + column * (itemWidth + horizontalGap),
          y: iconTop + row * (itemHeight + verticalGap),
          width: itemWidth,
          height: itemHeight,
        },
        path: entry.path,
        label: entry.name,
        itemKind: entry.kind,
      }),
    );
  });
  return Object.freeze(nodes);
}

export function renderDesktopWallpaper(
  input: DesktopWallpaperRenderInput,
): readonly DesktopBackgroundSceneNode[] {
  return Object.freeze(
    input.displays.map((display) =>
      Object.freeze({
        kind: "desktop-background" as const,
        order: 0 as const,
        bounds: display.bounds,
        displayId: display.id,
      }),
    ),
  );
}

export function renderDesktopStatusBar(
  input: DesktopStatusBarRenderInput,
): readonly DesktopStatusBarSceneNode[] {
  return Object.freeze(
    input.displays.map((display) =>
      Object.freeze({
        kind: "desktop-status-bar" as const,
        order: input.order,
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: 28, // macOS menu bar height
        },
        displayId: display.id,
        activeWorkspace: input.activeWorkspace,
        ...(input.timeText !== undefined ? { timeText: input.timeText } : {}),
        ...(input.dateText !== undefined ? { dateText: input.dateText } : {}),
        ...(input.wifiState !== undefined ? { wifiState: input.wifiState } : {}),
        ...(input.wifiSignal !== undefined ? { wifiSignal: input.wifiSignal } : {}),
        ...(input.wifiSsid !== undefined ? { wifiSsid: input.wifiSsid } : {}),
        ...(input.batteryAvailable !== undefined
          ? { batteryAvailable: input.batteryAvailable }
          : {}),
        ...(input.batteryPercent !== undefined
          ? { batteryPercent: input.batteryPercent }
          : {}),
        ...(input.batteryCharging !== undefined
          ? { batteryCharging: input.batteryCharging }
          : {}),
        ...(input.audioVolume !== undefined ? { audioVolume: input.audioVolume } : {}),
        ...(input.audioMuted !== undefined ? { audioMuted: input.audioMuted } : {}),
      }),
    ),
  );
}

export function renderDesktopDock(
  input: DesktopDockRenderInput,
): readonly (
  | DesktopTaskbarSceneNode
  | DesktopTaskbarApplicationSceneNode
  | DesktopWorkspaceControlSceneNode
)[] {
  // macOS-style floating dock: centered, width based on icon count.
  // Each display gets its own floating dock.
  const taskbars = input.displays.map((display) => {
    const displayApps = input.applications.filter((app) => app.displayId === display.id);
    const dockBounds = getFloatingDockBounds(
      display.taskbarBounds,
      displayApps.length,
      input.workspaces.length,
      input.position,
    );
    return Object.freeze({
      kind: "desktop-taskbar" as const,
      order: input.order,
      bounds: dockBounds,
      displayId: display.id,
      activeWorkspace: input.activeWorkspace,
    });
  });
  const applications = input.applications.flatMap((application) => {
    const display = input.displays.find(
      (candidate) => candidate.id === application.displayId,
    );
    if (display === undefined) return [];
    const displayApplications = input.applications.filter(
      (candidate) => candidate.displayId === application.displayId,
    );
    const index = displayApplications.indexOf(application);
    const dockBounds = getFloatingDockBounds(
      display.taskbarBounds,
      displayApplications.length,
      input.workspaces.length,
      input.position,
    );
    return [
      Object.freeze({
        kind: "desktop-taskbar-application" as const,
        order: input.order + 1,
        bounds: runningApplicationBounds(dockBounds, input.position, index),
        applicationId: application.applicationId,
        label: application.label,
        focused: application.focused,
        minimized: application.minimized,
        ...(application.pinned !== undefined ? { pinned: application.pinned } : {}),
        running: application.running ?? (application.focused || application.minimized),
      }),
    ];
  });
  const workspaces = input.displays.flatMap((display) => {
    const displayApps = input.applications.filter((app) => app.displayId === display.id);
    const dockBounds = getFloatingDockBounds(
      display.taskbarBounds,
      displayApps.length,
      input.workspaces.length,
      input.position,
    );
    return input.workspaces.map((workspaceId, index) =>
      Object.freeze({
        kind: "desktop-workspace-control" as const,
        order: input.order + 1,
        bounds: workspaceBounds(dockBounds, input.position, index),
        workspaceId,
        active: workspaceId === input.activeWorkspace,
      }),
    );
  });
  return Object.freeze([...taskbars, ...applications, ...workspaces]);
}

/**
 * Calculate macOS-style floating dock bounds: centered horizontally,
 * width based on icon count, 8px from bottom edge.
 */
function getFloatingDockBounds(
  taskbarBounds: DesktopShellBounds,
  iconCount: number,
  workspaceCount = 0,
  position: DesktopDockRenderInput["position"] = "bottom",
): DesktopShellBounds {
  const tilePitch = 54; // 44px tile + 10px gap (matches PR #20)
  const workspacePitch = 32; // workspace indicator width + gap
  const dividerWidth = 20; // divider between apps and workspaces
  const horizontalPadding = 16;
  const dockWidth = Math.max(
    80, // minimum width for empty dock
    iconCount * tilePitch +
      (workspaceCount > 0 ? dividerWidth + workspaceCount * workspacePitch : 0) +
      horizontalPadding * 2,
  );
  const dockHeight = 60;
  const margin = 8;

  // Position the floating dock based on taskbar position
  switch (position) {
    case "top":
      return {
        x: Math.round(taskbarBounds.x + (taskbarBounds.width - dockWidth) / 2),
        y: taskbarBounds.y + margin,
        width: dockWidth,
        height: dockHeight,
      };
    case "left":
      return {
        x: taskbarBounds.x + margin,
        y: Math.round(taskbarBounds.y + (taskbarBounds.height - dockHeight) / 2),
        width: dockWidth,
        height: dockHeight,
      };
    case "right":
      return {
        x: taskbarBounds.x + taskbarBounds.width - dockWidth - margin,
        y: Math.round(taskbarBounds.y + (taskbarBounds.height - dockHeight) / 2),
        width: dockWidth,
        height: dockHeight,
      };
    case "bottom":
    default:
      return {
        x: Math.round(taskbarBounds.x + (taskbarBounds.width - dockWidth) / 2),
        y: taskbarBounds.y + taskbarBounds.height - dockHeight - margin,
        width: dockWidth,
        height: dockHeight,
      };
  }
}

export function renderDesktopLauncher(
  input: DesktopLauncherRenderInput,
): readonly (
  | DesktopLauncherButtonSceneNode
  | DesktopLauncherSurfaceSceneNode
  | DesktopLauncherHeaderSceneNode
  | DesktopLauncherSearchSceneNode
  | DesktopLauncherEntrySceneNode
  | DesktopResetActionSceneNode
)[] {
  const launcherButton = Object.freeze({
    kind: "desktop-launcher-button" as const,
    order: input.order + 3,
    bounds: launcherButtonBounds(input.taskbarBounds, input.position),
    open: input.open,
  });
  if (!input.open) return Object.freeze([launcherButton]);

  const layout = launcherLayout(input.displayBounds);
  const query = input.searchQuery?.trim().toLocaleLowerCase() ?? "";
  const catalog = input.catalog.filter((entry) =>
    matchesLauncherSearch(entry.label, entry.applicationId, query),
  );

  const nodes: (
    | DesktopLauncherButtonSceneNode
    | DesktopLauncherSurfaceSceneNode
    | DesktopLauncherHeaderSceneNode
    | DesktopLauncherSearchSceneNode
    | DesktopLauncherEntrySceneNode
    | DesktopResetActionSceneNode
  )[] = [
    Object.freeze({
      kind: "desktop-launcher-surface",
      order: input.order,
      bounds: layout.surface,
    }),
    Object.freeze({
      kind: "desktop-launcher-header",
      order: input.order + 1,
      bounds: layout.header,
      title: "Applications",
    }),
    Object.freeze({
      kind: "desktop-launcher-search",
      order: input.order + 1,
      bounds: layout.search,
      query: input.searchQuery ?? "",
      placeholder: "Search applications",
    }),
    ...catalog.map((entry, index) =>
      Object.freeze({
        kind: "desktop-launcher-entry" as const,
        order: input.order + 2,
        bounds: launcherGridEntryBounds(layout.grid, index),
        applicationId: entry.applicationId,
        label: entry.label,
        iconLabel: applicationIconLabel(entry.label),
        running: entry.running,
      }),
    ),
    Object.freeze({
      kind: "desktop-reset-action",
      order: input.order + 2,
      bounds: layout.reset,
      label: "Reset Desktop",
    }),
    launcherButton,
  ];

  return Object.freeze(nodes);
}

export function renderDesktopWindowSwitcher(
  input: DesktopWindowSwitcherRenderInput,
): readonly (
  DesktopWindowSwitcherSurfaceSceneNode | DesktopWindowSwitcherEntrySceneNode
)[] {
  if (!input.open || input.applications.length === 0) return Object.freeze([]);

  const margin = SPACING_XL;
  const itemWidth = 140;
  const itemHeight = 140;
  const gap = SPACING_MD;
  const maxColumns = 6;
  const columns = Math.min(input.applications.length, maxColumns);
  const rows = Math.ceil(input.applications.length / maxColumns);

  const contentWidth = columns * itemWidth + (columns - 1) * gap;
  const contentHeight = rows * itemHeight + (rows - 1) * gap;

  const surfaceWidth = contentWidth + margin * 2;
  const surfaceHeight = contentHeight + margin * 2;

  const surfaceBounds = {
    x: input.displayBounds.x + (input.displayBounds.width - surfaceWidth) / 2,
    y: input.displayBounds.y + (input.displayBounds.height - surfaceHeight) / 2,
    width: surfaceWidth,
    height: surfaceHeight,
  };

  const nodes: (
    DesktopWindowSwitcherSurfaceSceneNode | DesktopWindowSwitcherEntrySceneNode
  )[] = [
    Object.freeze({
      kind: "desktop-window-switcher-surface",
      order: input.order,
      bounds: surfaceBounds,
    }),
  ];

  input.applications.forEach((app, index) => {
    const row = Math.floor(index / maxColumns);
    const col = index % maxColumns;

    // If it's the last row, center it if there are fewer items than maxColumns
    const itemsInRow =
      row === rows - 1 ? input.applications.length - row * maxColumns : maxColumns;
    const rowWidth = itemsInRow * itemWidth + (itemsInRow - 1) * gap;
    const startX = surfaceBounds.x + margin + (contentWidth - rowWidth) / 2;

    nodes.push(
      Object.freeze({
        kind: "desktop-window-switcher-entry",
        order: input.order + 1,
        bounds: {
          x: startX + col * (itemWidth + gap),
          y: surfaceBounds.y + margin + row * (itemHeight + gap),
          width: itemWidth,
          height: itemHeight,
        },
        applicationId: app.applicationId,
        label: app.label,
        iconLabel: applicationIconLabel(app.label),
        selected: app.applicationId === input.selectedApplicationId,
      }),
    );
  });

  return Object.freeze(nodes);
}

interface DesktopLauncherLayout {
  readonly surface: DesktopShellBounds;
  readonly header: DesktopShellBounds;
  readonly search: DesktopShellBounds;
  readonly grid: DesktopShellBounds;
  readonly reset: DesktopShellBounds;
}

function launcherLayout(display: DesktopShellBounds): DesktopLauncherLayout {
  const margin = SPACING_LG;
  const bottomInset = margin + 72;
  const surface = {
    x: display.x,
    y: display.y,
    width: display.width,
    height: display.height,
  };
  const contentWidth = Math.max(0, surface.width - margin * 2);
  const searchWidth = Math.min(560, contentWidth);
  return Object.freeze({
    surface,
    header: {
      x: surface.x + margin,
      y: surface.y + margin,
      width: contentWidth,
      height: 42,
    },
    search: {
      x: surface.x + Math.max(margin, (surface.width - searchWidth) / 2),
      y: surface.y + margin + 52,
      width: searchWidth,
      height: 46,
    },
    grid: {
      x: surface.x + margin,
      y: surface.y + margin + 122,
      width: contentWidth,
      height: Math.max(0, surface.height - margin - bottomInset - 178),
    },
    reset: {
      x: surface.x + margin,
      y: surface.y + surface.height - bottomInset - 40,
      width: Math.min(180, contentWidth),
      height: 40,
    },
  });
}

function launcherGridEntryBounds(
  grid: DesktopShellBounds,
  index: number,
): DesktopShellBounds {
  const minimumTileWidth = 112;
  const maximumColumns = 8;
  const gap = SPACING_MD;
  const columns = Math.max(
    1,
    Math.min(maximumColumns, Math.floor((grid.width + gap) / (minimumTileWidth + gap))),
  );
  const tileWidth = Math.floor((grid.width - gap * (columns - 1)) / columns);
  const tileHeight = 112;
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    x: grid.x + column * (tileWidth + gap),
    y: grid.y + row * (tileHeight + gap),
    width: tileWidth,
    height: tileHeight,
  };
}

function applicationIconLabel(label: string): string {
  const lower = label.toLocaleLowerCase();
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "WB";
  if (lower.includes("file")) return "FL";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "SM";
  if (lower.includes("note")) return "NT";
  if (lower.includes("gallery")) return "UI";
  const words = label.trim().split(/\s+/u).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word.slice(0, 1).toLocaleUpperCase())
      .join("") || "•"
  );
}

function launcherButtonBounds(
  taskbar: DesktopShellBounds,
  position: DesktopLauncherRenderInput["position"],
): DesktopShellBounds {
  if (position === "left" || position === "right")
    return { x: taskbar.x + 6, y: taskbar.y + 10, width: 40, height: 42 };
  const dockWidth = Math.min(taskbar.width - 48, 760);
  const dockX = Math.round(taskbar.x + (taskbar.width - dockWidth) / 2);
  return { x: dockX + 10, y: taskbar.y + 6, width: 40, height: 40 };
}

function runningApplicationBounds(
  dockBounds: DesktopShellBounds,
  position: DesktopDockRenderInput["position"],
  index: number,
): DesktopShellBounds {
  if (position === "left" || position === "right")
    return {
      x: dockBounds.x + 6,
      y: dockBounds.y + 60 + index * 48,
      width: 40,
      height: 40,
    };
  // Icons are laid out left-to-right within the floating dock, with padding.
  const tileWidth = 44;
  const tileHeight = 44;
  const horizontalPadding = 16;
  const tilePitch = 54;
  return {
    x: dockBounds.x + horizontalPadding + index * tilePitch,
    y: dockBounds.y + Math.round((dockBounds.height - tileHeight) / 2),
    width: tileWidth,
    height: tileHeight,
  };
}

function workspaceBounds(
  dockBounds: DesktopShellBounds,
  position: DesktopDockRenderInput["position"],
  index: number,
): DesktopShellBounds {
  if (position === "left" || position === "right")
    return {
      x: dockBounds.x + 14,
      y: dockBounds.y + dockBounds.height - 132 + index * 28,
      width: 24,
      height: 24,
    };
  // Workspace indicators at the right end of the floating dock.
  return {
    x: dockBounds.x + dockBounds.width - 16 - 22 - index * 26,
    y: dockBounds.y + Math.round((dockBounds.height - 22) / 2),
    width: 22,
    height: 22,
  };
}

export function getApplicationAliases(
  label: string,
  applicationId: string,
): readonly string[] {
  const aliases: string[] = [];
  const lowerLabel = label.toLocaleLowerCase();
  const lowerId = applicationId.toLocaleLowerCase();

  if (lowerLabel.includes("browser") || lowerId.includes("browser")) {
    aliases.push("web", "internet", "http", "www", "chrome", "firefox");
  }
  if (
    lowerLabel.includes("terminal") ||
    lowerLabel.includes("console") ||
    lowerId.includes("terminal")
  ) {
    aliases.push("cmd", "command", "bash", "sh", "zsh", "prompt", "shell");
  }
  if (lowerLabel.includes("file") || lowerId.includes("files")) {
    aliases.push("folder", "directory", "storage", "documents", "explorer");
  }
  if (lowerLabel.includes("setting") || lowerId.includes("settings")) {
    aliases.push(
      "preference",
      "config",
      "control",
      "appearance",
      "wifi",
      "sound",
      "theme",
    );
  }
  if (lowerLabel.includes("note") || lowerId.includes("note")) {
    aliases.push("text", "memo", "doc", "write", "pad", "scratchpad");
  }
  if (lowerLabel.includes("monitor") || lowerId.includes("system-monitor")) {
    aliases.push(
      "task",
      "process",
      "cpu",
      "ram",
      "memory",
      "perf",
      "performance",
      "activity",
    );
  }
  if (lowerLabel.includes("welcome") || lowerId.includes("welcome")) {
    aliases.push("start", "intro", "guide", "tutorial", "help");
  }
  if (lowerLabel.includes("camera") || lowerId.includes("camera")) {
    aliases.push("webcam", "photo", "video", "record", "booth", "picture", "snapshot");
  }
  if (
    lowerLabel.includes("studio") ||
    lowerId.includes("studio") ||
    lowerLabel.includes("ide")
  ) {
    aliases.push("code", "develop", "dev", "editor", "programming");
  }
  if (lowerLabel.includes("music") || lowerId.includes("music")) {
    aliases.push(
      "audio",
      "song",
      "songs",
      "player",
      "sound",
      "mp3",
      "flac",
      "tune",
      "playlist",
      "track",
    );
  }
  return aliases;
}

export function matchesLauncherSearch(
  label: string,
  applicationId: string,
  query: string | undefined,
): boolean {
  if (query === undefined) return true;
  const trimmed = query.trim().toLocaleLowerCase();
  if (trimmed.length === 0) return true;

  if (label.toLocaleLowerCase().includes(trimmed)) return true;
  if (applicationId.toLocaleLowerCase().includes(trimmed)) return true;

  const aliases = getApplicationAliases(label, applicationId);
  return aliases.some((alias) => alias.includes(trimmed));
}

export function renderDesktopLockScreen(
  input: DesktopLockScreenRenderInput,
): readonly (
  | DesktopLockScreenSurfaceSceneNode
  | DesktopLockScreenClockSceneNode
  | DesktopLockScreenUnlockActionSceneNode
)[] {
  if (!input.locked) return Object.freeze([]);

  const bounds = input.displayBounds;
  const cardWidth = 400;
  const cardHeight = 360;
  const cardX = bounds.x + (bounds.width - cardWidth) / 2;
  const cardY = bounds.y + (bounds.height - cardHeight) / 2;

  const surfaceNode: DesktopLockScreenSurfaceSceneNode = Object.freeze({
    kind: "desktop-lock-screen-surface",
    order: input.order,
    bounds: input.displayBounds,
  });

  const clockNode: DesktopLockScreenClockSceneNode = Object.freeze({
    kind: "desktop-lock-screen-clock",
    order: input.order + 1,
    bounds: {
      x: cardX,
      y: cardY - 100,
      width: cardWidth,
      height: 80,
    },
    timeText: input.timeText ?? "12:00",
    dateText: input.dateText ?? "SevynOS",
  });

  const unlockNode: DesktopLockScreenUnlockActionSceneNode = Object.freeze({
    kind: "desktop-lock-screen-unlock",
    order: input.order + 2,
    bounds: {
      x: cardX + 50,
      y: cardY + 260,
      width: cardWidth - 100,
      height: 48,
    },
    label: "Unlock",
  });

  return Object.freeze([surfaceNode, clockNode, unlockNode]);
}
