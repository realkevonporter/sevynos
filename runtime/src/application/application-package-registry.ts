import { ApplicationNotFoundError } from "../errors/application-not-found-error.js";
import { DuplicateApplicationError } from "../errors/duplicate-application-error.js";
import type { ApplicationPackage } from "./application-package.js";
import type { ApplicationId } from "./application-manifest.js";
import { validateApplicationManifest } from "./application-manifest-validator.js";

export class ApplicationPackageRegistry {
  readonly #packages = new Map<ApplicationId, ApplicationPackage>();

  public register(applicationPackage: ApplicationPackage): void {
    const manifest = validateApplicationManifest(applicationPackage.manifest);

    if (this.#packages.has(manifest.id)) {
      throw new DuplicateApplicationError(manifest.id);
    }

    this.#packages.set(manifest.id, {
      ...applicationPackage,
      manifest,
    });
  }

  public unregister(id: ApplicationId): boolean {
    return this.#packages.delete(id);
  }

  public get(applicationId: ApplicationId): ApplicationPackage {
    const applicationPackage = this.#packages.get(applicationId);

    if (!applicationPackage) {
      throw new ApplicationNotFoundError(applicationId);
    }

    return applicationPackage;
  }

  public list(): readonly ApplicationPackage[] {
    return [...this.#packages.values()];
  }

  public has(id: ApplicationId): boolean {
    return this.#packages.has(id);
  }

  public clear(): void {
    this.#packages.clear();
  }
}
