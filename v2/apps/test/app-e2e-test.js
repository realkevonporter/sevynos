"use strict";
// End-to-end Node test for the built app bundle (dist/app.js) and the
// crash bundle (dist/crash.js). Loads the app bundle with the mock
// Sevyn host as two different apps — files (status.read granted) and
// notes (no permission) — and drives the close X. The crash bundle
// must throw during evaluation.
//
// Run: node test/app-e2e-test.js   (from v2/apps, after npm run build)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Sevyn = require("../../rn/renderer/test/mock-sevyn");
const renderer = require("../../rn/renderer/sevyn-renderer");
global.Sevyn = Sevyn;
// Hermes has no setTimeout-driven microtask queue issues here; the
// bundle only needs the globals the host provides.
global.queueMicrotask = global.queueMicrotask || ((fn) => Promise.resolve().then(fn));

const appBundle = fs.readFileSync(path.join(__dirname, "..", "dist", "app.js"), "utf8");
const crashBundle = fs.readFileSync(
  path.join(__dirname, "..", "dist", "crash.js"),
  "utf8",
);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

function textsOf(present) {
  return present.ops.filter((o) => o.type === "text").map((o) => o.text);
}

// Load the app bundle as one app identity (host-provided globals).
function loadAs(app) {
  renderer.unmount();
  Sevyn._reset();
  Sevyn.appId = app.id;
  Sevyn.appName = app.name;
  Sevyn.appColor = app.color;
  Sevyn.appGlyph = app.glyph;
  Sevyn.hasPermission = (name) => app.permissions.includes(name);
  vm.runInThisContext(appBundle, { filename: "app.js" });
  return Sevyn._presents[Sevyn._presents.length - 1];
}

check("files (status.read): name, glyph, live status line", () => {
  const last = loadAs({
    id: "files",
    name: "Files",
    color: "#3b82f6",
    glyph: "F",
    permissions: ["status.read"],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Files"), "app name shown");
  assert.ok(texts.includes("F"), "glyph shown");
  assert.ok(
    texts.some((t) => t.includes("87%")),
    "live battery in status line",
  );
  assert.ok(
    texts.some((t) => t.includes("Wi-Fi")),
    "live wifi in status line",
  );
  const header = last.ops.find(
    (o) => o.type === "rect" && o.color === "#3b82f6" && o.h === 44,
  );
  assert.ok(header, "header uses the app colour");
});

check("notes (no permission): status line says not permitted", () => {
  const last = loadAs({
    id: "notes",
    name: "Notes",
    color: "#eab308",
    glyph: "N",
    permissions: [],
  });
  const texts = textsOf(last);
  assert.ok(texts.includes("Notes"), "app name shown");
  assert.ok(
    texts.some((t) => t.includes("not permitted")),
    "status line says not permitted",
  );
  assert.ok(
    !texts.some((t) => t.includes("87%")),
    "no live status leaks without the permission",
  );
});

check("close X calls Sevyn.closeApp()", () => {
  const last = loadAs({
    id: "files",
    name: "Files",
    color: "#3b82f6",
    glyph: "F",
    permissions: ["status.read"],
  });
  // The X is the only pressable in the app window (28x28).
  const pressables = last.ops.filter(
    (o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect",
  );
  assert.equal(pressables.length, 1, "one pressable (the X)");
  const x = pressables[0];
  assert.equal(x.w, 28, "X button is 28 wide");
  Sevyn._handlers.pointer({
    type: "button",
    x: x.x + 2,
    y: x.y + 2,
    button: 1,
    pressed: true,
    nodeId: x.nodeId,
  });
  assert.ok(
    Sevyn._logs.includes("CLOSEAPP"),
    "closeApp called, logs=" + JSON.stringify(Sevyn._logs),
  );
});

check("crash bundle throws during evaluation", () => {
  assert.throws(
    () => vm.runInThisContext(crashBundle, { filename: "crash.js" }),
    /intentional startup failure/,
  );
});

console.log(`\n${passed} app e2e checks passed`);
