// runtime/src/application/application-manifest.test.ts

import { describe, expect, it } from "vitest";

import {
  APPLICATION_MANIFEST_VERSION,
  type ApplicationManifest,
} from "./application-manifest.js";

describe("ApplicationManifest", () => {
  it("describes an application recognized by the runtime", () => {
    const manifest: ApplicationManifest = {
      manifestVersion: APPLICATION_MANIFEST_VERSION,

      id: "org.sevynos.hello",
      name: "Hello SevynOS",
      version: "0.1.0",

      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["filesystem.read", "notifications"],
      signature: "sig-valid-test",
      system: false,
    };

    expect(manifest).toEqual({
      manifestVersion: 2,

      id: "org.sevynos.hello",
      name: "Hello SevynOS",
      version: "0.1.0",

      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["filesystem.read", "notifications"],
      signature: "sig-valid-test",
      system: false,
    });
  });

  it("distinguishes the manifest format version from the application version", () => {
    const manifest: ApplicationManifest = {
      manifestVersion: APPLICATION_MANIFEST_VERSION,

      id: "org.sevynos.hello",
      name: "Hello SevynOS",
      version: "4.7.2",

      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
    };

    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.version).toBe("4.7.2");
  });
});
