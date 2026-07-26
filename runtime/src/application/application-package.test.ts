import { describe, expect, it } from "vitest";

import type { ApplicationPackage } from "./application-package.js";

describe("ApplicationPackage", () => {
  it("contains an application manifest", () => {
    const applicationPackage: ApplicationPackage = {
      manifest: {
        manifestVersion: 1,
        id: "dev.sevyn.hello",
        name: "Hello SevynOS",
        version: "0.1.0",
        hostId: "sevyn.host.test",
        entrypoint: "index.js",
      },
    };

    expect(applicationPackage.manifest.id).toBe("dev.sevyn.hello");
  });
});
