/**
 * App catalog feed. The catalog is a small JSON manifest published next to
 * the release artifacts (same pattern as updates.json) that lists the
 * `.sevyn` application bundles the Software app can offer for install:
 *
 * {
 *   "format": "sevynos-app-catalog/1",
 *   "generatedAt": "2026-10-07T12:00:00.000Z",
 *   "apps": [
 *     {
 *       "id": "org.example.notes",
 *       "name": "Notes",
 *       "version": "1.2.0",
 *       "summary": "Take notes, organised in folders.",
 *       "developer": "Example",
 *       "iconUrl": "https://…/notes.svg",
 *       "bundleUrl": "https://…/notes-1.2.0.sevyn",
 *       "sha256": "…64 hex chars…",
 *       "sizeBytes": 123456,
 *       "permissions": ["filesystem:user"]
 *     }
 *   ],
 *   "signature": { "algorithm": "…", "value": "…" }   // RESERVED, Phase 3
 * }
 *
 * Signature verification is explicitly Phase 3. The feed MAY already carry a
 * top-level `signature` object; this parser records it but never verifies it,
 * and installers must not treat its presence as a trust signal until Phase 3
 * defines the algorithm and the trust anchors. Unknown fields are ignored so
 * the Phase 3 signature format can slot in without breaking older parsers.
 *
 * The sha256 on each entry is an integrity check against a truncated or
 * corrupted bundle download, not a trust anchor.
 */

export const APP_CATALOG_FEED_FORMAT = "sevynos-app-catalog/1";

export interface AppCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly developer?: string | undefined;
  readonly iconUrl?: string | undefined;
  /** https URL of the `.sevyn` bundle to download and install. */
  readonly bundleUrl: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly permissions: readonly string[];
}

/**
 * Phase 3 reservation. Parsed and carried through, never verified here.
 * Installers must not treat a present-but-unverified signature as trusted.
 */
export interface AppCatalogSignature {
  readonly algorithm: string;
  readonly value: string;
}

export interface AppCatalogFeed {
  readonly format: typeof APP_CATALOG_FEED_FORMAT;
  readonly generatedAt: string;
  readonly apps: readonly AppCatalogEntry[];
  readonly signature?: AppCatalogSignature | undefined;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function fail(reason: string): never {
  throw new Error(`Invalid app catalog feed: ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0)
    fail(`"${field}" must be a non-empty string`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    fail(`"${field}" must be a non-empty string when present`);
  return value;
}

function parseEntry(value: unknown, index: number): AppCatalogEntry {
  if (!isRecord(value)) fail(`apps[${String(index)}] must be an object`);
  const where = `apps[${String(index)}]`;
  const id = requireString(value, "id");
  const name = requireString(value, "name");
  const version = requireString(value, "version");
  const summary = requireString(value, "summary");
  const developer = optionalString(value, "developer");
  const iconUrl = optionalString(value, "iconUrl");
  if (iconUrl !== undefined && !iconUrl.startsWith("https://"))
    fail(`${where}.iconUrl must be https`);
  const bundleUrl = requireString(value, "bundleUrl");
  if (!bundleUrl.startsWith("https://")) fail(`${where}.bundleUrl must be https`);
  const sha256 = requireString(value, "sha256");
  if (!SHA256_PATTERN.test(sha256)) fail(`${where}.sha256 must be 64 hex chars`);
  const sizeBytes = value["sizeBytes"];
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0)
    fail(`${where}.sizeBytes must be a positive integer`);
  const permissions = value["permissions"];
  if (!Array.isArray(permissions)) fail(`${where}.permissions must be an array`);
  const permissionList: string[] = [];
  for (const permission of permissions) {
    if (typeof permission !== "string" || permission.length === 0)
      fail(`${where}.permissions must be an array of non-empty strings`);
    permissionList.push(permission);
  }
  return {
    id,
    name,
    version,
    summary,
    ...(developer === undefined ? {} : { developer }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
    bundleUrl,
    sha256: sha256.toLowerCase(),
    sizeBytes,
    permissions: Object.freeze(permissionList),
  };
}

function parseSignature(value: unknown): AppCatalogSignature | undefined {
  if (value === undefined) return undefined;
  // Reserved for Phase 3: accept the field, carry it through, never verify.
  if (!isRecord(value)) fail('"signature" must be an object when present');
  return {
    algorithm: requireString(value, "algorithm"),
    value: requireString(value, "value"),
  };
}

/** Parses and validates an app catalog feed. Throws a descriptive error. */
export function parseAppCatalogFeed(text: string): AppCatalogFeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("not valid JSON");
  }
  if (!isRecord(parsed)) fail("top level must be an object");
  const format = requireString(parsed, "format");
  if (format !== APP_CATALOG_FEED_FORMAT)
    fail(`"format" must be "${APP_CATALOG_FEED_FORMAT}"`);
  const generatedAt = requireString(parsed, "generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) fail('"generatedAt" must be a date');
  const apps = parsed["apps"];
  if (!Array.isArray(apps)) fail('"apps" must be an array');
  const seen = new Set<string>();
  const entries = apps.map((entry, index) => {
    const parsedEntry = parseEntry(entry, index);
    if (seen.has(parsedEntry.id)) fail(`duplicate app id "${parsedEntry.id}"`);
    seen.add(parsedEntry.id);
    return parsedEntry;
  });
  return {
    format: APP_CATALOG_FEED_FORMAT,
    generatedAt,
    apps: Object.freeze(entries),
    signature: parseSignature(parsed["signature"]),
  };
}

/**
 * Default catalog feed location: published next to updates.json on the
 * nightly release. Until a catalog is published there, the Software app
 * shows an honest empty-catalog state instead of stub listings.
 */
export function defaultAppCatalogFeedUrl(): string {
  return "https://github.com/realkevonporter/sevynos/releases/download/nightly/app-catalog.json";
}
