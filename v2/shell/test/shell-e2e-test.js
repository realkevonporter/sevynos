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
  // AI sidebar (phase 1): one-shot ask, canned counts reply.
  if (cmd.startsWith("sevyn ai ask "))
    return "0\nOK backend=muse-ai allowed=1 denied=0 failed=0\n";
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
// The AI button is a 56px square pressable (see AiButton.tsx) in the
// same bottom band as the dock tiles, so the tile filter excludes
// that size — otherwise the button counts as a 15th tile.
const AI_BUTTON_SIZE = 56;
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
        o.w > 10 &&
        o.w !== AI_BUTTON_SIZE,
    )
    .sort((a, b) => a.x - b.x);
// The AI button rect (the only 56x56 square pressable) and the
// sidebar panel rect (the only #111827 rect at its width).
const aiButtonRect = (ops) =>
  ops.find(
    (o) =>
      o.type === "rect" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      o.w === AI_BUTTON_SIZE &&
      o.h === AI_BUTTON_SIZE,
  );
const sidebarRect = (ops, width) =>
  ops.find((o) => o.type === "rect" && o.w === width && o.color === "#111827");
// A pressable rect containing the centre of a text op (the sidebar
// header buttons are text pressables — the test finds the text, then
// its pressable). Text ops carry x/y/w/h; the smallest containing
// nodeId rect is the pressable (panels and rows are Views, nodeId -1).
const pressableAtText = (ops, label) => {
  const t = ops.find((o) => o.type === "text" && o.text === label);
  assert.ok(t, "text " + label + " present");
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const hit = ops
    .filter(
      (o) =>
        o.type === "rect" &&
        o.nodeId != null &&
        o.nodeId >= 0 &&
        cx >= o.x &&
        cx < o.x + o.w &&
        cy >= o.y &&
        cy < o.y + o.h,
    )
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  assert.ok(hit, "pressable for " + label);
  return hit;
};
const tap = (rect) => {
  Sevyn._handlers.pointer({
    type: "button",
    x: rect.x + 2,
    y: rect.y + 2,
    button: 1,
    pressed: true,
    nodeId: rect.nodeId,
  });
};
// Let the microtask queue + state flush settle (the sidebar's ask
// resolves a Promise, then re-renders).
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
// Key helpers (evdev codes; the renderer's US keymap) — the subset
// for "list the installed apps", copied from app-e2e-test.js.
const KEY_FOR = {
  a: [30, false],
  d: [32, false],
  e: [18, false],
  h: [35, false],
  i: [23, false],
  l: [38, false],
  n: [49, false],
  p: [25, false],
  s: [31, false],
  t: [20, false],
  " ": [57, false],
};
function type(text) {
  for (const ch of text) {
    const [code, shift] = KEY_FOR[ch];
    Sevyn._handlers.key({ key: code, pressed: true, shift });
  }
}
function pressEnter() {
  Sevyn._handlers.key({ key: 28, pressed: true });
}
// Desktop icon pressables (104x92), left to right. The old desktop
// action pressables (132x34, "New folder" / "New text file") are
// gone — gap unit 11 moved them into the right-click menu — so
// desktopActions now only ever asserts their absence.
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

// Desktop right-click (gap unit 11, audit #14): drive a right-button
// press (0x111) at a presented rect, and read the menu back from the
// presented ops. The menu panel is the 220-wide #1f2937 rect; its
// item rows are the smallest hit rects under their labels (the
// full-surface click-away overlay is larger, so "smallest" picks the
// row, not the overlay).
// The desktop surface is the plain View behind the icons — its
// transparent hit rect spans the surface width (1024). The mock
// lays the main area out at height 0 (its flex quirk — see the
// hover check), so the rect is 1024x0 here; the renderer still
// dispatches by nodeId, which is what this test proves, and the
// real host lays the surface out full-height (proven on-device).
const desktopSurfaceRect = (ops) => {
  const rect = ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#00000000" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      o.w === 1024,
  );
  assert.ok(rect, "desktop surface hit rect found");
  return rect;
};
const rightClickRect = (rect, x, y) => {
  Sevyn._handlers.pointer({
    type: "button",
    x,
    y,
    button: 0x111,
    pressed: true,
    nodeId: rect.nodeId,
  });
};
const findMenuPanel = (ops) =>
  ops.find((o) => o.type === "rect" && o.color === "#1f2937" && o.w === 220);
