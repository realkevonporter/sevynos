import type { ApplicationHost } from "./application-host.js";
import type { ApplicationHostId } from "./application-host-id.js";

export class ApplicationHostRegistry {
  readonly #hosts = new Map<ApplicationHostId, ApplicationHost>();

  public register(host: ApplicationHost): void {
    if (this.#hosts.has(host.id)) {
      throw new Error(`Application host "${host.id}" is already registered.`);
    }

    this.#hosts.set(host.id, host);
  }

  public unregister(id: ApplicationHostId): boolean {
    return this.#hosts.delete(id);
  }

  public get(id: ApplicationHostId): ApplicationHost | undefined {
    return this.#hosts.get(id);
  }

  public has(id: ApplicationHostId): boolean {
    return this.#hosts.has(id);
  }

  public list(): readonly ApplicationHost[] {
    return [...this.#hosts.values()];
  }

  public clear(): void {
    this.#hosts.clear();
  }
}
