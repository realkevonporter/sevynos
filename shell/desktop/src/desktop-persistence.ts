import type { WindowBounds } from "@sevynos/graphics";
import type { DesktopRuntime } from "./desktop-runtime.js";
import type {
  DesktopDisplayLayoutMode,
  DesktopWorkspaceId,
} from "./desktop-environment.js";
import { clampToWorkArea } from "./desktop-environment.js";
import { mapBounds } from "./desktop-window-layout.js";

export const DESKTOP_SESSION_VERSION = 4 as const;

export interface PersistedConsoleSurface {
  readonly kind: "console";
  readonly history: readonly string[];
  readonly input: string;
}

export interface PersistedDesktopWindow {
  readonly applicationId: string;
  readonly bounds: WindowBounds;
  readonly state: "visible" | "focused" | "minimized";
  readonly zIndex: number;
  readonly workspaceId: DesktopWorkspaceId;
  readonly displayId?: string;
  readonly maximized: boolean;
  readonly restoreBounds?: WindowBounds;
  readonly surface?: PersistedConsoleSurface;
}

export interface PersistedDesktopSessionV1 {
  readonly version: typeof DESKTOP_SESSION_VERSION;
  readonly viewport?: DesktopViewportBounds;
  readonly windows: readonly PersistedDesktopWindow[];
  readonly displayLayout: DesktopDisplayLayoutMode;
  readonly activeWorkspace: DesktopWorkspaceId;
}

export interface DesktopPersistenceAdapter {
  load(): Promise<unknown>;
  save(session: PersistedDesktopSessionV1): Promise<void>;
  clear(): Promise<void>;
}

export interface DesktopViewportBounds {
  readonly width: number;
  readonly height: number;
}

const VALID_STATES = new Set(["visible", "focused", "minimized"]);

export function validateDesktopSession(
  input: unknown,
): PersistedDesktopSessionV1 | undefined {
  const version = isRecord(input) ? input["version"] : undefined;
  if (
    !isRecord(input) ||
    (version !== DESKTOP_SESSION_VERSION &&
      version !== 3 &&
      version !== 2 &&
      version !== 1) ||
    !Array.isArray(input["windows"])
  ) {
    return undefined;
  }
  const viewport =
    version === DESKTOP_SESSION_VERSION ? readViewport(input["viewport"]) : undefined;
  if (version === DESKTOP_SESSION_VERSION && viewport === undefined) return undefined;
  const windows = input["windows"].flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const applicationId = candidate["applicationId"];
    const state = candidate["state"];
    const zIndex = candidate["zIndex"];
    const bounds = readBounds(candidate["bounds"]);
    const workspaceId = readWorkspace(candidate["workspaceId"]) ?? "workspace-1";
    if (
      typeof applicationId !== "string" ||
      !VALID_STATES.has(typeof state === "string" ? state : "") ||
      !Number.isSafeInteger(zIndex) ||
      typeof zIndex !== "number" ||
      zIndex < 0 ||
      bounds === undefined
    )
      return [];
    const surface = readSurface(candidate["surface"]);
    const restoreBounds = readBounds(candidate["restoreBounds"]);
    return [
      Object.freeze({
        applicationId,
        bounds,
        state: state as PersistedDesktopWindow["state"],
        zIndex,
        workspaceId,
        ...(typeof candidate["displayId"] === "string"
          ? { displayId: candidate["displayId"] }
          : {}),
        maximized: candidate["maximized"] === true,
        ...(restoreBounds === undefined ? {} : { restoreBounds }),
        ...(surface === undefined ? {} : { surface }),
      }),
    ];
  });
  return Object.freeze({
    version: DESKTOP_SESSION_VERSION,
    ...(viewport === undefined ? {} : { viewport }),
    windows: Object.freeze(windows),
    displayLayout: readLayout(input["displayLayout"]) ?? "side-by-side",
    activeWorkspace: readWorkspace(input["activeWorkspace"]) ?? "workspace-1",
  });
}

export function clampWindowBounds(
  bounds: WindowBounds,
  viewport: DesktopViewportBounds,
): WindowBounds {
  const titleBarReach = 80;
  const width = Math.min(bounds.width, Math.max(320, viewport.width));
  const height = Math.min(bounds.height, Math.max(200, viewport.height));
  return Object.freeze({
    x: Math.min(
      Math.max(bounds.x, titleBarReach - width),
      viewport.width - titleBarReach,
    ),
    y: Math.min(Math.max(bounds.y, 0), Math.max(0, viewport.height - 46)),
    width,
    height,
  });
}

