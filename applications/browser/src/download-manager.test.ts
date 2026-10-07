import { describe, expect, it, vi } from "vitest";
import {
  EngineDownloadManager,
  describeDownloadState,
  downloadProgressPercent,
  formatDownloadBytes,
  isDownloadFinished,
  isInstallableDownload,
  type DownloadManagerStorage,
  type EngineDownload,
} from "./download-manager.js";

function download(overrides: Partial<EngineDownload> = {}): EngineDownload {
  return {
    guid: "guid-1",
    url: "https://example.com/file.zip",
    filename: "file.zip",
    receivedBytes: 50,
    totalBytes: 100,
    state: "in_progress",
    ...overrides,
  };
}

function memoryStorage(): DownloadManagerStorage & { writes: string[] } {
  const store = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    get: (key: string) => Promise.resolve(store.get(key)),
    set: (key: string, value: string) => {
      store.set(key, value);
      writes.push(value);
      return Promise.resolve();
    },
  };
}

describe("download state helpers", () => {
  it("classifies finished states", () => {
    expect(isDownloadFinished("completed")).toBe(true);
    expect(isDownloadFinished("cancelled")).toBe(true);
    expect(isDownloadFinished("interrupted")).toBe(true);
    expect(isDownloadFinished("in_progress")).toBe(false);
  });

  it("detects installable .sevyn bundles", () => {
    expect(
      isInstallableDownload(download({ state: "completed", filename: "app.sevyn" })),
    ).toBe(true);
    expect(
      isInstallableDownload(download({ state: "completed", filename: "APP.SEVYNAPP" })),
    ).toBe(true);
    expect(
      isInstallableDownload(download({ state: "in_progress", filename: "app.sevyn" })),
    ).toBe(false);
    expect(
      isInstallableDownload(download({ state: "completed", filename: "app.zip" })),
    ).toBe(false);
  });

  it("computes progress only for in-progress downloads with a known total", () => {
    expect(downloadProgressPercent(download())).toBe(50);
    expect(downloadProgressPercent(download({ totalBytes: 0 }))).toBeUndefined();
    expect(downloadProgressPercent(download({ state: "completed" }))).toBeUndefined();
  });

  it("describes states for the UI", () => {
    expect(describeDownloadState(download())).toBe("Downloading… 50%");
    expect(describeDownloadState(download({ state: "completed" }))).toBe("Completed");
    expect(describeDownloadState(download({ state: "cancelled" }))).toBe("Cancelled");
    expect(describeDownloadState(download({ state: "weird" }))).toBe("Interrupted");
  });

  it("formats byte counts", () => {
    expect(formatDownloadBytes(512)).toBe("512 B");
    expect(formatDownloadBytes(2048)).toBe("2 KB");
    expect(formatDownloadBytes(Number.NaN)).toBe("unknown size");
  });
});

describe("EngineDownloadManager", () => {
  it("lists engine downloads with live progress", () => {
    const manager = new EngineDownloadManager();
    manager.syncEngineDownloads([download()]);
    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.fromHistory).toBe(false);
    expect(list[0]?.receivedBytes).toBe(50);
  });

  it("records finished engine downloads into persisted history", async () => {
    const storage = memoryStorage();
    const manager = new EngineDownloadManager({ storage, now: () => 1234 });
    await manager.load();
    manager.syncEngineDownloads([download({ state: "completed", receivedBytes: 100 })]);
    // Engine drops finished entries from later snapshots; history keeps them.
    manager.syncEngineDownloads([]);
    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.fromHistory).toBe(true);
    expect(list[0]?.state).toBe("completed");
    // A fresh manager reloads the persisted history.
    const reloaded = new EngineDownloadManager({ storage });
    await reloaded.load();
    expect(reloaded.list().map((d) => d.guid)).toEqual(["guid-1"]);
  });

  it("engine entries win over history for the same guid", () => {
    const manager = new EngineDownloadManager();
    manager.noteCompleted(download({ state: "completed", receivedBytes: 100 }));
    manager.syncEngineDownloads([download({ state: "in_progress", receivedBytes: 60 })]);
    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.fromHistory).toBe(false);
    expect(list[0]?.receivedBytes).toBe(60);
  });

  it("dismiss hides an entry without touching others", () => {
    const manager = new EngineDownloadManager();
    manager.syncEngineDownloads([
      download({ guid: "a" }),
      download({ guid: "b", state: "completed", receivedBytes: 100 }),
    ]);
    manager.dismiss("a");
    expect(manager.list().map((d) => d.guid)).toEqual(["b"]);
  });

  it("clearFinished keeps in-progress downloads", () => {
    const manager = new EngineDownloadManager();
    manager.syncEngineDownloads([
      download({ guid: "active" }),
      download({ guid: "done", state: "completed", receivedBytes: 100 }),
      download({ guid: "dead", state: "interrupted", receivedBytes: 10 }),
    ]);
    manager.clearFinished();
    expect(manager.list().map((d) => d.guid)).toEqual(["active"]);
    expect(manager.finishedCount).toBe(0);
  });

  it("notifies subscribers on change", () => {
    const manager = new EngineDownloadManager();
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    manager.syncEngineDownloads([download()]);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    manager.syncEngineDownloads([download({ receivedBytes: 60 })]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tolerates corrupt persisted history", async () => {
    const storage = memoryStorage();
    await storage.set("sevyn.browser.download-history", "not-json{{");
    const manager = new EngineDownloadManager({ storage });
    await manager.load();
    expect(manager.list()).toEqual([]);
  });
});
