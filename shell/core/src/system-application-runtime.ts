import type {
  DeviceDescriptor,
  DeviceProfile,
  SystemApplicationMount,
} from "./device-profile.js";
import type {
  ShellServiceClient,
  SystemApplicationContext,
  SystemApplicationInstance,
  SystemApplicationModule,
  SystemApplicationStopReason,
} from "./system-application.js";

export interface RunningSystemApplication {
  readonly applicationId: string;
  readonly version: string;
  readonly slot: string;
  readonly layer: number;
}

interface ActiveApplication {
  readonly module: SystemApplicationModule;
  readonly context: SystemApplicationContext;
  readonly instance: SystemApplicationInstance;
}

const unavailableServices: ShellServiceClient = Object.freeze({
  request: <Result>(service: string): Promise<Result> =>
    Promise.reject(new Error(`Shell service "${service}" is unavailable.`)),
});

export class SystemApplicationRuntime {
  readonly #modules = new Map<string, SystemApplicationModule>();
  readonly #active = new Map<string, ActiveApplication>();
  readonly #listeners = new Set<() => void>();
  readonly #services: ShellServiceClient;
  #profile: DeviceProfile | undefined;
  #device: DeviceDescriptor | undefined;
  #revision = 0;

  public constructor(options: { readonly services?: ShellServiceClient } = {}) {
    this.#services = options.services ?? unavailableServices;
  }

  public get profile(): DeviceProfile | undefined {
    return this.#profile;
  }

  public get revision(): number {
    return this.#revision;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  public register(module: SystemApplicationModule): void {
    const applicationId = module.manifest.id;
    if (this.#modules.has(applicationId))
      throw new Error(`System application "${applicationId}" is already registered.`);
    this.#modules.set(applicationId, module);
    this.#notify();
  }

  public listRegistered(): readonly SystemApplicationModule[] {
    return Object.freeze([...this.#modules.values()]);
  }

  public listRunning(): readonly RunningSystemApplication[] {
    return Object.freeze(
      [...this.#active.values()]
        .sort((first, second) => first.context.mount.layer - second.context.mount.layer)
        .map((entry) =>
          Object.freeze({
            applicationId: entry.module.manifest.id,
            version: entry.module.manifest.version,
            slot: entry.context.mount.slot,
            layer: entry.context.mount.layer,
          }),
        ),
    );
  }

  public isRunning(applicationId: string): boolean {
    return this.#active.has(applicationId);
  }

  public async activate(profile: DeviceProfile, device: DeviceDescriptor): Promise<void> {
    const candidates = new Map<string, ActiveApplication>();
    try {
      for (const mount of profile.applications) {
        const module = this.#modules.get(mount.applicationId);
        if (module === undefined) {
          if (mount.optional === true) continue;
          throw new Error(
            `Shell profile "${profile.id}" requires unregistered system application "${mount.applicationId}".`,
          );
        }
        if (!module.manifest.supportedDeviceClasses.includes(device.deviceClass))
          throw new Error(
            `System application "${mount.applicationId}" does not support device class "${device.deviceClass}".`,
          );
        const preservedState = this.#active
          .get(mount.applicationId)
          ?.instance.captureState?.();
        const candidate = this.#createActive(
          module,
          profile,
          device,
          mount,
          preservedState,
        );
        candidates.set(mount.applicationId, candidate);
        await candidate.instance.start?.();
      }
    } catch (error: unknown) {
      await stopEntries(candidates.values(), "profile-changed");
      throw error;
    }

    try {
      await stopEntries(this.#active.values(), "profile-changed");
    } catch (error: unknown) {
      await stopEntries(candidates.values(), "profile-changed");
      throw error;
    }
    this.#active.clear();
    for (const [applicationId, candidate] of candidates)
      this.#active.set(applicationId, candidate);
    this.#profile = profile;
    this.#device = device;
    this.#notify();
  }

  public async hotReload(module: SystemApplicationModule): Promise<void> {
    const applicationId = module.manifest.id;
    const currentModule = this.#modules.get(applicationId);
    if (currentModule === undefined)
      throw new Error(`System application "${applicationId}" is not registered.`);
    const current = this.#active.get(applicationId);
    if (current === undefined) {
      this.#modules.set(applicationId, module);
      this.#notify();
      return;
    }
    if (this.#profile === undefined || this.#device === undefined)
      throw new Error("The active shell profile is unavailable.");
    if (!module.manifest.supportedDeviceClasses.includes(this.#device.deviceClass))
      throw new Error(
        `System application "${applicationId}" does not support device class "${this.#device.deviceClass}".`,
      );

    const state = current.instance.captureState?.();
    const candidate = this.#createActive(
      module,
      this.#profile,
      this.#device,
      current.context.mount,
      state,
    );
    try {
      await candidate.instance.start?.();
    } catch (error: unknown) {
      await candidate.instance.stop?.("hot-reload");
      throw error;
    }
    try {
      await current.instance.stop?.("hot-reload");
    } catch (error: unknown) {
      await candidate.instance.stop?.("hot-reload");
      throw error;
    }
    this.#modules.set(applicationId, module);
    this.#active.set(applicationId, candidate);
    this.#notify();
  }

  public render(applicationId: string, input: unknown): unknown {
    const active = this.#active.get(applicationId);
    if (active === undefined)
      throw new Error(`System application "${applicationId}" is not running.`);
    if (active.instance.render === undefined)
      throw new Error(`System application "${applicationId}" has no presentation.`);
    return active.instance.render(input);
  }

  public async shutdown(): Promise<void> {
    await stopEntries(this.#active.values(), "shell-shutdown");
    this.#active.clear();
    this.#profile = undefined;
    this.#device = undefined;
    this.#notify();
  }

  #createActive(
    module: SystemApplicationModule,
    profile: DeviceProfile,
    device: DeviceDescriptor,
    mount: SystemApplicationMount,
    preservedState: unknown,
  ): ActiveApplication {
    const context = Object.freeze({
      device,
      profile,
      mount,
      services: this.#services,
      invalidate: (): void => {
        this.#notify();
      },
    });
    const instance = module.create(context, preservedState);
    return { module, context, instance };
  }

  #notify(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}

async function stopEntries(
  entries: Iterable<ActiveApplication>,
  reason: SystemApplicationStopReason,
): Promise<void> {
  for (const entry of [...entries].reverse()) await entry.instance.stop?.(reason);
}
