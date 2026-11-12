// SevynOS v2 M3 — stock-app bundle build.
// esbuild bundles src/main.tsx (or src/crash-main.tsx) into one IIFE
// file the host evaluates in Hermes; hermesc then compiles it to
// bytecode. One template bundle serves every stock app — the app's
// identity comes from the host at runtime (Sevyn.appId/appName/
// appColor/appGlyph), so make-bundles.py packages the same app.hbc
// under twelve different manifests.
//
// Usage: node build-app.mjs [--entry app|crash|terminal|settings|files|browser|comms|installer]
//                            [--hermesc <path>] [--out <dir>]
//   --entry: app (default) builds src/main.tsx -> app.hbc;
//            crash builds src/crash-main.tsx -> crash.hbc;
//            terminal|settings|files|browser|comms|installer build
//            src/<entry>-main.tsx -> <entry>.hbc.
//   --hermesc: path to hermesc (from the Hermes build in build-deps.sh).
//              Without it, only the .js is produced (hermesc runs in CI).
//   --out: output dir (default: dist).

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
const entry = getArg("--entry", "app");
const ENTRIES = [
  "app",
  "crash",
  "terminal",
  "settings",
  "files",
  "browser",
  "comms",
  "installer",
];
if (!ENTRIES.includes(entry)) {
  console.error("--entry must be one of " + ENTRIES.join("|") + ", got " + entry);
  process.exit(1);
}
const mainFile =
  entry === "app"
    ? "main.tsx"
    : entry === "crash"
      ? "crash-main.tsx"
      : entry + "-main.tsx";
const base = entry === "app" ? "app" : entry;
const jsOut = join(outDir, base + ".js");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src", mainFile)],
  bundle: true,
  // Single React copy: the renderer (../../rn/renderer) requires
  // react-reconciler, which requires react. Both must resolve to this
  // package's node_modules — the renderer's own tree has a node_modules
  // too, and a natural walk-up would find THAT copy first, giving the
  // bundle two Reacts and "Invalid hook call" at runtime. (Same trap
  // as the shell build — see v2/shell/build-shell.mjs.)
  alias: {
    react: join(root, "node_modules/react"),
    "react-reconciler": join(root, "node_modules/react-reconciler"),
  },
  nodePaths: [join(root, "node_modules")],
  format: "iife",
  platform: "neutral",
  target: "es2019",
  jsx: "automatic",
  // The host runs the bundle in Hermes, where there is NO Node `process`
  // global. React's entry does `process.env.NODE_ENV === 'production'`
  // to pick its build — without this define esbuild leaves a bare
  // `process` reference in the output and the host fails the bundle.
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: jsOut,
  logLevel: "info",
});

console.log("wrote " + jsOut);

// Hermes-safe CJS interop (same rewrite as the shell build): esbuild's
// __copyProps defines each copied export as a GETTER closing over the
// loop variable; Hermes 0.13.0 shares that binding across iterations,
// so every getter reads the LAST export. Read the value EAGERLY as a
// data property instead. Fail loudly if esbuild ever changes the helper
// text, so this never silently stops applying.
{
  const src = readFileSync(jsOut, "utf8");
  const needle = "get: () => from[key]";
  const hits = src.split(needle).length - 1;
  // The app entry imports React (1 helper, as in the shell build).
  // The crash entry imports nothing, so it has no helper at all.
  // The terminal/settings/files entries import React too (1 helper).
  const expected = entry === "crash" ? 0 : 1;
  if (hits !== expected) {
    console.error(
      `expected exactly ${expected} __copyProps getter(s) in ${jsOut}, found ${hits} — ` +
        "esbuild helper changed; update the Hermes-safe rewrite",
    );
    process.exit(1);
  }
  if (hits === 1) {
    writeFileSync(jsOut, src.replace(needle, "value: from[key]"));
    console.log("rewrote __copyProps to eager data properties (Hermes-safe)");
  }
}

if (hermesc) {
  if (!existsSync(hermesc)) {
    console.error("hermesc not found: " + hermesc);
    process.exit(1);
  }
  const hbcOut = join(outDir, base + ".hbc");
  execFileSync(hermesc, ["-emit-binary", "-out", hbcOut, jsOut], { stdio: "inherit" });
  console.log("wrote " + hbcOut);
} else {
  console.log("no --hermesc given; app.hbc is built in CI (see build-deps.sh)");
}
