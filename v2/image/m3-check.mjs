#!/usr/bin/env node
// M3 check: boot the SevynOS v2 M3 image in QEMU and prove the milestone.
//
// What it proves, in order:
//   1. The image boots, the shell mounts (SEVYNOS_M2_READY), and appd is
//      ready with its control serial (APPD ready … ctl=/dev/ttyS2) after
//      seeding all 12 stock bundles from pristine.
//   2. The shell surface is on screen: top bar, main area, and dock
//      colours are all present. The dock is appd-driven now, so the
//      first tile is Browser (alphabetical registry order) — its blue
//      (#0ea5e9) is fully visible and the dock's right edge is the
//      scroll chevron, not a half-cut tile.
//   3. Keys reach the shell: Tab + Enter (no pointer yet) launches the
//      first tile — LAUNCH browser, and the app's own host logs
//      SEVYNOS_M3_APP_READY browser. The app window is on screen: the
//      browser-blue pixel count jumps by the window's header + glyph.
//   4. Input reaches the app: the app window's close X (found from its
//      blue header bar in the screendump) closes it — APP STOPPED
//      browser 0 — and the blue pixels drop back to baseline.
//   5. Status is live in the shell tray (M2 behaviour): SETs injected
//      on the status control serial repaint the tray.
//   6. Status is live inside an app window: Files (status.read) shows
//      a repaint in its window body when the volume changes.
//   7. Permissions are enforced: Notes (no status.read) does NOT
//      repaint its window body on a status push, while the shell tray
//      does — the app never sees the values.
//   8. A crashing app never takes down the shell: installing and
//      launching crash.sevyn logs APP CRASHED crash 1 and the shell is
//      still on screen.
//   9. The loader refuses bad bundles: tampered.sevyn (bad bundleHash)
//      and badsystem.sevyn (system:true, untrusted signature) are both
//      refused.
//  10. The done-when, end to end: Files is uninstalled (LIST no longer
//      shows it), reinstalled offline from pristine (LIST shows it
//      again), and relaunched into its own window. Terminal cannot be
//      uninstalled (protected).
//  11. The shell is still on screen at the end; clean poweroff.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM
// format. The status daemon takes commands on the first control serial
// (ttyS1); appd takes INSTALL/UNINSTALL/REINSTALL/LAUNCH/CLOSE/LIST on
// the second (ttyS2) and answers as APPD log lines on the console.
// Results go to m3-check.json; screendumps and the serial log stay in
// the build dir as artifacts.
//
// Usage: node v2/image/m3-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M3_TIMEOUT (seconds, default 600).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const LOG = join(OUT, "m3-boot.log");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M3_TIMEOUT || 600);
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

