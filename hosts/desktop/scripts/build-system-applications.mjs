import { build, context } from "esbuild";
import { resolve } from "node:path";

const hostRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(hostRoot, "../..");
const entryPoints = {
  "org.sevynos.shell.wallpaper": resolve(
    repositoryRoot,
    "applications/shell/wallpaper/index.ts",
  ),
  "org.sevynos.shell.dock": resolve(repositoryRoot, "applications/shell/dock/index.ts"),
  "org.sevynos.shell.status-bar": resolve(
    repositoryRoot,
    "applications/shell/status-bar/index.ts",
  ),
  "org.sevynos.shell.launcher": resolve(
    repositoryRoot,
    "applications/shell/launcher/index.ts",
  ),
};

function options(production) {
  return {
    entryPoints,
    outdir: resolve(hostRoot, "dist/system-applications"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    minify: production,
    sourcemap: production ? false : "linked",
    logLevel: "info",
    jsx: "automatic",
  };
}

export async function buildSystemApplications(production = false) {
  await build(options(production));
}

export async function watchSystemApplications() {
  const buildContext = await context(options(false));
  await buildContext.watch();
  return buildContext;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  await buildSystemApplications(process.argv.includes("--production"));
