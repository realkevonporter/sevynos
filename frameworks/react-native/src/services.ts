export interface FileSystemEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modified?: number | undefined;
  readonly mimeType?: string | undefined;
}
export interface SevynFileSystem {
  list(path: string): Promise<readonly FileSystemEntry[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete?(path: string): Promise<void>;
  rename?(fromPath: string, toPath: string): Promise<void>;
  copy?(fromPath: string, toPath: string): Promise<void>;
  stat?(path: string): Promise<FileSystemEntry | undefined>;
  moveToTrash?(path: string): Promise<void>;
  listTrash?(): Promise<readonly FileSystemEntry[]>;
  restoreFromTrash?(name: string): Promise<void>;
  emptyTrash?(): Promise<void>;
}

export interface SevynStudioBuildRequest {
  readonly applicationId: string;
  readonly applicationName: string;
  readonly source: string;
}

export interface SevynStudioBuildResult {
  readonly bundle: string;
  readonly bytecodeBase64: string;
  readonly packageJson: string;
  readonly diagnostics: readonly string[];
}

export interface SevynStudioService {
  build(request: SevynStudioBuildRequest): Promise<SevynStudioBuildResult>;
}

export type WirelessConnectionState =
  "unavailable" | "disconnected" | "scanning" | "connecting" | "connected" | "failed";

export interface WirelessNetwork {
  readonly ssid: string;
  readonly signal: number;
  readonly secure: boolean;
  readonly security: "open" | "personal" | "enhanced-open" | "enterprise" | "legacy";
  readonly supported: boolean;
  readonly requiresPassword: boolean;
  readonly connected: boolean;
  readonly frequency?: number;
  readonly flags?: string;
}

export interface WirelessNetworkSnapshot {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly interfaceName?: string | undefined;
  readonly state: WirelessConnectionState;
  readonly connectedSsid?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly networks: readonly WirelessNetwork[];
  readonly error?: string | undefined;
}

export interface SevynWirelessNetworkService {
  snapshot(): Promise<WirelessNetworkSnapshot>;
  setEnabled?(enabled: boolean): Promise<WirelessNetworkSnapshot>;
  scan(): Promise<WirelessNetworkSnapshot>;
  connect(ssid: string, password?: string): Promise<WirelessNetworkSnapshot>;
  disconnect(): Promise<WirelessNetworkSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface SevynPowerService {
  readonly available: boolean;
  shutdown(): Promise<void>;
  restart?(): Promise<void>;
  lock?(): Promise<void>;
  sleep?(): Promise<void>;
  logout?(): Promise<void>;
}

export interface BatterySnapshot {
  readonly available: boolean;
  readonly percent: number;
  readonly charging: boolean;
  readonly state: "charging" | "discharging" | "full" | "not-charging" | "unknown";
}

export interface SevynBatteryService {
  snapshot(): Promise<BatterySnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface AudioSnapshot {
  readonly available: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly outputDevice: string;
  readonly hasHeadphones: boolean;
}

export interface SevynAudioService {
  snapshot(): Promise<AudioSnapshot>;
  setVolume(volume: number): Promise<AudioSnapshot>;
  setMuted(muted: boolean): Promise<AudioSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface SystemHardwareSnapshot {
  readonly cpuPercent: number;
  readonly cpuCores: number;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly memoryAvailableBytes: number;
  readonly uptimeSeconds: number;
}

export interface SevynSystemService {
  snapshot(): Promise<SystemHardwareSnapshot>;
  subscribe(listener: () => void): () => void;
}

export interface BrowserEngineSnapshot {
  readonly ready: boolean;
  readonly loading: boolean;
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly pixels?: Uint8Array | undefined;
  readonly error?: string | undefined;
}

export interface SevynBrowserEngine {
  snapshot(): BrowserEngineSnapshot;
  navigate(address: string): Promise<BrowserEngineSnapshot>;
  back(): Promise<BrowserEngineSnapshot>;
  forward(): Promise<BrowserEngineSnapshot>;
  reload(): Promise<BrowserEngineSnapshot>;
  resize(width: number, height: number): Promise<BrowserEngineSnapshot>;
  click(x: number, y: number, clickCount?: number): Promise<BrowserEngineSnapshot>;
  pointerDown(x: number, y: number, button?: number): Promise<BrowserEngineSnapshot>;
  pointerUp(x: number, y: number, button?: number): Promise<BrowserEngineSnapshot>;
  pointerMove(x: number, y: number): Promise<BrowserEngineSnapshot>;
  scroll(
    x: number,
    y: number,
    deltaY: number,
    deltaX?: number,
  ): Promise<BrowserEngineSnapshot>;
  key(
    key: string,
    code: string,
    modifiers?: { shift: boolean; alt: boolean; control: boolean; meta: boolean },
  ): Promise<BrowserEngineSnapshot>;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export class UnavailablePowerService implements SevynPowerService {
  public readonly available = false;

  public shutdown(): Promise<void> {
    return Promise.reject(new Error("Power controls are not available on this host."));
  }

  public restart(): Promise<void> {
    return Promise.reject(new Error("Power controls are not available on this host."));
  }

  public lock(): Promise<void> {
    return Promise.reject(new Error("Power controls are not available on this host."));
  }

  public sleep(): Promise<void> {
    return Promise.reject(new Error("Power controls are not available on this host."));
  }

  public logout(): Promise<void> {
    return Promise.reject(new Error("Power controls are not available on this host."));
  }
}

const WIRELESS_UNAVAILABLE: WirelessNetworkSnapshot = Object.freeze({
  available: false,
  enabled: false,
  state: "unavailable",
  networks: Object.freeze([]),
});

export class UnavailableWirelessNetworkService implements SevynWirelessNetworkService {
  public snapshot(): Promise<WirelessNetworkSnapshot> {
    return Promise.resolve(WIRELESS_UNAVAILABLE);
  }

