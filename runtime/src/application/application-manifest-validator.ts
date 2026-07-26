// runtime/src/application/application-manifest-validator.ts

import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";
import {
  APPLICATION_MANIFEST_VERSION,
  type ApplicationManifest,
} from "./application-manifest.js";

const APPLICATION_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

const HOST_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateApplicationManifest(manifest: ApplicationManifest): void {
  validateManifestVersion(manifest.manifestVersion);
  validateApplicationId(manifest);
  validateApplicationName(manifest);
  validateApplicationVersion(manifest);
  validateHostId(manifest);
  validateEntrypoint(manifest);
}

function validateManifestVersion(manifestVersion: number): void {
  if (manifestVersion !== APPLICATION_MANIFEST_VERSION) {
    throw new InvalidApplicationManifestError(
      "manifestVersion",
      `unsupported manifest version ${String(manifestVersion)}.`,
    );
  }
}

function validateApplicationId(manifest: ApplicationManifest): void {
  const id = manifest.id.trim();

  if (id.length === 0) {
    throw new InvalidApplicationManifestError("id", "application ID cannot be empty.");
  }

  if (!APPLICATION_ID_PATTERN.test(id)) {
    throw new InvalidApplicationManifestError(
      "id",
      `"${manifest.id}" must use lowercase reverse-domain notation.`,
    );
  }
}

function validateApplicationName(manifest: ApplicationManifest): void {
  if (manifest.name.trim().length === 0) {
    throw new InvalidApplicationManifestError(
      "name",
      "application name cannot be empty.",
    );
  }
}

function validateApplicationVersion(manifest: ApplicationManifest): void {
  if (!SEMANTIC_VERSION_PATTERN.test(manifest.version)) {
    throw new InvalidApplicationManifestError(
      "version",
      `"${manifest.version}" must be a valid semantic version.`,
    );
  }
}

function validateHostId(manifest: ApplicationManifest): void {
  const hostId = manifest.hostId.trim();

  if (hostId.length === 0) {
    throw new InvalidApplicationManifestError(
      "hostId",
      "application host ID cannot be empty.",
    );
  }

  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new InvalidApplicationManifestError(
      "hostId",
      `"${manifest.hostId}" must use lowercase dot-separated notation.`,
    );
  }
}

function validateEntrypoint(manifest: ApplicationManifest): void {
  const entrypoint = manifest.entrypoint.trim();

  if (entrypoint.length === 0) {
    throw new InvalidApplicationManifestError(
      "entrypoint",
      "application entrypoint cannot be empty.",
    );
  }

  if (entrypoint.startsWith("/")) {
    throw new InvalidApplicationManifestError(
      "entrypoint",
      "application entrypoint must be relative.",
    );
  }

  const segments = entrypoint.split("/");

  if (segments.includes("..")) {
    throw new InvalidApplicationManifestError(
      "entrypoint",
      'application entrypoint cannot contain ".." path segments.',
    );
  }
}
