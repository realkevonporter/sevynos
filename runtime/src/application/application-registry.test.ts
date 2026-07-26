import { describe, expect, it } from "vitest";

import type { ApplicationDescriptor } from "./application-descriptor.js";
import { ApplicationRegistry } from "./application-registry.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";

const hello: ApplicationDescriptor = {
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
});
