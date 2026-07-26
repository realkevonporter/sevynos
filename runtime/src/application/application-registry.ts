import { ApplicationNotFoundError } from "../errors/application-not-found-error.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import type { ApplicationId, ApplicationManifest } from "./application-manifest.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

export class ApplicationRegistry {
  readonly #applications = new Map<ApplicationId, ApplicationManifest>();

  public register(input: unknown): void {
    const manifest = validateApplicationManifest(input);

    if (this.#applications.has(manifest.id)) {
      throw new DuplicateApplicationError(manifest.id);
    }

    this.#applications.set(manifest.id, manifest);
  }

  public unregister(id: ApplicationId): boolean {
    return this.#applications.delete(id);
  }

  public get(applicationId: ApplicationId): ApplicationManifest {
    const manifest = this.#applications.get(applicationId);

    if (!manifest) {
      throw new ApplicationNotFoundError(applicationId);
    }

    return manifest;
  }

  public list(): readonly ApplicationManifest[] {
    return [...this.#applications.values()];
  }

  public has(id: ApplicationId): boolean {
    return this.#applications.has(id);
  }

  public clear(): void {
    this.#applications.clear();
  }
}
