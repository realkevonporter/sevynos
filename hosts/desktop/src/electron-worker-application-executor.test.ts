import { describe, expect, it } from "vitest";
import type { HostWorkerMessage } from "@sevynos/react-native/internal";
import {
  ElectronWorkerApplicationExecutor,
  type ElectronWorkerLike,
} from "./electron-worker-application-executor.js";

class RecordingWorker implements ElectronWorkerLike {
  readonly posted: HostWorkerMessage[] = [];
  terminated = false;
  public postMessage(message: HostWorkerMessage): void {
    this.posted.push(message);
  }
  public addEventListener(
    type: "message" | "error",
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    void type;
    void listener;
  }
  public removeEventListener(
    type: "message" | "error",
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    void type;
    void listener;
  }
  public terminate(): void {
    this.terminated = true;
  }
}

describe("ElectronWorkerApplicationExecutor", () => {
  it("creates a module Web Worker and terminates it independently", async () => {
    const worker = new RecordingWorker();
    let options: WorkerOptions | undefined;
    const executor = new ElectronWorkerApplicationExecutor(
      new URL("file:///application-worker.js"),
      (_url, workerOptions) => {
        options = workerOptions;
        return worker;
      },
    );
    const transport = await executor.create({
      applicationId: "dev.example.notes",
      sessionId: "session-1",
      applicationPackage: {
        packageVersion: 1,
        manifest: {
          manifestVersion: 1,
          id: "dev.example.notes",
          name: "Notes",
          version: "1.0.0",
          runtime: "react-native",
          applicationKey: "main",
          developer: "Example",
          icon: "icon.svg",
          entrypoint: "index.js",
          minimumSevynOSVersion: "0.1.0",
          permissions: [],
          services: [],
          windowModes: ["standard"],
          instanceMode: "single",
        },
        files: {},
        assets: {},
        icons: {},
        integrity: { algorithm: "SHA-256", files: {}, packageHash: "hash" },
      },
    });
    expect(options).toMatchObject({
      type: "module",
      name: "sevyn-dev.example.notes-session-1",
    });
    await transport.terminate("test");
    expect(worker.terminated).toBe(true);
  });
});
