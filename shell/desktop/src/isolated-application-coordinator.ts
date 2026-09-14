import { notesApplicationBundle, notesManifest } from "@sevynos/example-notes";
import {
  InMemoryApplicationPermissionStore,
  IsolatedApplicationWorkerManager,
  NamespacedApplicationStorage,
  TrustedWorkerServiceBroker,
  VirtualApplicationPackageRepository,
  buildSevynApplicationPackage,
  verifyPackageIntegrity,
  type ApplicationPackageRepository,
  type SevynApplicationPackage,
  type ApplicationWorkerExecutor,
  type ApplicationWorkerSnapshot,
  type StructuredValue,
  type WorkerServiceName,
} from "@sevynos/react-native/internal";
import type { DesktopRuntime } from "./desktop-runtime.js";
import { decodeWorkerSurface } from "./worker-surface-decoder.js";

export interface IsolatedApplicationServiceProvider {
  request(
    applicationId: string,
    service: WorkerServiceName,
    argumentsValue: StructuredValue,
  ): Promise<StructuredValue>;
}

export class DesktopIsolatedApplicationCoordinator {
  readonly #runtime: DesktopRuntime;
  readonly #manager: IsolatedApplicationWorkerManager;
  readonly #repository: ApplicationPackageRepository;
  readonly #permissions: InMemoryApplicationPermissionStore;
  readonly #workerWindows = new Map<string, string>();
  readonly #workerSessionsByWindow = new Map<string, string>();
  readonly #unsubscribe: () => void;
  readonly #onProcessLaunched: ((applicationId: string) => void) | undefined;

  private constructor(
    runtime: DesktopRuntime,
    manager: IsolatedApplicationWorkerManager,
    repository: ApplicationPackageRepository,
    permissions: InMemoryApplicationPermissionStore,
    onProcessLaunched?: (applicationId: string) => void,
  ) {
    this.#runtime = runtime;
    this.#manager = manager;
    this.#repository = repository;
    this.#permissions = permissions;
    this.#onProcessLaunched = onProcessLaunched;
    this.#unsubscribe = manager.subscribe(() => {
      const snapshots = manager.list();
      runtime.surfaces.updateWorkerSnapshots(snapshots);
      for (const snapshot of snapshots) this.#handleSnapshot(snapshot);
    });
  }

  public static async create(options: {
    readonly runtime: DesktopRuntime;
    readonly executor: ApplicationWorkerExecutor;
    readonly services: IsolatedApplicationServiceProvider;
    readonly storage?: Pick<NamespacedApplicationStorage, "get" | "set">;
    readonly onProcessLaunched?: (applicationId: string) => void;
  }): Promise<DesktopIsolatedApplicationCoordinator> {
    const repository = new VirtualApplicationPackageRepository();
    await repository.put(
      await buildSevynApplicationPackage({
        manifest: notesManifest,
        files: { [notesManifest.entrypoint]: notesApplicationBundle },
        icons: { [notesManifest.icon]: "sevyn-notes" },
      }),
    );
    const permissions = new InMemoryApplicationPermissionStore();
    permissions.set(notesManifest.id, "notifications", "granted");
    const broker = new TrustedWorkerServiceBroker(permissions, {
      storage: options.storage ?? new NamespacedApplicationStorage(),
      request: (applicationId, service, argumentsValue) =>
        options.services.request(applicationId, service, argumentsValue),
    });
    return new DesktopIsolatedApplicationCoordinator(
      options.runtime,
      new IsolatedApplicationWorkerManager(repository, options.executor, broker),
      repository,
      permissions,
      options.onProcessLaunched,
    );
  }

  public async launch(applicationId: string): Promise<void> {
    const running = await this.#runtime.applications.launch(applicationId);
    if ((await this.#repository.get(running.definition.id)) !== undefined)
      await this.#ensureWindow(running.windowId, running.definition.id);
  }

  public async attachRunningApplications(): Promise<void> {
    for (const running of this.#runtime.applications.listRunning())
      if (running.definition.id === notesManifest.id)
        await this.#ensureWindow(running.windowId, running.definition.id);
  }

  public async shutdown(): Promise<void> {
    this.#unsubscribe();
    await this.#manager.shutdown();
  }

  public async installDevelopmentPackage(
    applicationPackage: SevynApplicationPackage,
    options: { readonly launch?: boolean } = {},
  ): Promise<void> {
    await verifyPackageIntegrity(applicationPackage);
    await this.#repository.put(applicationPackage);
    for (const permission of applicationPackage.manifest.permissions)
      this.#permissions.set(applicationPackage.manifest.id, permission, "granted");
    const active = this.#manager
      .list()
      .filter(
        ({ applicationId, status }) =>
          applicationId === applicationPackage.manifest.id && status === "running",
      );
    await Promise.all(active.map(({ sessionId }) => this.#manager.hotReload(sessionId)));
    if (active.length === 0) {
      this.#runtime.applications.registerDevelopmentApplication(
        applicationPackage.manifest.id,
        applicationPackage.manifest.name,
      );
      if (options.launch !== false) {
        const running = await this.#runtime.applications.launch(
          applicationPackage.manifest.id,
        );
        await this.#ensureWindow(running.windowId, applicationPackage.manifest.id);
      }
    }
  }

  async #ensureWindow(windowId: string, applicationId: string): Promise<void> {
    if (this.#workerSessionsByWindow.has(windowId)) return;
    const snapshot = await this.#manager.launch(applicationId);
    this.#onProcessLaunched?.(applicationId);
    this.#workerWindows.set(snapshot.sessionId, windowId);
    this.#workerSessionsByWindow.set(windowId, snapshot.sessionId);
    this.#handleSnapshot(snapshot);
  }

  #handleSnapshot(snapshot: ApplicationWorkerSnapshot): void {
    const windowId = this.#workerWindows.get(snapshot.sessionId);
    if (windowId === undefined || snapshot.latestSurface === undefined) return;
    try {
      this.#runtime.surfaces.attachIsolatedSurface(
        windowId,
        decodeWorkerSurface(snapshot.latestSurface),
        (event) => {
          this.#manager.deliverEvent(snapshot.sessionId, event);
        },
        () => {
          this.#workerWindows.delete(snapshot.sessionId);
          this.#workerSessionsByWindow.delete(windowId);
          void this.#manager.terminate(snapshot.sessionId, "window-closed");
        },
      );
    } catch (error: unknown) {
      this.#runtime.diagnostics.record({
        severity: "error",
        subsystem: "application-worker",
        event: "surface.rejected",
        message: error instanceof Error ? error.message : "Worker surface was rejected.",
      });
      void this.#manager.terminate(snapshot.sessionId, "invalid-surface");
    }
  }
}
