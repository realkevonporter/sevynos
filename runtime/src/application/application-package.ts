import type { ApplicationManifest } from "./application-manifest.js";

export interface ApplicationPackage {
  readonly manifest: ApplicationManifest;
}
