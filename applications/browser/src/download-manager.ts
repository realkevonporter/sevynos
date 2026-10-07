/**
 * Download record, structurally identical to the framework's BrowserDownload
 * (which services.ts defines but sdk.ts does not re-export). Kept local so
 * the browser app does not depend on an unexported type.
 */
export interface EngineDownload {
  readonly guid: string;
  readonly url: string;
  readonly filename: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly state: string;
}

/**
 * Downloads manager backing store for the browser's downloads panel.
 *
 * The engine snapshot (`BrowserEngineSnapshot.downloads`) is the source of
 * live in-progress downloads. Finished downloads are also recorded into a
 * persisted history so the list survives restarts and so entries remain
 * actionable after the engine drops them from its snapshot. Dismissing an
 * entry only hides it in this manager; it never deletes the downloaded file.
 *
 * Engine implementations that never populate `snapshot().downloads` simply
 * contribute nothing — the history half keeps working.
 */

export interface DownloadHistoryEntry {
  readonly guid: string;
  readonly url: string;
  readonly filename: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly state: string;
  readonly completedAt: number;
}

export interface ManagedDownload extends EngineDownload {
  /** True when this entry comes from persisted history rather than the engine. */
  readonly fromHistory: boolean;
}

export interface DownloadManagerStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export const DOWNLOAD_HISTORY_STORAGE_KEY = "sevyn.browser.download-history";
const MAX_HISTORY_ENTRIES = 100;

const FINISHED_STATES = new Set(["completed", "cancelled", "interrupted"]);

export function isDownloadFinished(state: string): boolean {
  return FINISHED_STATES.has(state);
}

/** A finished `.sevyn`/`.sevynapp` bundle can be handed to the installer. */
export function isInstallableDownload(download: EngineDownload): boolean {
  return download.state === "completed" && /\.(sevyn|sevynapp)$/i.test(download.filename);
}

export function downloadProgressPercent(download: EngineDownload): number | undefined {
  if (download.state !== "in_progress" || download.totalBytes <= 0) return undefined;
  return Math.max(
    0,
    Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)),
  );
}

export function describeDownloadState(download: EngineDownload): string {
  switch (download.state) {
    case "in_progress": {
      const percent = downloadProgressPercent(download);
      return percent === undefined ? "Downloading…" : `Downloading… ${String(percent)}%`;
    }
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Interrupted";
  }
}

export function formatDownloadBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "unknown size";
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = sizeBytes / 1024;
  let unit: (typeof units)[number] = "KB";
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === "GB") break;
    value /= 1024;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${unit}`;
}

function toHistoryEntry(
  download: EngineDownload,
  completedAt: number,
): DownloadHistoryEntry {
  return {
    guid: download.guid,
    url: download.url,
    filename: download.filename,
    receivedBytes: download.receivedBytes,
    totalBytes: download.totalBytes,
    state: download.state,
    completedAt,
  };
}

function parseHistory(raw: string | undefined): DownloadHistoryEntry[] {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DownloadHistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { guid?: unknown }).guid === "string" &&
        typeof (entry as { filename?: unknown }).filename === "string",
    );
  } catch {
    return [];
  }
}

export class EngineDownloadManager {
  readonly #storage: DownloadManagerStorage | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  readonly #history = new Map<string, DownloadHistoryEntry>();
  readonly #engine = new Map<string, EngineDownload>();
  readonly #dismissed = new Set<string>();
  #loaded = false;

  public constructor(
    options: {
      readonly storage?: DownloadManagerStorage | undefined;
      readonly now?: (() => number) | undefined;
    } = {},
  ) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Loads persisted history. Safe to call when no storage is configured. */
  public async load(): Promise<void> {
    if (this.#loaded || this.#storage === undefined) return;
    this.#loaded = true;
    try {
      const raw = await this.#storage.get(DOWNLOAD_HISTORY_STORAGE_KEY);
      for (const entry of parseHistory(raw)) {
        if (!this.#dismissed.has(entry.guid)) this.#history.set(entry.guid, entry);
      }
    } catch {
      // Corrupt history is not fatal; start empty.
    }
    this.#notify();
  }

  /**
   * Merges the latest engine snapshot downloads. Engine entries win over
   * history for the same guid; newly finished engine entries are recorded
   * into history.
   */
  public syncEngineDownloads(downloads: readonly EngineDownload[]): void {
    let changed = false;
    const seen = new Set<string>();
    for (const download of downloads) {
      seen.add(download.guid);
      const previous = this.#engine.get(download.guid);
      if (
        previous?.state !== download.state ||
        previous.receivedBytes !== download.receivedBytes
      ) {
        changed = true;
      }
      this.#engine.set(download.guid, download);
      if (
        isDownloadFinished(download.state) &&
        !this.#history.has(download.guid) &&
        !this.#dismissed.has(download.guid)
      ) {
        this.#history.set(download.guid, toHistoryEntry(download, this.#now()));
        changed = true;
        this.#persist();
      }
    }
    for (const guid of [...this.#engine.keys()]) {
      if (!seen.has(guid)) {
        this.#engine.delete(guid);
        changed = true;
      }
    }
    if (changed) this.#notify();
  }

  /** Record a finished download the engine never reported (host hook). */
  public noteCompleted(download: EngineDownload): void {
    if (this.#dismissed.has(download.guid)) return;
    this.#history.set(download.guid, toHistoryEntry(download, this.#now()));
    this.#persist();
    this.#notify();
  }

  /** Hide an entry from the list. The downloaded file is untouched. */
  public dismiss(guid: string): void {
    if (this.#dismissed.has(guid)) return;
    this.#dismissed.add(guid);
    this.#engine.delete(guid);
    this.#history.delete(guid);
    this.#persist();
    this.#notify();
  }

  /** Hide every finished entry. In-progress downloads keep their progress. */
  public clearFinished(): void {
    let changed = false;
    for (const download of this.list()) {
      if (isDownloadFinished(download.state)) {
        this.#dismissed.add(download.guid);
        this.#engine.delete(download.guid);
        this.#history.delete(download.guid);
        changed = true;
      }
    }
    if (changed) {
      this.#persist();
      this.#notify();
    }
  }

  public get finishedCount(): number {
    return this.list().filter((d) => isDownloadFinished(d.state)).length;
  }

  public list(): readonly ManagedDownload[] {
    const merged = new Map<string, ManagedDownload>();
    for (const entry of this.#history.values()) {
      if (this.#dismissed.has(entry.guid)) continue;
      merged.set(entry.guid, { ...entry, fromHistory: true });
    }
    for (const download of this.#engine.values()) {
      if (this.#dismissed.has(download.guid)) continue;
      merged.set(download.guid, { ...download, fromHistory: false });
    }
    return [...merged.values()].sort((a, b) => {
      const aActive = a.state === "in_progress" ? 0 : 1;
      const bActive = b.state === "in_progress" ? 0 : 1;
      return aActive - bActive;
    });
  }

  #persist(): void {
    if (this.#storage === undefined) return;
    const entries = [...this.#history.values()]
      .filter((entry) => !this.#dismissed.has(entry.guid))
      .slice(-MAX_HISTORY_ENTRIES);
    void this.#storage
      .set(DOWNLOAD_HISTORY_STORAGE_KEY, JSON.stringify(entries))
      .catch(() => undefined);
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Listener failures must not break the manager.
      }
    }
  }
}
