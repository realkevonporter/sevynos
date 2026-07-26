import { describe, expect, it } from "vitest";

import type { ApplicationDescriptor } from "./application-descriptor.js";

describe("ApplicationDescriptor", () => {
  it("describes an application without framework-specific Runtime fields", () => {
    const application: ApplicationDescriptor = {
      manifestVersion: 1,
      id: "dev.sevyn.hello",
      name: "Hello SevynOS",
      version: "0.1.0",
      hostId: "sevyn.host.react-native",
      entrypoint: "index.js",
    };

    expect(application).toEqual({
      manifestVersion: 1,
      id: "dev.sevyn.hello",
      name: "Hello SevynOS",
      version: "0.1.0",
      hostId: "sevyn.host.react-native",
      entrypoint: "index.js",
    });
  });
});
