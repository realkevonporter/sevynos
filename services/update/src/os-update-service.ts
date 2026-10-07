import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { isUpdateAvailable, parseOsVersion } from "./version.js";
import { verifyUpdateFeed, type TrustedUpdateKey } from "./feed-signing.js";
import {
  parseUpdateFeed,
  selectRootfsArtifact,
  type UpdateArtifact,
  type UpdateFeedManifest,
} from "./update-feed.js";

export type OsUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "applying"
  | "pending-reboot"
  | "error";

export interface UpdateCheckResult {
  readonly status: OsUpdateStatus;
  readonly currentVersion: string;
  readonly latestVersion?: string | undefined;
  readonly releaseNotes?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly artifact?: UpdateArtifact | undefined;
  readonly checkedAt: number;
  readonly error?: string | undefined;
}

export interface StagedUpdate {
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface PendingUpdate {
  readonly version: string;
  readonly payloadPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly stagedAt: string;
}

export interface OsUpdateServiceOptions {
  /** Version of the running system, e.g. from /etc/sevynos-release. */
  readonly currentVersion: string;
  /** URL of the versioned JSON feed (updates.json). */
  readonly feedUrl: string;
  /** Host state directory; updates stage under <stateDirectory>/updates. */
  readonly stateDirectory: string;
  /**
   * Trust anchors for feed signature verification (public keys only).
   * Verification is mandatory and fail-closed: when this is empty or
   * omitted, every feed check errors with "no trusted update keys" rather
   * than silently trusting an unsigned feed. Production hosts pass the keys
   * loaded from /etc/sevynos/trusted-update-keys.json.
   */
  readonly trustedKeys?: readonly TrustedUpdateKey[] | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** First automatic check delay; defaults to 60s so boot networking settles. */
  readonly autoCheckDelayMs?: number | undefined;
  readonly autoCheckIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export type UpdateProgressListener = (receivedBytes: number, totalBytes: number) => void;

const DEFAULT_AUTO_CHECK_DELAY_MS = 60_000;
const DEFAULT_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the running OS version. Prefers /etc/sevynos-release (written by the
 * installer), then SEVYN_OS_VERSION, then a dev fallback.
 */
export async function resolveCurrentVersion(
  readReleaseFile: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  try {
    const content = await readReleaseFile("/etc/sevynos-release");
    const match = /^VERSION_ID\s*=\s*"?([^"\n]+)"?/m.exec(content);
    const version = match?.[1]?.trim();
    if (version !== undefined && version.length > 0) return version;
  } catch {
    // Fall through to the environment fallback.
  }
  const fromEnv = process.env["SEVYN_OS_VERSION"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return "0.0.0-dev";
}

/**
 * Minimal OS update check: polls a versioned JSON feed, verifies its Ed25519
 * signature against the configured trust anchors BEFORE trusting any
 * artifact URL or hash, downloads the new rootfs payload with integrity
 * verification, and stages it for the boot-time applier
 * (tools/qemu/sevyn-apply-update.sh consumes
 * <stateDirectory>/updates/pending.json).
 */
export class OsUpdateService {
  readonly #currentVersion: string;
  readonly #feedUrl: string;
  readonly #stateDirectory: string;
  readonly #trustedKeys: readonly TrustedUpdateKey[];
  readonly #fetch: typeof fetch;
  readonly #autoCheckDelayMs: number;
  readonly #autoCheckIntervalMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #status: OsUpdateStatus = "idle";
  #lastResult: UpdateCheckResult | undefined;
  #lastManifest: UpdateFeedManifest | undefined;
  #checkPromise: Promise<UpdateCheckResult> | undefined;
  #autoCheckTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  public constructor(options: OsUpdateServiceOptions) {
    // Validate the version eagerly so a bad install is loud, not silent.
    parseOsVersion(options.currentVersion);
    if (!options.feedUrl.startsWith("https://"))
      throw new Error("The update feed URL must be https.");
    this.#currentVersion = options.currentVersion;
    this.#feedUrl = options.feedUrl;
    this.#stateDirectory = options.stateDirectory;
    this.#trustedKeys = options.trustedKeys ?? [];
    this.#fetch = options.fetchImpl ?? fetch;
    this.#autoCheckDelayMs = options.autoCheckDelayMs ?? DEFAULT_AUTO_CHECK_DELAY_MS;
    this.#autoCheckIntervalMs =
      options.autoCheckIntervalMs ?? DEFAULT_AUTO_CHECK_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  public get status(): OsUpdateStatus {
    return this.#status;
  }

