"use strict";
// End-to-end Node test for the built shell bundle (dist/shell.js).
// Loads the bundle with the mock Sevyn host and drives it like the real
// host would: mount -> present, pointer click on a dock tile -> LAUNCH
// + "Starting …" state, status push -> tray re-render, pointer move
// over the dock -> no magnification (tiles stay flat). The wallpaper
// (default variant) and the desktop icons (/data/Desktop, canned)
// are asserted from the same mount.
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

// The shell reads its wallpaper + desktop icons through Sevyn.exec
// on render: canned answers so the wallpaper and desktop checks
// below drive the real paths (default style/color + two desktop
// entries). Installed before the bundle runs: the shell execs
// during mount.
Sevyn._execHandler = (cmd) => {
  if (cmd === "sevyn settings get wallpaperStyle") return "0\nwallpaperStyle=default\n";
  if (cmd === "sevyn settings get wallpaperColor") return "0\nwallpaperColor=#090b11\n";
  if (cmd === "sevyn files list /data/Desktop") return "0\nd Photos\nf Notes.txt\n";
  if (cmd.startsWith("sevyn files mkdir ")) return "0\ncreated\n";
  if (cmd.startsWith("sevyn files write ")) return "0\nwrote\n";
  return "0\n";
};

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
// Dock tiles are the only SQUARE pressables down here: the desktop
// "New folder" / "New text file" actions are 132x34 and the desktop
// icons are 104x92, so the square filter keeps them out too (and the
// 6x6 running dots are excluded by the size floor).
const tiles = (ops) =>
  ops
    .filter(
      (o) =>
        o.nodeId != null &&
        o.nodeId >= 0 &&
        o.type === "rect" &&
        o.y >= 48 &&
        o.w === o.h &&
        o.w > 10,
    )
    .sort((a, b) => a.x - b.x);
// Desktop icon pressables (104x92) and desktop action pressables
// (132x34), left to right.
const desktopItems = (ops) =>
  ops
    .filter(
      (o) =>
        o.nodeId != null &&
        o.nodeId >= 0 &&
        o.type === "rect" &&
        o.w === 104 &&
        o.h === 92,
    )
    .sort((a, b) => a.x - b.x);
const desktopActions = (ops) =>
  ops
    .filter(
      (o) =>
        o.nodeId != null &&
        o.nodeId >= 0 &&
        o.type === "rect" &&
        o.w === 132 &&
        o.h === 34,
    )
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

check("wallpaper: default variant paints the #06080F base + auras", () => {
  const last = lastPresent();
  const colors = last.ops.filter((o) => o.type === "rect").map((o) => o.color);
  assert.ok(colors.includes("#06080F"), "default base present");
  assert.ok(colors.includes("rgba(139, 156, 254, 0.20)"), "violet aura present");
  assert.ok(colors.includes("rgba(240, 208, 138, 0.16)"), "gold aura present");
  assert.ok(colors.includes("rgba(139, 156, 254, 0.08)"), "horizon band present");
  assert.ok(colors.includes("rgba(6, 8, 15, 0.35)"), "grain present");
  // The wallpaper reads its setting through exec on render.
  assert.ok(
    Sevyn._logs.some((l) => l === "EXEC sevyn settings get wallpaperStyle"),
    "wallpaper style read, logs=" + JSON.stringify(Sevyn._logs),
  );
  assert.ok(
    Sevyn._logs.some((l) => l === "EXEC sevyn settings get wallpaperColor"),
    "wallpaper color read",
  );
});

check("desktop icons: /data/Desktop entries render as tiles", () => {
  const last = lastPresent();
  const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(texts.includes("Photos"), "folder entry shown");
  assert.ok(texts.includes("Notes.txt"), "file entry shown");
  assert.ok(texts.includes("New folder"), "new-folder action shown");
  assert.ok(texts.includes("New text file"), "new-text-file action shown");
  const items = desktopItems(last.ops);
  assert.equal(items.length, 2, "2 desktop icons, got " + items.length);
  // Direction-C tile colors: folder amber, document blue.
  const tileColors = last.ops
    .filter((o) => o.type === "rect" && o.w === 48 && o.h === 48)
    .map((o) => o.color);
  assert.ok(tileColors.includes("#F5A623"), "folder tile amber");
  assert.ok(tileColors.includes("#3B82F6"), "document tile blue");
  assert.ok(
    Sevyn._logs.some((l) => l === "EXEC sevyn files list /data/Desktop"),
    "desktop listed, logs=" + JSON.stringify(Sevyn._logs),
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

check("desktop icons: tapping one launches Files", () => {
  const last = lastPresent();
  const items = desktopItems(last.ops);
  assert.equal(items.length, 2, "2 desktop icons");
  const before = Sevyn._logs.filter((l) => l === "LAUNCH files").length;
  // The previous check ended on STOPPED files, and the shell
  // deliberately shows no second "Starting…" flash for a relaunch
  // right after a STOPPED for the same id — move lastEvent off
  // files first so the tap's Starting… state is observable.
  Sevyn._handlers.appEvent("EVENT STOPPED terminal signal 15");
  const photos = items[0];
  Sevyn._handlers.pointer({
    type: "button",
    x: photos.x + 2,
    y: photos.y + 2,
    button: 1,
    pressed: true,
    nodeId: photos.nodeId,
  });
  assert.equal(
    Sevyn._logs.filter((l) => l === "LAUNCH files").length,
    before + 1,
    "one more LAUNCH files, logs=" + JSON.stringify(Sevyn._logs),
  );
  assert.ok(
    Sevyn._logs.some((l) => l === "DESKTOP open /data/Desktop/Photos"),
    "desktop open logged",
  );
  const after = lastPresent();
  const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
  assert.ok(
    texts.some((t) => t.includes("Starting Files")),
    "Starting… state shown",
  );
  // Clear the launch again so later checks start clean.
  Sevyn._handlers.appEvent("EVENT LAUNCHED files");
});

check("desktop icons: New folder runs sevyn files mkdir", () => {
  const last = lastPresent();
  const actions = desktopActions(last.ops);
  assert.equal(actions.length, 2, "2 desktop actions, got " + actions.length);
  const newFolder = actions[0];
  Sevyn._handlers.pointer({
    type: "button",
    x: newFolder.x + 2,
    y: newFolder.y + 2,
    button: 1,
    pressed: true,
    nodeId: newFolder.nodeId,
  });
  assert.ok(
    Sevyn._logs.some((l) => l === 'EXEC sevyn files mkdir "/data/Desktop/New folder"'),
    "mkdir run, logs=" + JSON.stringify(Sevyn._logs),
  );
  // The create re-renders (and re-lists) the desktop.
  assert.ok(
    Sevyn._logs.filter((l) => l === "EXEC sevyn files list /data/Desktop").length >= 2,
    "desktop re-listed after create",
  );
});

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
