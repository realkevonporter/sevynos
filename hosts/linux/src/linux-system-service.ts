import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import type {
  SystemHardwareSnapshot,
  SevynSystemService,
} from "@sevynos/react-native/internal";

export interface LinuxSystemServiceOptions {
  readonly procStatPath?: string;
  readonly procMeminfoPath?: string;
  readonly procUptimePath?: string;
}

export class LinuxSystemService implements SevynSystemService {
  readonly #options: LinuxSystemServiceOptions;
  readonly #listeners = new Set<() => void>();
  #lastCpuTotal = 0;
  #lastCpuIdle = 0;
  #lastCpuPercent = 0;
  #timer: NodeJS.Timeout | undefined;

  public constructor(options: LinuxSystemServiceOptions = {}) {
    this.#options = options;
  }

  public async snapshot(): Promise<SystemHardwareSnapshot> {
    const cores = cpus().length || 0;
    let memoryTotalBytes = 0;
    let memoryAvailableBytes = 0;
    let uptimeSeconds = 0;

    try {
      const statPath = this.#options.procStatPath ?? "/proc/stat";
      const statContent = await readFile(statPath, "utf8").catch(() => "");
      if (statContent.length > 0) {
        const firstLine = statContent.split("\n")[0];
        if (firstLine !== undefined) {
          const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
          const part3 = parts[3];
          const part4 = parts[4];
          if (part3 !== undefined) {
            const idle = part3 + (part4 ?? 0);
            const total = parts.reduce((sum, val) => sum + val, 0);
            const diffTotal = total - this.#lastCpuTotal;
            const diffIdle = idle - this.#lastCpuIdle;
            if (diffTotal > 0) {
              this.#lastCpuPercent = Math.round(
                ((diffTotal - diffIdle) / diffTotal) * 100,
              );
            }
            this.#lastCpuTotal = total;
            this.#lastCpuIdle = idle;
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
    } catch {
      // Ignored
    }

    const memoryUsedBytes = Math.max(0, memoryTotalBytes - memoryAvailableBytes);

    return Object.freeze({
      cpuPercent: Math.min(100, Math.max(0, this.#lastCpuPercent)),
      cpuCores: cores,
      memoryTotalBytes,
      memoryUsedBytes,
      memoryAvailableBytes,
      uptimeSeconds,
    });
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
