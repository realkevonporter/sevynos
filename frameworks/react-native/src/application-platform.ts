import type { SevynFileSystem, SystemNotificationService } from "./services.js";

export const SEVYN_MANIFEST_VERSION = 1 as const;
export const SEVYN_PACKAGE_VERSION = 1 as const;

export type SevynPermission =
  | "filesystem.read"
  | "filesystem.write"
  | "removable-storage"
  | "clipboard.read"
  | "clipboard.write"
  | "notifications"
  | "network"
  | "location"
  | "camera"
  | "microphone"
  | "bluetooth"
  | "sensors"
  | "biometrics"
  | "media"
  | "native-modules"
  | "battery"
  | "display"
  | "audio"
  | "vibration"
  | "nfc"
  | "cellular";
export type SevynWindowMode = "standard" | "dialog" | "utility" | "fullscreen";
export type SevynInstanceMode = "single" | "multiple";

export interface SevynApplicationManifest {
  readonly manifestVersion: typeof SEVYN_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: "react-native";
  readonly applicationKey: string;
  readonly developer: string;
  readonly icon: string;
  readonly entrypoint: string;
  readonly minimumSevynOSVersion: string;
  readonly permissions: readonly SevynPermission[];
  readonly services: readonly string[];
  readonly windowModes: readonly SevynWindowMode[];
  readonly instanceMode: SevynInstanceMode;
}
export interface SevynPackageIntegrity {
  readonly algorithm: "SHA-256";
  readonly files: Readonly<Record<string, string>>;
  readonly packageHash: string;
  readonly signature?: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
}
export interface SevynApplicationPackage {
  readonly packageVersion: typeof SEVYN_PACKAGE_VERSION;
  readonly manifest: SevynApplicationManifest;
  readonly files: Readonly<Record<string, string>>;
  readonly assets: Readonly<Record<string, string>>;
  readonly icons: Readonly<Record<string, string>>;
  readonly migrations?: Readonly<Record<string, string>>;
  readonly integrity: SevynPackageIntegrity;
}

const semanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const applicationId = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
function parsePermission(value: string): SevynPermission | undefined {
  switch (value) {
    case "filesystem.read":
    case "filesystem.write":
    case "clipboard.read":
    case "clipboard.write":
    case "notifications":
    case "network":
    case "location":
    case "camera":
    case "microphone":
    case "bluetooth":
    case "sensors":
    case "biometrics":
    case "media":
    case "native-modules":
    case "battery":
    case "display":
    case "audio":
    case "vibration":
    case "nfc":
    case "cellular":
      return value;
    default:
      return undefined;
  }
}
function parseWindowMode(value: string): SevynWindowMode | undefined {
  switch (value) {
    case "standard":
    case "dialog":
    case "utility":
    case "fullscreen":
      return value;
    default:
      return undefined;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const pathIsSafe = (path: string): boolean =>
  path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
const requiredString = (source: Record<string, unknown>, field: string): string => {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0)
    throw new SevynManifestError(field, "must be a non-empty string");
  return value;
};
const stringArray = (
  source: Record<string, unknown>,
  field: string,
): readonly string[] => {
  const value = source[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new SevynManifestError(field, "must be an array of strings");
  return Object.freeze([...new Set(value)]);
};

export class SevynManifestError extends Error {
  public constructor(
    readonly field: string,
    message: string,
  ) {
    super(`Invalid application manifest field "${field}": ${message}.`);
    this.name = "SevynManifestError";
  }
}
export function validateSevynApplicationManifest(
  input: unknown,
): SevynApplicationManifest {
  if (!record(input)) throw new SevynManifestError("manifest", "must be an object");
  if (input["manifestVersion"] !== SEVYN_MANIFEST_VERSION)
    throw new SevynManifestError("manifestVersion", "is unsupported");
  const id = requiredString(input, "id");
  if (!applicationId.test(id))
    throw new SevynManifestError("id", "must use lowercase reverse-domain notation");
  const version = requiredString(input, "version");
  const minimumSevynOSVersion = requiredString(input, "minimumSevynOSVersion");
  if (!semanticVersion.test(version))
    throw new SevynManifestError("version", "must be semantic");
  if (!semanticVersion.test(minimumSevynOSVersion))
    throw new SevynManifestError("minimumSevynOSVersion", "must be semantic");
  const entrypoint = requiredString(input, "entrypoint");
  const icon = requiredString(input, "icon");
  if (!pathIsSafe(entrypoint))
    throw new SevynManifestError("entrypoint", "must be a safe relative path");
  if (!pathIsSafe(icon))
    throw new SevynManifestError("icon", "must be a safe relative path");
  const requestedPermissions = stringArray(input, "permissions").map(parsePermission);
  if (requestedPermissions.some((item) => item === undefined))
    throw new SevynManifestError("permissions", "contains an unknown permission");
  const requestedWindowModes = stringArray(input, "windowModes").map(parseWindowMode);
  if (
    requestedWindowModes.some((item) => item === undefined) ||
    requestedWindowModes.length === 0
  )
    throw new SevynManifestError("windowModes", "must contain supported modes");
  const instanceMode = input["instanceMode"];
  if (instanceMode !== "single" && instanceMode !== "multiple")
    throw new SevynManifestError("instanceMode", "must be single or multiple");
  return Object.freeze({
    manifestVersion: 1,
    id,
    name: requiredString(input, "name"),
    version,
    runtime:
      input["runtime"] === "react-native"
        ? "react-native"
        : (() => {
            throw new SevynManifestError("runtime", "must be react-native");
          })(),
    applicationKey: requiredString(input, "applicationKey"),
    developer: requiredString(input, "developer"),
    icon,
    entrypoint,
    minimumSevynOSVersion,
    permissions: Object.freeze(requestedPermissions.filter((item) => item !== undefined)),
    services: Object.freeze(stringArray(input, "services")),
    windowModes: Object.freeze(requestedWindowModes.filter((item) => item !== undefined)),
    instanceMode,
  });
}

const compareVersions = (left: string, right: string): number => {
  const a = left.split(/[.+-]/, 3).map(Number);
  const b = right.split(/[.+-]/, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
const canonicalFiles = (groups: readonly Readonly<Record<string, string>>[]): string =>
  groups
    .flatMap((group) => Object.entries(group))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => `${path}\0${content}`)
    .join("\0");
const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
export async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return hex(digest);
}
export async function createPackageIntegrity(
  files: Readonly<Record<string, string>>,
  assets: Readonly<Record<string, string>> = {},
  icons: Readonly<Record<string, string>> = {},
  migrations: Readonly<Record<string, string>> = {},
): Promise<SevynPackageIntegrity> {
  const entries = { ...files, ...assets, ...icons, ...migrations };
  const hashes = await Promise.all(
    Object.entries(entries).map(
      async ([path, content]) => [path, await sha256(content)] as const,
    ),
  );
  return Object.freeze({
    algorithm: "SHA-256",
    files: Object.freeze(Object.fromEntries(hashes)),
    packageHash: await sha256(canonicalFiles([files, assets, icons, migrations])),
  });
}
export async function verifyPackageIntegrity(
  applicationPackage: SevynApplicationPackage,
): Promise<void> {
  const expected = await createPackageIntegrity(
    applicationPackage.files,
    applicationPackage.assets,
    applicationPackage.icons,
    applicationPackage.migrations ?? {},
  );
  if (expected.packageHash !== applicationPackage.integrity.packageHash)
    throw new Error("Application package hash does not match its contents.");
  for (const [path, hash] of Object.entries(expected.files))
    if (applicationPackage.integrity.files[path] !== hash)
      throw new Error(
        `Application package file "${path}" failed integrity verification.`,
      );
}
export async function buildSevynApplicationPackage(options: {
  readonly manifest: unknown;
  readonly files: Readonly<Record<string, string>>;
  readonly assets?: Readonly<Record<string, string>>;
  readonly icons?: Readonly<Record<string, string>>;
  readonly migrations?: Readonly<Record<string, string>>;
}): Promise<SevynApplicationPackage> {
  const manifest = validateSevynApplicationManifest(options.manifest);
  const assets = Object.freeze({ ...options.assets });
  const icons = Object.freeze({ ...options.icons });
  const migrations = Object.freeze({ ...options.migrations });
  const files = Object.freeze({ ...options.files });
  for (const path of [
    ...Object.keys(files),
    ...Object.keys(assets),
    ...Object.keys(icons),
    ...Object.keys(migrations),
  ])
    if (!pathIsSafe(path)) throw new Error(`Package path "${path}" is not safe.`);
  const integrity = await createPackageIntegrity(files, assets, icons, migrations);
  return Object.freeze({
    packageVersion: 1,
    manifest,
    files,
    assets,
    icons,
    migrations,
    integrity,
  });
}

export interface InstalledApplication {
  readonly manifest: SevynApplicationManifest;
  readonly installedAt: number;
  readonly packageHash: string;
}
export interface ApplicationPackageRepository {
  get(id: string): Promise<SevynApplicationPackage | undefined>;
  put(applicationPackage: SevynApplicationPackage): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<readonly SevynApplicationPackage[]>;
}
export class VirtualApplicationPackageRepository implements ApplicationPackageRepository {
  readonly #packages = new Map<string, SevynApplicationPackage>();
  public get(id: string): Promise<SevynApplicationPackage | undefined> {
    return Promise.resolve(this.#packages.get(id));
  }
  public put(value: SevynApplicationPackage): Promise<void> {
    this.#packages.set(value.manifest.id, value);
    return Promise.resolve();
  }
  public remove(id: string): Promise<void> {
    this.#packages.delete(id);
    return Promise.resolve();
  }
  public list(): Promise<readonly SevynApplicationPackage[]> {
    return Promise.resolve(Object.freeze([...this.#packages.values()]));
  }
}
export type PermissionDecision = "granted" | "denied";
export interface ApplicationPermissionStore {
  get(applicationId: string, permission: SevynPermission): PermissionDecision;
  set(
    applicationId: string,
    permission: SevynPermission,
    decision: PermissionDecision,
  ): void;
  clear(applicationId: string): void;
}
export class InMemoryApplicationPermissionStore implements ApplicationPermissionStore {
  readonly #values = new Map<string, PermissionDecision>();
  public get(id: string, permission: SevynPermission): PermissionDecision {
    return this.#values.get(`${id}:${permission}`) ?? "denied";
  }
  public set(
    id: string,
    permission: SevynPermission,
    decision: PermissionDecision,
  ): void {
    this.#values.set(`${id}:${permission}`, decision);
  }
  public clear(id: string): void {
    for (const key of this.#values.keys())
      if (key.startsWith(`${id}:`)) this.#values.delete(key);
  }
}
export interface InstallPermissionPrompt {
  request(
    manifest: SevynApplicationManifest,
    permissions: readonly SevynPermission[],
  ): Promise<ReadonlyMap<SevynPermission, PermissionDecision>>;
}
export class ApplicationInstaller {
  readonly #installed = new Map<string, InstalledApplication>();
  public constructor(
    readonly repository: ApplicationPackageRepository,
    readonly permissionStore: ApplicationPermissionStore,
    readonly prompt: InstallPermissionPrompt,
    readonly sevynOSVersion = "0.1.0",
    readonly now: () => number = Date.now,
  ) {}
  public list(): readonly InstalledApplication[] {
    return Object.freeze([...this.#installed.values()]);
  }
  public async install(
    candidate: SevynApplicationPackage,
  ): Promise<InstalledApplication> {
    const manifest = validateSevynApplicationManifest(candidate.manifest);
    if (compareVersions(this.sevynOSVersion, manifest.minimumSevynOSVersion) < 0)
      throw new Error(
        `${manifest.name} requires SevynOS ${manifest.minimumSevynOSVersion} or later.`,
      );
    if (!(manifest.entrypoint in candidate.files))
      throw new Error("Package entrypoint is missing.");
    if (!(manifest.icon in candidate.icons || manifest.icon in candidate.assets))
      throw new Error("Package icon is missing.");
    await verifyPackageIntegrity(candidate);
    const previous = await this.repository.get(manifest.id);
    const previousInstalled = this.#installed.get(manifest.id);
    try {
      const decisions = await this.prompt.request(manifest, manifest.permissions);
      for (const permission of manifest.permissions)
        this.permissionStore.set(
          manifest.id,
          permission,
          decisions.get(permission) ?? "denied",
        );
      await this.repository.put(Object.freeze({ ...candidate, manifest }));
      const installed = Object.freeze({
        manifest,
        installedAt: this.now(),
        packageHash: candidate.integrity.packageHash,
      });
      this.#installed.set(manifest.id, installed);
      return installed;
    } catch (error: unknown) {
      if (previous === undefined) await this.repository.remove(manifest.id);
      else await this.repository.put(previous);
      if (previousInstalled === undefined) this.#installed.delete(manifest.id);
      else this.#installed.set(manifest.id, previousInstalled);
      throw error;
    }
  }
  public async uninstall(id: string): Promise<void> {
    await this.repository.remove(id);
    this.#installed.delete(id);
    this.permissionStore.clear(id);
  }
}

export class ApplicationStorageQuotaError extends Error {}
export class NamespacedApplicationStorage {
  readonly #values = new Map<string, string>();
  public constructor(readonly quotaBytes = 1024 * 1024) {}
  public get(applicationId: string, key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(`${applicationId}:${key}`));
  }
  public set(applicationId: string, key: string, value: string): Promise<void> {
    const prefix = `${applicationId}:`;
    const entries = [...this.#values.entries()].filter(([entry]) =>
      entry.startsWith(prefix),
    );
    const current = entries.reduce(
      (total, [entry, content]) => total + entry.length + content.length,
      0,
    );
    const previous = this.#values.get(`${prefix}${key}`);
    const next = current - (previous?.length ?? 0) + key.length + value.length;
    if (next > this.quotaBytes)
      return Promise.reject(
        new ApplicationStorageQuotaError(
          `Application storage quota of ${String(this.quotaBytes)} bytes exceeded.`,
        ),
      );
    this.#values.set(`${prefix}${key}`, value);
    return Promise.resolve();
  }
  public usage(applicationId: string): number {
    const prefix = `${applicationId}:`;
    return [...this.#values.entries()]
      .filter(([entry]) => entry.startsWith(prefix))
      .reduce(
        (total, [entry, value]) => total + entry.length - prefix.length + value.length,
        0,
      );
  }
}
export interface ScopedClipboard {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}
export interface ScopedNetwork {
  request(url: string): Promise<string>;
}
export interface CameraCaptureResult {
  readonly path: string;
  readonly mediaType?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly timestamp?: number | undefined;
}

export interface CameraRecordResult {
  readonly path: string;
  readonly durationMs?: number | undefined;
  readonly format?: string | undefined;
  readonly timestamp?: number | undefined;
}

export interface CameraPreviewFrame {
  readonly width: number;
  readonly height: number;
  readonly pixels?: Uint8Array | undefined;
  readonly path?: string | undefined;
  readonly base64?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly available?: boolean | undefined;
}

export interface CameraStatus {
  readonly available: boolean;
  readonly device?: string | undefined;
  readonly message?: string | undefined;
  readonly formats?: readonly string[] | undefined;
}

export interface CameraVideoPlaybackInfo {
  readonly width: number;
  readonly height: number;
  readonly durationSec: number;
  readonly fps: number;
  readonly available: boolean;
  readonly message?: string | undefined;
}

export interface CameraVideoFrame extends CameraPreviewFrame {
  readonly frameIndex?: number | undefined;
  readonly ended?: boolean | undefined;
}

export interface CameraVideoPlayOptions {
  readonly startSec?: number | undefined;
}

export interface CameraService {
  capture(options?: unknown): Promise<string | CameraCaptureResult>;
  recordStart?(options?: unknown): Promise<{ recording: boolean; path?: string }>;
  recordStop?(): Promise<CameraRecordResult>;
  preview?(): Promise<CameraPreviewFrame>;
  status?(): Promise<CameraStatus>;
  readImage?(path: string): Promise<CameraPreviewFrame>;
  /**
   * Starts decoding a recorded video file into frames. The native side pumps
   * decoded RGBA frames (following the same file-based pattern as `preview`);
   * call `videoFrame()` to fetch the latest frame and `stopVideo()` to end.
   */
  playVideo?(
    path: string,
    options?: CameraVideoPlayOptions,
  ): Promise<CameraVideoPlaybackInfo>;
  /** Returns the latest decoded video frame, or undefined when unsupported. */
  videoFrame?(): Promise<CameraVideoFrame | undefined>;
  /** Stops an in-progress `playVideo` decode session. */
  stopVideo?(): Promise<void>;
}

export interface MediaTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string | undefined;
  readonly durationSec: number;
  readonly path: string;
  readonly format: string;
  readonly coverArtUri?: string | undefined;
  readonly year?: number | undefined;
  readonly genre?: string | undefined;
}

export interface MediaPlaybackStatus {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly currentPositionSec: number;
  readonly durationSec: number;
  readonly track?: MediaTrack | undefined;
  readonly volume: number;
}

export interface MediaPlaylist {
  readonly id: string;
  readonly name: string;
  readonly trackIds: readonly string[];
  readonly createdAt: number;
}

export interface MediaService {
  play(
    source: string | { path: string; track?: MediaTrack },
  ): Promise<MediaPlaybackStatus>;
  pause(): Promise<MediaPlaybackStatus>;
  resume(): Promise<MediaPlaybackStatus>;
  stop(): Promise<MediaPlaybackStatus>;
  seek(seconds: number): Promise<MediaPlaybackStatus>;
  setVolume?(volume: number): Promise<MediaPlaybackStatus>;
  status(): Promise<MediaPlaybackStatus>;
  scan?(directory?: string): Promise<readonly MediaTrack[]>;
  metadata?(path: string): Promise<MediaTrack>;
}

export interface ApplicationCapabilities {
  readonly filesystem?: Partial<SevynFileSystem> | undefined;
  readonly clipboard?: Partial<ScopedClipboard> | undefined;
  readonly notifications?: Pick<SystemNotificationService, "show"> | undefined;
  readonly network?: ScopedNetwork | undefined;
  readonly location?:
    | {
        current(): Promise<Readonly<{ latitude: number; longitude: number }>>;
      }
    | undefined;
  readonly camera?: CameraService | undefined;
  readonly microphone?: { record(): Promise<string> } | undefined;
  readonly media?: MediaService | undefined;
}
export interface ApplicationCapabilityProviders {
  readonly filesystem: SevynFileSystem;
  readonly clipboard: ScopedClipboard;
  readonly notifications: SystemNotificationService;
  readonly network: ScopedNetwork;
  readonly location: {
    current(): Promise<Readonly<{ latitude: number; longitude: number }>>;
  };
  readonly camera: CameraService;
  readonly microphone: { record(): Promise<string> };
  readonly media?: MediaService | undefined;
}
export function createApplicationCapabilities(
  applicationId: string,
  store: ApplicationPermissionStore,
  providers: ApplicationCapabilityProviders,
): ApplicationCapabilities {
  const granted = (permission: SevynPermission): boolean =>
    store.get(applicationId, permission) === "granted";
  const filesystem: Partial<SevynFileSystem> = {
    ...(granted("filesystem.read")
      ? {
          list: providers.filesystem.list.bind(providers.filesystem),
          read: providers.filesystem.read.bind(providers.filesystem),
        }
      : {}),
    ...(granted("filesystem.write")
      ? {
          write: providers.filesystem.write.bind(providers.filesystem),
          createDirectory: providers.filesystem.createDirectory.bind(
            providers.filesystem,
          ),
        }
      : {}),
  };
  const clipboard: Partial<ScopedClipboard> = {
    ...(granted("clipboard.read")
      ? { readText: providers.clipboard.readText.bind(providers.clipboard) }
      : {}),
    ...(granted("clipboard.write")
      ? { writeText: providers.clipboard.writeText.bind(providers.clipboard) }
      : {}),
  };
  return Object.freeze({
    ...(Object.keys(filesystem).length === 0
      ? {}
      : { filesystem: Object.freeze(filesystem) }),
    ...(Object.keys(clipboard).length === 0
      ? {}
      : { clipboard: Object.freeze(clipboard) }),
    ...(granted("notifications")
      ? {
          notifications: Object.freeze({
            show: providers.notifications.show.bind(providers.notifications),
          }),
        }
      : {}),
    ...(granted("network") ? { network: providers.network } : {}),
    ...(granted("location") ? { location: providers.location } : {}),
    ...(granted("camera") ? { camera: providers.camera } : {}),
    ...(granted("microphone") ? { microphone: providers.microphone } : {}),
    ...(granted("media") && providers.media !== undefined
      ? { media: providers.media }
      : {}),
  });
}
export class ApplicationResourceGovernor {
  readonly #events: (() => void)[] = [];
  #invalidations = 0;
  public constructor(
    readonly updateBudgetMilliseconds = 16,
    readonly maximumQueuedEvents = 128,
    readonly maximumInvalidationsPerTurn = 4,
  ) {}
  public runUpdate<T>(update: () => T): T {
    const started = performance.now();
    const value = update();
    if (performance.now() - started > this.updateBudgetMilliseconds)
      throw new Error("Application update exceeded its time budget.");
    return value;
  }
  public enqueue(event: () => void): boolean {
    if (this.#events.length >= this.maximumQueuedEvents) return false;
    this.#events.push(event);
    return true;
  }
  public drain(): void {
    for (const event of this.#events.splice(0)) this.runUpdate(event);
  }
  public requestInvalidation(): boolean {
    this.#invalidations += 1;
    if (this.#invalidations === 1)
      queueMicrotask(() => {
        this.#invalidations = 0;
      });
    return this.#invalidations <= this.maximumInvalidationsPerTurn;
  }
}

export class ApplicationHotReloadController<State> {
  #state: State | undefined;
  #revision = 0;
  public get revision(): number {
    return this.#revision;
  }
  public preserve(state: State): void {
    this.#state = state;
  }
  public reload(reload: (preserved: State | undefined) => void): void {
    this.#revision += 1;
    reload(this.#state);
  }
}

export interface ThirdPartyApplicationInstance {
  stop(): void;
  captureState(): unknown;
}
export interface ThirdPartyApplicationModule {
  start(preservedState: unknown): ThirdPartyApplicationInstance;
}
export interface ThirdPartyApplicationModuleLoader {
  load(applicationPackage: SevynApplicationPackage): Promise<ThirdPartyApplicationModule>;
}
export interface ThirdPartyApplicationSession {
  readonly id: string;
  readonly applicationId: string;
  readonly status: "running" | "crashed";
  readonly sanitizedError?: string;
}
export class ThirdPartyApplicationExecutionService {
  readonly #sessions = new Map<
    string,
    { session: ThirdPartyApplicationSession; instance?: ThirdPartyApplicationInstance }
  >();
  #nextSession = 0;
  public constructor(
    readonly repository: ApplicationPackageRepository,
    readonly loader: ThirdPartyApplicationModuleLoader,
    readonly governor = new ApplicationResourceGovernor(),
  ) {}
  public list(): readonly ThirdPartyApplicationSession[] {
    return Object.freeze([...this.#sessions.values()].map((entry) => entry.session));
  }
  public async launch(
    applicationId: string,
    preservedState?: unknown,
  ): Promise<ThirdPartyApplicationSession> {
    const applicationPackage = await this.repository.get(applicationId);
    if (applicationPackage === undefined)
      throw new Error(`Application "${applicationId}" is not installed.`);
    if (applicationPackage.manifest.instanceMode === "single") {
      const existing = [...this.#sessions.values()].find(
        (entry) =>
          entry.session.applicationId === applicationId &&
          entry.session.status === "running",
      );
      if (existing !== undefined) return existing.session;
    }
    this.#nextSession += 1;
    const id = `third-party-session-${String(this.#nextSession)}`;
    try {
      const module = await this.loader.load(applicationPackage);
      const instance = this.governor.runUpdate(() => module.start(preservedState));
      const session = Object.freeze({ id, applicationId, status: "running" as const });
      this.#sessions.set(id, { session, instance });
      return session;
    } catch {
      const session = Object.freeze({
        id,
        applicationId,
        status: "crashed" as const,
        sanitizedError: "The application stopped unexpectedly.",
      });
      this.#sessions.set(id, { session });
      return session;
    }
  }
  public terminate(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    entry.instance?.stop();
    this.#sessions.delete(sessionId);
  }
  public async hotReload(sessionId: string): Promise<ThirdPartyApplicationSession> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined)
      throw new Error(`Application session "${sessionId}" does not exist.`);
    const state = entry.instance?.captureState();
    const applicationId = entry.session.applicationId;
    this.terminate(sessionId);
    return this.launch(applicationId, state);
  }
}
