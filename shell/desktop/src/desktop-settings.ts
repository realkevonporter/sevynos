export const DESKTOP_SETTINGS_VERSION = 1 as const;
export type DesktopTheme = "dark" | "light" | "system";
export type TaskbarPosition = "bottom" | "top" | "left" | "right";
export type TaskbarBehavior = "always-visible" | "auto-hide";

export interface DesktopSettings {
  readonly version: 1;
  readonly theme: DesktopTheme;
  readonly accentColor: string;
  readonly taskbarPosition: TaskbarPosition;
  readonly taskbarBehavior: TaskbarBehavior;
  readonly displayLayout: "side-by-side" | "vertical" | "offset";
  readonly activeDisplayId: string;
  readonly workspaceCount: number;
  readonly cursorSize: number;
  readonly minimumWindowWidth: number;
  readonly minimumWindowHeight: number;
  readonly reducedMotion: boolean;
  readonly restorePreviousSession: boolean;
  readonly pinnedApplications?: readonly string[] | undefined;
  readonly wallpaperStyle?: ("default" | "solid" | "cosmic" | "minimal") | undefined;
  readonly wallpaperColor?: string | undefined;
  readonly idleLockTimeoutMinutes?: number | undefined;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = Object.freeze({
  version: 1,
  theme: "dark",
  accentColor: "#d5aa4e",
  taskbarPosition: "bottom",
  taskbarBehavior: "always-visible",
  displayLayout: "side-by-side",
  activeDisplayId: "display-simulated-1",
  workspaceCount: 4,
  cursorSize: 1,
  minimumWindowWidth: 320,
  minimumWindowHeight: 200,
  reducedMotion: false,
  restorePreviousSession: true,
  pinnedApplications: Object.freeze(["org.sevynos.installer"]),
  wallpaperStyle: "default",
  wallpaperColor: "#090b11",
  idleLockTimeoutMinutes: 0,
});

export interface DesktopSettingsAdapter {
  load(): Promise<unknown>;
  save(settings: DesktopSettings): Promise<void>;
}
export type DesktopSettingsListener = (settings: DesktopSettings) => void;

export function validateDesktopSettings(value: unknown): DesktopSettings {
  if (!record(value)) return DEFAULT_DESKTOP_SETTINGS;
  const theme =
    one(value["theme"], ["dark", "light", "system"] as const) ??
    DEFAULT_DESKTOP_SETTINGS.theme;
  const position =
    one(value["taskbarPosition"], ["bottom", "top", "left", "right"] as const) ??
    DEFAULT_DESKTOP_SETTINGS.taskbarPosition;
  const behavior =
    one(value["taskbarBehavior"], ["always-visible", "auto-hide"] as const) ??
    DEFAULT_DESKTOP_SETTINGS.taskbarBehavior;
  const layout =
    one(value["displayLayout"], ["side-by-side", "vertical", "offset"] as const) ??
    DEFAULT_DESKTOP_SETTINGS.displayLayout;
  return Object.freeze({
    version: 1,
    theme,
    accentColor:
      typeof value["accentColor"] === "string" &&
      /^#[0-9a-f]{6}$/i.test(value["accentColor"])
        ? value["accentColor"]
        : DEFAULT_DESKTOP_SETTINGS.accentColor,
    taskbarPosition: position,
    taskbarBehavior: behavior,
    displayLayout: layout,
    activeDisplayId:
      typeof value["activeDisplayId"] === "string"
        ? value["activeDisplayId"]
        : DEFAULT_DESKTOP_SETTINGS.activeDisplayId,
    workspaceCount: integer(value["workspaceCount"], 1, 8, 4),
    cursorSize: finite(value["cursorSize"], 0.5, 3, 1),
    minimumWindowWidth: integer(value["minimumWindowWidth"], 240, 1200, 320),
    minimumWindowHeight: integer(value["minimumWindowHeight"], 160, 900, 200),
    reducedMotion: value["reducedMotion"] === true,
    restorePreviousSession: value["restorePreviousSession"] !== false,
    pinnedApplications: (() => {
      if (
        Array.isArray(value["pinnedApplications"]) &&
        value["pinnedApplications"].every((id) => typeof id === "string")
      ) {
        const set = new Set(value["pinnedApplications"]);
        const list = [...value["pinnedApplications"]];
        for (const defaultId of DEFAULT_DESKTOP_SETTINGS.pinnedApplications ?? []) {
          if (!set.has(defaultId)) {
            list.push(defaultId);
            set.add(defaultId);
          }
        }
        return Object.freeze(list);
      }
      return DEFAULT_DESKTOP_SETTINGS.pinnedApplications;
    })(),
    wallpaperStyle:
      one(value["wallpaperStyle"], ["default", "solid", "cosmic", "minimal"] as const) ??
      DEFAULT_DESKTOP_SETTINGS.wallpaperStyle,
    wallpaperColor:
      typeof value["wallpaperColor"] === "string" &&
      /^#[0-9a-f]{6}$/i.test(value["wallpaperColor"])
        ? value["wallpaperColor"]
        : DEFAULT_DESKTOP_SETTINGS.wallpaperColor,
    idleLockTimeoutMinutes: integer(
      value["idleLockTimeoutMinutes"],
      0,
      120,
      DEFAULT_DESKTOP_SETTINGS.idleLockTimeoutMinutes ?? 0,
    ),
  });
}

export class DesktopSettingsService {
  #settings: DesktopSettings;
  readonly #listeners = new Set<DesktopSettingsListener>();
  public constructor(initial: DesktopSettings = DEFAULT_DESKTOP_SETTINGS) {
    this.#settings = initial;
  }
  public get snapshot(): DesktopSettings {
    return this.#settings;
  }
  public subscribe(listener: DesktopSettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  public update(changes: Partial<Omit<DesktopSettings, "version">>): DesktopSettings {
    const next = validateDesktopSettings({ ...this.#settings, ...changes, version: 1 });
    if (JSON.stringify(next) === JSON.stringify(this.#settings)) return this.#settings;
    this.#settings = next;
    for (const listener of this.#listeners) listener(next);
    return next;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function one<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string"
    ? values.find((candidate) => candidate === value)
    : undefined;
}
function integer(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
function finite(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
