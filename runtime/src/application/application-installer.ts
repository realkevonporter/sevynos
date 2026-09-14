import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApplicationId, ApplicationManifest } from "./application-manifest.js";
import type { ApplicationPackage } from "./application-package.js";
import type { ApplicationPackageRegistry } from "./application-package-registry.js";
import { extractSevynBundle, createSevynBundle } from "./application-bundle.js";
import { ProtectedApplicationError } from "../errors/protected-application-error.js";
import { InvalidSignatureError } from "../errors/invalid-signature-error.js";
import { ApplicationNotFoundError } from "../errors/application-not-found-error.js";

export interface InstalledApplicationRecord {
  readonly id: ApplicationId;
  readonly name: string;
  readonly version: string;
  readonly hostId: string;
  readonly entrypoint: string;
  readonly system: boolean;
  readonly permissions: readonly string[];
  readonly installSource: "pristine" | "bundle" | "sideload";
  readonly installedAt: string;
  readonly signatureStatus: "official" | "self-signed" | "unsigned";
  readonly path: string;
}

export interface ApplicationInstallerOptions {
  readonly appsDirectory?: string | undefined;
  readonly pristineDirectory?: string | undefined;
  readonly packages: ApplicationPackageRegistry;
  readonly onBeforeUninstall?:
    ((applicationId: ApplicationId) => Promise<void>) | undefined;
}

export const SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX = "sevyn-release:";

export function isOfficialSevynSignature(signature: string | undefined): boolean {
  if (!signature) return false;
  return signature.startsWith(SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX);
}

function defaultAppsDirectory(): string {
  if (typeof process !== "undefined" && process.env["SEVYN_APPS_DIR"]) {
    return process.env["SEVYN_APPS_DIR"];
  }
  if (typeof process !== "undefined" && process.platform === "darwin") {
    return join(homedir(), ".sevyn", "apps");
  }
  return "/var/lib/sevyn/apps";
}

function defaultPristineDirectory(): string {
  if (typeof process !== "undefined" && process.env["SEVYN_PRISTINE_DIR"]) {
    return process.env["SEVYN_PRISTINE_DIR"];
  }
  if (typeof process !== "undefined" && process.platform === "darwin") {
    return join(homedir(), ".sevyn", "pristine");
  }
  return "/usr/share/sevyn/pristine";
}

export class ApplicationInstaller {
  #appsDirectory: string;
  #pristineDirectory: string;
  readonly #packages: ApplicationPackageRegistry;
  readonly #onBeforeUninstall?:
    ((applicationId: ApplicationId) => Promise<void>) | undefined;

  public constructor(options: ApplicationInstallerOptions) {
    this.#appsDirectory = options.appsDirectory ?? defaultAppsDirectory();
    this.#pristineDirectory = options.pristineDirectory ?? defaultPristineDirectory();
    this.#packages = options.packages;
    this.#onBeforeUninstall = options.onBeforeUninstall;
  }

  public get appsDirectory(): string {
    return this.#appsDirectory;
  }

  public get pristineDirectory(): string {
    return this.#pristineDirectory;
  }

