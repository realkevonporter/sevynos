"use strict";
// End-to-end Node test for the built shell bundle (dist/shell.js).
// Loads the bundle with the mock Sevyn host and drives it like the real
// host would: mount -> present, pointer click on a dock tile -> LAUNCH
// + "Starting …" state, status push -> tray re-render, chevron -> scroll.
//
// Run: node test/shell-e2e-test.js   (from v2/shell, after npm run build)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.Sevyn = require("../../rn/renderer/test/mock-sevyn");
// Hermes has no setTimeout-driven microtask queue issues here; the
// bundle only needs the globals the host provides.
global.queueMicrotask = global.queueMicrotask || ((fn) => Promise.resolve().then(fn));

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "shell.js"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

vm.runInThisContext(bundle, { filename: "shell.js" });

check("shell mounts and presents the full frame", () => {
  assert.ok(Sevyn._presents.length >= 1, "at least one present");
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(texts.includes("SevynOS"), "wordmark");
  assert.ok(texts.includes("Welcome to SevynOS"), "welcome");
  assert.ok(
    texts.some((t) => t.includes("87%")),
    "battery in tray",
  );
  assert.ok(
    texts.some((t) => t.includes("Wi-Fi")),
    "wifi in tray",
  );
});

check("dock shows 12 tiles and both chevrons (overflow by design)", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(texts.includes("‹"), "left chevron");
  assert.ok(texts.includes("›"), "right chevron");
  // 12 app glyphs: F > B S M P C N = O M S (two Ms, two Ss — count tiles
  // by their pressable rects instead).
  const hits = last.ops.filter((o) => o.nodeId != null && o.nodeId >= 0);
  // 12 tiles + 2 chevrons + 1 tray power button = 15 pressables.
  assert.equal(hits.length, 15, "15 pressable rects, got " + hits.length);
});

check("tray power button opens the menu; Shut Down runs sevyn poweroff", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  // The tray power button is the only pressable in the top tray band.
  const power = last.ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect" && o.y < 48)
    .sort((a, b) => b.x - a.x)[0];
  assert.ok(power, "power button rect present");
  Sevyn._handlers.pointer({
    type: "button",
    x: power.x + 2,
    y: power.y + 2,
    button: 1,
    pressed: true,
    nodeId: power.nodeId,
  });
  const menu = Sevyn._presents[Sevyn._presents.length - 1];
  const menuTexts = menu.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(menuTexts.includes("Shut Down"), "menu shows Shut Down");
  assert.ok(menuTexts.includes("Restart"), "menu shows Restart");
  // The Shut Down row is the upper of the two menu-row pressables
  // (panel top 48: rows 52..96 and 96..140; the full-screen backdrop
  // sits at y 0 and is excluded by the y filter).
  const rows = menu.ops
    .filter(
      (o) =>
        o.nodeId != null && o.nodeId >= 0 && o.type === "rect" && o.y >= 48 && o.y < 140,
    )
    .sort((a, b) => a.y - b.y);
  assert.ok(rows.length >= 1, "menu rows present, got " + rows.length);
  Sevyn._handlers.pointer({
    type: "button",
    x: rows[0].x + 2,
    y: rows[0].y + 2,
    button: 1,
    pressed: true,
    nodeId: rows[0].nodeId,
  });
  assert.ok(
    Sevyn._logs.some((l) => l === "EXEC sevyn poweroff"),
    "poweroff requested, logs=" + JSON.stringify(Sevyn._logs),
  );
  const after = Sevyn._presents[Sevyn._presents.length - 1];
  const afterTexts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(!afterTexts.includes("Shut Down"), "menu closed after Shut Down");
});

check("clicking a dock tile logs LAUNCH and shows Starting…", () => {
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  // The first tile is Files (glyph F). Find its pressable rect: the
  // leftmost tile rect (x just past the left chevron).
  const tiles = last.ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect")
    .sort((a, b) => a.x - b.x);
  const filesTile = tiles[1]; // [0] is the left chevron
  Sevyn._handlers.pointer({
    type: "button",
    x: filesTile.x + 2,
    y: filesTile.y + 2,
    button: 1,
    pressed: true,
    nodeId: filesTile.nodeId,
  });
  assert.ok(
    Sevyn._logs.some((l) => l === "LAUNCH files"),
    "LAUNCH files logged, logs=" + JSON.stringify(Sevyn._logs),
  );
  const after = Sevyn._presents[Sevyn._presents.length - 1];
  const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(
    texts.some((t) => t.includes("Starting Files")),
    "Starting… state shown",
  );
});

check(
  "app events: LAUNCHED clears Starting… and shows a running dot; STOPPED clears the dot",
  () => {
    assert.ok(Sevyn._handlers.appEvent, "appEvent handler registered");
    Sevyn._handlers.appEvent("EVENT LAUNCHED files");
    let after = Sevyn._presents[Sevyn._presents.length - 1];
    let texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(texts.includes("Welcome to SevynOS"), "welcome returns after LAUNCHED");
    assert.ok(
      !texts.some((t) => t.includes("Starting Files")),
      "Starting… cleared after LAUNCHED",
    );
    const dots = after.ops.filter((o) => o.type === "rect" && o.w === 6 && o.h === 6);
    assert.equal(dots.length, 1, "one running dot, got " + dots.length);
    Sevyn._handlers.appEvent("EVENT STOPPED files signal 15");
    after = Sevyn._presents[Sevyn._presents.length - 1];
    const dotsAfter = after.ops.filter(
      (o) => o.type === "rect" && o.w === 6 && o.h === 6,
    );
    assert.equal(dotsAfter.length, 0, "dot gone after STOPPED");
  },
);

check("status push re-renders the tray", () => {
  Sevyn._status.battery = "42";
  Sevyn._status.volume = "10";
  Sevyn._handlers.status({ key: "battery", value: "42" });
  const last = Sevyn._presents[Sevyn._presents.length - 1];
  const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(
    texts.some((t) => t.includes("42%")),
    "tray shows new battery",
  );
  assert.ok(
    texts.some((t) => t.includes("Vol 10")),
    "tray shows new volume",
  );
});

check("right chevron scrolls the tray (scroll offset changes)", () => {
  const before = Sevyn._presents[Sevyn._presents.length - 1];
  // The right chevron is the 28px-wide pressable on the right — NOT
  // the rightmost pressable overall: scrolled-off tiles extend past
  // it (that is the point of the dock overflowing).
  const chevron = before.ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect" && o.w === 28)
    .sort((a, b) => b.x - a.x)[0]; // rightmost chevron
  Sevyn._handlers.pointer({
    type: "button",
    x: chevron.x + 2,
    y: chevron.y + 2,
    button: 1,
    pressed: true,
    nodeId: chevron.nodeId,
  });
  const after = Sevyn._presents[Sevyn._presents.length - 1];
  // After scrolling, the first tile's x must have moved left (clipped).
  const firstTileBefore = before.ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0)
    .sort((a, b) => a.x - b.x)[1];
  const firstTileAfter = after.ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0)
    .sort((a, b) => a.x - b.x)[1];
  assert.ok(
    firstTileAfter.x < firstTileBefore.x,
    "first tile moved left after scroll: " +
      firstTileBefore.x +
      " -> " +
      firstTileAfter.x,
  );
});

console.log(`\n${passed} shell e2e checks passed`);