export function captureDesktopSession(
  runtime: DesktopRuntime,
): PersistedDesktopSessionV1 {
  const viewport = captureViewport(runtime);
  const windows = runtime.applications.listRunning().flatMap((running) => {
    const window = runtime.windows.getWindow(running.windowId);
    if (window === undefined || window.state === "closed" || window.state === "closing")
      return [];
    const surface = runtime.surfaces.get(window.id);
    const restoreBounds = runtime.getRestoreBounds(window.id);
    return [
      Object.freeze({
        applicationId: running.definition.id,
        bounds: Object.freeze({ ...window.bounds }),
        state: normalizePersistedState(window.state),
        zIndex: window.zIndex,
        workspaceId: runtime.environment.getWindowWorkspace(window.id),
        displayId: runtime.environment.getDisplayForBounds(window.bounds).id,
        maximized: runtime.isMaximized(window.id),
        ...(restoreBounds === undefined ? {} : { restoreBounds }),
        ...(surface?.kind === "console"
          ? {
              surface: Object.freeze({
                kind: "console" as const,
                history: Object.freeze([...surface.history]),
                input: surface.input,
              }),
            }
          : {}),
      }),
    ];
  });
  return Object.freeze({
    version: DESKTOP_SESSION_VERSION,
    viewport,
    windows: Object.freeze(windows),
    displayLayout: runtime.environment.layoutMode,
    activeWorkspace: runtime.environment.activeWorkspace,
  });
}

export async function restoreDesktopSession(
  runtime: DesktopRuntime,
  input: unknown,
  viewport: DesktopViewportBounds,
): Promise<boolean> {
  const session = validateDesktopSession(input);
  if (session === undefined) return false;
  runtime.environment.configure(
    viewport.width,
    viewport.height,
    1,
    session.displayLayout,
  );
  const catalogIds = new Set(runtime.applications.catalog.map((entry) => entry.id));
  const unique = new Map<string, PersistedDesktopWindow>();
  const restoredBounds = new Map<string, WindowBounds>();
  for (const saved of session.windows) {
    if (catalogIds.has(saved.applicationId) && !unique.has(saved.applicationId))
      unique.set(saved.applicationId, saved);
  }
  for (const saved of [...unique.values()].sort((a, b) => a.zIndex - b.zIndex)) {
    const running = await runtime.applications.launch(saved.applicationId);
    runtime.environment.moveWindowToWorkspace(running.windowId, saved.workspaceId);
    const destination = runtime.environment
      .listDisplays()
      .find((display) => display.id === saved.displayId);
    const primary = runtime.environment.listDisplays().find((display) => display.primary);
    const targetWorkArea = destination?.workArea ?? primary?.workArea;
    const launchedBounds = runtime.windows.getWindow(running.windowId)?.bounds;
    if (launchedBounds === undefined) continue;
    const targetBounds =
      session.viewport === undefined
        ? launchedBounds
        : mapBounds(
            saved.restoreBounds ?? saved.bounds,
            { x: 0, y: 0, ...session.viewport },
            { x: 0, y: 0, ...viewport },
          );
    restoredBounds.set(saved.applicationId, targetBounds);
    runtime.windows.resizeWindow({
      windowId: running.windowId,
      bounds:
        targetWorkArea === undefined
          ? clampWindowBounds(targetBounds, viewport)
          : clampToWorkArea(targetBounds, targetWorkArea),
    });
    if (saved.surface?.kind === "console")
      runtime.surfaces.restoreConsole(
        running.windowId,
        saved.surface.history,
        saved.surface.input,
      );
  }
  for (const saved of [...unique.values()].sort((a, b) => a.zIndex - b.zIndex)) {
    const running = runtime.applications.getByApplicationId(saved.applicationId);
    if (running !== undefined) runtime.windows.focusWindow(running.windowId);
  }
  for (const saved of unique.values()) {
    if (saved.state === "minimized") {
      const running = runtime.applications.getByApplicationId(saved.applicationId);
      if (running !== undefined) runtime.windows.minimizeWindow(running.windowId);
    }
  }
  const focused = [...unique.values()].find((saved) => saved.state === "focused");
  const focusedRunning =
    focused === undefined
      ? undefined
      : runtime.applications.getByApplicationId(focused.applicationId);
  runtime.environment.switchWorkspace(session.activeWorkspace);
  if (focusedRunning !== undefined && focused?.workspaceId === session.activeWorkspace)
    runtime.windows.focusWindow(focusedRunning.windowId);
  for (const saved of unique.values()) {
    if (!saved.maximized || saved.workspaceId !== session.activeWorkspace) continue;
    const running = runtime.applications.getByApplicationId(saved.applicationId);
    const restoreBounds = restoredBounds.get(saved.applicationId);
    if (running !== undefined && restoreBounds !== undefined)
      await runtime.activateWindowControl(running.windowId, "maximize", restoreBounds);
  }
  runtime.applications.synchronizeKeyboardFocus();
  return true;
}

