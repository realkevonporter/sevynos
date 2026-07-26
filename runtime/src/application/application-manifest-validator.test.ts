import { describe, expect, it } from "vitest";

import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";
import type { ApplicationManifest } from "./application-manifest.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

function createManifest(
  overrides: Partial<ApplicationManifest> = {},
): ApplicationManifest {
  return {
    manifestVersion: 1,
    id: "dev.sevyn.hello",
    name: "Hello SevynOS",
    version: "0.1.0",
    hostId: "sevyn.host.test",
    entrypoint: "index.js",
    ...overrides,
  };
}

describe("validateApplicationManifest", () => {
  it("accepts a valid application manifest", () => {
    const manifest = createManifest();

    expect(() => {
      validateApplicationManifest(manifest);
    }).not.toThrow();
  });

  it("rejects an unsupported manifest version", () => {
    const manifest = createManifest({
      manifestVersion: 2 as 1,
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow(InvalidApplicationManifestError);
  });

  it("rejects an invalid application ID", () => {
    const manifest = createManifest({
      id: "Hello App",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "id"');
  });

  it("rejects an empty application name", () => {
    const manifest = createManifest({
      name: "   ",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "name"');
  });

  it("rejects an invalid application version", () => {
    const manifest = createManifest({
      version: "version-one",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "version"');
  });

  it("accepts a semantic version with prerelease metadata", () => {
    const manifest = createManifest({
      version: "1.0.0-beta.1",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).not.toThrow();
  });

  it("rejects an invalid application host ID", () => {
    const manifest = createManifest({
      hostId: "Test Host",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "hostId"');
  });

  it("rejects an empty application entrypoint", () => {
    const manifest = createManifest({
      entrypoint: " ",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "entrypoint"');
  });

  it("rejects an absolute application entrypoint", () => {
    const manifest = createManifest({
      entrypoint: "/index.js",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow("application entrypoint must be relative.");
  });

  it("rejects an entrypoint that escapes its application directory", () => {
    const manifest = createManifest({
      entrypoint: "../index.js",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('application entrypoint cannot contain ".." path segments.');
  });

  it("identifies the invalid field on the error", () => {
    const manifest = createManifest({
      version: "invalid",
    });

    try {
      validateApplicationManifest(manifest);

      expect.fail("Expected manifest validation to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidApplicationManifestError);

      if (!(error instanceof InvalidApplicationManifestError)) {
        return;
      }

      expect(error.code).toBe("INVALID_APPLICATION_MANIFEST");
      expect(error.field).toBe("version");
    }
  });
});
