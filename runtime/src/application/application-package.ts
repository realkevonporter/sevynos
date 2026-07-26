import type { ApplicationManifest } from "./application-manifest.js";

export interface ApplicationPackage {
  readonly manifest: ApplicationManifest;
}

export function isApplicationPackage(input: unknown): input is ApplicationPackage {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "manifest" in input
  );
}
