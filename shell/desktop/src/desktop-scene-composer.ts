import type { DesktopRuntime } from "./desktop-runtime.js";
import type {
  AudioSnapshot,
  BatterySnapshot,
  NativeControlAction,
  WirelessNetworkSnapshot,
} from "@sevynos/react-native/internal";
import { SystemApplicationId } from "@sevynos/system-applications";
import { renderDesktopWorkspace } from "@sevynos/system-applications/desktop";
import type {
  DesktopDockRenderInput,
  DesktopLauncherRenderInput,
  DesktopShellApplicationSummary,
  DesktopShellDisplay,
  DesktopStatusBarRenderInput,
  DesktopWallpaperRenderInput,
  DesktopWindowSwitcherRenderInput,
  DesktopLockScreenRenderInput,
} from "@sevynos/system-applications/desktop";
import type {
  DesktopScene,
  DesktopSceneNode,
  DesktopViewport,
  DesktopWindowSceneNode,
  DesktopSettingsAction,
} from "./desktop-scene.js";
import { getWindowControlRects } from "./window-controls.js";
import { getTaskbarBounds } from "./desktop-window-layout.js";
import { DESKTOP_VISUAL_METRICS } from "./desktop-appearance.js";
import { ShellComponentRenderer } from "./shell-component-renderer.js";
import type { ComponentType } from "react";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

let cachedSecondTimestamp = -1;
let cachedTimeText = "";
let cachedDateText = "";

function getFormattedTimeAndDate(): { timeText: string; dateText: string } {
  const now = new Date();
  const secondFloor = Math.floor(now.getTime() / 1000);
  if (secondFloor !== cachedSecondTimestamp) {
    cachedSecondTimestamp = secondFloor;
    let hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    cachedTimeText = `${String(hours)}:${minutes} ${ampm}`;
    const day = DAY_NAMES[now.getDay()] ?? "Sun";
    const month = MONTH_NAMES[now.getMonth()] ?? "Jan";
    cachedDateText = `${day}, ${month} ${String(now.getDate())}`;
  }
  return { timeText: cachedTimeText, dateText: cachedDateText };
}

const SETTINGS_ACTIONS: ReadonlySet<DesktopSettingsAction> =
  new Set<DesktopSettingsAction>([
    "installer-launch",
    "theme",
    "accent",
    "taskbar-position",
    "taskbar-behavior",
    "display-layout",
    "workspace-count",
    "cursor-size",
    "reduced-motion",
    "restore-session",
  ]);

function isSettingsAction(action: NativeControlAction): action is DesktopSettingsAction {
  return SETTINGS_ACTIONS.has(action as DesktopSettingsAction);
}

