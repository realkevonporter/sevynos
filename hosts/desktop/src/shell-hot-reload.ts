import type { SystemApplicationModule } from "@sevynos/shell-core";

const SYSTEM_APPLICATION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

interface UnknownSystemApplicationModule {
  readonly manifest?: unknown;
  readonly create?: unknown;
}

interface UnknownSystemApplicationManifest {
  readonly id?: unknown;
}

export function resolveSystemApplicationModule(
  applicationId: string,
  moduleNamespace: unknown,
): SystemApplicationModule {
  if (typeof moduleNamespace !== "object" || moduleNamespace === null)
    throw new TypeError("The shell application module namespace is invalid.");
  const application = Object.values(moduleNamespace as Record<string, unknown>).find(
    (value): value is SystemApplicationModule =>
      isSystemApplicationModule(value, applicationId),
  );
  if (application === undefined)
    throw new Error(
      `The rebuilt module did not export system application "${applicationId}".`,
    );
  return application;
}

function isSystemApplicationModule(
  value: unknown,
  applicationId: string,
): value is SystemApplicationModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as UnknownSystemApplicationModule;
  const manifest = candidate.manifest;
  if (typeof manifest !== "object" || manifest === null) return false;
  const manifestRecord = manifest as UnknownSystemApplicationManifest;
  return manifestRecord.id === applicationId && typeof candidate.create === "function";
}

export function createSystemApplicationModuleUrl(
  rendererUrl: string,
  applicationId: string,
  revision: number,
): string {
  if (!SYSTEM_APPLICATION_ID.test(applicationId))
    throw new TypeError(`Invalid system application identifier "${applicationId}".`);
  const url = new URL(`./system-applications/${applicationId}.js`, rendererUrl);
  url.searchParams.set("revision", String(revision));
  return url.href;
}
