"use strict";
// Pin test for the design tokens (polish surface (a)).
// Run: node test/tokens-test.js (from v2/rn/renderer, or via npm test).
//
// Every value in ./tokens.js must equal the same value in
// layout-manifest/tokens.json — the manifest is the authority, this
// file is the runnable source, and the two must never drift. Only
// the manifest's `meta` section is skipped: it describes the JSON
// file itself (name, date, base commit), not design values.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const { tokens } = require("../tokens");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

const manifestPath = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "layout-manifest",
  "tokens.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

check("tokens.js exports a frozen tokens object", () => {
  assert.equal(typeof tokens, "object");
  assert.ok(tokens !== null);
  assert.ok(Object.isFrozen(tokens), "tokens is frozen");
  assert.ok(Object.isFrozen(tokens.menu), "sections are frozen");
  assert.ok(Object.isFrozen(tokens.spacing.scale), "arrays are frozen");
});

check("every manifest section except meta matches tokens.js", () => {
  const sections = Object.keys(manifest).filter((s) => s !== "meta");
  assert.deepEqual(Object.keys(tokens).sort(), sections.sort());
  for (const section of sections) {
    assert.deepEqual(
      tokens[section],
      manifest[section],
      "tokens." + section + " matches layout-manifest/tokens.json",
    );
  }
});

check("spot values read back through the token paths", () => {
  assert.equal(tokens.menu.width, 220);
  assert.equal(tokens.menu.rowHeight, 28);
  assert.equal(tokens.color.dark.surface, "#1F2937");
  assert.equal(tokens.color.dark.textPrimary, "#FAFAFA");
  assert.equal(tokens.type.body.size, 14);
  assert.equal(tokens.radii.window, 10);
  assert.equal(tokens.topbar.height, 32);
  assert.equal(tokens.accent.default, "violet");
});

console.log("\n" + passed + " tokens checks passed");