  public scan(): Promise<WirelessNetworkSnapshot> {
    return this.snapshot();
  }
  public setEnabled(): Promise<WirelessNetworkSnapshot> {
    return Promise.resolve(WIRELESS_UNAVAILABLE);
  }

  public connect(): Promise<WirelessNetworkSnapshot> {
    return this.snapshot();
  }

  public disconnect(): Promise<WirelessNetworkSnapshot> {
    return this.snapshot();
  }

  public subscribe(): () => void {
    return () => undefined;
  }
}

export class UnavailableBatteryService implements SevynBatteryService {
  public snapshot(): Promise<BatterySnapshot> {
    return Promise.resolve({
      available: false,
      percent: 100,
      charging: false,
      state: "unknown",
    });
  }
  public subscribe(): () => void {
    return () => undefined;
  }
}

export class UnavailableAudioService implements SevynAudioService {
  public snapshot(): Promise<AudioSnapshot> {
    return Promise.resolve({
      available: false,
      volume: 80,
      muted: false,
      outputDevice: "Default Output",
      hasHeadphones: false,
    });
  }
  public setVolume(volume: number): Promise<AudioSnapshot> {
    return Promise.resolve({
      available: false,
      volume,
      muted: false,
      outputDevice: "Default Output",
      hasHeadphones: false,
    });
  }
  public setMuted(muted: boolean): Promise<AudioSnapshot> {
    return Promise.resolve({
      available: false,
      volume: 80,
      muted,
      outputDevice: "Default Output",
      hasHeadphones: false,
    });
  }
  public subscribe(): () => void {
    return () => undefined;
  }
}

export class UnavailableSystemService implements SevynSystemService {
  public snapshot(): Promise<SystemHardwareSnapshot> {
    return Promise.resolve({
      cpuPercent: 5,
      cpuCores: 4,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      memoryUsedBytes: 2 * 1024 * 1024 * 1024,
      memoryAvailableBytes: 6 * 1024 * 1024 * 1024,
      uptimeSeconds: 300,
    });
  }
  public subscribe(): () => void {
    return () => undefined;
  }
}

export class InMemoryFileSystem implements SevynFileSystem {
  readonly #files = new Map<string, string>();
  readonly #directories = new Set<string>(["/"]);
  public constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [path, content] of Object.entries(seed)) {
      this.#files.set(normalize(path), content);
      this.#ensureParents(path);
    }
  }
  public list(path: string): Promise<readonly FileSystemEntry[]> {
    const directory = normalize(path);
    const prefix = directory === "/" ? "/" : `${directory}/`;
    const entries = new Map<string, FileSystemEntry>();
    for (const candidate of this.#directories) {
      if (!candidate.startsWith(prefix) || candidate === directory) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder.includes("/"))
        entries.set(
          candidate,
          Object.freeze({ name: remainder, path: candidate, kind: "directory", size: 0 }),
        );
    }
    for (const [candidate, content] of this.#files) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder.includes("/"))
        entries.set(
          candidate,
          Object.freeze({
            name: remainder,
            path: candidate,
            kind: "file",
            size: content.length,
          }),
        );
    }
    return Promise.resolve(
      Object.freeze(
        [...entries.values()].sort((a, b) =>
          a.kind === b.kind
            ? a.name.localeCompare(b.name)
            : a.kind === "directory"
              ? -1
              : 1,
        ),
      ),
    );
  }
  public read(path: string): Promise<string> {
    const content = this.#files.get(normalize(path));
    if (content === undefined)
      return Promise.reject(new Error(`File "${path}" does not exist.`));
    return Promise.resolve(content);
  }
  public write(path: string, content: string): Promise<void> {
    const normalized = normalize(path);
    this.#ensureParents(normalized);
    this.#files.set(normalized, content);
    return Promise.resolve();
  }
  public createDirectory(path: string): Promise<void> {
    this.#ensureParents(normalize(path));
    this.#directories.add(normalize(path));
    return Promise.resolve();
  }
  public delete(path: string): Promise<void> {
    const normalized = normalize(path);
    this.#files.delete(normalized);
    this.#directories.delete(normalized);
    const prefix = `${normalized}/`;
    for (const key of [...this.#files.keys()]) {
      if (key.startsWith(prefix)) this.#files.delete(key);
    }
    for (const key of [...this.#directories]) {
      if (key.startsWith(prefix)) this.#directories.delete(key);
    }
    return Promise.resolve();
  }
  #ensureParents(path: string): void {
    const parts = normalize(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
      this.#directories.add(current);
    }
  }
}
function normalize(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".."))
    throw new Error("Parent traversal is not allowed in the Sevyn virtual filesystem.");
  return `/${parts.join("/")}`;
}

export interface SystemNotification {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly createdAt: number;
  readonly applicationId?: string;
}
export class SystemNotificationService {
  readonly #notifications: SystemNotification[] = [];
  readonly #listeners = new Set<() => void>();
  #next = 0;
  public constructor(readonly maximumNotifications = 100) {
    if (!Number.isInteger(maximumNotifications) || maximumNotifications < 1)
      throw new Error("Notification capacity must be a positive integer.");
  }
  public show(
    notification: Omit<SystemNotification, "id" | "createdAt">,
  ): SystemNotification {
    this.#next += 1;
    const value = Object.freeze({
      ...notification,
      id: `notification-${String(this.#next)}`,
      createdAt: Date.now(),
    });
    this.#notifications.push(value);
    if (this.#notifications.length > this.maximumNotifications)
      this.#notifications.splice(
        0,
        this.#notifications.length - this.maximumNotifications,
      );
    for (const listener of this.#listeners) listener();
    return value;
  }
  public dismiss(id: string): void {
    const index = this.#notifications.findIndex((item) => item.id === id);
    if (index >= 0) this.#notifications.splice(index, 1);
    for (const listener of this.#listeners) listener();
  }
  public list(): readonly SystemNotification[] {
    return Object.freeze([...this.#notifications]);
  }
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export interface SevynApplicationSdk {
  readonly application: {
    readonly id: string;
    readonly sessionId: string;
    readonly state: string;
  };
  readonly windows: { requestWindow(title: string): Promise<string> };
  readonly theme: {
    readonly appearance: "light" | "dark";
    readonly accent: string;
    readonly reducedMotion: boolean;
  };
  readonly storage: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
  readonly notifications?: Pick<SystemNotificationService, "show">;
  readonly clipboard?: {
    readText(): Promise<string>;
    writeText(value: string): Promise<void>;
  };
  readonly filesystem?: Partial<SevynFileSystem>;
  readonly workspace: { readonly id: string };
  readonly display: { readonly id: string; readonly scaleFactor: number };
}

export type BrowserSection =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string }
  | { readonly kind: "code"; readonly code: string; readonly language?: string }
  | { readonly kind: "list-item"; readonly text: string }
  | {
      readonly kind: "callout";
      readonly title: string;
      readonly text: string;
      readonly tone?: "info" | "success" | "warning";
    }
  | {
      readonly kind: "card-group";
      readonly cards: readonly {
        readonly title: string;
        readonly description: string;
        readonly url: string;
        readonly tag?: string;
      }[];
    };

export interface TextBrowserPage {
  readonly url: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly sections?: readonly BrowserSection[];
}
