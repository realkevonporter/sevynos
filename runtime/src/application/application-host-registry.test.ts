import { describe, expect, it } from "vitest";

import type { ApplicationHost, ApplicationHostStartResult } from "./application-host.js";
import { ApplicationHostRegistry } from "./application-host-registry.js";
import type { ApplicationSession } from "./application-session.js";

class TestApplicationHost implements ApplicationHost {
  public constructor(public readonly id: string) {}

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    await Promise.resolve();

    return {
      instanceId: `${this.id}:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    void session;

    await Promise.resolve();
  }
}

describe("ApplicationHostRegistry", () => {
  it("registers and retrieves a host", () => {
    const registry = new ApplicationHostRegistry();
    const host = new TestApplicationHost("sevyn.host.test");

    registry.register(host);

    expect(registry.get(host.id)).toBe(host);
  });

  it("rejects duplicate host registrations", () => {
    const registry = new ApplicationHostRegistry();
    const firstHost = new TestApplicationHost("sevyn.host.test");

    const secondHost = new TestApplicationHost("sevyn.host.test");

    registry.register(firstHost);

    expect(() => {
      registry.register(secondHost);
    }).toThrow('Application host "sevyn.host.test" is already registered.');
  });

  it("lists registered hosts", () => {
    const registry = new ApplicationHostRegistry();

    const firstHost = new TestApplicationHost("sevyn.host.first");

    const secondHost = new TestApplicationHost("sevyn.host.second");

    registry.register(firstHost);
    registry.register(secondHost);

    expect(registry.list()).toEqual([firstHost, secondHost]);
  });

  it("reports whether a host exists", () => {
    const registry = new ApplicationHostRegistry();
    const host = new TestApplicationHost("sevyn.host.test");

    registry.register(host);

    expect(registry.has(host.id)).toBe(true);
    expect(registry.has("sevyn.host.missing")).toBe(false);
  });

  it("unregisters a host", () => {
    const registry = new ApplicationHostRegistry();
    const host = new TestApplicationHost("sevyn.host.test");

    registry.register(host);

    expect(registry.unregister(host.id)).toBe(true);
    expect(registry.get(host.id)).toBeUndefined();
  });

  it("clears all hosts", () => {
    const registry = new ApplicationHostRegistry();

    registry.register(new TestApplicationHost("sevyn.host.first"));

    registry.register(new TestApplicationHost("sevyn.host.second"));

    registry.clear();

    expect(registry.list()).toEqual([]);
  });
});
