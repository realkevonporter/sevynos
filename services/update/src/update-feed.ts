/**
 * Versioned OS release feed. The feed is a small JSON manifest published
 * next to the release artifacts (see tools/qemu/build.mjs, which writes
 * updates.json for the nightly release):
 *
 * {
 *   "version": "0.1.0-nightly.20261007.abc1234",
 *   "publishedAt": "2026-10-07T10:00:00.000Z",
 *   "releaseNotes": "…",
 *   "artifacts": [
 *     { "kind": "rootfs-squashfs",
 *       "url": "https://…/rootfs.squashfs",
 *       "sha256": "…64 hex chars…",
 *       "sizeBytes": 123456789 }
 *   ]
 * }
 *
 * Signature verification is explicitly Phase 3; the sha256 here is an
 * integrity check against a truncated or corrupted download, not a trust
 * anchor.
 */

export type UpdateArtifactKind = "rootfs-squashfs" | "iso";

export interface UpdateArtifact {
  readonly kind: UpdateArtifactKind;
  readonly url: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface UpdateFeedManifest {
  readonly version: string;
  readonly publishedAt: string;
  readonly releaseNotes: string;
  readonly artifacts: readonly UpdateArtifact[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function fail(reason: string): never {
  throw new Error(`Invalid update feed: ${reason}.`);
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

function parseArtifact(value: unknown, index: number): UpdateArtifact {
  if (!isRecord(value)) fail(`artifacts[${String(index)}] must be an object`);
  const kind = value["kind"];
  if (kind !== "rootfs-squashfs" && kind !== "iso")
    fail(`artifacts[${String(index)}].kind must be "rootfs-squashfs" or "iso"`);
  const url = requireString(value, "url");
  if (!url.startsWith("https://")) fail(`artifacts[${String(index)}].url must be https`);
  const sha256 = requireString(value, "sha256");
  if (!SHA256_PATTERN.test(sha256))
    fail(`artifacts[${String(index)}].sha256 must be 64 hex chars`);
  const sizeBytes = value["sizeBytes"];
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0)
    fail(`artifacts[${String(index)}].sizeBytes must be a positive integer`);
  return { kind, url, sha256: sha256.toLowerCase(), sizeBytes };
}

/** Parses and validates a feed manifest. Throws a descriptive error. */
export function parseUpdateFeed(text: string): UpdateFeedManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("not valid JSON");
  }
  if (!isRecord(parsed)) fail("top level must be an object");
  const version = requireString(parsed, "version");
  const publishedAt = requireString(parsed, "publishedAt");
  if (Number.isNaN(Date.parse(publishedAt))) fail('"publishedAt" must be a date');
  const releaseNotes = requireString(parsed, "releaseNotes");
  const artifacts = parsed["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    fail('"artifacts" must be a non-empty array');
  return {
    version,
    publishedAt,
    releaseNotes,
    artifacts: Object.freeze(
      artifacts.map((entry, index) => parseArtifact(entry, index)),
    ),
  };
}

/** Picks the rootfs payload the installed-system updater applies. */
export function selectRootfsArtifact(
  manifest: UpdateFeedManifest,
): UpdateArtifact | undefined {
  return manifest.artifacts.find((artifact) => artifact.kind === "rootfs-squashfs");
}
