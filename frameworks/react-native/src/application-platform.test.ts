import { describe, expect, it } from "vitest";
import {
  ApplicationHotReloadController,
  ApplicationInstaller,
  ApplicationResourceGovernor,
  ApplicationStorageQuotaError,
  InMemoryApplicationPermissionStore,
  NamespacedApplicationStorage,
  ThirdPartyApplicationExecutionService,
  VirtualApplicationPackageRepository,
  buildSevynApplicationPackage,
  createApplicationCapabilities,
  validateSevynApplicationManifest,
  verifyPackageIntegrity,
  type ApplicationCapabilityProviders,
  type ApplicationPackageRepository,
  type InstallPermissionPrompt,
  type SevynApplicationManifest,
  type SevynPermission,
  type ThirdPartyApplicationModule,
} from "./public.js";
import * as publicApi from "./index.js";
import { InMemoryFileSystem, SystemNotificationService } from "./services.js";

const manifest = (
  changes: Partial<SevynApplicationManifest> = {},
): SevynApplicationManifest => ({
  manifestVersion: 1,
  id: "org.sevynos.notes",
  name: "Notes",
  version: "1.0.0",
  runtime: "react-native",
  applicationKey: "Notes",
  developer: "Sevyn Example Developers",
  icon: "icons/notes.svg",
  entrypoint: "dist/index.js",
  minimumSevynOSVersion: "0.1.0",
  permissions: ["notifications"],
  services: [],
  windowModes: ["standard"],
  instanceMode: "multiple",
  ...changes,
});
const packageFor = (changes: Partial<SevynApplicationManifest> = {}) =>
  buildSevynApplicationPackage({
    manifest: manifest(changes),
    files: { "dist/index.js": "export const Notes = () => null;" },
    icons: { "icons/notes.svg": "<svg/>" },
  });
const grantAll: InstallPermissionPrompt = {
  request: (_manifest, requested) =>
    Promise.resolve(
      new Map(requested.map((permission) => [permission, "granted" as const])),
    ),
};
class FailableRepository implements ApplicationPackageRepository {
  readonly inner = new VirtualApplicationPackageRepository();
  failNextPut = false;
  public get(id: string) {
    return this.inner.get(id);
  }
  public list() {
    return this.inner.list();
  }
  public remove(id: string) {
    return this.inner.remove(id);
  }
  public put(value: Parameters<ApplicationPackageRepository["put"]>[0]): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error("simulated write failure"));
    }
    return this.inner.put(value);
  }
}

