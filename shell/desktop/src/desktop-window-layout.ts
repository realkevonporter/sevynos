import type {
  GenesisWindowId,
  GenesisWindowManager,
  WindowBounds,
} from "@sevynos/graphics";
import type {
  DesktopEnvironment,
  DesktopHostDisplayConfiguration,
} from "./desktop-environment.js";

export interface DesktopWindowLayoutPreferences {
  readonly preferredWidth: number;
  readonly preferredHeight: number;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
  readonly maximumWidthRatio?: number;
  readonly maximumHeightRatio?: number;
}

interface WindowLayoutSnapshot {
  readonly windowId: GenesisWindowId;
  readonly bounds: WindowBounds;
  readonly displayId: string;
  readonly workspace: WindowBounds;
  readonly maximized: boolean;
}

export interface DesktopLayoutSnapshot {
  readonly windows: readonly WindowLayoutSnapshot[];
}

const WINDOW_MARGIN = 16;
const CASCADE_OFFSET = 28;
const CASCADE_STEPS = 6;

export class DesktopWindowLayoutManager {
  public constructor(
    readonly windows: GenesisWindowManager,
    readonly environment: DesktopEnvironment,
    readonly maximized: (windowId: GenesisWindowId) => boolean,
    readonly updateRestoreBounds: (
      windowId: GenesisWindowId,
      bounds: WindowBounds,
    ) => void,
  ) {}

  public initialBounds(preferences: DesktopWindowLayoutPreferences): WindowBounds {
    const workspace = this.#primaryWorkspace();
    const availableWidth = Math.max(1, workspace.width - WINDOW_MARGIN * 2);
    const availableHeight = Math.max(1, workspace.height - WINDOW_MARGIN * 2);
    const minimumWidth = Math.min(preferences.minimumWidth, availableWidth);
    const minimumHeight = Math.min(preferences.minimumHeight, availableHeight);
    const maximumWidth = Math.min(
      availableWidth,
      Math.max(minimumWidth, workspace.width * (preferences.maximumWidthRatio ?? 0.76)),
    );
    const maximumHeight = Math.min(
      availableHeight,
      Math.max(
        minimumHeight,
        workspace.height * (preferences.maximumHeightRatio ?? 0.82),
      ),
    );
    const width = clamp(preferences.preferredWidth, minimumWidth, maximumWidth);
    const height = clamp(preferences.preferredHeight, minimumHeight, maximumHeight);
    const activeWindowCount = this.windows
      .listWindows()
      .filter(
        (window) =>
          window.state !== "closed" &&
          window.state !== "closing" &&
          this.environment.getWindowWorkspace(window.id) ===
            this.environment.activeWorkspace,
      ).length;
    const cascade = (activeWindowCount % CASCADE_STEPS) * CASCADE_OFFSET;
    return constrainToWorkspace(
      {
        x: workspace.x + (workspace.width - width) / 2 + cascade,
        y: workspace.y + (workspace.height - height) / 2 + cascade,
        width,
        height,
      },
      workspace,
    );
  }

  public capture(): DesktopLayoutSnapshot {
    return Object.freeze({
      windows: Object.freeze(
        this.windows
          .listWindows()
          .filter((window) => window.state !== "closed" && window.state !== "closing")
          .map((window) => {
            const display = this.environment.getDisplayForBounds(window.bounds);
            return Object.freeze({
              windowId: window.id,
              bounds: Object.freeze({ ...window.bounds }),
              displayId: display.id,
              workspace: Object.freeze({ ...display.workArea }),
              maximized: this.maximized(window.id),
            });
          }),
      ),
    });
  }

  public configureHostDisplays(
    configurations: readonly DesktopHostDisplayConfiguration[],
  ): void {
    const previous = this.capture();
    this.environment.configureHostDisplays(configurations);
    this.reflow(previous);
  }

  public configureViewport(
    width: number,
    height: number,
    scaleFactor: number,
    mode = this.environment.layoutMode,
  ): void {
    const previous = this.capture();
    this.environment.configure(width, height, scaleFactor, mode);
    this.reflow(previous);
  }

  public reflow(snapshot: DesktopLayoutSnapshot): void {
    const displays = this.environment.listDisplays();
    const primary = displays.find((display) => display.primary) ?? displays[0];
    if (primary === undefined) return;
    for (const saved of snapshot.windows) {
      const window = this.windows.getWindow(saved.windowId);
      if (window === undefined || window.state === "closed" || window.state === "closing")
        continue;
      const destination =
        displays.find((display) => display.id === saved.displayId) ?? primary;
      if (saved.maximized) {
        this.windows.resizeWindow({
          windowId: saved.windowId,
          bounds: destination.workArea,
        });
        this.updateRestoreBounds(
          saved.windowId,
          mapBounds(saved.bounds, saved.workspace, destination.workArea),
        );
        continue;
      }
      this.windows.resizeWindow({
        windowId: saved.windowId,
        bounds: mapBounds(saved.bounds, saved.workspace, destination.workArea),
      });
    }
  }

  #primaryWorkspace(): WindowBounds {
    const displays = this.environment.listDisplays();
    const primary = displays.find((display) => display.primary) ?? displays[0];
    if (primary === undefined)
      throw new Error("A display is required for window layout.");
    return primary.workArea;
  }
}

