import { describe, expect, it, vi } from "vitest";
import {
  describeSignatureStatus,
  formatBytes,
  installedAppSubtitle,
  isBundleFilename,
  loadAppCatalog,
  mergeCatalogWithInstalled,
  selectAppUpdates,
  type AppCatalogEntry,
  type InstalledAppInfo,
} from "./store-model.js";

function entry(overrides: Partial<AppCatalogEntry> = {}): AppCatalogEntry {
  return {
    id: "org.example.notes",
    name: "Notes",
    version: "1.2.0",
    summary: "Take notes.",
    bundleUrl: "https://example.com/notes.sevyn",
    sha256: "a".repeat(64),
    sizeBytes: 1024,
    permissions: [],
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledAppInfo> = {}): InstalledAppInfo {
  return {
    id: "org.example.notes",
    name: "Notes",
    version: "1.0.0",
    ...overrides,
  };
}

describe("mergeCatalogWithInstalled", () => {
  it("marks unknown apps as not-installed", () => {
    const merged = mergeCatalogWithInstalled([entry()], []);
    expect(merged[0]?.installState).toBe("not-installed");
    expect(merged[0]?.installedVersion).toBeUndefined();
  });

  it("marks same-version apps as installed", () => {
    const merged = mergeCatalogWithInstalled(
      [entry({ version: "1.0.0" })],
      [installed({ version: "1.0.0" })],
    );
    expect(merged[0]?.installState).toBe("installed");
  });

  it("marks newer catalog versions as update-available", () => {
    const merged = mergeCatalogWithInstalled(
      [entry({ version: "1.2.0" })],
      [installed({ version: "1.0.0" })],
    );
    expect(merged[0]?.installState).toBe("update-available");
    expect(merged[0]?.installedVersion).toBe("1.0.0");
  });

  it("does not offer an update when the installed copy is newer", () => {
    const merged = mergeCatalogWithInstalled(
      [entry({ version: "1.0.0" })],
      [installed({ version: "2.0.0" })],
    );
    expect(merged[0]?.installState).toBe("installed");
  });

  it("degrades to installed when versions do not parse", () => {
    const merged = mergeCatalogWithInstalled(
      [entry({ version: "1.0.0" })],
      [installed({ version: "not-a-version" })],
    );
    expect(merged[0]?.installState).toBe("installed");
  });
});

describe("selectAppUpdates", () => {
  it("returns only update-available entries", () => {
    const merged = mergeCatalogWithInstalled(
      [entry({ id: "a", version: "2.0.0" }), entry({ id: "b", version: "1.0.0" })],
      [
        installed({ id: "a", version: "1.0.0" }),
        installed({ id: "b", version: "1.0.0" }),
      ],
    );
    const updates = selectAppUpdates(merged);
    expect(updates.map((u) => u.entry.id)).toEqual(["a"]);
  });
});

describe("loadAppCatalog", () => {
  const feedText = JSON.stringify({
    format: "sevynos-app-catalog/1",
    generatedAt: "2026-10-07T12:00:00.000Z",
    apps: [entry()],
  });

  it("loads and parses a reachable feed", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(feedText, { status: 200 })),
    ) as unknown as typeof fetch;
    const result = await loadAppCatalog("https://example.com/catalog.json", fetchImpl);
    expect(result?.feed.apps).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns undefined when the feed is unreachable (honest empty state)", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error("network down")),
    ) as unknown as typeof fetch;
    await expect(
      loadAppCatalog("https://example.com/catalog.json", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on HTTP errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("nope", { status: 404 })),
    ) as unknown as typeof fetch;
    await expect(
      loadAppCatalog("https://example.com/catalog.json", fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("throws on malformed feeds so the UI can say so", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("garbage", { status: 200 })),
    ) as unknown as typeof fetch;
    await expect(
      loadAppCatalog("https://example.com/catalog.json", fetchImpl),
    ).rejects.toThrow(/Invalid app catalog feed/);
  });
});

describe("formatBytes", () => {
  it("formats byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(Number.NaN)).toBe("unknown size");
  });
});

describe("isBundleFilename", () => {
  it("matches .sevyn and .sevynapp (case-insensitive)", () => {
    expect(isBundleFilename("notes.sevyn")).toBe(true);
    expect(isBundleFilename("notes.SEVYNAPP")).toBe(true);
    expect(isBundleFilename("notes.zip")).toBe(false);
    expect(isBundleFilename("sevyn")).toBe(false);
  });
});

describe("describeSignatureStatus", () => {
  it("labels the unsigned case honestly", () => {
    expect(describeSignatureStatus("unsigned")).toBe("Unsigned bundle");
    expect(describeSignatureStatus("official")).toContain("Official");
    expect(describeSignatureStatus("self-signed")).toContain("Self-signed");
  });
});

describe("installedAppSubtitle", () => {
  it("combines version, system flag and signature status", () => {
    expect(installedAppSubtitle(installed({ version: "1.0.0", system: true }))).toBe(
      "v1.0.0 · system",
    );
    expect(
      installedAppSubtitle(installed({ version: "1.0.0", signatureStatus: "unsigned" })),
    ).toBe("v1.0.0 · Unsigned bundle");
  });
});
