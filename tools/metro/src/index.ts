export * from "./config.js";
import { getSevynMetroConfig } from "./config.js";
import { realpath } from "node:fs/promises";

export interface MetroBundleOptions {
  readonly entryFile: string;
  readonly out: string;
  readonly dev?: boolean;
  readonly platform?: string;
  readonly projectRoot?: string;
}

export async function bundleWithMetro(
  options: MetroBundleOptions,
): Promise<{ readonly outputFilePath: string }> {
  const Metro = (await import("metro")).default;
  const { getSevynMetroConfig } = await import("./config.js");
  const projectRoot = await realpath(options.projectRoot ?? process.cwd());
  const config = await getSevynMetroConfig(projectRoot);
  const outputFilePath = options.out.replace(/(\.js)?$/, ".js");

  await Metro.runBuild(config as any, {
    entry: options.entryFile,
    out: options.out,
    dev: options.dev ?? false,
    platform: options.platform ?? "sevynos",
    minify: !options.dev,
    sourceMap: options.dev ?? false,
  });

  return { outputFilePath };
}

export interface MetroServerOptions {
  readonly port?: number;
  readonly projectRoot?: string;
}

export async function startMetroServer(options: MetroServerOptions = {}): Promise<void> {
  const Metro = (await import("metro")).default;
  const projectRoot = await realpath(options.projectRoot ?? process.cwd());
  const port = options.port ?? 8081;
  const config = await getSevynMetroConfig(projectRoot, { port });
  console.log(`⚡ Starting SevynOS Metro Bundler on port ${port}...`);
  await Metro.runServer(config as any, {
    waitForBundler: true,
  });
  console.log(`✓ Metro Bundler ready at http://localhost:${port}`);
}