  public get currentVersion(): string {
    return this.#currentVersion;
  }

  public get lastResult(): UpdateCheckResult | undefined {
    return this.#lastResult;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public checkNow(): Promise<UpdateCheckResult> {
    if (this.#checkPromise !== undefined) return this.#checkPromise;
    this.#checkPromise = this.#performCheck().finally(() => {
      this.#checkPromise = undefined;
    });
    return this.#checkPromise;
  }

  /**
   * Downloads the rootfs payload from the most recent check. Requires a
   * check that found an update; verifies size and sha256 while streaming.
   */
  public async downloadUpdate(
    onProgress?: UpdateProgressListener,
  ): Promise<StagedUpdate> {
    const manifest = this.#lastManifest;
    const artifact = this.#lastManifestArtifact();
    if (manifest === undefined || artifact === undefined)
      throw new Error("Check for updates before downloading.");
    if (this.#status === "downloading") throw new Error("A download is already running.");
    this.#setStatus("downloading");

    const stagingDir = join(this.#updatesDir(), manifest.version);
    await mkdir(stagingDir, { recursive: true });
    const finalPath = join(stagingDir, "rootfs.squashfs");
    const tmpPath = `${finalPath}.part`;
    try {
      const received = await this.#streamToFile(artifact, tmpPath, onProgress);
      if (received !== artifact.sizeBytes) {
        throw new Error(
          `Download size mismatch: got ${String(received)} bytes, expected ${String(artifact.sizeBytes)}.`,
        );
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      this.#setStatus("error");
      throw error;
    }
    this.#setStatus("downloaded");
    return {
      version: manifest.version,
      path: finalPath,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    };
  }

  /**
   * Stages a downloaded update for the boot-time applier and returns after
   * writing pending.json. The caller reboots; sevyn-apply-update.sh applies
   * the payload before genesis starts.
   */
  public async applyUpdate(staged: StagedUpdate): Promise<void> {
    this.#setStatus("applying");
    const record: PendingUpdate = {
      version: staged.version,
      payloadPath: staged.path,
      sha256: staged.sha256,
      sizeBytes: staged.sizeBytes,
      stagedAt: new Date(this.#now()).toISOString(),
    };
    await mkdir(this.#updatesDir(), { recursive: true });
    await writeFile(this.#pendingPath(), `${JSON.stringify(record)}\n`, "utf8");
    this.#setStatus("pending-reboot");
  }

  public async pendingUpdate(): Promise<PendingUpdate | undefined> {
    try {
      const raw = await readFile(this.#pendingPath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed["version"] !== "string" ||
        typeof parsed["payloadPath"] !== "string" ||
        typeof parsed["sha256"] !== "string" ||
        typeof parsed["sizeBytes"] !== "number"
      )
        return undefined;
      return {
        version: parsed["version"],
        payloadPath: parsed["payloadPath"],
        sha256: parsed["sha256"],
        sizeBytes: parsed["sizeBytes"],
        stagedAt: typeof parsed["stagedAt"] === "string" ? parsed["stagedAt"] : "",
      };
    } catch {
      return undefined;
    }
  }

  public async clearPendingUpdate(): Promise<void> {
    const pending = await this.pendingUpdate();
    await rm(this.#pendingPath(), { force: true });
    if (pending !== undefined) {
      await rm(join(this.#updatesDir(), pending.version), {
        recursive: true,
        force: true,
      });
    }
    if (this.#status === "pending-reboot" || this.#status === "downloaded")
      this.#setStatus("idle");
  }

  public startAutoCheck(): void {
    this.stopAutoCheck();
    if (this.#disposed) return;
    this.#autoCheckTimer = setTimeout(() => {
      if (this.#disposed) return;
      void this.checkNow().catch(() => undefined);
      this.#autoCheckTimer = setInterval(() => {
        if (!this.#disposed) void this.checkNow().catch(() => undefined);
      }, this.#autoCheckIntervalMs);
      if (typeof this.#autoCheckTimer.unref === "function") this.#autoCheckTimer.unref();
    }, this.#autoCheckDelayMs);
    if (typeof this.#autoCheckTimer.unref === "function") this.#autoCheckTimer.unref();
  }

  public stopAutoCheck(): void {
    if (this.#autoCheckTimer !== undefined) {
      clearTimeout(this.#autoCheckTimer);
      clearInterval(this.#autoCheckTimer);
      this.#autoCheckTimer = undefined;
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.stopAutoCheck();
    this.#listeners.clear();
  }

  #updatesDir(): string {
    return join(this.#stateDirectory, "updates");
  }

  #pendingPath(): string {
    return join(this.#updatesDir(), "pending.json");
  }

  #lastManifestArtifact(): UpdateArtifact | undefined {
    return this.#lastManifest === undefined
      ? undefined
      : selectRootfsArtifact(this.#lastManifest);
  }

  async #performCheck(): Promise<UpdateCheckResult> {
    this.#setStatus("checking");
    const checkedAt = this.#now();
    try {
      const response = await this.#fetch(this.#feedUrl, {
        headers: { accept: "application/json" },
      });
      if (!response.ok)
        throw new Error(`Feed request failed with HTTP ${String(response.status)}.`);
      const manifest = parseUpdateFeed(await response.text());
      // Verify the feed signature BEFORE trusting any artifact URL or hash.
      // A verification failure lands in the "error" result below and is
      // shown in the Software Update UI; nothing is downloaded or staged.
      verifyUpdateFeed(manifest, this.#trustedKeys);
      // Validate the feed version parses before comparing.
      parseOsVersion(manifest.version);
      const artifact = selectRootfsArtifact(manifest);
      if (artifact === undefined)
        throw new Error("The feed has no rootfs-squashfs artifact.");
      this.#lastManifest = manifest;
      if (isUpdateAvailable(this.#currentVersion, manifest.version)) {
        const result: UpdateCheckResult = {
          status: "update-available",
          currentVersion: this.#currentVersion,
          latestVersion: manifest.version,
          releaseNotes: manifest.releaseNotes,
          publishedAt: manifest.publishedAt,
          artifact,
          checkedAt,
        };
        this.#lastResult = result;
        this.#setStatus("update-available");
        return result;
      }
      const result: UpdateCheckResult = {
        status: "up-to-date",
        currentVersion: this.#currentVersion,
        latestVersion: manifest.version,
        checkedAt,
      };
      this.#lastResult = result;
      this.#setStatus("up-to-date");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: UpdateCheckResult = {
        status: "error",
        currentVersion: this.#currentVersion,
        checkedAt,
        error: message,
      };
      this.#lastResult = result;
      this.#setStatus("error");
      return result;
    }
  }

  async #streamToFile(
    artifact: UpdateArtifact,
    tmpPath: string,
    onProgress: UpdateProgressListener | undefined,
  ): Promise<number> {
    const response = await this.#fetch(artifact.url);
    if (!response.ok || response.body === null)
      throw new Error(`Download failed with HTTP ${String(response.status)}.`);
    const hash = createHash("sha256");
    const file = createWriteStream(tmpPath);
    let received = 0;
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
        hash.update(chunk);
        if (!file.write(chunk)) await once(file, "drain");
        if (onProgress !== undefined) {
          onProgress(received, artifact.sizeBytes);
        }
      }
    } catch (error) {
      file.destroy();
      throw error;
    }
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256)
      throw new Error("Download failed integrity check (sha256 mismatch).");
    await new Promise<void>((resolve, reject) => {
      file.on("error", reject);
      file.end(() => {
        resolve();
      });
    });
    return received;
  }

  #setStatus(status: OsUpdateStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Listener failures must not break the service.
      }
    }
  }
}

export function defaultUpdateFeedUrl(): string {
  return "https://github.com/realkevonporter/sevynos/releases/download/nightly/updates.json";
}
