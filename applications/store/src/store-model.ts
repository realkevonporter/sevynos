import {
  compareOsVersions,
  defaultAppCatalogFeedUrl,
  parseAppCatalogFeed,
  type AppCatalogEntry,
  type AppCatalogFeed,
} from "@sevynos/os-update";

export type { AppCatalogEntry, AppCatalogFeed };

export interface InstalledAppInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly system?: boolean | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly signatureStatus?: "official" | "self-signed" | "unsigned" | undefined;
}

/**
 * A `.sevyn` bundle as previewed before a sideload install. The host
 * produces this by extracting the bundle's manifest.json; the store never
 * unzips bundles itself (it runs in the app sandbox without zlib).
 */
export interface BundlePreview {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly signatureStatus: "official" | "self-signed" | "unsigned";
  readonly developer?: string | undefined;
  readonly description?: string | undefined;
}

export type CatalogInstallState = "not-installed" | "installed" | "update-available";

export interface CatalogAppView {
  readonly entry: AppCatalogEntry;
  readonly installState: CatalogInstallState;
  readonly installedVersion?: string | undefined;
}

export interface CatalogLoadResult {
  readonly feed: AppCatalogFeed;
  readonly loadedAt: number;
}

/**
 * Fetches and parses the app catalog feed. A missing/unreachable feed is not
 * an error the caller must hide: it resolves to `undefined` so the UI can
 * render the honest empty-catalog state. Malformed feeds throw.
 */
export async function loadAppCatalog(
  feedUrl: string = defaultAppCatalogFeedUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogLoadResult | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(feedUrl, { headers: { accept: "application/json" } });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const feed = parseAppCatalogFeed(await response.text());
  return { feed, loadedAt: Date.now() };
}

/**
 * Annotates every catalog entry with its install state relative to the
 * installed registry. Version comparison failures (unparseable versions)
 * degrade to "installed" rather than offering a bogus update.
 */
export function mergeCatalogWithInstalled(
  apps: readonly AppCatalogEntry[],
  installed: readonly InstalledAppInfo[],
): readonly CatalogAppView[] {
  const byId = new Map(installed.map((app) => [app.id, app]));
  return apps.map((entry) => {
    const existing = byId.get(entry.id);
    if (existing === undefined) return { entry, installState: "not-installed" };
    let installState: CatalogInstallState = "installed";
    try {
      if (compareOsVersions(existing.version, entry.version) < 0)
        installState = "update-available";
    } catch {
      installState = "installed";
    }
    return { entry, installState, installedVersion: existing.version };
  });
}

/** Catalog entries that are newer than the installed copy. */
export function selectAppUpdates(
  merged: readonly CatalogAppView[],
): readonly CatalogAppView[] {
  return merged.filter((view) => view.installState === "update-available");
}

export function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "unknown size";
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = sizeBytes / 1024;
  let unit = units[0] ?? "KB";
  for (const candidate of units) {
    unit = candidate;
    if (value < 1024 || candidate === "GB") break;
    value /= 1024;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${unit}`;
}

export function isBundleFilename(filename: string): boolean {
  return /\.(sevyn|sevynapp)$/i.test(filename.trim());
}

export function describeSignatureStatus(
  status: "official" | "self-signed" | "unsigned",
): string {
  switch (status) {
    case "official":
      return "Official SevynOS signature";
    case "self-signed":
      return "Self-signed by its developer";
    case "unsigned":
      return "Unsigned bundle";
  }
}

/** Short human label for an installed app row. */
export function installedAppSubtitle(app: InstalledAppInfo): string {
  const parts = [`v${app.version}`];
  if (app.system === true) parts.push("system");
  else if (app.signatureStatus !== undefined)
    parts.push(describeSignatureStatus(app.signatureStatus));
  return parts.join(" · ");
}
