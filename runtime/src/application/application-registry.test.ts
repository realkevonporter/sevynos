import { describe, expect, it } from "vitest";

import type { ApplicationDescriptor } from "./application-descriptor.js";
import { ApplicationRegistry } from "./application-registry.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import { InvalidApplicationManifestError } from "../errors/invalid-application-manifest-error.js";

const hello: ApplicationDescriptor = {
  manifestVersion: 1,
  id: "dev.sevyn.hello",
  name: "Hello",
  version: "1.0.0",
  hostId: "sevyn.host.react-native",
  entrypoint: "index.js",
};

describe("ApplicationRegistry", () => {
  it("registers an application", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(registry.get(hello.id)).toEqual(hello);
  });

  it("lists registered applications", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(registry.list()).toEqual([hello]);
  });

  it("reports whether an application exists", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(registry.has(hello.id)).toBe(true);
    expect(registry.has("missing")).toBe(false);
  });

  it("removes an application", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(registry.unregister(hello.id)).toBe(true);
    expect(registry.get(hello.id)).toBeUndefined();
  });

  it("prevents duplicate registrations", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(() => registry.register(hello)).toThrow();
  });

  it("prevents duplicate registrations", () => {
    const registry = new ApplicationRegistry();

    registry.register(hello);

    expect(() => registry.register(hello)).toThrow(DuplicateApplicationError);
  });

  it("rejects an invalid application manifest", () => {
    const registry = new ApplicationRegistry();

    const invalidApplication: ApplicationDescriptor = {
      manifestVersion: 1,
      id: "Invalid Application",
      name: "Invalid Application",
      version: "0.1.0",
      hostId: "sevyn.host.test",
      entrypoint: "index.js",
    };

    expect(() => {
      registry.register(invalidApplication);
    }).toThrow(InvalidApplicationManifestError);

    expect(registry.list()).toEqual([]);
  });
});
