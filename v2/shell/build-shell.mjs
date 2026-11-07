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
  // The host runs the bundle in Hermes, where there is NO Node `process`
  // global. React's entry does `process.env.NODE_ENV === 'production'`
  // to pick its build — without this define esbuild leaves a bare
  // `process` reference in the output and the host fails the bundle with
  // "Property 'process' doesn't exist" (verified in CI run 42334471009).
  // Inlining it also pins the production React build into the shell.
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: jsOut,
  logLevel: "info",
});

console.log("wrote " + jsOut);

// Hermes-safe CJS interop: esbuild's __copyProps defines each copied
// export as a GETTER closing over the loop variable (`get: () => from[key]`
// inside `for (let key of ...)`). Hermes 0.13.0 (via hermesc) shares that
// binding across iterations, so every getter reads the LAST export —
// React's `version` ("19.3.1") — and the shell dies at load with
// "'19.3.1' is not a function" at React.createElement (verified in CI
// run 42337894586, stack shell.js:10724, and reproduced locally by
// changing `let` to `var` in the same helper). Read the value EAGERLY
// as a data property instead: the CJS exports (React, jsx-runtime,
// react-reconciler) never mutate after load, so the getter adds nothing.
// Fail loudly if esbuild ever changes the helper text, so this never
// silently stops applying.
{
  const src = readFileSync(jsOut, "utf8");
  const needle = "get: () => from[key]";
  const hits = src.split(needle).length - 1;
  if (hits !== 1) {
    console.error(
      `expected exactly 1 __copyProps getter in ${jsOut}, found ${hits} — ` +
        "esbuild helper changed; update the Hermes-safe rewrite",
    );
    process.exit(1);
  }
  writeFileSync(jsOut, src.replace(needle, "value: from[key]"));
  console.log("rewrote __copyProps to eager data properties (Hermes-safe)");
}

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
