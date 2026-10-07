// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProcessInfo,
  ProcessSnapshot,
  SevynProcessService,
} from "@sevynos/react-native/internal";

export interface LinuxProcessServiceOptions {
  /** Defaults to "/proc". Overridable for tests. */
  readonly procPath?: string;
  /** Defaults to 4096. Resident pages from /proc/<pid>/stat are multiplied by this. */
  readonly pageSizeBytes?: number;
  /** Snapshot refresh interval for subscribers. Defaults to 3000ms. */
  readonly refreshIntervalMs?: number;
}

const PROCESS_STATE_INDEX = 0; // field 3 (state) after the comm token
const RSS_INDEX = 21; // field 24 (rss, pages) after the comm token

export class LinuxProcessService implements SevynProcessService {
  readonly #options: LinuxProcessServiceOptions;
  readonly #listeners = new Set<() => void>();
  #timer: NodeJS.Timeout | undefined;

  public constructor(options: LinuxProcessServiceOptions = {}) {
    this.#options = options;
  }

  public async snapshot(): Promise<ProcessSnapshot> {
    const procPath = this.#options.procPath ?? "/proc";
    const pageSize = this.#options.pageSizeBytes ?? 4096;
    const processes: ProcessInfo[] = [];

    let entries: string[];
    try {
      entries = await readdir(procPath);
    } catch {
      return Object.freeze({ processes: Object.freeze([]) });
    }

    const reads = entries
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => this.#readProcess(procPath, entry, pageSize));
    const results = await Promise.all(reads);
    for (const info of results) {
      if (info !== undefined) processes.push(info);
    }
    // Most memory-hungry first; ties broken by pid for a stable order.
    processes.sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid);

    return Object.freeze({
      processes: Object.freeze(processes),
    });
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#timer === undefined) {
      const intervalMs = this.#options.refreshIntervalMs ?? 3000;
      this.#timer = setInterval(() => {
        void this.snapshot().then(() => {
          for (const l of this.#listeners) l();
        });
      }, intervalMs);
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

  async #readProcess(
    procPath: string,
    entry: string,
    pageSize: number,
  ): Promise<ProcessInfo | undefined> {
    const pid = parseInt(entry, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    let stat: string;
    try {
      stat = await readFile(join(procPath, entry, "stat"), "utf8");
    } catch {
      // The process exited (or is unreadable) between readdir and read.
      return undefined;
    }
    const openParen = stat.indexOf("(");
    const closeParen = stat.lastIndexOf(")");
    if (openParen < 0 || closeParen <= openParen) return undefined;
    const name = stat.slice(openParen + 1, closeParen);
    const rest = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const state = rest[PROCESS_STATE_INDEX];
    if (state === undefined) return undefined;
    const rssPages = Number(rest[RSS_INDEX]);
    const memoryBytes =
      Number.isFinite(rssPages) && rssPages > 0 ? rssPages * pageSize : 0;
    return Object.freeze({
      pid,
      name: name.length > 0 ? name : String(pid),
      state,
      memoryBytes,
    });
  }
}
