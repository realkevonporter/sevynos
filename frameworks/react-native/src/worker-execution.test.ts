import { describe, expect, it } from "vitest";
import {
  InMemoryApplicationPermissionStore,
  NamespacedApplicationStorage,
  VirtualApplicationPackageRepository,
  buildSevynApplicationPackage,
  type SevynApplicationManifest,
} from "./application-platform.js";
import {
  IsolatedApplicationWorkerManager,
  TrustedWorkerServiceBroker,
  type ApplicationWorkerDescriptor,
  type ApplicationWorkerExecutor,
  type ApplicationWorkerTransport,
  type WorkerExecutionLimits,
} from "./worker-execution.js";
import type { HostWorkerMessage } from "./worker-protocol.js";

const pause = (milliseconds = 0): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
const manifest = (id: string): SevynApplicationManifest => ({
  manifestVersion: 1,
  id,
  name: id,
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "main",
  developer: "Hostile Tests",
  icon: "icons/app.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["notifications", "network"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
});
const packaged = (id: string) =>
  buildSevynApplicationPackage({
    manifest: manifest(id),
    files: { "dist/index.js": "export const application = true;" },
    icons: { "icons/app.svg": "<svg/>" },
  });
class FakeTransport implements ApplicationWorkerTransport {
  readonly posted: HostWorkerMessage[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  terminatedWith: string | undefined;
  public post(message: HostWorkerMessage): void {
    this.posted.push(message);
  }
  public subscribe(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  public subscribeError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => {
      this.#errors.delete(listener);
    };
  }
  public terminate(reason: string): Promise<void> {
    this.terminatedWith = reason;
    return Promise.resolve();
  }
  public emit(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
  public fail(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }
}
class FakeExecutor implements ApplicationWorkerExecutor {
  readonly transports: FakeTransport[] = [];
  public create(
    descriptor: ApplicationWorkerDescriptor,
  ): Promise<ApplicationWorkerTransport> {
    void descriptor;
    const transport = new FakeTransport();
    this.transports.push(transport);
    return Promise.resolve(transport);
  }
}
const limits = (changes: Partial<WorkerExecutionLimits> = {}): WorkerExecutionLimits => ({
  startupTimeoutMs: 30,
  eventTimeoutMs: 20,
  serviceTimeoutMs: 100,
  updateTimeoutMs: 30,
  maximumInboundQueue: 8,
  maximumOutboundQueue: 8,
  maximumMessageBytes: 2_048,
  maximumInvalidationsPerSecond: 2,
  maximumNotificationsPerMinute: 1,
  maximumDeadlineFailures: 1,
  ...changes,
});
async function setup(changes: Partial<WorkerExecutionLimits> = {}) {
  const repository = new VirtualApplicationPackageRepository();
  await repository.put(await packaged("dev.hostile.one"));
  await repository.put(await packaged("dev.healthy.two"));
  const permissions = new InMemoryApplicationPermissionStore();
  const storage = new NamespacedApplicationStorage();
  const activeLimits = limits(changes);
  const broker = new TrustedWorkerServiceBroker(
    permissions,
    { storage, request: () => Promise.resolve(null) },
    activeLimits,
  );
  const executor = new FakeExecutor();
  const manager = new IsolatedApplicationWorkerManager(
    repository,
    executor,
    broker,
    activeLimits,
  );
  return { repository, permissions, storage, executor, manager };
}
function message(
  type: "ready" | "heartbeat" | "shutdown-complete",
  applicationId: string,
  sessionId: string,
  sequence = 1,
) {
  return { protocolVersion: 1, applicationId, sessionId, sequence, type };
}
function request(
  applicationId: string,
  sessionId: string,
  service: "network.request" | "notifications.show",
  sequence: number,
) {
  return {
    protocolVersion: 1,
    applicationId,
    sessionId,
    sequence,
    type: "service-request",
    requestId: `request-${String(sequence)}`,
    service,
    arguments: null,
  };
}
describe("isolated third-party application workers", () => {
  it("terminates an infinite-loop worker through the startup deadline without freezing", async () => {
    const { manager, executor } = await setup({ startupTimeoutMs: 5 });
    const worker = await manager.launch("dev.hostile.one");
    await pause(15);
    expect(
      manager.list().find((item) => item.sessionId === worker.sessionId),
    ).toMatchObject({
      status: "unresponsive",
      metrics: { terminationReason: "startup-timeout" },
    });
    expect(executor.transports[0]?.terminatedWith).toBe("startup-timeout");
  });

  it("keeps a healthy worker running when another crashes", async () => {
    const { manager, executor } = await setup({ startupTimeoutMs: 150 });
    const hostile = await manager.launch("dev.hostile.one");
    const healthy = await manager.launch("dev.healthy.two");
    executor.transports[1]?.emit(
      message("ready", healthy.applicationId, healthy.sessionId),
    );
    executor.transports[0]?.fail(new Error("private content"));
    await pause();
    expect(
      manager.list().find((item) => item.sessionId === hostile.sessionId)?.status,
    ).toBe("crashed");
    expect(
      manager.list().find((item) => item.sessionId === healthy.sessionId)?.status,
    ).toBe("running");
  });

  it("terminates malformed, oversized, and identity-spoofed messages", async () => {
    const { manager, executor } = await setup({ maximumMessageBytes: 1_000 });
    await manager.launch("dev.hostile.one");
    executor.transports[0]?.emit({ bad: true });
    await pause();
    expect(executor.transports[0]?.terminatedWith).toBe("protocol-violation");
    const oversized = await manager.launch("dev.hostile.one");
    executor.transports[1]?.emit({
      ...message("heartbeat", oversized.applicationId, oversized.sessionId),
      payload: "x".repeat(3_000),
    });
    await pause();
    expect(executor.transports[1]?.terminatedWith).toBe("protocol-violation");
  });

  it("rejects replayed or out-of-order worker messages", async () => {
    const { manager, executor } = await setup();
    const worker = await manager.launch("dev.hostile.one");
    const transport = executor.transports[0];
    transport?.emit(message("ready", worker.applicationId, worker.sessionId, 2));
    transport?.emit(message("heartbeat", worker.applicationId, worker.sessionId, 1));
    await pause();
    expect(transport?.terminatedWith).toBe("protocol-violation");
  });

  it("denies unauthorized capabilities and terminates the requester", async () => {
    const { manager, executor } = await setup();
    const worker = await manager.launch("dev.hostile.one");
    executor.transports[0]?.emit(
      message("ready", worker.applicationId, worker.sessionId),
    );
    executor.transports[0]?.emit(
      request(worker.applicationId, worker.sessionId, "network.request", 2),
    );
    await pause();
    expect(executor.transports[0]?.terminatedWith).toBe("unauthorized-capability");
  });

  it("enforces notification and invalidation flood limits", async () => {
    const { manager, executor, permissions } = await setup();
    permissions.set("dev.hostile.one", "notifications", "granted");
    const worker = await manager.launch("dev.hostile.one");
    const transport = executor.transports[0];
    transport?.emit(message("ready", worker.applicationId, worker.sessionId));
    transport?.emit(
      request(worker.applicationId, worker.sessionId, "notifications.show", 2),
    );
    await pause();
    transport?.emit(
      request(worker.applicationId, worker.sessionId, "notifications.show", 3),
    );
    await pause();
    expect(transport?.terminatedWith).toBe("unauthorized-capability");
  });

  it("enforces event and initial-render timeouts", async () => {
    const { manager, executor } = await setup({ eventTimeoutMs: 5, updateTimeoutMs: 50 });
    const worker = await manager.launch("dev.hostile.one");
    const transport = executor.transports[0];
    transport?.emit(message("ready", worker.applicationId, worker.sessionId));
    manager.deliverEvent(worker.sessionId, { kind: "press" });
    await pause(15);
    expect(transport?.terminatedWith).toBe("event-timeout");
  });

  it("restarts only the target worker and restores trusted persisted state", async () => {
    const { manager, executor, storage } = await setup();
    await storage.set(
      "dev.hostile.one",
      "worker.persisted-state",
      JSON.stringify({ count: 4 }),
    );
    const target = await manager.launch("dev.hostile.one");
    const other = await manager.launch("dev.healthy.two");
    await manager.hotReload(target.sessionId);
    const initialization = executor.transports[2]?.posted[0];
    expect(initialization?.type).toBe("initialize");
    if (initialization?.type !== "initialize") return;
    expect(initialization.persistedState).toEqual({ count: 4 });
    expect(initialization.applicationKey).toBe("main");
    expect(initialization.bundleSource).toBe("export const application = true;");
    expect(executor.transports[1]?.terminatedWith).toBeUndefined();
    expect(
      manager.list().find((item) => item.sessionId === other.sessionId)?.status,
    ).toBe("starting");
  });

  it("reloads a worker bundle in place so its native window session is preserved", async () => {
    const { manager, executor, repository } = await setup();
    Object.defineProperty(executor, "isolation", { value: "worker" });
    const target = await manager.launch("dev.hostile.one");
    executor.transports[0]?.emit(
      message("ready", target.applicationId, target.sessionId),
    );
    const replacement = await buildSevynApplicationPackage({
      manifest: { ...manifest(target.applicationId), version: "1.0.1" },
      files: { "dist/index.js": "updated bundle" },
      icons: { "icons/app.svg": "<svg/>" },
    });
    await repository.put(replacement);

    const reloaded = await manager.hotReload(target.sessionId);

    expect(reloaded.sessionId).toBe(target.sessionId);
    expect(reloaded.metrics.restartCount).toBe(1);
    expect(executor.transports).toHaveLength(1);
    expect(executor.transports[0]?.posted.at(-1)).toMatchObject({
      type: "reload",
      applicationKey: "main",
      bundleSource: "updated bundle",
    });
  });

  it("prevents disabled launches and shuts down every worker", async () => {
    const { manager, executor } = await setup();
    await manager.launch("dev.hostile.one");
    await manager.launch("dev.healthy.two");
    manager.disable("dev.hostile.one");
    await expect(manager.launch("dev.hostile.one")).rejects.toThrow(/disabled/);
    manager.enable("dev.hostile.one");
    await manager.shutdown();
    expect(
      executor.transports.every((transport) => transport.terminatedWith !== undefined),
    ).toBe(true);
  });
});
