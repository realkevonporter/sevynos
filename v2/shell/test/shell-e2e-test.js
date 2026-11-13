"use strict";
// End-to-end Node test for the built shell bundle (dist/shell.js).
// Loads the bundle with the mock Sevyn host and drives it like the real
// host would: mount -> present, pointer click on a dock tile -> LAUNCH
// + "Starting …" state, status push -> tray re-render, pointer move
// over the dock -> no magnification (tiles stay flat).
//
// The mock's app list is extended to 14 apps (the 12 stock apps plus
// the two M10 call apps under their working titles) so the dock's
// shrink-to-fit is exercised at the 1024px mock surface: 14 tiles at
// 61px, not 64px.
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

// 14 apps: the mock's 12 stock apps + the M10 call apps (working
// titles; main has 12 today, 14 once M10 lands).
const realListApps = Sevyn.listApps;
Sevyn.listApps = () => [
  ...realListApps(),
  {
    id: "video-calls",
    name: "Video Calls",
    version: "1.0.0",
    color: "#7c3aed",
    glyph: "V",
    system: false,
    protected: false,
    permissions: ["status.read"],
  },
  {
    id: "voice-calls",
    name: "Voice Calls",
    version: "1.0.0",
    color: "#0d9488",
    glyph: "V",
    system: false,
    protected: false,
    permissions: ["status.read"],
  },
];

const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "shell.js"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log("ok - " + name);
}

const lastPresent = () => Sevyn._presents[Sevyn._presents.length - 1];
// Tile pressables, left to right. The tray power button (#100) is also a
// rect with a nodeId, but it lives in the top tray (y < 48); the dock
// tiles are below it, so the y filter keeps it out of the count.
const tiles = (ops) =>
  ops
    .filter((o) => o.nodeId != null && o.nodeId >= 0 && o.type === "rect" && o.y >= 48)
    .sort((a, b) => a.x - b.x);
// Running dots are the white 6x6 rects; every tile also carries a
// transparent 6x6 spacer so columns stay aligned.
const runningDots = (ops) =>
  ops.filter((o) => o.type === "rect" && o.w === 6 && o.h === 6 && o.color === "#ffffff");

vm.runInThisContext(bundle, { filename: "shell.js" });

check("shell mounts and presents the full frame", () => {
  assert.ok(Sevyn._presents.length >= 1, "at least one present");
  const last = lastPresent();
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
  // Tray symbols: wifi + battery + volume drawn next to the labels.
  const images = last.ops.filter((o) => o.type === "image").map((o) => o.asset);
  assert.ok(
    images.some((a) => a.endsWith("symbols/wifi.png")),
    "wifi symbol in tray",
  );
  assert.ok(
    images.some((a) => a.endsWith("symbols/battery.png")),
    "battery symbol in tray",
  );
  assert.ok(
    images.some((a) => a.endsWith("symbols/volume.png")),
    "volume symbol in tray",
  );
});

check("dock shows 14 tiles, no chevrons, as a centered glass pill", () => {
  const last = lastPresent();
  const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(!texts.includes("‹"), "no left chevron");
  assert.ok(!texts.includes("›"), "no right chevron");
  // 14 app glyphs: F > B S M P C N = O M S V V — count tiles by their
  // pressable rects instead (the two Ms, two Ss and two Vs collide).
  const hits = tiles(last.ops);
  assert.equal(hits.length, 14, "14 pressable rects, got " + hits.length);
  // Shrink-to-fit at 1024px: 14 tiles at 61px.
  assert.ok(
    hits.every((t) => t.w === 61 && t.h === 61),
    "all tiles 61x61, got " + JSON.stringify(hits.map((t) => [t.w, t.h])),
  );
  // Centered pill, not a full-width bar: 974px pill (976px ring) at
  // x25, so the first tile starts at x33 and the last tile ends at
  // x991.
  assert.equal(hits[0].x, 33, "first tile x=33, got " + hits[0].x);
  assert.equal(
    hits[13].x + hits[13].w,
    991,
    "last tile right=991, got " + (hits[13].x + hits[13].w),
  );
  // Glass: the pill fill is present.
  assert.ok(
    last.ops.some((o) => o.type === "rect" && o.color === "#ffffff1f"),
    "glass pill fill present",
  );
  // Icon contract: one image op per tile, stacked over the monogram.
  // The tray symbols live under icons/symbols/ and are image ops too,
  // so count only the tile icons (direct children of the icons dir).
  const images = last.ops
    .filter((o) => o.type === "image")
    .filter(
      (im) =>
        typeof im.asset === "string" &&
        im.asset.startsWith("/usr/share/sevyn/shell/icons/") &&
        !im.asset.includes("/symbols/"),
    );
  assert.equal(images.length, 14, "14 icon images, got " + images.length);
  assert.ok(
    images.every((im) => im.asset.endsWith(".png")),
    "icon paths under /usr/share/sevyn/shell/icons/",
  );
});

check("clicking a dock tile logs LAUNCH and shows Starting…", () => {
  const last = lastPresent();
  // The first tile is Files (glyph F): the leftmost tile rect.
  const filesTile = tiles(last.ops)[0];
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
  const after = lastPresent();
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
    let after = lastPresent();
    let texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(texts.includes("Welcome to SevynOS"), "welcome returns after LAUNCHED");
    assert.ok(
      !texts.some((t) => t.includes("Starting Files")),
      "Starting… cleared after LAUNCHED",
    );
    assert.equal(runningDots(after.ops).length, 1, "one running dot");
    Sevyn._handlers.appEvent("EVENT STOPPED files signal 15");
    after = lastPresent();
    assert.equal(runningDots(after.ops).length, 0, "dot gone after STOPPED");
  },
);

check("status push re-renders the tray", () => {
  Sevyn._status.battery = "42";
  Sevyn._status.volume = "10";
  Sevyn._handlers.status({ key: "battery", value: "42" });
  const last = lastPresent();
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

(async () => {
  // Let the microtask queue flush before driving the pointer.
  await new Promise((r) => setTimeout(r, 0));

  await checkAsync("pointer move over a tile does not magnify it", () => {
    // Hover point from the dock's assumed geometry (1024x768, 14
    // apps, 61px tiles: 974px pill at x25, tile 3 centre
    // (270.5, 715.5)). The mock lays out x correctly (centered pill)
    // but stacks the dock below the surface vertically — its flex
    // distribution ignores auto-height siblings — so the hover point
    // cannot come from the tile rects; sizes, not positions, are what
    // this test proves. Placement is proven in QEMU (m9-check).
    // The real Wayland host forwards motion as type "motion"
    // (wayland.cc onPointerMotion); the headless driver uses "move".
    // This hover uses type "enter" — the real first-contact path:
    // the pointer's first arrival on the surface is a wl_pointer
    // enter, not a motion event. The move-away below uses "move" so
    // both host vocabularies are covered too.
    Sevyn._handlers.pointer({ type: "enter", x: 270.5, y: 715.5 });
    const after = lastPresent();
    const afterTiles = tiles(after.ops);
    // No magnification: every tile stays 61px under the pointer.
    assert.ok(
      afterTiles.every((t) => t.h === 61),
      "all tiles stay 61px, got " + JSON.stringify(afterTiles.map((t) => t.h)),
    );
  });

  await checkAsync("pointer move away leaves every tile flat", () => {
    Sevyn._handlers.pointer({ type: "move", x: 512, y: 100 });
    const after = lastPresent();
    const afterTiles = tiles(after.ops);
    assert.ok(
      afterTiles.every((t) => t.h === 61),
      "all tiles stay 61px",
    );
  });

  console.log(`\n${passed} shell e2e checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
