import type { ApplicationManifest } from "./application-manifest.js";

export interface ApplicationPackage {
  readonly manifest: ApplicationManifest;

  /**
   * Package files indexed by their package-relative path.
   *
   * Example:
   * {
   *   "index.js": "export async function start(context) {}"
   * }
   */
  readonly files: Readonly<Record<string, string>>;
}

export function isApplicationPackage(input: unknown): input is ApplicationPackage {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Record<string, unknown>;

  if (typeof candidate["manifest"] !== "object" || candidate["manifest"] === null) {
    return false;
  }

  if (
    typeof candidate["files"] !== "object" ||
    candidate["files"] === null ||
    Array.isArray(candidate["files"])
  ) {
    return false;
  }

  return Object.values(candidate["files"]).every((file) => typeof file === "string");
}
