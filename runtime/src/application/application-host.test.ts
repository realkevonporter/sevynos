import { describe, expect, it } from "vitest";

import type { ApplicationHost, ApplicationHostStartResult } from "./application-host.js";
import type { ApplicationPackage } from "./application-package.js";
import { ApplicationSession } from "./application-session.js";

const helloApplicationPackage: ApplicationPackage = {
  manifest: {
    manifestVersion: 1,
    id: "dev.sevyn.hello",
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

class TestApplicationHost implements ApplicationHost {
  public readonly id = "sevyn.host.javascript";

  public async start(session: ApplicationSession): Promise<ApplicationHostStartResult> {
    await Promise.resolve();

    return {
      instanceId: `test:${session.id}`,
    };
  }

  public async stop(session: ApplicationSession): Promise<void> {
    void session;

    await Promise.resolve();
  }
}

describe("ApplicationHost", () => {
  it("supports framework-specific application execution", async () => {
    const host: ApplicationHost = new TestApplicationHost();

    const session = new ApplicationSession({
      id: "session-1",
      application: helloApplicationPackage,
      createdAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    const result = await host.start(session);

    expect(host.id).toBe("sevyn.host.javascript");

    expect(result).toEqual({
      instanceId: "test:session-1",
    });

    await expect(host.stop(session)).resolves.toBeUndefined();
  });
});
