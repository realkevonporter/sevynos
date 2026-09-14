import type { ApplicationHostId } from "./application-host-id.js";

export const APPLICATION_MANIFEST_VERSION = 2 as const;
export type SupportedManifestVersion = 1 | 2;

export type ApplicationId = string;

export interface ApplicationManifest {
  readonly manifestVersion: SupportedManifestVersion;

  readonly id: ApplicationId;
  readonly name: string;
  readonly version: string;

  readonly hostId: ApplicationHostId;
  readonly entrypoint: string;

  readonly permissions?: readonly string[] | undefined;
  readonly signature?: string | undefined;
  readonly system?: boolean | undefined;
}
