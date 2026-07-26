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

export function validateApplicationManifest(input: unknown): ApplicationManifest {
  if (!isRecord(input)) {
    throw new InvalidApplicationManifestError(
      "manifest",
      "application manifest must be an object.",
    );
  }

  const { manifestVersion, id, name, version, hostId, entrypoint } = input;

  validateManifestVersion(manifestVersion);
  validateApplicationId(id);
  validateApplicationName(name);
  validateApplicationVersion(version);
  validateHostId(hostId);
  validateEntrypoint(entrypoint);

  return {
    manifestVersion,
    id,
    name,
    version,
    hostId,
    entrypoint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateManifestVersion(
  value: unknown,
): asserts value is typeof APPLICATION_MANIFEST_VERSION {
  if (typeof value !== "number" || value !== APPLICATION_MANIFEST_VERSION) {
    throw new InvalidApplicationManifestError(
      "manifestVersion",
      `unsupported manifest version ${String(value)}.`,
    );
  }
}

function validateApplicationId(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new InvalidApplicationManifestError("id", "application ID must be a string.");
  }

  const id = value.trim();

  if (id.length === 0) {
    throw new InvalidApplicationManifestError("id", "application ID cannot be empty.");
  }

  if (!APPLICATION_ID_PATTERN.test(id)) {
    throw new InvalidApplicationManifestError(
      "id",
      `"${value}" must use lowercase reverse-domain notation.`,
    );
  }
}

function validateApplicationName(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new InvalidApplicationManifestError(
      "name",
      "application name must be a string.",
    );
  }

  if (value.trim().length === 0) {
    throw new InvalidApplicationManifestError(
      "name",
      "application name cannot be empty.",
    );
  }
}

function validateApplicationVersion(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new InvalidApplicationManifestError(
      "version",
      "application version must be a string.",
    );
  }

  if (!SEMANTIC_VERSION_PATTERN.test(value)) {
    throw new InvalidApplicationManifestError(
      "version",
      `"${value}" must be a valid semantic version.`,
    );
  }
}

function validateHostId(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new InvalidApplicationManifestError(
      "hostId",
      "application host ID must be a string.",
    );
  }

  const hostId = value.trim();

  if (hostId.length === 0) {
    throw new InvalidApplicationManifestError(
      "hostId",
      "application host ID cannot be empty.",
    );
  }

  if (!HOST_ID_PATTERN.test(hostId)) {
    throw new InvalidApplicationManifestError(
      "hostId",
      `"${value}" must use lowercase dot-separated notation.`,
    );
  }
}

function validateEntrypoint(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new InvalidApplicationManifestError(
      "entrypoint",
      "application entrypoint must be a string.",
    );
  }

  const entrypoint = value.trim();

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
