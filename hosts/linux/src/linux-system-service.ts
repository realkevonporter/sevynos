import { readFile, statfs } from "node:fs/promises";
import type { StatsFs } from "node:fs";
import { cpus } from "node:os";
import type {
  DiskUsage,
  NetworkInterfaceThroughput,
  SystemHardwareSnapshot,
  SevynSystemService,
} from "@sevynos/react-native/internal";

export interface LinuxSystemServiceOptions {
  readonly procStatPath?: string;
  readonly procMeminfoPath?: string;
  readonly procUptimePath?: string;
  /** Defaults to "/proc/net/dev". Overridable for tests. */
  readonly procNetDevPath?: string;
  /** Filesystem path to report disk usage for. Defaults to "/". */
  readonly diskPath?: string;
  /** Clock for network throughput deltas. Defaults to Date.now; tests inject. */
  readonly now?: () => number;
}

interface NetworkCounters {
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly atMs: number;
}

export class LinuxSystemService implements SevynSystemService {
  readonly #options: LinuxSystemServiceOptions;
  readonly #listeners = new Set<() => void>();
  #lastCpuTotal = 0;
  #lastCpuIdle = 0;
  #lastCpuPercent = 0;
  readonly #lastCoreTotal = new Map<number, number>();
  readonly #lastCoreIdle = new Map<number, number>();
  #lastCorePercents: readonly number[] = Object.freeze([]);
  readonly #lastNetCounters = new Map<string, NetworkCounters>();
  #timer: NodeJS.Timeout | undefined;

  public constructor(options: LinuxSystemServiceOptions = {}) {
    this.#options = options;
  }

  public async snapshot(): Promise<SystemHardwareSnapshot> {
    const cores = cpus().length || 0;
    let memoryTotalBytes = 0;
    let memoryAvailableBytes = 0;
    let uptimeSeconds = 0;
    let disks: readonly DiskUsage[] | undefined;
    let networkInterfaces: readonly NetworkInterfaceThroughput[] | undefined;

    try {
      const statPath = this.#options.procStatPath ?? "/proc/stat";
      const statContent = await readFile(statPath, "utf8").catch(() => "");
      if (statContent.length > 0) {
        const lines = statContent.split("\n");
        for (const line of lines) {
          const cpuMatch = /^cpu(\d*)\s+(.*)$/.exec(line.trim());
          if (cpuMatch === null) continue;
          const coreIndex = cpuMatch[1];
          const fields = cpuMatch[2];
          if (coreIndex === undefined || fields === undefined) continue;
          const parts = fields.trim().split(/\s+/).map(Number);
          const part3 = parts[3];
          const part4 = parts[4];
          if (part3 === undefined || Number.isNaN(part3)) continue;
          const idle = part3 + (part4 ?? 0);
          const total = parts.reduce((sum, val) => sum + val, 0);
          if (coreIndex === "") {
            // Aggregate line.
            const diffTotal = total - this.#lastCpuTotal;
            const diffIdle = idle - this.#lastCpuIdle;
            if (diffTotal > 0) {
              this.#lastCpuPercent = Math.round(
                ((diffTotal - diffIdle) / diffTotal) * 100,
              );
            }
            this.#lastCpuTotal = total;
            this.#lastCpuIdle = idle;
          } else {
            // Per-core line (cpu0, cpu1, ...).
            const core = parseInt(coreIndex, 10);
            if (!Number.isSafeInteger(core)) continue;
            const lastTotal = this.#lastCoreTotal.get(core);
            const lastIdle = this.#lastCoreIdle.get(core);
            if (lastTotal !== undefined && lastIdle !== undefined) {
              const diffTotal = total - lastTotal;
              const diffIdle = idle - lastIdle;
              if (diffTotal > 0) {
                const percent = Math.round(((diffTotal - diffIdle) / diffTotal) * 100);
                const next = Array.from(this.#lastCorePercents);
                while (next.length <= core) next.push(0);
                next[core] = Math.min(100, Math.max(0, percent));
                this.#lastCorePercents = Object.freeze(next);
              }
            }
            this.#lastCoreTotal.set(core, total);
            this.#lastCoreIdle.set(core, idle);
          }
        }
      }

      const memPath = this.#options.procMeminfoPath ?? "/proc/meminfo";
      const memContent = await readFile(memPath, "utf8").catch(() => "");
      if (memContent.length > 0) {
        const totalMatch = /MemTotal:\s+(\d+)\s+kB/.exec(memContent);
        const availMatch = /MemAvailable:\s+(\d+)\s+kB/.exec(memContent);
        if (totalMatch?.[1]) {
          memoryTotalBytes = parseInt(totalMatch[1], 10) * 1024;
        }
        if (availMatch?.[1]) {
          memoryAvailableBytes = parseInt(availMatch[1], 10) * 1024;
        }
      }

      const uptimePath = this.#options.procUptimePath ?? "/proc/uptime";
      const uptimeContent = await readFile(uptimePath, "utf8").catch(() => "");
      if (uptimeContent.length > 0) {
        const uptimeFirst = uptimeContent.trim().split(" ")[0];
        if (uptimeFirst !== undefined) {
          uptimeSeconds = Math.round(parseFloat(uptimeFirst) || 0);
        }
      }

      disks = await this.#readDiskUsage();
      networkInterfaces = await this.#readNetworkInterfaces();
    } catch {
      // Ignored
    }

    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);

