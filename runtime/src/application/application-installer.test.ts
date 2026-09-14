import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplicationInstaller,
  SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX,
} from "./application-installer.js";
import { ApplicationPackageRegistry } from "./application-package-registry.js";
import { createSevynBundle } from "./application-bundle.js";
import type { ApplicationManifest } from "./application-manifest.js";
import { ProtectedApplicationError } from "../errors/protected-application-error.js";
import { InvalidSignatureError } from "../errors/invalid-signature-error.js";

describe("ApplicationInstaller", () => {
  let tempDir: string;
  let appsDir: string;
  let pristineDir: string;
  let packages: ApplicationPackageRegistry;
  let installer: ApplicationInstaller;
  let stoppedApps: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sevyn-installer-test-"));
    appsDir = join(tempDir, "apps");
    pristineDir = join(tempDir, "pristine");
    packages = new ApplicationPackageRegistry();
    stoppedApps = [];

    installer = new ApplicationInstaller({
      appsDirectory: appsDir,
      pristineDirectory: pristineDir,
      packages,
      onBeforeUninstall: (appId) => {
        stoppedApps.push(appId);
        return Promise.resolve();
      },
    });

    await installer.init();
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("installs a valid third-party dev application bundle", async () => {
    const manifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.calculator",
      name: "Calculator",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["notifications"],
      system: false,
    };

    const bundle = createSevynBundle({
      manifest,
      bytecode: new Uint8Array([1, 2, 3]),
      extraFiles: {
        "index.js": "console.log('Calculator running');",
      },
    });

    const record = await installer.install(bundle);
    expect(record.id).toBe("org.sevynos.calculator");
    expect(record.name).toBe("Calculator");
    expect(record.system).toBe(false);
    expect(record.permissions).toEqual(["notifications"]);
    expect(record.signatureStatus).toBe("unsigned");

    // Must be registered in ApplicationPackageRegistry
    expect(packages.has("org.sevynos.calculator")).toBe(true);
    const pkg = packages.get("org.sevynos.calculator");
    expect(pkg.manifest.name).toBe("Calculator");

    // Files must be extracted in apps directory
    const extractedManifest = JSON.parse(
      await readFile(join(appsDir, "org.sevynos.calculator", "manifest.json"), "utf8"),
    ) as ApplicationManifest;
    expect(extractedManifest.id).toBe("org.sevynos.calculator");

    // List installed
    const installed = await installer.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe("org.sevynos.calculator");
  });

  it("refuses to install a system: true application without an official Sevyn signature", async () => {
    const unsignedSystemManifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.malicious-terminal",
      name: "Fake Terminal",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["native-modules"],
      system: true,
      // No official signature!
    };

    const bundle = createSevynBundle({
      manifest: unsignedSystemManifest,
      bytecode: new Uint8Array([1, 2, 3]),
      extraFiles: {
        "index.js": "evil();",
      },
    });

    await expect(installer.install(bundle)).rejects.toThrow(InvalidSignatureError);
    expect(packages.has("org.sevynos.malicious-terminal")).toBe(false);
  });

  it("installs a system application with an official Sevyn signature", async () => {
    const signedSystemManifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.terminal",
      name: "Terminal",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["native-modules"],
      system: true,
      signature: `${SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX}official-terminal-release-key`,
    };

    const bundle = createSevynBundle({
      manifest: signedSystemManifest,
      bytecode: new Uint8Array([1, 2, 3]),
      extraFiles: {
        "index.js": "startTerminal();",
      },
    });

    const record = await installer.install(bundle);
    expect(record.id).toBe("org.sevynos.terminal");
    expect(record.system).toBe(true);
    expect(record.signatureStatus).toBe("official");
    expect(packages.has("org.sevynos.terminal")).toBe(true);
  });

  it("refuses to uninstall a protected system application (fail-closed)", async () => {
    const signedSystemManifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.shell",
      name: "Shell",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["native-modules"],
      system: true,
      signature: `${SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX}official-shell-release-key`,
    };

    const bundle = createSevynBundle({
      manifest: signedSystemManifest,
      bytecode: new Uint8Array([1, 2, 3]),
      extraFiles: {
        "index.js": "startShell();",
      },
    });

    await installer.install(bundle);

    // Attempting to uninstall protected shell must fail closed
    await expect(installer.uninstall("org.sevynos.shell")).rejects.toThrow(
      ProtectedApplicationError,
    );

    // Shell must still remain registered
    expect(packages.has("org.sevynos.shell")).toBe(true);
    expect(stoppedApps).not.toContain("org.sevynos.shell");
  });

  it("successfully uninstalls a deletable application and stops active sessions", async () => {
    const manifest: ApplicationManifest = {
      manifestVersion: 2,
      id: "org.sevynos.notes",
      name: "Notes",
      version: "1.0.0",
      hostId: "sevyn.host.javascript",
      entrypoint: "index.js",
      permissions: ["filesystem.read", "filesystem.write"],
      system: false,
    };

    const bundle = createSevynBundle({
      manifest,
      bytecode: new Uint8Array([1, 2, 3]),
      extraFiles: {
        "index.js": "console.log('Notes');",
      },
    });

    await installer.install(bundle);
    expect(packages.has("org.sevynos.notes")).toBe(true);

    // Uninstall
    await installer.uninstall("org.sevynos.notes");

    // Must have invoked session termination callback
    expect(stoppedApps).toContain("org.sevynos.notes");

    // Package must be unregistered
    expect(packages.has("org.sevynos.notes")).toBe(false);

    // App directory must be removed
    await expect(stat(join(appsDir, "org.sevynos.notes"))).rejects.toThrow();

    // Registry must be empty
    const list = await installer.listInstalled();
    expect(list).toHaveLength(0);
  });

  it("reinstalls a deleted stock app from the pristine store", async () => {
    // Install and delete notes
    await installer.installFromPristine("notes");
    expect(packages.has("org.sevynos.notes")).toBe(true);
    expect(await installer.listInstalled()).toHaveLength(1);

    await installer.uninstall("org.sevynos.notes");
    expect(packages.has("org.sevynos.notes")).toBe(false);
    expect(await installer.listInstalled()).toHaveLength(0);

    // Reinstall from pristine
    const restored = await installer.installFromPristine("notes");
    expect(restored.id).toBe("org.sevynos.notes");
    expect(packages.has("org.sevynos.notes")).toBe(true);
    expect(restored.installSource).toBe("pristine");
  });
});