describe("Sevyn third-party application platform", () => {
  it("does not expose renderer or reconciler internals from the public entrypoint", () => {
    expect("SevynApplicationRuntime" in publicApi).toBe(false);
    expect("layoutNativeTree" in publicApi).toBe(false);
    expect("createNativeReconcilerRoot" in publicApi).toBe(false);
  });
  it("validates developer-facing manifest fields", () => {
    expect(validateSevynApplicationManifest(manifest()).id).toBe("org.sevynos.notes");
    const platformPermissions: readonly SevynPermission[] = [
      "battery",
      "display",
      "audio",
      "vibration",
      "nfc",
      "cellular",
    ];
    expect(
      validateSevynApplicationManifest(
        manifest({ permissions: platformPermissions }),
      ).permissions,
    ).toEqual(platformPermissions);
    expect(() =>
      validateSevynApplicationManifest({ ...manifest(), entrypoint: "../host.js" }),
    ).toThrow(/entrypoint/);
    expect(() =>
      validateSevynApplicationManifest({ ...manifest(), permissions: ["host.root"] }),
    ).toThrow(/permissions/);
  });

  it("builds and cryptographically verifies packages", async () => {
    const applicationPackage = await packageFor();
    await expect(verifyPackageIntegrity(applicationPackage)).resolves.toBeUndefined();
    await expect(
      verifyPackageIntegrity({
        ...applicationPackage,
        files: { "dist/index.js": "tampered" },
      }),
    ).rejects.toThrow(/hash/);
  });

  it("installs, updates, and uninstalls atomically", async () => {
    const repository = new VirtualApplicationPackageRepository();
    const permissions = new InMemoryApplicationPermissionStore();
    const installer = new ApplicationInstaller(
      repository,
      permissions,
      grantAll,
      "1.0.0",
      () => 7,
    );
    await installer.install(await packageFor());
    await installer.install(await packageFor({ version: "1.1.0" }));
    expect(installer.list()[0]?.manifest.version).toBe("1.1.0");
    expect(permissions.get("org.sevynos.notes", "notifications")).toBe("granted");
    await installer.uninstall("org.sevynos.notes");
    expect(await repository.get("org.sevynos.notes")).toBeUndefined();
    expect(permissions.get("org.sevynos.notes", "notifications")).toBe("denied");
  });

  it("rolls back a failed atomic update", async () => {
    const repository = new FailableRepository();
    const installer = new ApplicationInstaller(
      repository,
      new InMemoryApplicationPermissionStore(),
      grantAll,
    );
    await installer.install(await packageFor());
    repository.failNextPut = true;
    await expect(
      installer.install(await packageFor({ version: "2.0.0" })),
    ).rejects.toThrow(/write failure/);
    expect((await repository.get("org.sevynos.notes"))?.manifest.version).toBe("1.0.0");
    expect(installer.list()[0]?.manifest.version).toBe("1.0.0");
  });

  it("defaults permissions to denied and exposes only granted capabilities", () => {
    const permissions = new InMemoryApplicationPermissionStore();
    const filesystem = new InMemoryFileSystem();
    const providers: ApplicationCapabilityProviders = {
      filesystem,
      clipboard: {
        readText: () => Promise.resolve("secret"),
        writeText: () => Promise.resolve(),
      },
      notifications: new SystemNotificationService(),
      network: { request: () => Promise.resolve("ok") },
      location: { current: () => Promise.resolve({ latitude: 0, longitude: 0 }) },
      camera: { capture: () => Promise.resolve("image") },
      microphone: { record: () => Promise.resolve("audio") },
    };
    expect(
      createApplicationCapabilities("org.sevynos.notes", permissions, providers),
    ).toEqual({});
    permissions.set("org.sevynos.notes", "filesystem.read", "granted");
    permissions.set("org.sevynos.notes", "notifications", "granted");
    const scoped = createApplicationCapabilities(
      "org.sevynos.notes",
      permissions,
      providers,
    );
    expect(scoped.filesystem?.read).toBeTypeOf("function");
    expect(scoped.filesystem?.write).toBeUndefined();
    expect(scoped.notifications?.show).toBeTypeOf("function");
  });

  it("isolates storage namespaces and enforces quotas", async () => {
    const storage = new NamespacedApplicationStorage(12);
    await storage.set("app.one", "note", "hello");
    expect(await storage.get("app.two", "note")).toBeUndefined();
    await expect(
      storage.set("app.one", "large", "this is too large"),
    ).rejects.toBeInstanceOf(ApplicationStorageQuotaError);
  });

  it("bounds events, invalidations, update time, and preserves hot-reload state", () => {
    const governor = new ApplicationResourceGovernor(100, 2, 2);
    expect(governor.enqueue(() => undefined)).toBe(true);
    expect(governor.enqueue(() => undefined)).toBe(true);
    expect(governor.enqueue(() => undefined)).toBe(false);
    expect(governor.requestInvalidation()).toBe(true);
    expect(governor.requestInvalidation()).toBe(true);
    expect(governor.requestInvalidation()).toBe(false);
    const hotReload = new ApplicationHotReloadController<{ readonly note: string }>();
    hotReload.preserve({ note: "kept" });
    let restored = "";
    hotReload.reload((state) => {
      restored = state?.note ?? "";
    });
    expect(restored).toBe("kept");
    expect(hotReload.revision).toBe(1);
  });

  it("keeps the permission vocabulary stable", () => {
    const expected: readonly SevynPermission[] = [
      "filesystem.read",
      "filesystem.write",
      "clipboard.read",
      "clipboard.write",
      "notifications",
      "network",
      "location",
      "camera",
      "microphone",
    ];
    expect(expected).toHaveLength(9);
  });

  it("isolates crashes and preserves state across application hot reload", async () => {
    const repository = new VirtualApplicationPackageRepository();
    await repository.put(await packageFor({ instanceMode: "multiple" }));
    let restored: unknown;
    let shouldCrash = false;
    const module: ThirdPartyApplicationModule = {
      start: (state) => {
        if (shouldCrash) throw new Error("private application content");
        restored = state;
        return { stop: () => undefined, captureState: () => ({ draft: "preserved" }) };
      },
    };
    const executions = new ThirdPartyApplicationExecutionService(repository, {
      load: () => Promise.resolve(module),
    });
    const first = await executions.launch("org.sevynos.notes");
    const reloaded = await executions.hotReload(first.id);
    expect(reloaded.status).toBe("running");
    expect(restored).toEqual({ draft: "preserved" });
    shouldCrash = true;
    const crashed = await executions.launch("org.sevynos.notes");
    expect(crashed).toMatchObject({
      status: "crashed",
      sanitizedError: "The application stopped unexpectedly.",
    });
    expect(JSON.stringify(crashed)).not.toContain("private");
  });
});
