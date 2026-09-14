import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostWorkerMessage } from "@sevynos/react-native/internal";
import {
  NativeLinuxProcessApplicationExecutor,
  type LinuxApplicationProcess,
} from "./linux-process-application-executor.js";

class FakeProcess extends EventEmitter implements LinuxApplicationProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  signal: NodeJS.Signals | undefined;
  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signal = signal;
    return true;
  }
}

describe("Linux process application executor", () => {
  it("uses a restricted child process transport and terminates only that process", async () => {
    const child = new FakeProcess();
    let bundlePath = "";
    const executor = new NativeLinuxProcessApplicationExecutor(
      "runner.js",
      (_executable, _argumentsValue, environment) => {
        expect(environment["SEVYN_APPLICATION_ID"]).toBe("org.sevynos.notes");
        expect(environment["SEVYN_APPLICATION_KEY"]).toBe("main");
        bundlePath = environment["SEVYN_APPLICATION_BUNDLE"] ?? "";
        expect(environment["HOME"]).toBeUndefined();
        return child;
      },
    );
    const transport = await executor.create({
      applicationId: "org.sevynos.notes",
      sessionId: "session-1",
      applicationPackage: {
        packageVersion: 1,
        manifest: {
          manifestVersion: 1,
          id: "org.sevynos.notes",
          name: "Notes",
          version: "1.0.0",
          runtime: "react-native",
          applicationKey: "main",
          developer: "Sevyn",
          icon: "icon.svg",
          entrypoint: "index.js",
          minimumSevynOSVersion: "0.1.0",
          permissions: [],
          services: [],
          windowModes: ["standard"],
          instanceMode: "single",
        },
        files: { "index.js": "application-bundle" },
        assets: {},
        icons: {},
        migrations: {},
        integrity: { algorithm: "SHA-256", packageHash: "hash", files: {} },
      },
    });
    expect(await readFile(bundlePath, "utf8")).toBe("application-bundle");
    const received: unknown[] = [];
    transport.subscribe((message) => received.push(message));
    const hostMessage: HostWorkerMessage = {
      protocolVersion: 1,
      applicationId: "org.sevynos.notes",
      sessionId: "session-1",
      sequence: 1,
      type: "shutdown",
      reason: "test",
    };
    transport.post(hostMessage);
    child.stdout.write(
      `${JSON.stringify({ protocolVersion: 1, applicationId: "org.sevynos.notes", sessionId: "session-1", sequence: 1, type: "ready" })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(1);
    await transport.terminate("test-complete");
    expect(child.signal).toBe("SIGTERM");
    await expect(stat(bundlePath)).rejects.toThrow();
  });
});
