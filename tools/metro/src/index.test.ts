import { afterEach, describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { bundleWithMetro, getSevynMetroConfig } from "./index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("@sevynos/metro bundler config", () => {
  it("generates Metro configuration targeting sevynos platform", async () => {
    const config = await getSevynMetroConfig(process.cwd());
    expect(config).toBeDefined();
    expect(config.resolver?.platforms).toContain("sevynos");
    expect(isAbsolute(config.resolver?.extraNodeModules?.["react-native"] ?? "")).toBe(
      true,
    );
    expect(
      isAbsolute(config.resolver?.extraNodeModules?.["expo-modules-core"] ?? ""),
    ).toBe(true);
    expect(config.server?.port).toBe(8081);
  });

  it("builds the sevynos implementation of a platform-specific module", async () => {
    const project = await mkdtemp(join(tmpdir(), "sevyn-metro-platform-"));
    temporaryDirectories.push(project);
    await writeFile(
      join(project, "index.js"),
      'import value from "./value"; console.log(value);',
    );
    await mkdir(join(project, "node_modules", "@babel"), { recursive: true });
    await symlink(
      await realpath(join(import.meta.dirname, "../node_modules/@babel/runtime")),
      join(project, "node_modules", "@babel", "runtime"),
    );
    await writeFile(
      join(project, "value.js"),
      'export default "generic-implementation";',
    );
    await writeFile(
      join(project, "value.sevynos.js"),
      'export default "sevynos-implementation";',
    );
    await writeFile(
      join(project, "babel.config.cjs"),
      `module.exports = { presets: [${JSON.stringify(
        createRequire(import.meta.url).resolve("@react-native/babel-preset"),
      )}] };`,
    );
    const output = join(project, "index.bundle");
    const result = await bundleWithMetro({
      projectRoot: project,
      entryFile: "index.js",
      out: output,
    });
    const bundle = await readFile(result.outputFilePath, "utf8");
    expect(bundle).toContain("sevynos-implementation");
    expect(bundle).not.toContain("generic-implementation");
  }, 20_000);
});
