import { describe, expect, it } from "vitest";

import { ApplicationNotFoundError } from "../errors/application-not-found-error.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";
import type { ApplicationPackage } from "./application-package.js";
import { ApplicationPackageRegistry } from "./application-package-registry.js";

const helloPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "dev.sevyn.hello",
    name: "Hello",
    version: "1.0.0",
    hostId: "sevyn.host.react-native",
    entrypoint: "index.js",
  },
};

describe("ApplicationPackageRegistry", () => {
  it("registers an application package", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);

    expect(registry.get(helloPackage.manifest.id)).toStrictEqual(helloPackage);
  });

  it("lists registered application packages", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);

    expect(registry.list()).toStrictEqual([helloPackage]);
  });

  it("reports whether an application package exists", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);

    expect(registry.has(helloPackage.manifest.id)).toBe(true);

    expect(registry.has("missing")).toBe(false);
  });

  it("removes an application package", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);

    expect(registry.unregister(helloPackage.manifest.id)).toBe(true);

    expect(registry.has(helloPackage.manifest.id)).toBe(false);

    expect(registry.list()).toStrictEqual([]);

    expect(() => {
      registry.get(helloPackage.manifest.id);
    }).toThrow(ApplicationNotFoundError);
  });

  it("returns false when removing an unregistered application package", () => {
    const registry = new ApplicationPackageRegistry();

    expect(registry.unregister(helloPackage.manifest.id)).toBe(false);
  });

  it("prevents duplicate application package registrations", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);

    expect(() => {
      registry.register(helloPackage);
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
        hostId: "sevyn.host.test",
        entrypoint: "index.js",
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
        ...helloPackage.manifest,
      },
    };

    registry.register(inputPackage);

    const registeredPackage = registry.get(inputPackage.manifest.id);

    expect(registeredPackage).toStrictEqual(inputPackage);

    expect(registeredPackage.manifest).not.toBe(inputPackage.manifest);
  });

  it("clears all registered application packages", () => {
    const registry = new ApplicationPackageRegistry();

    registry.register(helloPackage);
    registry.clear();

    expect(registry.list()).toStrictEqual([]);

    expect(registry.has(helloPackage.manifest.id)).toBe(false);
  });
});