  public async init(): Promise<void> {
    try {
      await mkdir(this.#appsDirectory, { recursive: true });
    } catch {
      this.#appsDirectory = join(homedir(), ".sevyn", "apps");
      await mkdir(this.#appsDirectory, { recursive: true });
    }

    try {
      await mkdir(this.#pristineDirectory, { recursive: true });
    } catch {
      this.#pristineDirectory = join(homedir(), ".sevyn", "pristine");
      await mkdir(this.#pristineDirectory, { recursive: true });
    }

    const registryPath = join(this.#appsDirectory, "registry.json");
    try {
      await stat(registryPath);
    } catch {
      await writeFile(registryPath, JSON.stringify({}, null, 2), "utf8");
    }

    // Load any existing installed packages into ApplicationPackageRegistry
    const registry = await this.#readRegistry();
    for (const record of Object.values(registry)) {
      if (!this.#packages.has(record.id)) {
        const manifest: ApplicationManifest = {
          manifestVersion: 2,
          id: record.id,
          name: record.name,
          version: record.version,
          hostId: record.hostId,
          entrypoint: record.entrypoint,
          permissions: record.permissions,
          system: record.system,
        };
        const appPkg: ApplicationPackage = {
          manifest,
          files: {
            [record.entrypoint]: "/* installed application */",
          },
        };
        this.#packages.register(appPkg);
      }
    }
  }

  public async listInstalled(): Promise<readonly InstalledApplicationRecord[]> {
    const registry = await this.#readRegistry();
    return Object.freeze(Object.values(registry));
  }

  public async getInstalled(
    id: ApplicationId,
  ): Promise<InstalledApplicationRecord | undefined> {
    const registry = await this.#readRegistry();
    return registry[id];
  }

  public async install(
    bundleData: Uint8Array | string,
    options: { source?: "pristine" | "bundle" | "sideload" } = {},
  ): Promise<InstalledApplicationRecord> {
    let bytes: Uint8Array;
    if (typeof bundleData === "string") {
      bytes = await readFile(bundleData);
    } else {
      bytes = bundleData;
    }

    const extracted = extractSevynBundle(bytes);
    const manifest = extracted.manifest;

    // Validate signature requirements:
    // If manifest.system is true, signature is REQUIRED and must be an official Sevyn release signature
    let signatureStatus: "official" | "self-signed" | "unsigned";
    if (manifest.system === true) {
      if (!isOfficialSevynSignature(manifest.signature)) {
        throw new InvalidSignatureError(
          manifest.id,
          `Cannot install system application "${manifest.id}": protected system applications must be signed with an official SevynOS release key.`,
        );
      }
      signatureStatus = "official";
    } else if (manifest.signature) {
      signatureStatus = isOfficialSevynSignature(manifest.signature)
        ? "official"
        : "self-signed";
    } else {
      signatureStatus = "unsigned";
    }

    // Stage app directory
    await mkdir(this.#appsDirectory, { recursive: true });
    const appDir = join(this.#appsDirectory, manifest.id);
    await mkdir(appDir, { recursive: true });
    await mkdir(join(appDir, "assets"), { recursive: true });

    // Write extracted bundle files
    for (const [filename, content] of extracted.files.entries()) {
      const targetPath = join(appDir, filename);
      const parent = targetPath.substring(0, targetPath.lastIndexOf("/"));
      if (parent.length > 0) {
        await mkdir(parent, { recursive: true });
      }
      await writeFile(targetPath, content);
    }

    const record: InstalledApplicationRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      hostId: manifest.hostId,
      entrypoint: manifest.entrypoint,
      system: manifest.system ?? false,
      permissions: Object.freeze(manifest.permissions ? [...manifest.permissions] : []),
      installSource:
        options.source ?? (typeof bundleData === "string" ? "bundle" : "sideload"),
      installedAt: new Date().toISOString(),
      signatureStatus,
      path: appDir,
    };

    // Update registry.json
    const registry = await this.#readRegistry();
    registry[manifest.id] = record;
    await this.#writeRegistry(registry);

    // Register or update in ApplicationPackageRegistry
    if (this.#packages.has(manifest.id)) {
      this.#packages.unregister(manifest.id);
    }
    const pkg: ApplicationPackage = {
      manifest,
      files: {
        [manifest.entrypoint]: "/* installed application */",
      },
    };
    this.#packages.register(pkg);

    return record;
  }

  public async uninstall(applicationId: ApplicationId): Promise<void> {
    const registry = await this.#readRegistry();
    const record = registry[applicationId];

    if (!record) {
      throw new ApplicationNotFoundError(applicationId);
    }

    // Fail closed if protected system application
    if (record.system) {
      throw new ProtectedApplicationError(
        applicationId,
        `Cannot uninstall protected system application "${applicationId}". Core system applications (shell, terminal) are protected to preserve system integrity and recovery.`,
      );
    }

    // Terminate any active sessions
    if (this.#onBeforeUninstall) {
      await this.#onBeforeUninstall(applicationId);
    }

    // Unregister package from memory registry
    if (this.#packages.has(applicationId)) {
      this.#packages.unregister(applicationId);
    }

    // Remove application directory
    const appDir = record.path || join(this.#appsDirectory, applicationId);
    try {
      await rm(appDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory does not exist
    }

    // Remove from registry.json
    const updatedRegistry: Record<string, InstalledApplicationRecord> = {};
    for (const [key, val] of Object.entries(registry)) {
      if (key !== applicationId) {
        updatedRegistry[key] = val;
      }
    }
    await this.#writeRegistry(updatedRegistry);
  }

  public async installFromPristine(
    applicationId: ApplicationId,
  ): Promise<InstalledApplicationRecord> {
    const candidateFilenames = [
      `${applicationId}.sevyn`,
      `${applicationId}.sevynapp`,
      `org.sevynos.${applicationId}.sevyn`,
      `${applicationId.replace("org.sevynos.", "")}.sevyn`,
    ];

    let pristineBundlePath: string | undefined;
    for (const filename of candidateFilenames) {
      const candidatePath = join(this.#pristineDirectory, filename);
      try {
        await stat(candidatePath);
        pristineBundlePath = candidatePath;
        break;
      } catch {
        // Not found, check next
      }
    }

    if (!pristineBundlePath) {
      // Check built-in fallback pristine bundles
      const fallbackBundle = createFallbackPristineBundle(applicationId);
      if (fallbackBundle) {
        return this.install(fallbackBundle, { source: "pristine" });
      }

      throw new Error(
        `Pristine stock bundle for application "${applicationId}" not found at ${this.#pristineDirectory}.`,
      );
    }

    return this.install(pristineBundlePath, { source: "pristine" });
  }

  async #readRegistry(): Promise<Record<string, InstalledApplicationRecord>> {
    const registryPath = join(this.#appsDirectory, "registry.json");
    try {
      const raw = await readFile(registryPath, "utf8");
      return JSON.parse(raw) as Record<string, InstalledApplicationRecord>;
    } catch {
      return {};
    }
  }

  async #writeRegistry(data: Record<string, InstalledApplicationRecord>): Promise<void> {
    await mkdir(this.#appsDirectory, { recursive: true });
    const registryPath = join(this.#appsDirectory, "registry.json");
    await writeFile(registryPath, JSON.stringify(data, null, 2), "utf8");
  }
}

function createFallbackPristineBundle(appId: ApplicationId): Uint8Array | undefined {
  const shortId = appId.replace("org.sevynos.", "");
  const stockAppCatalog: Record<
    string,
    {
      name: string;
      permissions: string[];
      system: boolean;
      signature?: string;
    }
  > = {
    notes: {
      name: "Notes",
      permissions: ["filesystem.read", "filesystem.write"],
      system: false,
    },
    browser: {
      name: "Browser",
      permissions: ["network"],
      system: false,
    },
    files: {
      name: "Files",
      permissions: ["filesystem.read", "filesystem.write"],
      system: false,
    },
    settings: {
      name: "Settings",
      permissions: [],
      system: false,
    },
    "system-monitor": {
      name: "System Monitor",
      permissions: [],
      system: false,
    },
    welcome: {
      name: "Welcome",
      permissions: [],
      system: false,
    },
    terminal: {
      name: "Terminal",
      permissions: ["native-modules"],
      system: true,
      signature: `${SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX}official-terminal-release`,
    },
    shell: {
      name: "Shell",
      permissions: ["native-modules"],
      system: true,
      signature: `${SEVYN_OFFICIAL_RELEASE_SIGNATURE_PREFIX}official-shell-release`,
    },
  };

  const matched = stockAppCatalog[shortId] ?? stockAppCatalog[appId];
  if (!matched) return undefined;

  const fullId = appId.startsWith("org.sevynos.") ? appId : `org.sevynos.${shortId}`;
  const manifest: ApplicationManifest = {
    manifestVersion: 2,
    id: fullId,
    name: matched.name,
    version: "1.0.0",
    hostId: "sevyn.host.javascript",
    entrypoint: "index.js",
    permissions: matched.permissions,
    system: matched.system,
    signature: matched.signature,
  };

  return createSevynBundle({
    manifest,
    bytecode: new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
    assets: {
      "icon.svg": `<svg><text>${matched.name}</text></svg>`,
    },
    extraFiles: {
      "index.js": `// ${matched.name} fallback entrypoint`,
    },
  });
}
