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

      id: "dev.sevyn.hello",
      name: "Hello SevynOS",
      version: "0.1.0",

      hostId: "sevyn.host.test",
      entrypoint: "index.js",
    };

    expect(manifest).toEqual({
      manifestVersion: 1,

      id: "dev.sevyn.hello",
      name: "Hello SevynOS",
      version: "0.1.0",

      hostId: "sevyn.host.test",
      entrypoint: "index.js",
    });
  });

  it("distinguishes the manifest format version from the application version", () => {
    const manifest: ApplicationManifest = {
      manifestVersion: APPLICATION_MANIFEST_VERSION,

      id: "dev.sevyn.hello",
      name: "Hello SevynOS",
      version: "4.7.2",

      hostId: "sevyn.host.test",
      entrypoint: "index.js",
    };

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.version).toBe("4.7.2");
  });
});
