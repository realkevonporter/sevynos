import { build } from "esbuild";
import { resolve } from "node:path";

const hostRoot = resolve(import.meta.dirname, "..");
const production = process.argv.includes("--production");

const nodeShimsPlugin = {
  name: "node-browser-shims",
  setup(buildInstance) {
    buildInstance.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: "node-shim",
    }));
    buildInstance.onLoad({ filter: /.*/, namespace: "node-shim" }, () => ({
      contents: `
export const mkdir = async () => {};
export const readFile = async () => new Uint8Array();
export const writeFile = async () => {};
export const rm = async () => {};
export const stat = async () => ({ isDirectory: () => false, isFile: () => false, size: 0 });
export const homedir = () => "/";
export const join = (...parts) => parts.filter(Boolean).join("/").replace(/\\/+/g, "/");
export const deflateRawSync = (data) => data;
export const inflateRawSync = (data) => data;
// @sevynos/accounts (user accounts + scrypt password hashing). The browser
// renderer bundle never performs real account I/O (the fs shims above are
// no-ops), so these fail closed if they are ever reached there; the real
// Linux host bundles with platform=node and uses the real builtins.
export const chmod = async () => {};
export const randomBytes = () => { throw new Error("node:crypto is unavailable in this bundle"); };
export const scrypt = (password, salt, keylen, options, callback) => { callback(new Error("node:crypto is unavailable in this bundle")); };
export const timingSafeEqual = () => { throw new Error("node:crypto is unavailable in this bundle"); };
export default {};
`,
      loader: "js",
    }));
  },
};

// 1. Bundle Renderer
await build({
  entryPoints: [resolve(hostRoot, "src/renderer.ts")],
  outfile: resolve(hostRoot, "dist/renderer.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: production ? false : "linked",
  minify: production,
  define: production ? { __GENESIS_PRODUCTION__: "true" } : {},
  plugins: [nodeShimsPlugin],
  logLevel: "info",
});

// 2. Bundle Third-Party Application Worker
await build({
  entryPoints: [resolve(hostRoot, "src/third-party-application-worker.ts")],
  outfile: resolve(hostRoot, "dist/application-worker.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  sourcemap: production ? false : "linked",
  minify: production,
  plugins: [nodeShimsPlugin],
  logLevel: "info",
});