function captureViewport(runtime: DesktopRuntime): DesktopViewportBounds {
  const displays = runtime.environment.listDisplays();
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(
    ...displays.map((display) => display.bounds.x + display.bounds.width),
  );
  const bottom = Math.max(
    ...displays.map((display) => display.bounds.y + display.bounds.height),
  );
  return Object.freeze({ width: right - left, height: bottom - top });
}

export class DesktopPersistenceController {
  readonly #runtime: DesktopRuntime;
  readonly #adapter: DesktopPersistenceAdapter;
  readonly #delay: number;
  readonly #schedule: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly #cancel: (handle: ReturnType<typeof setTimeout>) => void;
  #pending: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #lastSnapshot = "";
  #suspended = false;

  public constructor(options: {
    readonly runtime: DesktopRuntime;
    readonly adapter: DesktopPersistenceAdapter;
    readonly delay?: number;
    readonly schedule?: typeof setTimeout;
    readonly cancel?: typeof clearTimeout;
  }) {
    this.#runtime = options.runtime;
    this.#adapter = options.adapter;
    this.#delay = options.delay ?? 250;
    this.#schedule =
      options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.#cancel =
      options.cancel ??
      ((handle) => {
        globalThis.clearTimeout(handle);
      });
  }

  public connect(): void {
    this.#lastSnapshot = JSON.stringify(captureDesktopSession(this.#runtime));
    this.#unsubscribe = this.#runtime.subscribe(() => {
      this.#requestSave();
    });
  }
  public disconnect(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
  public async flush(): Promise<void> {
    if (this.#pending !== undefined) {
      this.#cancel(this.#pending);
      this.#pending = undefined;
    }
    await this.#adapter.save(captureDesktopSession(this.#runtime));
  }
  public async reset(): Promise<void> {
    if (this.#pending !== undefined) {
      this.#cancel(this.#pending);
      this.#pending = undefined;
    }
    this.#suspended = true;
    try {
      await this.#adapter.clear();
      await this.#runtime.applications.resetToDefaults();
      this.#lastSnapshot = JSON.stringify(captureDesktopSession(this.#runtime));
    } finally {
      this.#suspended = false;
    }
  }
  #requestSave(): void {
    if (this.#suspended) return;
    const snapshot = JSON.stringify(captureDesktopSession(this.#runtime));
    if (snapshot === this.#lastSnapshot) return;
    this.#lastSnapshot = snapshot;
    if (this.#pending !== undefined) this.#cancel(this.#pending);
    this.#pending = this.#schedule(() => {
      this.#pending = undefined;
      void this.#adapter.save(captureDesktopSession(this.#runtime));
    }, this.#delay);
  }
}

function normalizePersistedState(state: string): PersistedDesktopWindow["state"] {
  return state === "minimized"
    ? "minimized"
    : state === "focused"
      ? "focused"
      : "visible";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (
    ![x, y, width, height].every(
      (part) => typeof part === "number" && Number.isFinite(part),
    ) ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    width < 1 ||
    height < 1
  )
    return undefined;
  return Object.freeze({ x: x as number, y: y as number, width, height });
}
function readViewport(value: unknown): DesktopViewportBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { width, height } = value;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width < 1 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height < 1
  )
    return undefined;
  return Object.freeze({ width, height });
}
function readSurface(value: unknown): PersistedConsoleSurface | undefined {
  if (
    !isRecord(value) ||
    value["kind"] !== "console" ||
    !Array.isArray(value["history"]) ||
    !value["history"].every((line) => typeof line === "string") ||
    typeof value["input"] !== "string"
  )
    return undefined;
  return Object.freeze({
    kind: "console",
    history: Object.freeze([...value["history"]] as string[]),
    input: value["input"],
  });
}
function readWorkspace(value: unknown): DesktopWorkspaceId | undefined {
  return typeof value === "string" && /^workspace-[1-8]$/.test(value) ? value : undefined;
}
function readLayout(value: unknown): DesktopDisplayLayoutMode | undefined {
  return value === "side-by-side" || value === "vertical" || value === "offset"
    ? value
    : undefined;
}
