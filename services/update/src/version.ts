/**
 * SevynOS version parsing and comparison.
 *
 * Versions are `MAJOR.MINOR.PATCH` with an optional `-nightly.YYYYMMDD[.sha]`
 * suffix for automated builds. The nightly suffix sorts NEWER than the bare
 * release with the same base version — a deliberate deviation from semver,
 * because the nightly channel is always ahead of the release it was cut
 * from. Stable releases sort purely by their numeric base.
 */
export interface ParsedOsVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Present for nightly builds, e.g. "20261007" or "20261007.abc1234". */
  readonly nightly?: string | undefined;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.([0-9]+(?:\.[0-9a-z]+)?))?$/;

export function parseOsVersion(version: string): ParsedOsVersion {
  const match = VERSION_PATTERN.exec(version.trim());
  if (match === null) throw new Error(`Invalid SevynOS version: "${version}".`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const nightly = match[4];
  if (nightly === undefined) return { major, minor, patch };
  return { major, minor, patch, nightly };
}

/**
 * Compares two SevynOS versions. Returns -1 when a < b, 0 when equal,
 * 1 when a > b.
 */
export function compareOsVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseOsVersion(a);
  const right = parseOsVersion(b);
  for (const [l, r] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    if (l < r) return -1;
    if (l > r) return 1;
  }
  if (left.nightly === right.nightly) return 0;
  // A nightly build is newer than the bare release with the same base.
  if (left.nightly === undefined) return -1;
  if (right.nightly === undefined) return 1;
  if (left.nightly < right.nightly) return -1;
  if (left.nightly > right.nightly) return 1;
  return 0;
}

/** True when `latest` is a newer version than `current`. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareOsVersions(current, latest) < 0;
}
