import type { ApplicationHostId } from "./application-host-id.js";

export const APPLICATION_MANIFEST_VERSION = 1 as const;

export type ApplicationId = string;

export interface ApplicationManifest {
  readonly manifestVersion: typeof APPLICATION_MANIFEST_VERSION;

  readonly id: ApplicationId;
  readonly name: string;
  readonly version: string;

  readonly hostId: ApplicationHostId;
  readonly entrypoint: string;
}
