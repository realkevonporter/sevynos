#!/usr/bin/env node
// M2 check: boot the SevynOS v2 M2 image in QEMU and prove the milestone.
//
// NOTE (M3): this check runs the M2 image, which has NO appd — so the
// shell falls back to its built-in app list (Files first, M2 order) and
// a dock click only logs LAUNCH (there is no appd to really launch).
// The shell shows "Starting…" only on a real launch since M3, so the
// click test asserts the main area does NOT change here; real launching
// is proven by m3-check.mjs. The host link needs appclient.cc since M3
// (see build-m2-image.sh) — the M2 image still builds and runs the same
// host binary.
//
// What it proves, in order:
//   1. The image boots and the shell mounts (SEVYNOS_M2_READY on serial).
//   2. The shell surface is on screen: top bar, main area, and dock
//      colours are all present in the first screendump. The dock is
//      a floating glass pill — its interior reads (57,57,59): the
//      edge ring (#ffffff14) paints under the pill too, then the
//      pill's own #ffffff1f fill composites over it. That glass,
//      not the old #101014 bar, is the settled signal.
//   3. The dock fits at 15 apps: the first tile is fully visible,
//      the pill is floating and centred (no glass at the far edges
//      of the bottom band), and there is no scroll chevron — the
//      dock shrinks its tiles to fit instead of scrolling.
//   4. Click lands on the intended control: clicking the Files tile logs
//      LAUNCH files, and the main area does NOT change (no "Starting…"
//      without a real launch — M3 behaviour, see note above). Moving
//      the pointer onto the tile first makes the shell set the pointer
//      cursor (WAYLAND cursor set on the serial log) — the cursor is a
//      hardware plane, so screendumps can't prove it; the log line is
//      the proof. Without it the mouse is invisible even though clicks
//      land.
//   5. Status is live: SETs injected on the host control serial change
//      the tray (pixel diff in the tray region).
//   6. Keys reach the focused control: after clicking Files, Tab moves
//      focus to Terminal and Enter launches it (LAUNCH terminal).
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM format.
// Results go to m2-check.json; screendumps and the serial log stay in
// the build dir as artifacts.
//
// Usage: node v2/image/m2-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M2_TIMEOUT (seconds, default 600).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const LOG = join(OUT, "m2-boot.log");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M2_TIMEOUT || 600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1) + "s";

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} [${elapsed()}] ${name}${detail ? " — " + detail : ""}`,
  );
  return ok;
}

function readLog() {
  try {
    return readFileSync(LOG, "utf8");
  } catch {
    return "";
  }
}

function logLines() {
  // Drop the trailing "" from a file ending in "\n": without this,
  // logLines().length counts a phantom line, and waitForLog(..., sinceLines)
  // skips the FIRST line appended after `sinceLines` was captured (it lands
  // on the phantom's index). Same bug found in m1-check.mjs during M1.
  const lines = readLog().split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function waitForLog(pattern, timeoutMs, sinceLines = 0) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const lines = logLines();
      for (let i = sinceLines; i < lines.length; i++) {
        if (pattern.test(lines[i])) return lines[i];
      }
      await sleep(200);
    }
    return null;
  })();
}

// --- PPM parsing (QEMU screendump, P6 binary) ---
function parsePPM(path) {
  const buf = readFileSync(path);
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4 && pos < buf.length) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    tokens.push(buf.subarray(start, pos).toString());
  }
  if (tokens[0] !== "P6") throw new Error(`${path}: not a P6 PPM`);
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maxval = Number(tokens[3]);
  pos++;
  const pixels = buf.subarray(pos, pos + width * height * 3);
  if (pixels.length < width * height * 3) throw new Error(`${path}: truncated raster`);
  return { width, height, maxval, pixels };
}

function countColor(img, r, g, b, tol = 10, box = null) {
  const { width: W, pixels } = img;
  const x0 = box ? box.x0 : 0;
  const y0 = box ? box.y0 : 0;
  const x1 = box ? box.x1 : W;
  const y1 = box ? box.y1 : img.height;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pixels[i] - r) <= tol &&
        Math.abs(pixels[i + 1] - g) <= tol &&
        Math.abs(pixels[i + 2] - b) <= tol
      ) {
        n++;
      }
    }
  }
  return n;
}

// Differing pixels between two frames inside a box.
function diffBox(a, b, box) {
  const { width: W } = a;
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * W + x) * 3;
      const d =
        Math.abs(a.pixels[i] - b.pixels[i]) +
        Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) +
        Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
      if (d > 30) n++;
    }
  }
  return n;
}

// --- QMP client ---
class QMP {
  constructor(path) {
    this.path = path;
    this.buf = "";
    this.waiters = [];
    this.sock = net.connect(path);
    this.sock.on("data", (d) => {
      this.buf += d.toString();
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.event) continue;
        const w = this.waiters.shift();
        if (w) w(msg);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.sock.once("connect", resolve);
      this.sock.once("error", reject);
    });
  }
  execute(cmd, args) {
    return new Promise((resolve, reject) => {
      this.waiters.push((msg) => {
        if (msg.error) reject(new Error(`${cmd}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.return);
      });
      this.sock.write(JSON.stringify({ execute: cmd, arguments: args }) + "\n");
    });
  }
  async capabilities() {
    await sleep(300);
    await this.execute("qmp_capabilities");
  }
  async input(events) {
    await this.execute("input-send-event", { events });
  }
  async screendump(path) {
    await this.execute("screendump", { filename: path, format: "ppm" });
  }
  close() {
    this.sock.destroy();
  }
}

