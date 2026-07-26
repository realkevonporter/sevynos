import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import type { ApplicationDescriptor, ApplicationId } from "./application-descriptor.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

export class ApplicationRegistry {
  readonly #applications = new Map<ApplicationId, ApplicationDescriptor>();

  public register(application: ApplicationDescriptor): void {
    validateApplicationManifest(application);
    if (this.#applications.has(application.id)) {
      throw new DuplicateApplicationError(application.id);
    }

    this.#applications.set(application.id, application);
  }

  public unregister(id: ApplicationId): boolean {
    return this.#applications.delete(id);
  }

  public get(id: ApplicationId): ApplicationDescriptor | undefined {
    return this.#applications.get(id);
  }

  public list(): readonly ApplicationDescriptor[] {
    return [...this.#applications.values()];
  }

  public has(id: ApplicationId): boolean {
    return this.#applications.has(id);
  }

  public clear(): void {
    this.#applications.clear();
  }
}