export class DesktopSceneComposer {
  readonly #runtime: DesktopRuntime;
  readonly #getFrameExecutionCount: () => number;
  readonly #onServiceUpdate: (() => void) | undefined;
  readonly #onShellRender:
    ((applicationId: string, nodeCount: number, bounds: string) => void) | undefined;
  readonly #shellRenderer: ShellComponentRenderer;
  #serviceUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  #batterySnapshot: BatterySnapshot | undefined;
  #networkSnapshot: WirelessNetworkSnapshot | undefined;
  #audioSnapshot: AudioSnapshot | undefined;
  #desktopEntries: readonly {
    readonly name: string;
    readonly path: string;
    readonly kind: "file" | "directory";
  }[] = Object.freeze([]);
  #desktopRefreshInFlight = false;
  readonly #unsubscribers: (() => void)[] = [];

  public constructor(
    runtime: DesktopRuntime,
    getFrameExecutionCount = (): number => 0,
    onServiceUpdate?: () => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shellComponents: ReadonlyMap<string, ComponentType<any>> = new Map(),
    onShellRender?: (applicationId: string, nodeCount: number, bounds: string) => void,
  ) {
    this.#runtime = runtime;
    this.#getFrameExecutionCount = getFrameExecutionCount;
    this.#shellRenderer = new ShellComponentRenderer(() => this.#onServiceUpdate?.());
    this.#onServiceUpdate = onServiceUpdate;
    this.#shellComponents = shellComponents;
    this.#onShellRender = onShellRender;
    void this.#refreshDesktopEntries();
    this.#unsubscribers.push(
      runtime.subscribe(() => {
        void this.#refreshDesktopEntries();
      }),
    );

    if (runtime.battery !== undefined) {
      void runtime.battery
        .snapshot()
        .then((snapshot) => {
          this.#batterySnapshot = snapshot;
          this.#notifyServiceUpdate();
        })
        .catch(() => undefined);
      this.#unsubscribers.push(
        runtime.battery.subscribe(() => {
          void runtime.battery
            ?.snapshot()
            .then((snapshot) => {
              this.#batterySnapshot = snapshot;
              this.#notifyServiceUpdate();
            })
            .catch(() => undefined);
        }),
      );
    }

    if (runtime.network !== undefined) {
      void runtime.network
        .snapshot()
        .then((snapshot) => {
          this.#networkSnapshot = snapshot;
          this.#notifyServiceUpdate();
        })
        .catch(() => undefined);
      this.#unsubscribers.push(
        runtime.network.subscribe(() => {
          void runtime.network
            ?.snapshot()
            .then((snapshot) => {
              this.#networkSnapshot = snapshot;
              this.#notifyServiceUpdate();
            })
            .catch(() => undefined);
        }),
      );
    }

    if (runtime.audio !== undefined) {
      void runtime.audio
        .snapshot()
        .then((snapshot) => {
          this.#audioSnapshot = snapshot;
          this.#notifyServiceUpdate();
        })
        .catch(() => undefined);
      this.#unsubscribers.push(
        runtime.audio.subscribe(() => {
          void runtime.audio
            ?.snapshot()
            .then((snapshot) => {
              this.#audioSnapshot = snapshot;
              this.#notifyServiceUpdate();
            })
            .catch(() => undefined);
        }),
      );
    }
  }

  #notifyServiceUpdate(): void {
    if (this.#onServiceUpdate === undefined || this.#serviceUpdateTimer !== undefined) {
      return;
    }
    this.#serviceUpdateTimer = setTimeout(() => {
      this.#serviceUpdateTimer = undefined;
      this.#onServiceUpdate?.();
    }, 16);
  }

  public dispose(): void {
    if (this.#serviceUpdateTimer !== undefined) {
      clearTimeout(this.#serviceUpdateTimer);
      this.#serviceUpdateTimer = undefined;
    }
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers.length = 0;
  }

  async #refreshDesktopEntries(): Promise<void> {
    if (this.#desktopRefreshInFlight || this.#runtime.filesystem === undefined) return;
    this.#desktopRefreshInFlight = true;
    try {
      const entries = await this.#runtime.listDesktopItems();
      this.#desktopEntries = Object.freeze(
        entries.map((entry) =>
          Object.freeze({ name: entry.name, path: entry.path, kind: entry.kind }),
        ),
      );
      this.#notifyServiceUpdate();
    } catch {
      this.#desktopEntries = Object.freeze([]);
    } finally {
      this.#desktopRefreshInFlight = false;
    }
  }

  /**
   * React Native shell components, keyed by application ID. Injected by the
   * real host entrypoint via `createShellComponentRegistry()`; unit tests
   * pass nothing, so the legacy native renderers are used there and
   * `react-native` never enters the test bundle.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #shellComponents: ReadonlyMap<string, ComponentType<any>>;

  /**
   * Render a shell application, using its React Native component if available,
   * otherwise falling back to the legacy native render function.
   *
   * For RN components, renders one surface per display (or a single surface
   * with the given bounds for overlays). When no component is registered for
   * the application (e.g. unit tests), falls back to the legacy render.
   */
  #renderShellApplication(
    applicationId: string,
    input: unknown,
    getBounds: (display: {
      readonly id: string;
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly taskbarBounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }) => {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    getOrder: () => number,
    displays: readonly {
      readonly id: string;
      readonly bounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly taskbarBounds: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    }[],
  ): readonly DesktopSceneNode[] {
    const component = this.#shellComponents.get(applicationId);
    if (component !== undefined) {
      const nodes: DesktopSceneNode[] = [];
      let firstBounds: string = "none";
      for (const display of displays) {
        const bounds = getBounds(display);
        if (firstBounds === "none") {
          firstBounds = `${String(bounds.x)},${String(bounds.y)},${String(bounds.width)}x${String(bounds.height)}`;
        }
        const node = this.#shellRenderer.render(
          applicationId,
          component,
          input,
          bounds,
          getOrder(),
          display.id,
        );
        if (node !== undefined) nodes.push(node);
      }
      // Diagnostic: report which shell components actually produce nodes.
      // A component returning null (e.g. closed Launcher) produces zero nodes.
      if (this.#onShellRender !== undefined) {
        this.#onShellRender(applicationId, nodes.length, firstBounds);
      }
      return Object.freeze(nodes);
    }
    // Fallback to legacy render
    return this.#runtime.shell.render(
      applicationId,
      input,
    ) as readonly DesktopSceneNode[];
  }

  /**
   * Dispatch a pointer event to a React Native shell component.
   * Returns true if the event was handled.
   */
  public dispatchShellPointer(
    applicationId: string,
    type: "down" | "up" | "move",
    x: number,
    y: number,
  ): boolean {
    return this.#shellRenderer.dispatchPointer(applicationId, type, x, y);
  }

  public compose(viewport: DesktopViewport): DesktopScene {
    const base = this.#runtime.compositor.compose();
    const windowNodes = base.listWindows().map<DesktopWindowSceneNode>((baseNode) => {
      const window = this.#runtime.windows.getWindow(baseNode.windowId);

      if (window === undefined) {
        throw new Error(`Composed window "${baseNode.windowId}" was not found.`);
      }

      const surface = this.#runtime.surfaces.get(window.id);
      const settingsSnapshot =
        surface?.kind === "settings" ? this.#runtime.settings.snapshot : undefined;
      const systemMonitorSnapshot =
        surface?.kind === "system-monitor"
          ? Object.freeze({
              runningApplicationSessions: this.#runtime.platformRuntime
                .listApplicationSessions()
                .filter((session) => !session.isTerminal()).length,
              openWindows: this.#runtime.windows
                .listWindows()
                .filter((candidate) => candidate.state !== "closed").length,
              focusedWindow: this.#runtime.windows
                .listWindows()
                .find((candidate) => candidate.state === "focused")?.title,
              cursorKind: this.#runtime.cursor.state.kind,
              frameExecutionCount: this.#getFrameExecutionCount(),
              activeWorkspace: this.#runtime.environment.activeWorkspace,
              averageFrameDuration: this.#runtime.diagnostics.frames.averageDuration,
              latestFrameDuration: this.#runtime.diagnostics.frames.latestDuration,
              failedFrames: this.#runtime.diagnostics.frames.failedFrames,
              activePointerCaptures: this.#runtime.activePointerCaptureCount(),
              registeredInputDevices: this.#runtime.registeredInputDeviceCount(),
              displayCount: this.#runtime.environment.listDisplays().length,
              workspaceCount: this.#runtime.environment.workspaceCount,
              recentDiagnostics: this.#runtime.diagnostics.list().slice(-5),
              applicationWorkers: this.#runtime.surfaces.workerSnapshots,
            })
          : undefined;
      const contentBounds = {
        x: baseNode.bounds.x + 1,
        y: baseNode.bounds.y + DESKTOP_VISUAL_METRICS.titleBarHeight,
        width: baseNode.bounds.width - 2,
        height: baseNode.bounds.height - (DESKTOP_VISUAL_METRICS.titleBarHeight + 1),
      };
      return Object.freeze({
        kind: "desktop-window",
        order: baseNode.zIndex,
        base: baseNode,
        windowId: baseNode.windowId,
        title: window.title,
        controls: Object.freeze([...getWindowControlRects(window)]),
        contentBounds: Object.freeze(contentBounds),
        surface,
        maximized: this.#runtime.isMaximized(window.id),
        systemMonitorSnapshot,
        settingsSnapshot,
        nativeSurface: this.#runtime.surfaces.composeNativeSurface(
          window.id,
          contentBounds,
          this.#runtime.settings.snapshot,
          systemMonitorSnapshot,
        ),
        animationTransform: this.#runtime.windowAnimations.getTransform(window.id),
      });
    });

    const topContentOrder = Math.max(0, ...windowNodes.map((node) => node.order)) + 1;
    const displays = this.#runtime.environment.listDisplays();
    const primary = displays.find((display) => display.primary) ?? displays[0];
    if (primary === undefined)
      throw new Error("No display is available for scene composition.");
    const taskbarBounds = getTaskbarBounds(
      primary.bounds,
      this.#runtime.settings.snapshot.taskbarPosition,
    );
    const taskbarPosition = this.#runtime.settings.snapshot.taskbarPosition;
    const shellDisplays: readonly DesktopShellDisplay[] = displays.map((display) =>
      Object.freeze({
        id: display.id,
        bounds: display.bounds,
        taskbarBounds: getTaskbarBounds(display.bounds, taskbarPosition),
      }),
    );
    const pinnedIds = this.#runtime.settings.snapshot.pinnedApplications ?? [];
    const runningList = this.#runtime.applications.listRunning().filter((running) => {
      const window = this.#runtime.windows.getWindow(running.windowId);
      return (
        window !== undefined &&
        this.#runtime.environment.getWindowWorkspace(window.id) ===
          this.#runtime.environment.activeWorkspace
      );
    });

    const dockApplications: DesktopShellApplicationSummary[] = [];
    const seenAppIds = new Set<string>();

    for (const pinnedId of pinnedIds) {
      seenAppIds.add(pinnedId);
      const running = runningList.find((r) => r.definition.id === pinnedId);
      const def = this.#runtime.applications.catalog.find((d) => d.id === pinnedId);
      const label = running?.definition.name ?? def?.name ?? pinnedId;
      const window = running
        ? this.#runtime.windows.getWindow(running.windowId)
        : undefined;

      dockApplications.push(
        Object.freeze({
          applicationId: pinnedId,
          label,
          focused: window?.state === "focused",
          minimized: window?.state === "minimized",
          displayId: window
            ? this.#runtime.environment.getDisplayForBounds(window.bounds).id
            : primary.id,
          pinned: true,
          running: running !== undefined,
        }),
      );
    }

    for (const running of runningList) {
      if (seenAppIds.has(running.definition.id)) continue;
      seenAppIds.add(running.definition.id);
      const window = this.#runtime.windows.getWindow(running.windowId);
      if (window === undefined) continue;
      dockApplications.push(
        Object.freeze({
          applicationId: running.definition.id,
          label: running.definition.name,
          focused: window.state === "focused",
          minimized: window.state === "minimized",
          displayId: this.#runtime.environment.getDisplayForBounds(window.bounds).id,
          pinned: false,
          running: true,
        }),
      );
    }

    const { timeText, dateText } = getFormattedTimeAndDate();

    const activeNetwork = this.#networkSnapshot?.networks.find((n) => n.connected);
    const wifiSignal = activeNetwork?.signal ?? 100;
    const wifiSsid = this.#networkSnapshot?.connectedSsid ?? activeNetwork?.ssid;
    const rawState = this.#networkSnapshot?.state;
    const wifiState: "connected" | "connecting" | "disconnected" | "unavailable" =
      rawState === "connected"
        ? "connected"
        : rawState === "connecting" || rawState === "scanning"
          ? "connecting"
          : rawState === "disconnected" || rawState === "failed"
            ? "disconnected"
            : this.#runtime.network
              ? "disconnected"
              : "unavailable";

    const wallpaperInput = {
      displays: shellDisplays,
    } satisfies DesktopWallpaperRenderInput;
    const backgroundNodes = this.#renderShellApplication(
      SystemApplicationId.Wallpaper,
      wallpaperInput,
      (display) => display.bounds,
      () => 0,
      shellDisplays,
    );
    const statusBarInput = {
      displays: shellDisplays,
      activeWorkspace: this.#runtime.environment.activeWorkspace,
      order: topContentOrder,
      timeText,
      dateText,
      wifiState,
      wifiSignal,
      wifiSsid,
      batteryAvailable: this.#batterySnapshot?.available,
      batteryPercent: this.#batterySnapshot?.percent,
      batteryCharging: this.#batterySnapshot?.charging,
      audioVolume: this.#audioSnapshot?.volume,
      audioMuted: this.#audioSnapshot?.muted,
    } satisfies DesktopStatusBarRenderInput;
    const statusBarNodes = this.#renderShellApplication(
      SystemApplicationId.StatusBar,
      statusBarInput,
      (display) => display.bounds,
      () => topContentOrder,
      shellDisplays,
    );
    const workspaceInput = {
      display: primary.bounds,
      entries: this.#desktopEntries,
      order: 0.5,
    };
    // Try RN component first; fall back to direct native renderer in tests
    // (no react-native) or if the RN component fails to load.
    let workspaceNodes: readonly DesktopSceneNode[];
    const workspaceComponent = this.#shellComponents.get(SystemApplicationId.DesktopHome);
    if (workspaceComponent !== undefined) {
      workspaceNodes = this.#renderShellApplication(
        SystemApplicationId.DesktopHome,
        workspaceInput,
        (display) => display.bounds,
        () => 0.5,
        shellDisplays,
      );
    } else {
      // Legacy fallback: direct native renderer (used in unit tests)
      workspaceNodes = renderDesktopWorkspace(workspaceInput);
    }
    const dockInput = {
      displays: shellDisplays,
      position: taskbarPosition,
      applications: dockApplications,
      activeWorkspace: this.#runtime.environment.activeWorkspace,
      workspaces: this.#runtime.environment.listWorkspaces(),
      order: topContentOrder + 2,
    } satisfies DesktopDockRenderInput;
    const dockNodes = this.#renderShellApplication(
      SystemApplicationId.Dock,
      dockInput,
      (display) => display.taskbarBounds,
      () => topContentOrder + 2,
      shellDisplays,
    );
    const launcherInput = {
      open: this.#runtime.applications.launcherOpen,
      searchQuery: this.#runtime.applications.launcherSearchQuery,
      taskbarBounds,
      displayBounds: primary.bounds,
      position: taskbarPosition,
      catalog: this.#runtime.applications.catalog.map((definition) =>
        Object.freeze({
          applicationId: definition.id,
          label: definition.name,
          running:
            this.#runtime.applications.getByApplicationId(definition.id) !== undefined,
        }),
      ),
      order: topContentOrder + 1,
    } satisfies DesktopLauncherRenderInput;
    const launcherNodes = this.#renderShellApplication(
      SystemApplicationId.Launcher,
      launcherInput,
      () => primary.bounds,
      () => topContentOrder + 1,
      [
        {
          id: "primary",
          bounds: primary.bounds,
          taskbarBounds: taskbarBounds,
        },
      ],
    );
    const switcherInput = {
      open: true,
      displayBounds: primary.bounds,
      applications: this.#runtime.applications.switcherApplications,
      selectedApplicationId: this.#runtime.applications.switcherSelectedApplicationId,
      order: topContentOrder + 10,
    } satisfies DesktopWindowSwitcherRenderInput;
    const switcherNodes = this.#runtime.applications.switcherOpen
      ? this.#renderShellApplication(
          SystemApplicationId.WindowSwitcher,
          switcherInput,
          () => primary.bounds,
          () => topContentOrder + 10,
          [
            {
              id: "primary",
              bounds: primary.bounds,
              taskbarBounds: taskbarBounds,
            },
          ],
        )
      : [];
    const lockScreenInput = {
      displayBounds: primary.bounds,
      locked: true,
      order: topContentOrder + 100,
      timeText,
      dateText,
    } satisfies DesktopLockScreenRenderInput;
    const lockScreenNodes = this.#runtime.applications.isLocked
      ? this.#renderShellApplication(
          SystemApplicationId.LockScreen,
          lockScreenInput,
          () => primary.bounds,
          () => topContentOrder + 100,
          [
            {
              id: "primary",
              bounds: primary.bounds,
              taskbarBounds: taskbarBounds,
            },
          ],
        )
      : [];
    // Window chrome (title bars + traffic lights) as React Native.
    // TEMPORARILY DISABLED: The full-display surface intercepts all pointer
    // events, preventing interaction with browser/Sevyn Code windows underneath.
    // TODO: Fix hit testing to only intercept title bar areas, or use per-window
    // surfaces. Native chrome remains active via the compositor.
    // The WindowChrome RN component exists and is registered, but not wired
    // into the scene until the hit-testing issue is resolved.
    const windowChromeNodes: readonly DesktopSceneNode[] = [];
    const nodes: DesktopSceneNode[] = [
      ...backgroundNodes,
      ...workspaceNodes,
      ...statusBarNodes,
      ...windowNodes,
      ...windowChromeNodes,
      ...windowNodes.flatMap(
        (node) =>
          node.nativeSurface?.commands.flatMap((command) =>
            command.kind === "control" && isSettingsAction(command.action)
              ? [
                  Object.freeze({
                    kind: "desktop-settings-control" as const,
                    order: node.order + 0.1,
                    bounds: {
                      x: node.contentBounds.x + command.bounds.x,
                      y: node.contentBounds.y + command.bounds.y,
                      width: command.bounds.width,
                      height: command.bounds.height,
                    },
                    action: command.action,
                    label: command.value,
                  }),
                ]
              : [],
          ) ?? [],
      ),
      ...windowNodes.flatMap((node) =>
        node.surface?.kind === "system-monitor"
          ? (["clear", "export", "test"] as const).map((action, index) =>
              Object.freeze({
                kind: "desktop-diagnostics-control" as const,
                order: node.order + 0.1,
                bounds: {
                  x: node.base.bounds.x + 22 + index * 120,
                  y: node.base.bounds.y + node.base.bounds.height - 48,
                  width: 110,
                  height: 28,
                },
                action,
                label:
                  action === "clear"
                    ? "Clear logs"
                    : action === "export"
                      ? "Export"
                      : "Test event",
              }),
            )
          : [],
      ),
      ...launcherNodes,
      ...dockNodes,
      ...switcherNodes,
      ...lockScreenNodes,
      Object.freeze({
        kind: "desktop-cursor" as const,
        order: topContentOrder + 3,
        cursorKind: this.#runtime.cursor.state.kind,
        position: this.#runtime.cursor.state.position,
        visible: this.#runtime.cursor.state.visible,
      }),
    ];
    if (this.#runtime.recovery.state.active) {
      nodes.push(
        Object.freeze({
          kind: "desktop-recovery",
          order: topContentOrder + 20,
          bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height },
          message: this.#runtime.recovery.state.message,
        }),
      );
      nodes.push(
        Object.freeze({
          kind: "desktop-recovery-control",
          order: topContentOrder + 21,
          bounds: {
            x: viewport.width / 2 - 140,
            y: viewport.height / 2 + 50,
            width: 125,
            height: 38,
          },
          action: "reset",
          label: "Reset Desktop",
        }),
      );
      nodes.push(
        Object.freeze({
          kind: "desktop-recovery-control",
          order: topContentOrder + 21,
          bounds: {
            x: viewport.width / 2 + 15,
            y: viewport.height / 2 + 50,
            width: 125,
            height: 38,
          },
          action: "quit",
          label: "Quit",
        }),
      );
    }

    return Object.freeze({
      base,
      viewport: Object.freeze({ ...viewport }),
      nodes: Object.freeze(nodes.sort((first, second) => first.order - second.order)),
      settings: this.#runtime.settings.snapshot,
    });
  }
}
