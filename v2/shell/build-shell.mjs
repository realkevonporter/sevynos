// SevynOS v2 M2 — shell bundle build.
// esbuild bundles src/main.tsx (+ renderer + react) into one IIFE file
// the host evaluates in Hermes. hermesc then compiles it to shell.hbc.
//
// Usage: node build-shell.mjs [--hermesc <path>] [--out <dir>]
//   --hermesc: path to hermesc (from the Hermes build in build-deps.sh).
//              Without it, only shell.js is produced (hermesc runs in CI).
//   --out: output dir (default: dist).

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const outDir = getArg("--out", join(root, "dist"));
const hermesc = getArg("--hermesc", "");

mkdirSync(outDir, { recursive: true });
const jsOut = join(outDir, "shell.js");

await build({
  entryPoints: [join(root, "src/main.tsx")],
  bundle: true,
  // Single React copy: the renderer (../../rn/renderer) requires
  // react-reconciler, which requires react. Both must resolve to this
  // shell's node_modules — the renderer's own tree has a node_modules too
  // (its own tests run from it), and a natural walk-up from the renderer
  // files would find THAT copy first, giving the bundle two Reacts and
  // "Invalid hook call" at runtime. nodePaths alone does not fix that
  // (it only adds a lookup path); the alias forces one copy.
  alias: {
    react: join(root, "node_modules/react"),
    "react-reconciler": join(root, "node_modules/react-reconciler"),
  },
  nodePaths: [join(root, "node_modules")],
  format: "iife",
  platform: "neutral",
  target: "es2019",
  jsx: "automatic",
  outfile: jsOut,
  logLevel: "info",
});

console.log("wrote " + jsOut);

if (hermesc) {
  if (!existsSync(hermesc)) {
    console.error("hermesc not found: " + hermesc);
    process.exit(1);
  }
  const hbcOut = join(outDir, "shell.hbc");
  execFileSync(hermesc, ["-emit-binary", "-out", hbcOut, jsOut], { stdio: "inherit" });
  console.log("wrote " + hbcOut);
} else {
  console.log("no --hermesc given; shell.hbc is built in CI (see build-deps.sh)");
}