const menuTexts = (ops) => {
  const panel = findMenuPanel(ops);
  assert.ok(panel, "menu panel presented");
  return ops
    .filter(
      (o) =>
        o.type === "text" &&
        o.x >= panel.x &&
        o.x < panel.x + panel.w &&
        o.y >= panel.y &&
        o.y < panel.y + panel.h,
    )
    .map((o) => o.text);
};
const smallestRectAt = (ops, x, y) => {
  let best = null;
  for (const o of ops) {
    if (o.type !== "rect" || o.nodeId == null || o.nodeId < 0) continue;
    if (x < o.x || x >= o.x + o.w || y < o.y || y >= o.y + o.h) continue;
    if (!best || o.w * o.h < best.w * best.h) best = o;
  }
  assert.ok(best, `hit rect at (${x},${y}) found`);
  return best;
};
const tapMenuItem = (label) => {
  const ops = lastPresent().ops;
  const panel = findMenuPanel(ops);
  assert.ok(panel, "menu panel presented");
  const text = ops.find(
    (o) =>
      o.type === "text" &&
      o.text === label &&
      o.x >= panel.x &&
      o.x < panel.x + panel.w &&
      o.y >= panel.y &&
      o.y < panel.y + panel.h,
  );
  assert.ok(text, `menu item ${JSON.stringify(label)} found`);
  const cx = text.x + text.w / 2;
  const cy = text.y + text.h / 2;
  tap(smallestRectAt(lastPresent().ops, cx, cy));
};

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
  // Gap unit 11: the always-visible "New folder" / "New text file"
  // buttons are gone — those actions live in the right-click menu
  // now, so neither label is on the surface with the menu closed.
  assert.ok(!texts.includes("New folder"), "no always-visible new-folder button");
  assert.ok(!texts.includes("New text file"), "no always-visible new-text-file button");
  assert.equal(desktopActions(last.ops).length, 0, "no 132x34 action buttons");
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

check("desktop right-click: empty space opens the menu; Esc dismisses", () => {
  const last = lastPresent();
  // (500, 300) is empty desktop: clear of the icons (top 22..114)
  // and of the dock band at the bottom.
  rightClickRect(desktopSurfaceRect(last.ops), 500, 300);
  const after = lastPresent();
  assert.deepEqual(
    menuTexts(after.ops),
    ["New folder", "New text file"],
    "menu offers the two moved create actions",
  );
  Sevyn._handlers.key({ key: 1, pressed: true }); // Esc
  assert.equal(findMenuPanel(lastPresent().ops), undefined, "menu dismissed by Esc");
});

check("desktop right-click: New folder in the menu runs sevyn files mkdir", () => {
  const last = lastPresent();
  rightClickRect(desktopSurfaceRect(last.ops), 500, 300);
  tapMenuItem("New folder");
  assert.ok(
    Sevyn._logs.some((l) => l === 'EXEC sevyn files mkdir "/data/Desktop/New folder"'),
    "mkdir run, logs=" + JSON.stringify(Sevyn._logs),
  );
  assert.equal(
    findMenuPanel(lastPresent().ops),
    undefined,
    "menu dismissed after selection",
  );
  // The create re-renders (and re-lists) the desktop.
  assert.ok(
    Sevyn._logs.filter((l) => l === "EXEC sevyn files list /data/Desktop").length >= 2,
    "desktop re-listed after create",
  );
});

check("desktop right-click: New text file in the menu runs sevyn files write", () => {
  const last = lastPresent();
  rightClickRect(desktopSurfaceRect(last.ops), 500, 300);
  tapMenuItem("New text file");
  assert.ok(
    Sevyn._logs.some(
      (l) => l === 'EXEC sevyn files write "/data/Desktop/New text file.txt" ""',
    ),
    "write run, logs=" + JSON.stringify(Sevyn._logs),
  );
  assert.equal(
    findMenuPanel(lastPresent().ops),
    undefined,
    "menu dismissed after selection",
  );
});

check(
  "desktop right-click: an icon right-click does nothing — no menu, no launch",
  () => {
    const last = lastPresent();
    const items = desktopItems(last.ops);
    assert.equal(items.length, 2, "2 desktop icons");
    const before = Sevyn._logs.filter((l) => l === "LAUNCH files").length;
    const photos = items[0];
    rightClickRect(photos, photos.x + 2, photos.y + 2);
    assert.equal(
      findMenuPanel(lastPresent().ops),
      undefined,
      "no menu from an icon right-click",
    );
    assert.equal(
      Sevyn._logs.filter((l) => l === "LAUNCH files").length,
      before,
      "no launch from an icon right-click",
    );
  },
);

