// M6 check: SKIPPED while Tokrah is out of the build.
//
// Tokrah is TEMPORARILY OUT of the build (Kevon, 2026-11-25 — to cut
// CI time while SevynOS and Tokrah move in parallel). M6's substance
// IS the Tokrah bring-up (Node harness gate + headless `sevyn tokrah
// run` live session + interactive dock launch), so with no Tokrah
// staged there is nothing left to prove — booting QEMU for it would
// only fail. This file exits 0 with a clear skip line instead.
//
// Re-inclusion (when Tokrah comes back): restore the full check from
// git history (this file's parent commit) and re-enable the
// v2-m6.yml workflow (deleted in the same PR). v2/tokrah/ stays in
// the tree, dormant, and the image scripts keep their "Tokrah
// staging lived here" markers.
//
// Usage: node v2/image/m6-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const started = Date.now();

const reason =
  "M6 skipped: Tokrah is temporarily out of the build (Kevon, 2026-11-25); " +
  "M6's substance is the Tokrah bring-up, so there is nothing to prove until it comes back.";
console.log(`M6 CHECK SKIPPED — ${reason}`);
try {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "m6-check.json"),
    JSON.stringify(
      {
        pass: true,
        skipped: true,
        reason,
        duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
        checks: [],
      },
      null,
      2,
    ),
  );
} catch {}
process.exit(0);
