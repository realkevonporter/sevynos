import { describe, expect, it } from "vitest";

import { ApplicationNotFoundError } from "../errors/application-not-found-error.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";
import type { ApplicationPackage } from "./application-package.js";
import { ApplicationPackageRegistry } from "./application-package-registry.js";

const helloApplicationPackage: ApplicationPackage = {
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

describe("ApplicationPackageRegistry", () => {
  it("registers an application package", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);

    expect(registry.get(helloApplicationPackage.manifest.id)).toStrictEqual(
      helloApplicationPackage,
    );
  });

  it("lists registered application packages", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);

    expect(registry.list()).toStrictEqual([helloApplicationPackage]);
  });

  it("reports whether an application package exists", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);

    expect(registry.has(helloApplicationPackage.manifest.id)).toBe(true);

    expect(registry.has("missing")).toBe(false);
  });

  it("removes an application package", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);

    expect(registry.unregister(helloApplicationPackage.manifest.id)).toBe(true);

    expect(registry.has(helloApplicationPackage.manifest.id)).toBe(false);

    expect(registry.list()).toStrictEqual([]);

    expect(() => {
      registry.get(helloApplicationPackage.manifest.id);
    }).toThrow(ApplicationNotFoundError);
  });

  it("returns false when removing an unregistered application package", () => {
    const registry = new ApplicationPackageRegistry();

    expect(registry.unregister(helloApplicationPackage.manifest.id)).toBe(false);
  });

  it("prevents duplicate application package registrations", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);

    expect(() => {
      registry.register(helloApplicationPackage);
    }).toThrow(DuplicateApplicationError);
  });

  it("rejects a package containing an invalid application manifest", () => {
    const registry = new ApplicationPackageRegistry();

    const invalidPackage = {
      manifest: {
        manifestVersion: 1,
        id: "Invalid Application",
        name: "Invalid Application",
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
    } satisfies ApplicationPackage;

    expect(() => {
      registry.register(invalidPackage);
    }).toThrow(InvalidApplicationManifestError);

    expect(registry.list()).toStrictEqual([]);
  });

  it("stores the validated manifest inside the package", () => {
    const registry = new ApplicationPackageRegistry();

    const inputPackage: ApplicationPackage = {
      manifest: {
        ...helloApplicationPackage.manifest,
      },
      files: {
        ...helloApplicationPackage.files,
      },
    };

    registry.register(inputPackage);

    const registeredPackage = registry.get(inputPackage.manifest.id);

    expect(registeredPackage).toStrictEqual(inputPackage);

    expect(registeredPackage.manifest).not.toBe(inputPackage.manifest);
  });

  it("clears all registered application packages", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloApplicationPackage);
    registry.clear();

    expect(registry.list()).toStrictEqual([]);

    expect(registry.has(helloApplicationPackage.manifest.id)).toBe(false);
  });
});
