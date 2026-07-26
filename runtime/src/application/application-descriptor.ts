import type { ApplicationId, ApplicationManifest } from "./application-manifest.js";

/**
 * Runtime-facing compatibility name for an application manifest.
 *
 * ApplicationDescriptor will be removed once the runtime migration
 * to ApplicationManifest is complete.
 */
export type ApplicationDescriptor = ApplicationManifest;

export type { ApplicationId };
