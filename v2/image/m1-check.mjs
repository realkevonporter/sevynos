#!/usr/bin/env node
// M1 check: boot the SevynOS v2 M1 image in QEMU and prove the milestone.
//
// What it proves, in order:
//   1. The image boots and the compositor + test client come up
//      (SEVYNOS_M1_READY on the serial console).
//   2. A surface is on screen: the final screendump contains both test
//      surface colours.
//   3. The cursor moves: two screendumps with the pointer at two different
//      points differ only near those points (nothing else on screen moves).
//   4. Clicks land on the intended surface: a pointer sweep maps screen
//      regions to surfaces A/B, then a click in each region is logged by
//      that surface's name.
//   5. Keys reach the focused surface: after clicking A, a key press is
//      logged with focus A and the right keycode.
//   6. Status is a pushed event feed: a SET injected on the host control
//      serial is logged by the subscriber client promptly.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM format
// (trivial to parse without dependencies). Results go to m1-check.json;
// screendumps and the serial log stay in the build dir as artifacts.
//
// Usage: node v2/image/m1-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M1_TIMEOUT (seconds, default 600).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const LOG = join(OUT, "m1-boot.log");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M1_TIMEOUT || 600);
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
  return readLog().split("\n");
}

// Surface currently under the pointer, from the client's PTR ENTER/LEAVE
// lines (the client logs every enter/leave with the surface name).
function pointerSurface() {
  let current = null;
  for (const line of logLines()) {
    const enter = line.match(/PTR ENTER (\S+)/);
    if (enter) current = enter[1];
    if (/PTR LEAVE/.test(line)) current = null;
  }
  return current;
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
    // Skip whitespace and comments.
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
  pos++; // Single whitespace byte after maxval.
  const pixels = buf.subarray(pos, pos + width * height * 3);
  if (pixels.length < width * height * 3) throw new Error(`${path}: truncated raster`);
  return { width, height, maxval, pixels };
}