export function mapBounds(
  bounds: WindowBounds,
  sourceWorkspace: WindowBounds,
  targetWorkspace: WindowBounds,
): WindowBounds {
  const widthRatio = targetWorkspace.width / sourceWorkspace.width;
  const heightRatio = targetWorkspace.height / sourceWorkspace.height;
  const sizeScale = Math.min(widthRatio, heightRatio);
  return constrainToWorkspace(
    {
      x: targetWorkspace.x + (bounds.x - sourceWorkspace.x) * widthRatio,
      y: targetWorkspace.y + (bounds.y - sourceWorkspace.y) * heightRatio,
      width: bounds.width * sizeScale,
      height: bounds.height * sizeScale,
    },
    targetWorkspace,
  );
}

export function constrainToWorkspace(
  bounds: WindowBounds,
  workspace: WindowBounds,
): WindowBounds {
  const width = Math.min(Math.max(1, Math.round(bounds.width)), workspace.width);
  const height = Math.min(Math.max(1, Math.round(bounds.height)), workspace.height);
  return Object.freeze({
    x: Math.round(
      Math.min(Math.max(bounds.x, workspace.x), workspace.x + workspace.width - width),
    ),
    y: Math.round(
      Math.min(Math.max(bounds.y, workspace.y), workspace.y + workspace.height - height),
    ),
    width,
    height,
  });
}

export function getTaskbarBounds(
  bounds: WindowBounds,
  position: "bottom" | "top" | "left" | "right",
): WindowBounds {
  if (position === "top")
    return { x: bounds.x + 12, y: bounds.y + 12, width: bounds.width - 24, height: 52 };
  if (position === "left")
    return { x: bounds.x + 12, y: bounds.y + 12, width: 52, height: bounds.height - 24 };
  if (position === "right")
    return {
      x: bounds.x + bounds.width - 64,
      y: bounds.y + 12,
      width: 52,
      height: bounds.height - 24,
    };
  return {
    x: bounds.x + 12,
    y: bounds.y + bounds.height - 88,
    width: bounds.width - 24,
    height: 76,
  };
}

export function getWorkspaceBounds(
  display: WindowBounds,
  position: "bottom" | "top" | "left" | "right",
): WindowBounds {
  const taskbar = getTaskbarBounds(display, position);
  if (position === "top") {
    const y = taskbar.y + taskbar.height + 8;
    return {
      x: display.x,
      y,
      width: display.width,
      height: display.y + display.height - y,
    };
  }
  if (position === "left") {
    const x = taskbar.x + taskbar.width + 8;
    return {
      x,
      y: display.y,
      width: display.x + display.width - x,
      height: display.height,
    };
  }
  if (position === "right")
    return {
      x: display.x,
      y: display.y,
      width: taskbar.x - display.x - 8,
      height: display.height,
    };
  return {
    x: display.x,
    y: display.y,
    width: display.width,
    height: taskbar.y - display.y - 8,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.round(Math.max(minimum, Math.min(maximum, value)));
}

export type WindowSnapTarget =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export function calculateSnapBounds(
  workArea: WindowBounds,
  target: WindowSnapTarget,
): WindowBounds {
  const halfWidth = Math.round(workArea.width / 2);
  const halfHeight = Math.round(workArea.height / 2);
  const remainingWidth = workArea.width - halfWidth;
  const remainingHeight = workArea.height - halfHeight;

  switch (target) {
    case "left":
      return Object.freeze({
        x: workArea.x,
        y: workArea.y,
        width: halfWidth,
        height: workArea.height,
      });
    case "right":
      return Object.freeze({
        x: workArea.x + halfWidth,
        y: workArea.y,
        width: remainingWidth,
        height: workArea.height,
      });
    case "top":
      return Object.freeze({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: halfHeight,
      });
    case "bottom":
      return Object.freeze({
        x: workArea.x,
        y: workArea.y + halfHeight,
        width: workArea.width,
        height: remainingHeight,
      });
    case "top-left":
      return Object.freeze({
        x: workArea.x,
        y: workArea.y,
        width: halfWidth,
        height: halfHeight,
      });
    case "top-right":
      return Object.freeze({
        x: workArea.x + halfWidth,
        y: workArea.y,
        width: remainingWidth,
        height: halfHeight,
      });
    case "bottom-left":
      return Object.freeze({
        x: workArea.x,
        y: workArea.y + halfHeight,
        width: halfWidth,
        height: remainingHeight,
      });
    case "bottom-right":
      return Object.freeze({
        x: workArea.x + halfWidth,
        y: workArea.y + halfHeight,
        width: remainingWidth,
        height: remainingHeight,
      });
  }
}

export function detectSnapTargetFromPoint(
  point: { readonly x: number; readonly y: number },
  workArea: WindowBounds,
  threshold = 24,
): WindowSnapTarget | "maximize" | undefined {
  const nearLeft = point.x <= workArea.x + threshold;
  const nearRight = point.x >= workArea.x + workArea.width - threshold;
  const nearTop = point.y <= workArea.y + threshold;
  const nearBottom = point.y >= workArea.y + workArea.height - threshold;

  if (nearTop && nearLeft) return "top-left";
  if (nearTop && nearRight) return "top-right";
  if (nearBottom && nearLeft) return "bottom-left";
  if (nearBottom && nearRight) return "bottom-right";
  if (nearTop) return "maximize";
  if (nearLeft) return "left";
  if (nearRight) return "right";
  return undefined;
}
