import { describe, expect, it } from "vitest";

import type { ApplicationPackage } from "./application-package.js";

describe("ApplicationPackage", () => {
  it("contains an application manifest", () => {
    const applicationPackage: ApplicationPackage = {
      manifest: {
        manifestVersion: 1,
        id: "org.sevynos.hello",
        name: "Hello SevynOS",
        version: "0.1.0",
        hostId: "sevyn.host.javascript",
        entrypoint: "index.js",
      },
      files: {
        "index.js": `
      export async function start(context) {
        context.log("Hello from SevynOS!");

        return {
          title: "Hello SevynOS"
        };
      }

      export async function stop(context) {
        context.log("Goodbye from SevynOS!");
      }
    `,
      },
    };

    expect(applicationPackage.manifest.id).toBe("org.sevynos.hello");
  });
});
