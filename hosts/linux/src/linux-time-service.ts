import { execFile } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SevynTimeService, TimeSyncState } from "@sevynos/react-native/internal";

const NTP_PACKET_SIZE = 48;
const NTP_EPOCH_OFFSET_SECONDS = 2208988800;
const NTP_PORT = 123;
const DEFAULT_NTP_HOSTS = ["pool.ntp.org", "time.google.com"];
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RESYNC_INTERVAL_MS = 60 * 60 * 1000;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)?$/;

export interface LinuxTimeServiceDependencies {
  createUdpSocket?: () => Socket;
  setSystemTime?: (epochMs: number) => Promise<void>;
  now?: () => number;
  timezoneFile?: string;
  localtimePath?: string;
  zoneinfoDir?: string;
  ntpHosts?: readonly string[];
  ntpPort?: number;
  ntpTimeoutMs?: number;
  resyncIntervalMs?: number;
  autoStart?: boolean;
}

function ntpTimestampToMs(seconds: number, fraction: number): number {
  return (
    (seconds - NTP_EPOCH_OFFSET_SECONDS) * 1000 + Math.round((fraction / 2 ** 32) * 1000)
  );
}

export function parseNtpOffsetMs(packet: Buffer, t1: number, t4: number): number {
  if (packet.length < NTP_PACKET_SIZE) throw new Error("Truncated NTP response.");
  const t2 = ntpTimestampToMs(packet.readUInt32BE(32), packet.readUInt32BE(36));
  const t3 = ntpTimestampToMs(packet.readUInt32BE(40), packet.readUInt32BE(44));
  return (t2 - t1 + (t3 - t4)) / 2;
}

function formatUtcForDate(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function defaultSetSystemTime(epochMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("date", ["-u", "-s", formatUtcForDate(epochMs)], (error) => {
      if (error) reject(new Error(`Failed to set system clock: ${error.message}`));
      else resolve();
    });
  });
}

export class LinuxTimeService implements SevynTimeService {
  readonly #listeners = new Set<() => void>();
  readonly #createUdpSocket: () => Socket;
  readonly #setSystemTime: (epochMs: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timezoneFile: string;
  readonly #localtimePath: string;
  readonly #zoneinfoDir: string;
  readonly #ntpHosts: readonly string[];
  readonly #ntpPort: number;
  readonly #ntpTimeoutMs: number;
  readonly #resyncIntervalMs: number;
  #state: TimeSyncState = Object.freeze({
    available: true,
    syncing: false,
    timezone: "UTC",
  });
  #syncPromise: Promise<TimeSyncState> | undefined;
  #resyncTimer: NodeJS.Timeout | undefined;
  #disposed = false;

  public constructor(deps: LinuxTimeServiceDependencies = {}) {
    this.#createUdpSocket = deps.createUdpSocket ?? (() => createSocket("udp4"));
    this.#setSystemTime = deps.setSystemTime ?? defaultSetSystemTime;
    this.#now = deps.now ?? (() => Date.now());
    this.#timezoneFile = deps.timezoneFile ?? "/etc/timezone";
    this.#localtimePath = deps.localtimePath ?? "/etc/localtime";
    this.#zoneinfoDir = deps.zoneinfoDir ?? "/usr/share/zoneinfo";
    this.#ntpHosts = deps.ntpHosts ?? DEFAULT_NTP_HOSTS;
    this.#ntpPort = deps.ntpPort ?? NTP_PORT;
    this.#ntpTimeoutMs = deps.ntpTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#resyncIntervalMs = deps.resyncIntervalMs ?? DEFAULT_RESYNC_INTERVAL_MS;
    if (deps.autoStart !== false) this.#start();
  }

  public async snapshot(): Promise<TimeSyncState> {
    const timezone = await this.#readTimezone().catch(() => "UTC");
    if (timezone !== this.#state.timezone) {
      this.#state = Object.freeze({ ...this.#state, timezone });
    }
    return this.#state;
  }

  public syncNow(): Promise<TimeSyncState> {
    if (this.#syncPromise) return this.#syncPromise;
    this.#syncPromise = this.#performSync().finally(() => {
      this.#syncPromise = undefined;
    });
    return this.#syncPromise;
  }

  public notifyNetworkAvailable(): void {
    if (this.#disposed || this.#state.lastSyncAt !== undefined) return;
    void this.syncNow();
  }

  public async setTimezone(timezone: string): Promise<TimeSyncState> {
    if (!TIMEZONE_PATTERN.test(timezone) || timezone.includes("..")) {
      throw new Error(`Invalid timezone: ${timezone}`);
    }
    const zoneinfoPath = join(this.#zoneinfoDir, timezone);
    await readFile(zoneinfoPath).catch(() => {
      throw new Error(`Unknown timezone: ${timezone}`);
    });
    await writeFile(this.#timezoneFile, `${timezone}\n`, "utf8");
    await unlink(this.#localtimePath).catch(() => undefined);
    await symlink(zoneinfoPath, this.#localtimePath);
    this.#setState({ ...this.#state, timezone, error: undefined });
    return this.#state;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  public dispose(): void {
    this.#disposed = true;
    if (this.#resyncTimer) {
      clearInterval(this.#resyncTimer);
      this.#resyncTimer = undefined;
    }
    this.#listeners.clear();
  }

  #start(): void {
    void this.#readTimezone()
      .then((timezone) => {
        this.#setState({ ...this.#state, timezone });
      })
      .catch(() => undefined);
    this.#resyncTimer = setInterval(() => {
      if (!this.#disposed) void this.syncNow();
    }, this.#resyncIntervalMs);
    if (typeof this.#resyncTimer.unref === "function") this.#resyncTimer.unref();
    setTimeout(() => {
      if (!this.#disposed) void this.syncNow();
    }, 5000);
  }

  async #readTimezone(): Promise<string> {
    const raw = await readFile(this.#timezoneFile, "utf8");
    const timezone = raw.trim();
    if (!TIMEZONE_PATTERN.test(timezone)) throw new Error("Invalid timezone file.");
    return timezone;
  }

  #setState(next: TimeSyncState): void {
    this.#state = Object.freeze(next);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Listener failures must not break the service.
      }
    }
  }

  async #performSync(): Promise<TimeSyncState> {
    this.#setState({ ...this.#state, syncing: true, error: undefined });
    let lastError = "All NTP servers failed.";
    for (const host of this.#ntpHosts) {
      try {
        const offsetMs = await this.#queryNtp(host);
        const correctedMs = this.#now() + offsetMs;
        await this.#setSystemTime(correctedMs);
        this.#setState({
          ...this.#state,
          syncing: false,
          lastSyncAt: this.#now(),
          offsetMs: Math.round(offsetMs),
          error: undefined,
        });
        return this.#state;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.#setState({ ...this.#state, syncing: false, error: lastError });
    return this.#state;
  }

  #queryNtp(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = this.#createUdpSocket();
      const request = Buffer.alloc(NTP_PACKET_SIZE);
      request[0] = 0x1b;
      const t1 = this.#now();
      let settled = false;
      const done = (error?: Error, offsetMs?: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(offsetMs ?? 0);
      };
      const timer = setTimeout(() => {
        done(new Error(`NTP request to ${host} timed out.`));
      }, this.#ntpTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      socket.on("error", (error) => {
        done(error instanceof Error ? error : new Error(String(error)));
      });
      socket.on("message", (message) => {
        try {
          const t4 = this.#now();
          done(undefined, parseNtpOffsetMs(message, t1, t4));
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.send(request, this.#ntpPort, host, (error) => {
        if (error) done(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}