function countColor(img, r, g, b, tol = 10) {
  let n = 0;
  for (let i = 0; i < img.pixels.length; i += 3) {
    if (
      Math.abs(img.pixels[i] - r) <= tol &&
      Math.abs(img.pixels[i + 1] - g) <= tol &&
      Math.abs(img.pixels[i + 2] - b) <= tol
    ) {
      n++;
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
        if (msg.event) continue; // Async event, not a command reply.
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
    // The greeting arrives first; wait a beat, then negotiate.
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

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m1-image.sh first`,
      );
      process.exit(1);
    }
  }

  const ctlSock = join(OUT, "m1-ctl.sock");
  const qmpSock = join(OUT, "m1-qmp.sock");
  // Truncate the serial log SYNCHRONOUSLY before QEMU starts.
  // createWriteStream opens async: without this, a stale
  // SEVYNOS_M1_READY left by a previous run can be read by the first
  // waitForLog poll before the truncation lands, falsely passing the
  // boot check at 0.0s and then failing on the not-yet-created QMP
  // socket — the exact failure of the second fixed-socket check run.
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
      // No emulated VGA: q35 defaults to a VGA adapter (720x400 text
      // console), and QMP screendump + the usb-tablet coordinate space
      // both target that console instead of the virtio-gpu display
      // Weston modesets. Without this the screendumps show the VGA
      // console (no test surfaces) and pointer coords map to 720x400
      // while Weston thinks the output is 1024x768 — the exact failure
      // of the first fixed-socket check run.
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

  // 1. Boot + compositor ready.
  const ready = await waitForLog(/SEVYNOS_M1_READY/, 280000);
  if (!check("boot: compositor + test client up (SEVYNOS_M1_READY)", !!ready)) {
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

  // Control serial: the host injection channel for status changes.
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

  // 2. First screendump: screen size + surfaces present.
  // The compositor's first present (background + client surfaces) can lag
  // the client's READY by seconds under TCG, so poll the frame until the
  // test surfaces appear (up to 30s) instead of trusting one early shot.
  const shot1 = join(OUT, "m1-shot-1.ppm");
  let img = null;
  let colorA = 0;
  let colorB = 0;
  const settleStart = Date.now();
  while (Date.now() - settleStart < 30000) {
    await qmp.screendump(shot1);
    // QEMU resolves the screendump command before the 2.3 MB file is fully
    // flushed; parsing immediately can read a truncated/stale raster and
    // report 0 surface pixels for a frame that actually has them. Wait for
    // the file size to settle, and retry a truncated parse instead of
    // aborting the whole settle.
    let parsed = null;
    for (let attempt = 0; attempt < 6 && !parsed; attempt++) {
      await sleep(300);
      try {
        parsed = parsePPM(shot1);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) continue;
    img = parsed;
    colorA = countColor(img, 0x40, 0x20, 0x20);
    colorB = countColor(img, 0x20, 0x20, 0x40);
    if (colorA > 5000 && colorB > 5000) break;
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
    "screen: both test surfaces visible",
    colorA > 5000 && colorB > 5000,
    `A pixels=${colorA} B pixels=${colorB}`,
  );

  // 3. Pointer sweep: map screen regions to surfaces.
  const regions = { A: [], B: [] };
  const step = 128;
  for (let y = 64; y < H - 32; y += step) {
    for (let x = 64; x < W - 32; x += step) {
      await moveTo(x, y, W, H);
      await sleep(200);
      const s = pointerSurface();
      if (s === "A" || s === "B") regions[s].push([x, y]);
      if (Date.now() - started > TIMEOUT_S * 1000) break;
    }
  }
  const sweepOk = regions.A.length >= 2 && regions.B.length >= 2;
  check(
    "input: pointer sweep maps two distinct surfaces",
    sweepOk,
    `A points=${regions.A.length} B points=${regions.B.length}`,
  );
  if (!sweepOk) {
    cleanup();
    finish(false);
    return;
  }

  // 4. Cursor moves: two screendumps, pointer at two distant points.
  const p1 = regions.A[0];
  const p2 = regions.B[regions.B.length - 1];
  await moveTo(p1[0], p1[1], W, H);
  await sleep(400);
  const shotA = join(OUT, "m1-shot-cursor-a.ppm");
  await qmp.screendump(shotA);
  await moveTo(p2[0], p2[1], W, H);
  await sleep(400);
  const shotB = join(OUT, "m1-shot-cursor-b.ppm");
  await qmp.screendump(shotB);
  const imgA = parsePPM(shotA);
  const imgB = parsePPM(shotB);
  let diffTotal = 0;
  let diffNear = 0;
  for (let i = 0; i < imgA.pixels.length; i += 3) {
    const px = (i / 3) % W;
    const py = Math.floor(i / 3 / W);
    const d =
      Math.abs(imgA.pixels[i] - imgB.pixels[i]) +
      Math.abs(imgA.pixels[i + 1] - imgB.pixels[i + 1]) +
      Math.abs(imgA.pixels[i + 2] - imgB.pixels[i + 2]);
    if (d > 30) {
      diffTotal++;
      const nearP1 = Math.abs(px - p1[0]) <= 80 && Math.abs(py - p1[1]) <= 80;
      const nearP2 = Math.abs(px - p2[0]) <= 80 && Math.abs(py - p2[1]) <= 80;
      if (nearP1 || nearP2) diffNear++;
    }
  }
  check(
    "cursor: moves (screendumps differ only near the pointer)",
    diffTotal > 50 && diffNear / Math.max(diffTotal, 1) >= 0.7,
    `differing pixels=${diffTotal}, near pointer=${diffNear} (${((diffNear / Math.max(diffTotal, 1)) * 100).toFixed(0)}%)`,
  );

  // 5. Clicks land on the intended surface.
  let clickOk = true;
  for (const [name, pt] of [
    ["A", regions.A[0]],
    ["B", regions.B[0]],
  ]) {
    const before = logLines().length;
    await moveTo(pt[0], pt[1], W, H);
    await sleep(300);
    await click();
    const hit = await waitForLog(new RegExp(`PTR BUTTON ${name} `), 5000, before);
    if (!check(`input: click in ${name} region reaches surface ${name}`, !!hit))
      clickOk = false;
  }

  // 6. Keys reach the focused surface (click A to focus it, then press "a").
  {
    const before = logLines().length;
    await moveTo(regions.A[0][0], regions.A[0][1], W, H);
    await sleep(300);
    await click();
    await sleep(300);
    await qmp.input([
      { type: "key", data: { down: true, key: { type: "qcode", data: "a" } } },
    ]);
    await sleep(120);
    await qmp.input([
      { type: "key", data: { down: false, key: { type: "qcode", data: "a" } } },
    ]);
    // KEY_A is evdev 30. The Wayland/XKB convention is evdev + 8 (38),
    // but this minimal image's Weston delivers the raw evdev code (30) —
    // no locale/keymap data for xkbcommon to apply the offset. Either
    // value proves the key reached the focused surface; accept both.
    const hit = await waitForLog(/KEY A key=(30|38) state=pressed/, 5000, before);
    check("input: key reaches focused surface (KEY_A)", !!hit);
  }

  // 7. Status is a pushed event feed.
  const statusTests = [
    ["volume", "42"],
    ["battery", "87"],
    ["wifi", "up"],
  ];
  for (const [key, val] of statusTests) {
    const before = logLines().length;
    ctl.write(`SET ${key} ${val}\n`);
    const hit = await waitForLog(new RegExp(`STATUS ${key} ${val}`), 10000, before);
    check(`status: ${key}=${val} pushed to subscriber`, !!hit);
  }

  // 8. Final frame still shows both surfaces, then clean poweroff.
  const shotFinal = join(OUT, "m1-shot-final.ppm");
  await qmp.screendump(shotFinal);
  const imgFinal = parsePPM(shotFinal);
  const fA = countColor(imgFinal, 0x40, 0x20, 0x20);
  const fB = countColor(imgFinal, 0x20, 0x20, 0x40);
  check(
    "screen: both surfaces still visible at end",
    fA > 5000 && fB > 5000,
    `A=${fA} B=${fB}`,
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
    { screen: { width: W, height: H }, regions },
  );
}

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m1-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M1 CHECK PASSED" : "M1 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M1 check crashed:", e);
  process.exit(1);
});