async function shot(qmp, path) {
  await qmp.screendump(path);
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(300);
    try {
      return parsePPM(path);
    } catch {
      // QEMU resolves the screendump command before the file is fully
      // flushed; retry a truncated parse (M1 settle lesson).
    }
  }
  throw new Error(`${path}: no readable frame after retries`);
}

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m2-image.sh first`,
      );
      process.exit(1);
    }
  }

  const ctlSock = join(OUT, "m2-ctl.sock");
  const qmpSock = join(OUT, "m2-qmp.sock");
  writeFileSync(LOG, "");
  const logStream = createWriteStream(LOG, { flags: "w" });

  const qemu = spawn(
    QEMU,
    [
      "-machine",
      "q35",
      "-m",
      "512",
      "-smp",
      "2",
      "-kernel",
      join(OUT, "vmlinuz"),
      "-initrd",
      join(OUT, "initramfs.cpio.gz"),
      "-append",
      "console=ttyS0",
      "-display",
      "none",
      "-vga",
      "none",
      "-monitor",
      "none",
      "-serial",
      "stdio",
      "-chardev",
      `socket,id=ctl,path=${ctlSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=ctl",
      "-chardev",
      `socket,id=qmp,path=${qmpSock},server=on,wait=off`,
      "-mon",
      "chardev=qmp,mode=control",
      "-device",
      "virtio-gpu-pci",
      "-device",
      "qemu-xhci",
      "-device",
      "usb-tablet",
      "-nic",
      "none",
      "-no-reboot",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  qemu.stdout.pipe(logStream);
  qemu.stderr.pipe(logStream);
  let qemuExited = false;
  qemu.on("exit", () => {
    qemuExited = true;
  });

  const cleanup = () => {
    try {
      qemu.kill("SIGKILL");
    } catch {}
  };
  process.on("exit", cleanup);

  // 1. Boot + shell mounted.
  const ready = await waitForLog(/SEVYNOS_M2_READY/, 280000);
  if (!check("boot: shell mounted (SEVYNOS_M2_READY)", !!ready)) {
    console.error(readLog().slice(-3000));
    cleanup();
    finish(false);
    return;
  }

  const qmp = new QMP(qmpSock);
  try {
    await qmp.ready();
    await qmp.capabilities();
  } catch (e) {
    check("qmp: connect + negotiate", false, String(e));
    cleanup();
    finish(false);
    return;
  }
  check("qmp: connect + negotiate", true);

  const ctl = net.connect(ctlSock);
  await new Promise((resolve, reject) => {
    ctl.once("connect", resolve);
    ctl.once("error", reject);
  });
  check("control serial: host injection channel open", true);

  const toAbs = (px, size) => Math.round((px / size) * 32767);
  const moveTo = async (x, y, w, h) => {
    await qmp.input([
      { type: "abs", data: { axis: "x", value: toAbs(x, w) } },
      { type: "abs", data: { axis: "y", value: toAbs(y, h) } },
    ]);
  };
  const click = async () => {
    await qmp.input([{ type: "btn", data: { button: "left", down: true } }]);
    await sleep(120);
    await qmp.input([{ type: "btn", data: { button: "left", down: false } }]);
  };

  // 2. First screendump: shell surface colours.
  // The shell's first present can lag the mount by seconds under TCG,
  // so poll the frame until the top bar + dock appear (up to 30s).
  const shot1 = join(OUT, "m2-shot-1.ppm");
  let img = null;
  let topBar = 0;
  let dockBg = 0;
  const settleStart = Date.now();
  while (Date.now() - settleStart < 30000) {
    try {
      img = await shot(qmp, shot1);
    } catch {
      await sleep(1000);
      continue;
    }
    // Top bar #15151c (21,21,28); dock glass (57,57,59) — the pill
    // interior: the edge ring's #ffffff14 paints under the pill,
    // then the pill's own #ffffff1f fill composites over it.
    // (No true backdrop blur: the painter only sees its own surface,
    // so the glass is a translucent fill + highlight, not a blur of
    // what's behind.) The band is the bottom 128px of the frame —
    // the pill sits at the bottom with an 8px margin, so this holds
    // at any surface size (CI runs at 1280x800, not 1024x768).
    topBar = countColor(img, 21, 21, 28, 10, { x0: 0, y0: 0, x1: img.width, y1: 48 });
    dockBg = countColor(img, 57, 57, 59, 10, {
      x0: 0,
      y0: img.height - 128,
      x1: img.width,
      y1: img.height,
    });
    if (topBar > 10000 && dockBg > 2000) break;
    await sleep(1000);
  }
  if (!img) {
    check("screendump: readable frame", false, "no frame parsed");
    cleanup();
    finish(false);
    return;
  }
  const { width: W, height: H } = img;
  check("screendump: readable frame", true, `${W}x${H}`);
  check(
    "screen: top bar + dock visible",
    topBar > 10000 && dockBg > 2000,
    `topBar=${topBar} dockBg=${dockBg}`,
  );

  // Dock geometry, mirroring v2/shell/src/Dock.tsx (same constants):
  // the pill is centered, so its position depends on the frame size —
  // CI runs at 1280x800, not 1024x768, and hardcoding 1024 geometry
  // fails there (the first tile lands at x212, not x84, and the pill
  // extends past x984). Everything below derives from W/H.
  // No magnification: tiles stay flat, so the resting size divides the
  // available width by the app count (mirrors Dock.tsx).
  const restingTileSize = (n, surfaceWidth) => {
    const cap = surfaceWidth - 2 * 24;
    const fixed = 2 * 8 + (n - 1) * 8;
    return Math.max(40, Math.min(64, Math.floor((cap - fixed) / n)));
  };
  const restingPillWidth = (n, tile) => 2 * 8 + n * tile + (n - 1) * 8;
  const restingPillHeight = (tile) => 2 * 8 + tile + 4 + 6;
  const dockGeom = (n) => {
    const tile = restingTileSize(n, W);
    const pillW = restingPillWidth(n, tile);
    const pillH = restingPillHeight(tile);
    const pillX = Math.floor((W - pillW) / 2);
    const pillTop = H - 8 - pillH;
    return { tile, pillW, pillH, pillX, pillTop };
  };
  const dockBand = { x0: 0, y0: H - 128, x1: W, y1: H };
  const g15 = dockGeom(15);

  // 3. Dock fits at 15 apps: the first tile (Files, #3b82f6) is fully
  // visible, the pill is floating and centred (no glass at the far
  // left/right of the bottom band), and there is no scroll chevron
  // (#1f2937) anywhere in the dock band. Tile 0 sits at
  // (pillX + 8, pillTop + 1 + 8); at 1280x800 that is x104..168,
  // y711..775 (at 1024x768 it was x84..148, y677..743).
  const tile0 = {
    x0: g15.pillX + 8,
    y0: g15.pillTop + 1 + 8,
    x1: g15.pillX + 8 + g15.tile,
    y1: g15.pillTop + 1 + 8 + g15.tile,
  };
  const filesBlue = countColor(img, 59, 130, 246, 12, tile0);
  const glassLeft = countColor(img, 57, 57, 59, 10, {
    x0: 0,
    y0: dockBand.y0,
    x1: Math.max(0, g15.pillX - 8),
    y1: H,
  });
  const glassRight = countColor(img, 57, 57, 59, 10, {
    x0: g15.pillX + g15.pillW + 8,
    y0: dockBand.y0,
    x1: W,
    y1: H,
  });
  const chevron = countColor(img, 31, 41, 55, 10, dockBand);
  check(
    "dock: first tile fully visible (Files blue)",
    filesBlue > 1000,
    `blue pixels=${filesBlue}`,
  );
  check(
    "dock: floating pill, no glass at the far edges",
    glassLeft < 100 && glassRight < 100,
    `glassLeft=${glassLeft} glassRight=${glassRight}`,
  );
  check(
    "dock: no scroll chevron in the dock band",
    chevron < 100,
    `chevron pixels=${chevron}`,
  );

  // 4. Click the Files tile: LAUNCH files in the log. The main area
  // must NOT change: since M3 the shell shows "Starting…" only when
  // launchApp returns true, and with no appd in this image it returns
  // false — so a click here logs LAUNCH but shows no "Starting…".
  // (Real launching, with the "Starting…" state, is m3-check's job.)
  const shotBefore = await shot(qmp, join(OUT, "m2-shot-before-click.ppm"));
  {
    const before = logLines().length;
    // Files tile centre, from the computed geometry (at 1280x800
    // that is (136, 743); the old hardcoded (116, 709) was 1024x768).
    await moveTo(
      Math.floor((tile0.x0 + tile0.x1) / 2),
      Math.floor((tile0.y0 + tile0.y1) / 2),
      W,
      H,
    );
    await sleep(300);
    // The pointer entering the shell surface must make the host set
    // the cursor (enter serial → wl_pointer_set_cursor). The cursor
    // lives on Weston's hardware plane, so no screendump can show it
    // — the host's log line is the proof. Without this the mouse is
    // invisible even though clicks land.
    const cursor = await waitForLog(/WAYLAND cursor set \(left_ptr/, 10000, before);
    check("pointer: shell sets the cursor on enter", !!cursor, cursor || "");
    await click();
    const hit = await waitForLog(/LAUNCH files/, 10000, before);
    check("input: click Files tile logs LAUNCH files", !!hit);
  }
  // Move the pointer to the top-left corner before the after-shot:
  // the corner keeps the cursor itself out of the diff region (the
  // cursor IS in the screendump; at the screen centre its arrow
  // alone left 147 differing pixels).
  await moveTo(0, 0, W, H);
  await sleep(1000);
  const shotAfter = await shot(qmp, join(OUT, "m2-shot-after-click.ppm"));
  // The main area must NOT change: since M3 the shell shows
  // "Starting…" only when launchApp returns true, and with no appd
  // in this image it returns false — so a click here logs LAUNCH
  // but shows no "Starting…". (Real launching, with the
  // "Starting…" state, is m3-check's job.)
  const mainDiff = diffBox(shotBefore, shotAfter, { x0: 0, y0: 48, x1: W, y1: H - 128 });
  check(
    "screen: main area unchanged after click (no fake Starting…)",
    mainDiff < 100,
    `differing pixels=${mainDiff}`,
  );

  // 5. Status is live: push battery/wifi/volume; the tray (top-right)
  // must repaint.
  const shotTrayBefore = await shot(qmp, join(OUT, "m2-shot-tray-before.ppm"));
  ctl.write("SET battery 87\n");
  await sleep(300);
  ctl.write("SET wifi on\n");
  await sleep(300);
  ctl.write("SET volume 55\n");
  await sleep(1500);
  const shotTrayAfter = await shot(qmp, join(OUT, "m2-shot-tray-after.ppm"));
  const trayDiff = diffBox(shotTrayBefore, shotTrayAfter, {
    x0: 600,
    y0: 0,
    x1: W,
    y1: 48,
  });
  check(
    "status: tray repaints on pushed battery/wifi/volume",
    trayDiff > 20,
    `tray differing pixels=${trayDiff}`,
  );

  // 6. Keyboard: focus is on Files (clicked above); Tab moves focus to
  // Terminal, Enter launches it.
  {
    const before = logLines().length;
    await qmp.input([
      { type: "key", data: { down: true, key: { type: "qcode", data: "tab" } } },
    ]);
    await sleep(120);
    await qmp.input([
      { type: "key", data: { down: false, key: { type: "qcode", data: "tab" } } },
    ]);
    await sleep(300);
    await qmp.input([
      { type: "key", data: { down: true, key: { type: "qcode", data: "ret" } } },
    ]);
    await sleep(120);
    await qmp.input([
      { type: "key", data: { down: false, key: { type: "qcode", data: "ret" } } },
    ]);
    const hit = await waitForLog(/LAUNCH terminal/, 10000, before);
    check("input: Tab + Enter launches the focused app (Terminal)", !!hit);
  }

  // 7. Final frame still shows the shell, then clean poweroff.
  const shotFinal = join(OUT, "m2-shot-final.ppm");
  const imgFinal = await shot(qmp, shotFinal);
  const fTop = countColor(imgFinal, 21, 21, 28, 10, { x0: 0, y0: 0, x1: W, y1: 48 });
  const fDock = countColor(imgFinal, 57, 57, 59, 10, {
    x0: 0,
    y0: H - 128,
    x1: W,
    y1: H,
  });
  check(
    "screen: shell still visible at end",
    fTop > 10000 && fDock > 2000,
    `topBar=${fTop} dockBg=${fDock}`,
  );

  ctl.write("POWEROFF\n");
  const exited = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (qemuExited) return true;
      await sleep(500);
    }
    return false;
  })();
  check("shutdown: guest powers off on request", exited);
  qmp.close();
  ctl.destroy();
  cleanup();
  finish(
    checks.every((c) => c.ok),
    { screen: { width: W, height: H } },
  );
}

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m2-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M2 CHECK PASSED" : "M2 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M2 check crashed:", e);
  process.exit(1);
});
