import type {
  ApplicationWorkerDescriptor,
  ApplicationWorkerExecutor,
  ApplicationWorkerTransport,
  HostWorkerMessage,
} from "@sevynos/react-native/internal";

export interface ElectronWorkerLike {
  postMessage(message: HostWorkerMessage): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}
export type ElectronWorkerFactory = (
  url: URL,
  options: WorkerOptions,
) => ElectronWorkerLike;

class ElectronWorkerTransport implements ApplicationWorkerTransport {
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    for (const listener of this.#messageListeners) listener(event.data);
  };
  readonly #onError = (event: ErrorEvent): void => {
    const error = new Error(event.message || "Application worker failed.");
    for (const listener of this.#errorListeners) listener(error);
  };
  #terminated = false;
  public constructor(readonly worker: ElectronWorkerLike) {
    worker.addEventListener("message", this.#onMessage);
    worker.addEventListener("error", this.#onError);
  }
  public post(message: HostWorkerMessage): void {
    if (this.#terminated) throw new Error("Application worker is terminated.");
    this.worker.postMessage(message);
  }
  public subscribe(listener: (message: unknown) => void): () => void {
    this.#messageListeners.add(listener);
    return () => {
      this.#messageListeners.delete(listener);
    };
  }
  public subscribeError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }
  public terminate(reason: string): Promise<void> {
    void reason;
    if (this.#terminated) return Promise.resolve();
    this.#terminated = true;
    this.worker.removeEventListener("message", this.#onMessage);
    this.worker.removeEventListener("error", this.#onError);
    this.worker.terminate();
    this.#messageListeners.clear();
    this.#errorListeners.clear();
    return Promise.resolve();
  }
  public memoryUsage(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }
}

export class ElectronWorkerApplicationExecutor implements ApplicationWorkerExecutor {
  public readonly isolation = "worker" as const;
  readonly #factory: ElectronWorkerFactory;
  public constructor(
    readonly workerUrl: URL,
    factory: ElectronWorkerFactory = (url, options) => new Worker(url, options),
  ) {
    this.#factory = factory;
  }
  public create(
    descriptor: ApplicationWorkerDescriptor,
  ): Promise<ApplicationWorkerTransport> {
    const worker = this.#factory(this.workerUrl, {
      type: "module",
      name: `sevyn-${descriptor.applicationId}-${descriptor.sessionId}`,
    });
    return Promise.resolve(new ElectronWorkerTransport(worker));
  }
}
