import { describe, expect, it } from "vitest";

import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";
import type { ApplicationManifest } from "./application-manifest.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

function createManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "org.sevynos.hello",
    name: "Hello SevynOS",
    version: "0.1.0",
    hostId: "sevyn.host.javascript",
    entrypoint: "index.js",
    ...overrides,
  };
}

describe("validateApplicationManifest", () => {
  it("returns a validated application manifest", () => {
    const input: unknown = createManifest();

    const manifest = validateApplicationManifest(input);

    const expected: ApplicationManifest = {
      manifestVersion: 1,
      id: "org.sevynos.hello",
      name: "Hello SevynOS",
      version: "0.1.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
    };

    expect(manifest).toEqual(expected);
  });

  it("rejects a non-object manifest", () => {
    expect(() => {
      validateApplicationManifest("invalid");
    }).toThrow('Invalid application manifest field "manifest"');
  });

  it("rejects null", () => {
    expect(() => {
      validateApplicationManifest(null);
    }).toThrow('Invalid application manifest field "manifest"');
  });

  it("rejects an array", () => {
    expect(() => {
      validateApplicationManifest([]);
    }).toThrow('Invalid application manifest field "manifest"');
  });

  it("rejects an unsupported manifest version", () => {
    const manifest = createManifest({
      manifestVersion: 3,
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "manifestVersion"');
  });

  it("accepts a manifest version 2 with permissions, signature, and system", () => {
    const manifest = createManifest({
      manifestVersion: 2,
      permissions: ["filesystem.read", "notifications"],
      signature: "sevyn-release-sig-123",
      system: true,
    });

    const validated = validateApplicationManifest(manifest);
    expect(validated.manifestVersion).toBe(2);
    expect(validated.permissions).toEqual(["filesystem.read", "notifications"]);
    expect(validated.signature).toBe("sevyn-release-sig-123");
    expect(validated.system).toBe(true);
  });

  it("rejects invalid permissions (non-array or invalid entries)", () => {
    expect(() => {
      validateApplicationManifest(createManifest({ permissions: "not-an-array" }));
    }).toThrow('Invalid application manifest field "permissions"');

    expect(() => {
      validateApplicationManifest(createManifest({ permissions: [""] }));
    }).toThrow('Invalid application manifest field "permissions"');
  });

  it("rejects invalid signature or system types", () => {
    expect(() => {
      validateApplicationManifest(createManifest({ signature: 123 }));
    }).toThrow('Invalid application manifest field "signature"');

    expect(() => {
      validateApplicationManifest(createManifest({ system: "true" }));
    }).toThrow('Invalid application manifest field "system"');
  });

  it("rejects a missing manifest version", () => {
    const manifest = createManifest();

    delete manifest["manifestVersion"];

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "manifestVersion"');
  });

  it("rejects an incorrectly typed manifest version", () => {
    const manifest = createManifest({
      manifestVersion: "1",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "manifestVersion"');
  });

  it("rejects an invalid application ID", () => {
    const manifest = createManifest({
      id: "Hello App",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "id"');
  });

  it("rejects an incorrectly typed application ID", () => {
    const manifest = createManifest({
      id: 123,
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

  it("rejects an incorrectly typed application name", () => {
    const manifest = createManifest({
      name: false,
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

  it("rejects an incorrectly typed application version", () => {
    const manifest = createManifest({
      version: 1,
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "version"');
  });

  it("rejects an invalid application host ID", () => {
    const manifest = createManifest({
      hostId: "Test Host",
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "hostId"');
  });

  it("rejects an incorrectly typed application host ID", () => {
    const manifest = createManifest({
      hostId: null,
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

  it("rejects an incorrectly typed application entrypoint", () => {
    const manifest = createManifest({
      entrypoint: {},
    });

    expect(() => {
      validateApplicationManifest(manifest);
    }).toThrow('Invalid application manifest field "entrypoint"');
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
