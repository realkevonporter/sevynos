import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type { StructuredValue } from "@sevynos/react-native/internal";

export interface LinuxBinaryNativeModuleManifest {
  readonly name: string;
  readonly version: string;
  readonly binary: string;
  readonly permissions: readonly string[];
}

export interface LinuxBinaryNativeModule {
  readonly name: string;
  readonly version: string;
  invoke(
    method: string,
    argumentsValue: StructuredValue,
  ): Promise<StructuredValue> | StructuredValue;
}

const require = createRequire(import.meta.url);

export class LinuxBinaryNativeModuleLoader {
  readonly #root: string;
  readonly #allowedPermissions: ReadonlySet<string>;

  public constructor(
    root = "/opt/sevynos/native-modules",
    allowedPermissions: readonly string[] = [],
  ) {
    this.#root = resolve(root);
    this.#allowedPermissions = new Set(allowedPermissions);
  }

  public async load(manifestPath: string): Promise<LinuxBinaryNativeModule> {
    const manifestFile = await this.#contained(manifestPath);
    const manifest = validateManifest(JSON.parse(await readFile(manifestFile, "utf8")));
    for (const permission of manifest.permissions)
      if (!this.#allowedPermissions.has(permission))
        throw new Error(`Native module ${manifest.name} lacks permission ${permission}.`);
    const binary = await this.#contained(resolve(dirname(manifestFile), manifest.binary));
    if (extname(binary) !== ".node")
      throw new Error("Native modules must use the Node-API .node ABI.");
    const loaded = require(binary) as { sevynNativeModule?: unknown };
    return validateModule(loaded.sevynNativeModule, manifest);
  }

  async #contained(path: string): Promise<string> {
    const canonical = await realpath(
      isAbsolute(path) ? resolve(path) : resolve(this.#root, path),
    );
    if (canonical !== this.#root && !canonical.startsWith(`${this.#root}${sep}`))
      throw new Error("Native module path escapes the configured module root.");
    return canonical;
  }
}

function validateManifest(value: unknown): LinuxBinaryNativeModuleManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Native module manifest is malformed.");
  const record = value as Record<string, unknown>;
  if (
    typeof record["name"] !== "string" ||
    typeof record["version"] !== "string" ||
    typeof record["binary"] !== "string" ||
    !Array.isArray(record["permissions"]) ||
    !record["permissions"].every((item) => typeof item === "string")
  )
    throw new Error("Native module manifest is malformed.");
  return {
    name: record["name"],
    version: record["version"],
    binary: record["binary"],
    permissions: record["permissions"],
  };
}

function validateModule(
  value: unknown,
  manifest: LinuxBinaryNativeModuleManifest,
): LinuxBinaryNativeModule {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Native module ${manifest.name} did not export sevynNativeModule.`);
  const module = value as LinuxBinaryNativeModule;
  if (
    module.name !== manifest.name ||
    module.version !== manifest.version ||
    typeof module.invoke !== "function"
  )
    throw new Error(`Native module ${manifest.name} does not match its manifest.`);
  return module;
}