check("desktop right-click: click-away dismisses the menu", () => {
  const last = lastPresent();
  rightClickRect(desktopSurfaceRect(last.ops), 500, 300);
  assert.ok(findMenuPanel(lastPresent().ops), "menu open");
  // The click-away overlay is the full-surface transparent
  // Pressable (1024x768); the desktop surface rect is 1024x0 in
  // the mock, so the height is what tells them apart.
  const overlay = lastPresent().ops.find(
    (o) =>
      o.type === "rect" &&
      o.color === "#00000000" &&
      o.nodeId != null &&
      o.nodeId >= 0 &&
      o.w === 1024 &&
      o.h === 768,
  );
  assert.ok(overlay, "click-away overlay presented");
  tap(overlay);
  assert.equal(
    findMenuPanel(lastPresent().ops),
    undefined,
    "menu dismissed by click-away",
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

  // AI sidebar (phase 1): the corner button opens a 360px sidebar;
  // a typed question runs `sevyn ai ask` and shows the receipt;
  // the header toggles full screen and closes back to the button.
  // Sizes, not positions, are what this test proves — the mock's
  // vertical layout ignores auto-height siblings (see the hover
  // check above); placement is proven in QEMU (m9-check).
  await checkAsync("AI button present, 56px, with AI monogram", () => {
    const last = lastPresent();
    assert.ok(aiButtonRect(last.ops), "AI button rect present");
    const texts = last.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(texts.includes("AI"), "AI monogram present");
  });

  await checkAsync("tap the AI button opens the sidebar", () => {
    const last = lastPresent();
    tap(aiButtonRect(last.ops));
    const after = lastPresent();
    const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(
      texts.some((t) => t.includes("Ask the AI to do something")),
      "sidebar empty state shown",
    );
    assert.ok(texts.includes("Full screen"), "full-screen toggle shown");
    assert.ok(texts.includes("Close"), "close shown");
    assert.ok(texts.includes("Standard"), "standard mode mark shown");
    assert.ok(sidebarRect(after.ops, 360), "360px sidebar panel present");
    assert.ok(!aiButtonRect(after.ops), "button hidden while sidebar open");
  });

  await checkAsync("god mode push shows the GOD mark in the sidebar header", () => {
    Sevyn._status["ai.god_mode"] = "on";
    Sevyn._handlers.status({ key: "ai.god_mode", value: "on" });
    const after = lastPresent();
    const gods = after.ops.filter((o) => o.type === "text" && o.text === "GOD");
    assert.equal(gods.length, 2, "GOD in tray + sidebar, got " + gods.length);
    Sevyn._status["ai.god_mode"] = "off";
    Sevyn._handlers.status({ key: "ai.god_mode", value: "off" });
  });

  await checkAsync(
    "typing a question and submitting runs sevyn ai ask and shows the receipt",
    async () => {
      // The input is autoFocus, so key events go straight to it.
      type("list the installed apps");
      pressEnter();
      await flush();
      assert.ok(
        Sevyn._logs.some((l) => l === "EXEC sevyn ai ask list the installed apps"),
        "ai ask run, logs=" + JSON.stringify(Sevyn._logs),
      );
      const after = lastPresent();
      const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
      assert.ok(
        texts.some((t) => t.includes("You: list the installed apps")),
        "user turn shown",
      );
      assert.ok(
        texts.some((t) => t.includes("1 allowed, 0 denied, 0 failed")),
        "receipt shown, texts=" + JSON.stringify(texts),
      );
      assert.ok(
        Sevyn._logs.some((l) => l === "AI-SIDEBAR ask allowed=1 denied=0 failed=0"),
        "sidebar marker logged",
      );
    },
  );

  await checkAsync("full-screen toggle grows the sidebar to the surface width", () => {
    const last = lastPresent();
    tap(pressableAtText(last.ops, "Full screen"));
    const after = lastPresent();
    const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(texts.includes("Exit full screen"), "toggle flips");
    assert.ok(sidebarRect(after.ops, 1024), "sidebar spans the 1024px surface");
    assert.ok(!sidebarRect(after.ops, 360), "no 360px panel while full-screen");
  });

  await checkAsync("close returns to button-only", () => {
    const last = lastPresent();
    tap(pressableAtText(last.ops, "Close"));
    const after = lastPresent();
    const texts = after.ops.filter((o) => o.type === "text").map((o) => o.text);
    assert.ok(
      !texts.some((t) => t.includes("Ask the AI to do something")),
      "sidebar gone",
    );
    assert.ok(aiButtonRect(after.ops), "button back after close");
  });

  console.log(`\n${passed} shell e2e checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