    return Object.freeze({
      cpuPercent: Math.min(100, Math.max(0, this.#lastCpuPercent)),
      cpuCores: cores,
      cpuCorePercents:
        this.#lastCorePercents.length > 0 ? this.#lastCorePercents : undefined,
      memoryTotalBytes,
      memoryUsedBytes,
      memoryAvailableBytes,
      uptimeSeconds,
      disks,
      networkInterfaces,
    });
  }

  /** Real disk usage via statfs; undefined when the path cannot be stat'ed. */
  async #readDiskUsage(): Promise<readonly DiskUsage[] | undefined> {
    const diskPath = this.#options.diskPath ?? "/";
    let stats: StatsFs;
    try {
      stats = await statfs(diskPath);
    } catch {
      return undefined;
    }
    const totalBytes = stats.blocks * stats.bsize;
    // bavail is what unprivileged processes can actually use.
    const freeBytes = Math.max(0, stats.bavail * stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return Object.freeze([
      Object.freeze({ mountPoint: diskPath, totalBytes, usedBytes, freeBytes }),
    ]);
  }

  /**
   * Real per-interface throughput from /proc/net/dev. Rates are deltas
   * between this sample and the previous one; the first sample reports 0
   * and only establishes the baseline. Loopback is excluded.
   */
  async #readNetworkInterfaces(): Promise<
    readonly NetworkInterfaceThroughput[] | undefined
  > {
    const netDevPath = this.#options.procNetDevPath ?? "/proc/net/dev";
    const content = await readFile(netDevPath, "utf8").catch(() => "");
    if (content.length === 0) return undefined;
    const nowMs = (this.#options.now ?? Date.now)();
    const interfaces: NetworkInterfaceThroughput[] = [];
    for (const line of content.split("\n")) {
      const match = /^\s*([^:\s]+)\s*:\s*(.*)$/.exec(line);
      const name = match?.[1];
      const fieldsText = match?.[2];
      if (name === undefined || fieldsText === undefined || name === "lo") {
        continue;
      }
      const fields = fieldsText.trim().split(/\s+/).map(Number);
      const rxBytes = fields[0];
      const txBytes = fields[8];
      if (
        rxBytes === undefined ||
        txBytes === undefined ||
        !Number.isFinite(rxBytes) ||
        !Number.isFinite(txBytes)
      ) {
        continue;
      }
      let rxBytesPerSecond = 0;
      let txBytesPerSecond = 0;
      const last = this.#lastNetCounters.get(name);
      if (last !== undefined) {
        const elapsedSeconds = (nowMs - last.atMs) / 1000;
        // Counters only move forward; a drop means reset/wrap — re-baseline.
        if (elapsedSeconds > 0 && rxBytes >= last.rxBytes && txBytes >= last.txBytes) {
          rxBytesPerSecond = (rxBytes - last.rxBytes) / elapsedSeconds;
          txBytesPerSecond = (txBytes - last.txBytes) / elapsedSeconds;
        }
      }
      this.#lastNetCounters.set(name, { rxBytes, txBytes, atMs: nowMs });
      interfaces.push(
        Object.freeze({
          name,
          rxBytesPerSecond: Math.max(0, rxBytesPerSecond),
          txBytesPerSecond: Math.max(0, txBytesPerSecond),
          rxBytesTotal: rxBytes,
          txBytesTotal: txBytes,
        }),
      );
    }
    return interfaces.length > 0 ? Object.freeze(interfaces) : undefined;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.snapshot().then(() => {
          for (const l of this.#listeners) l();
        });
      }, 3000);
      if (typeof this.#timer === "object" && "unref" in this.#timer) {
        this.#timer.unref();
      }
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  }

  public close(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#listeners.clear();
  }
}