// Find an app window's header bar: rows in the main area (below the
// shell top bar, above the dock) with >700 pixels of the app colour.
// A dock tile is 80 wide and the glyph tile 96 — only the 800-wide
// header bar clears 700. Returns {top, bottom, left, right} or null.
function findWindowHeader(img, r, g, b) {
  const { width: W, pixels } = img;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = 48; y < 672; y++) {
    let n = 0;
    let rowLeft = W;
    let rowRight = -1;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pixels[i] - r) <= 10 &&
        Math.abs(pixels[i + 1] - g) <= 10 &&
        Math.abs(pixels[i + 2] - b) <= 10
      ) {
        n++;
        if (x < rowLeft) rowLeft = x;
        if (x > rowRight) rowRight = x;
      }
    }
    if (n > 700) {
      if (top < 0) top = y;
      bottom = y;
      if (rowLeft < left) left = rowLeft;
      if (rowRight > right) right = rowRight;
    }
  }
  if (top < 0) return null;
  return { top, bottom, left, right };
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
        `error: missing ${join(OUT, f)} — run v2/image/build-m3-image.sh first`,
      );
      process.exit(1);
    }
  }

  const ctlSock = join(OUT, "m3-ctl.sock");
  const appdSock = join(OUT, "m3-appd.sock");
  const qmpSock = join(OUT, "m3-qmp.sock");
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
      // Second control serial: appd reads commands on /dev/ttyS2
      // (ttyS0 = console, ttyS1 = statusd). Order matters — QEMU
      // numbers the isa-serial devices in command-line order.
      "-chardev",
      `socket,id=appd,path=${appdSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=appd",
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

  // appd helpers: commands go on the appd serial; replies come back as
  // APPD log lines on the console (the boot log).
  let appd = null;
  async function appdCmd(cmd, pattern, timeoutMs = 15000) {
    const before = logLines().length;
    appd.write(cmd + "\n");
    return waitForLog(pattern, timeoutMs, before);
  }
  async function appdList() {
    const before = logLines().length;
    appd.write("LIST\n");
    const ok = await waitForLog(/APPD LIST OK/, 15000, before);
    if (!ok) return null;
    return logLines()
      .slice(before)
      .filter((l) => l.startsWith("APPD LIST ") && !l.endsWith("LIST OK"))
      .map((l) => l.slice("APPD LIST ".length));
  }

  // 1. Boot + shell mounted + appd ready (seeded from pristine).
  const ready = await waitForLog(/SEVYNOS_M2_READY/, 280000);
  if (!check("boot: shell mounted (SEVYNOS_M2_READY)", !!ready)) {
    console.error(readLog().slice(-3000));
    cleanup();
    finish(false);
    return;
  }
  const appdReady = await waitForLog(/APPD ready sock=.* ctl=\/dev\/ttyS2/, 60000);
  check(
    "boot: appd ready with control serial /dev/ttyS2",
    !!appdReady,
    appdReady || "APPD ready line missing or ctl=(none)",
  );
  const seed = await waitForLog(/APPD seed complete \(12 bundles\)/, 10000);
  check("boot: appd seeded 12 stock bundles from pristine", !!seed);

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
  check("control serial: status injection channel open", true);

  appd = net.connect(appdSock);
  await new Promise((resolve, reject) => {
    appd.once("connect", resolve);
    appd.once("error", reject);
  });
  check("control serial: appd command channel open", true);
  {
    const before = logLines().length;
    appd.write("PING\n");
    check("appd: PING answered", !!(await waitForLog(/APPD PONG/, 10000, before)));
  }

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
  const key = async (qcode) => {
    await qmp.input([
      { type: "key", data: { down: true, key: { type: "qcode", data: qcode } } },
    ]);
    await sleep(120);
    await qmp.input([
      { type: "key", data: { down: false, key: { type: "qcode", data: qcode } } },
    ]);
  };

  // 2. First screendump: shell surface colours. The shell's first
  // present can lag the mount by seconds under TCG, so poll the frame
  // until the top bar + dock appear (up to 30s).
  const shot1 = join(OUT, "m3-shot-1.ppm");
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
    // Top bar #15151c (21,21,28); dock #101014 (16,16,20).
    topBar = countColor(img, 21, 21, 28, 10, { x0: 0, y0: 0, x1: img.width, y1: 48 });
    dockBg = countColor(img, 16, 16, 20, 10, { x0: 0, y0: 672, x1: img.width, y1: 768 });
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

  // The dock is appd-driven now: registry order is the alphabetical
  // seed order, so the first tile is Browser (#0ea5e9 = 14,165,233).
  const browserBlue = countColor(img, 14, 165, 233, 12, {
    x0: 44,
    y0: 680,
    x1: 124,
    y1: 760,
  });
  const rightChevron = countColor(img, 31, 41, 55, 10, {
    x0: 988,
    y0: 680,
    x1: 1016,
    y1: 760,
  });
  check(
    "dock: first tile fully visible (Browser blue)",
    browserBlue > 1000,
    `blue pixels=${browserBlue}`,
  );
  check(
    "dock: right edge is the scroll chevron, not a cut tile",
    rightChevron > 1000,
    `chevron pixels=${rightChevron}`,
  );

  // Baseline browser-blue count for the window-appears check below
  // (the dock tile alone contributes ~6400).
  const blueBefore = countColor(img, 14, 165, 233, 12);

  // 3. Keyboard: Tab from no-focus lands on the first tile; Enter
  // launches it. The app's own host must report ready — the window
  // opened in its own Hermes runtime.
  {
    const before = logLines().length;
    await key("tab");
    await sleep(300);
    await key("ret");
    const hit = await waitForLog(/LAUNCH browser/, 10000, before);
    check("input: Tab + Enter launches the first app (Browser)", !!hit);
    const appReady = await waitForLog(
      /HOST app running \(SEVYNOS_M3_APP_READY\) browser/,
      15000,
      before,
    );
    check("app: browser host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotWindow = await shot(qmp, join(OUT, "m3-shot-window.ppm"));
  const blueAfter = countColor(shotWindow, 14, 165, 233, 12);
  check(
    "screen: browser window on screen (header + glyph)",
    blueAfter - blueBefore > 20000,
    `blue before=${blueBefore} after=${blueAfter}`,
  );

  // 4. Input reaches the app: click the close X in the app window's
  // header (found from the header bar in the screendump).
  {
    const header = findWindowHeader(shotWindow, 14, 165, 233);
    check("app: browser window header found on screen", !!header);
    if (header) {
      // The X is 28x28, right-aligned with 12px padding: its centre
      // is header.right - 12 - 14 horizontally, header.top + 22
      // vertically (44px header).
      const x = header.right - 26;
      const y = header.top + 22;
      const before = logLines().length;
      await moveTo(x, y, W, H);
      await sleep(300);
      await click();
      const stopped = await waitForLog(/APP STOPPED browser 0/, 10000, before);
      check("input: app close X stops the app (clean exit 0)", !!stopped);
    }
  }
  await sleep(500);
  const shotClosed = await shot(qmp, join(OUT, "m3-shot-closed.ppm"));
  const blueClosed = countColor(shotClosed, 14, 165, 233, 12);
  check(
    "screen: window gone after close (blue back to baseline)",
    Math.abs(blueClosed - blueBefore) < 2000,
    `blue before=${blueBefore} after close=${blueClosed}`,
  );

  // 5. Status is live in the shell tray (M2 behaviour).
  const shotTrayBefore = await shot(qmp, join(OUT, "m3-shot-tray-before.ppm"));
  ctl.write("SET battery 87\n");
  await sleep(300);
  ctl.write("SET wifi on\n");
  await sleep(300);
  ctl.write("SET volume 55\n");
  await sleep(1500);
  const shotTrayAfter = await shot(qmp, join(OUT, "m3-shot-tray-after.ppm"));
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

  // 6. Status is live inside an app window: Files has status.read.
  {
    const before = logLines().length;
    const ok = await appdCmd("LAUNCH files", /APPD LAUNCH OK files/);
    check("appd: LAUNCH files accepted", !!ok);
    const appReady = await waitForLog(
      /HOST app running \(SEVYNOS_M3_APP_READY\) files/,
      15000,
      before,
    );
    check("app: files host ready", !!appReady);
  }
  await sleep(800);
  const shotFiles = await shot(qmp, join(OUT, "m3-shot-files.ppm"));
  const filesHeader = findWindowHeader(shotFiles, 59, 130, 246);
  check("app: files window on screen", !!filesHeader);
  if (filesHeader) {
    const body = {
      x0: filesHeader.left,
      y0: filesHeader.bottom + 1,
      x1: filesHeader.right + 1,
      y1: Math.min(filesHeader.bottom + 1 + 456, H),
    };
    const bodyBefore = await shot(qmp, join(OUT, "m3-shot-files-body-before.ppm"));
    ctl.write("SET volume 42\n");
    await sleep(1500);
    const bodyAfter = await shot(qmp, join(OUT, "m3-shot-files-body-after.ppm"));
    const d = diffBox(bodyBefore, bodyAfter, body);
    check(
      "status: files window repaints on volume push (status.read)",
      d > 20,
      `body differing pixels=${d}`,
    );
  }

  // 7. Permissions are enforced: Notes has no status.read, so its
  // window body must NOT repaint on a status push — while the shell
  // tray does.
  {
    const before = logLines().length;
    const ok = await appdCmd("LAUNCH notes", /APPD LAUNCH OK notes/);
    check("appd: LAUNCH notes accepted", !!ok);
    const appReady = await waitForLog(
      /HOST app running \(SEVYNOS_M3_APP_READY\) notes/,
      15000,
      before,
    );
    check("app: notes host ready", !!appReady);
  }
  await sleep(800);
  const shotNotes = await shot(qmp, join(OUT, "m3-shot-notes.ppm"));
  const notesHeader = findWindowHeader(shotNotes, 234, 179, 8);
  check("app: notes window on screen", !!notesHeader);
  if (notesHeader) {
    const body = {
      x0: notesHeader.left,
      y0: notesHeader.bottom + 1,
      x1: notesHeader.right + 1,
      y1: Math.min(notesHeader.bottom + 1 + 456, H),
    };
    const trayBefore = await shot(qmp, join(OUT, "m3-shot-notes-tray-before.ppm"));
    ctl.write("SET battery 42\n");
    await sleep(1500);
    const trayAfter = await shot(qmp, join(OUT, "m3-shot-notes-tray-after.ppm"));
    const bodyDiff = diffBox(trayBefore, trayAfter, body);
    const trayDiff2 = diffBox(trayBefore, trayAfter, { x0: 600, y0: 0, x1: W, y1: 48 });
    check(
      "permissions: notes window does NOT repaint on status push",
      bodyDiff < 20,
      `body differing pixels=${bodyDiff}`,
    );
    check(
      "permissions: shell tray still repaints (control)",
      trayDiff2 > 20,
      `tray differing pixels=${trayDiff2}`,
    );
  }

  // Close both windows via appd (SIGTERM after CLOSE = STOPPED).
  {
    const before = logLines().length;
    const ok = await appdCmd("CLOSE files", /APPD CLOSE OK files/);
    check("appd: CLOSE files accepted", !!ok);
    const stopped = await waitForLog(/APP STOPPED files signal 15/, 10000, before);
    check("app: files stopped on close", !!stopped);
  }
  {
    const before = logLines().length;
    const ok = await appdCmd("CLOSE notes", /APPD CLOSE OK notes/);
    check("appd: CLOSE notes accepted", !!ok);
    const stopped = await waitForLog(/APP STOPPED notes signal 15/, 10000, before);
    check("app: notes stopped on close", !!stopped);
  }

  // 8. A crashing app never takes down the shell.
  {
    const ok = await appdCmd(
      "INSTALL /usr/share/sevyn/test-bundles/crash.sevyn",
      /APPD INSTALL OK \/usr\/share\/sevyn\/test-bundles\/crash\.sevyn/,
    );
    check("appd: crash bundle installs", !!ok);
  }
  {
    const before = logLines().length;
    const ok = await appdCmd("LAUNCH crash", /APPD LAUNCH OK crash/);
    check("appd: LAUNCH crash accepted", !!ok);
    const crashed = await waitForLog(/APP CRASHED crash 1/, 15000, before);
    check("sandbox: crash app exits 1, reported CRASHED", !!crashed);
  }
  await sleep(500);
  {
    const imgAlive = await shot(qmp, join(OUT, "m3-shot-after-crash.ppm"));
    const t = countColor(imgAlive, 21, 21, 28, 10, { x0: 0, y0: 0, x1: W, y1: 48 });
    const d = countColor(imgAlive, 16, 16, 20, 10, { x0: 0, y0: 672, x1: W, y1: 768 });
    check(
      "sandbox: shell still on screen after app crash",
      t > 10000 && d > 2000,
      `topBar=${t} dockBg=${d}`,
    );
  }

  // 9. The loader refuses bad bundles.
  {
    const bad = await appdCmd(
      "INSTALL /usr/share/sevyn/test-bundles/tampered.sevyn",
      /APPD INSTALL FAIL \/usr\/share\/sevyn\/test-bundles\/tampered\.sevyn rc=2/,
    );
    check("loader: tampered bundle refused (bad bundleHash)", !!bad);
  }
  {
    const bad = await appdCmd(
      "INSTALL /usr/share/sevyn/test-bundles/badsystem.sevyn",
      /APPD INSTALL FAIL \/usr\/share\/sevyn\/test-bundles\/badsystem\.sevyn rc=3/,
    );
    check("loader: untrusted system bundle refused", !!bad);
  }

  // 10. The done-when, end to end: uninstall, LIST absent, reinstall
  // offline from pristine, LIST present, relaunch.
  {
    const ok = await appdCmd("UNINSTALL files", /APPD UNINSTALL OK files/);
    check("appd: UNINSTALL files accepted", !!ok);
    const list = await appdList();
    check(
      "registry: files absent from LIST after uninstall",
      !!list && !list.some((l) => l.startsWith("files|")),
      list ? `${list.length} apps listed` : "LIST failed",
    );
    const ok2 = await appdCmd("REINSTALL files", /APPD REINSTALL OK files/);
    check("appd: REINSTALL files from pristine accepted", !!ok2);
    const list2 = await appdList();
    check(
      "registry: files present in LIST after reinstall",
      !!list2 && list2.some((l) => l.startsWith("files|")),
      list2 ? `${list2.length} apps listed` : "LIST failed",
    );
  }
  {
    const before = logLines().length;
    const ok = await appdCmd("LAUNCH files", /APPD LAUNCH OK files/);
    check("appd: reinstalled files relaunches", !!ok);
    const appReady = await waitForLog(
      /HOST app running \(SEVYNOS_M3_APP_READY\) files/,
      15000,
      before,
    );
    check("app: reinstalled files host ready", !!appReady);
    const ok2 = await appdCmd("CLOSE files", /APPD CLOSE OK files/);
    check("appd: CLOSE files accepted", !!ok2);
    const stopped = await waitForLog(/APP STOPPED files signal 15/, 10000, before);
    check("app: reinstalled files stopped on close", !!stopped);
  }

  // Terminal is protected: the loader must refuse to uninstall it.
  {
    const refused = await appdCmd(
      "UNINSTALL terminal",
      /APPD UNINSTALL FAIL terminal rc=3/,
    );
    check("protected: terminal uninstall refused", !!refused);
  }

  // 11. Final frame still shows the shell, then clean poweroff.
  const shotFinal = join(OUT, "m3-shot-final.ppm");
  const imgFinal = await shot(qmp, shotFinal);
  const fTop = countColor(imgFinal, 21, 21, 28, 10, { x0: 0, y0: 0, x1: W, y1: 48 });
  const fDock = countColor(imgFinal, 16, 16, 20, 10, { x0: 0, y0: 672, x1: W, y1: 768 });
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
  appd.destroy();
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
  writeFileSync(join(OUT, "m3-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M3 CHECK PASSED" : "M3 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M3 check crashed:", e);
  process.exit(1);
});
