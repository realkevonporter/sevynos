/**
 * Release version resolution for SevynOS image builds.
 *
 * Stable releases come from git tags `vX.Y.Z` (see
 * .github/workflows/stable-release.yml). Everything else is a nightly
 * build. The resolved version is stamped into the image at
 * /etc/sevynos-release and published in updates.json (see build.mjs).
 */

const RELEASE_TAG_PATTERN = /^v?(\d+\.\d+\.\d+)$/;

/**
 * Parses a release tag candidate. Accepts `v1.2.3` (and, leniently,
 * `1.2.3`); returns the bare `X.Y.Z` version or undefined.
 */
function parseReleaseTag(raw) {
  if (typeof raw !== "string") return undefined;
  const match = RELEASE_TAG_PATTERN.exec(raw.trim());
  return match?.[1];
}

/**
 * Resolves the OS version and update channel for an image build.
 *
 * Precedence: the SEVYN_RELEASE_TAG environment variable wins; otherwise
 * GITHUB_REF_NAME is used when it looks like a release tag (`v*`); when
 * neither parses, the build is a nightly.
 *
 * @param {Record<string, string | undefined>} env environment (process.env)
 * @param {{ packageVersion: string, buildDate?: string, shortSha?: string }} options
 * @returns {{ version: string, channel: "stable" | "nightly", releaseTag: string | undefined }}
 */
export function resolveReleaseInfo(env, options) {
  const releaseVersion =
    parseReleaseTag(env["SEVYN_RELEASE_TAG"]) ?? parseReleaseTag(env["GITHUB_REF_NAME"]);
  if (releaseVersion !== undefined) {
    return {
      version: releaseVersion,
      channel: "stable",
      releaseTag: `v${releaseVersion}`,
    };
  }
  const buildDate =
    options.buildDate ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const shortSha = options.shortSha ?? "local";
  return {
    version: `${options.packageVersion}-nightly.${buildDate}.${shortSha}`,
    channel: "nightly",
    releaseTag: undefined,
  };
}
