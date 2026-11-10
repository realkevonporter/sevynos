// M5 check: boot the SevynOS v2 M5 image in QEMU and prove the
// milestone — connectivity + the Chromium browser.
//
//   1. Boot: SEVYNOS_M5_READY + the M4.5 stack still intact
//      (SEVYNOS_M4_5_READY, SEVYNOS_M4_READY, code-server serving,
//      slot marked good). The shell is on screen (top bar + dock
//      settled), appd answers PING, aid answers PING on its control
//      serial. The init net probe reports interface eth0.
//   2. Network via the Terminal: `net status` reports eth0 /
//      10.0.2.15 / gateway 10.0.2.2 / DNS 10.0.2.3 / wifi on; `net dns
//      localhost` resolves; `net dns example.com` resolves (gated:
//      the sandbox has no guest internet, so this step is skipped
//      when SEVYN_V2_M5_INTERNET=0 and CI is the gate for it).
//   3. The old build's named failure — "wifi connected, browser
//      dead" — is the acceptance test: `browser open` a page served
//      by the host over the guest network (10.0.0.2.2:18080), then
//      prove it RENDERS: the tab title arrives over CDP AND the
//      page's red viewport is visible as pixels in Chromium's
//      window. A fetch alone would not count.
//   4. A real public page (gated like step 2): `browser open
//      https://example.com`, the "Example Domain" tab title over CDP
//      plus a white page on screen — the browser loads a real page
//      over the internet, not just the local test server.
//   5. Sevyn Code paints in a window (the M4 open item): `browser
//      open http://127.0.0.1:8080/` — the IDE workbench title over
//      CDP plus the dark workbench on screen.
//   6. Tab switching: activate the first tab again and the red page
//      comes back on screen.
//   7. The Browser app (tabs + address bar): launch it, type the
//      second test page's URL into its address bar, and the green
//      page renders in Chromium (the app drove the browser).
//   8. Clean poweroff.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM
// format. statusd takes commands on the first control serial (ttyS1);
// appd takes LAUNCH/CLOSE/LIST on the second (ttyS2); the updater
// takes STATUS/CHECK/APPLY on the third (ttyS3); aid takes
// PING/LIST/SELECT/STATUS/ASK on the fourth (ttyS4). The host serves
// the test pages on 127.0.0.1:18080 — the guest reaches them at
// 10.0.2.2:18080 through QEMU user networking (virtio-net). Results
// go to m5-check.json; boot logs, screendumps and the data disk stay
// in the build dir as artifacts.
//
// Usage: node v2/image/m5-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M5_TIMEOUT (seconds, default 1200),
//      SEVYN_V2_M5_INTERNET (1 = prove the public page, 0 = skip
//      the internet steps; default 1. The sandbox has no guest
//      internet, so local runs use 0 and CI is the gate).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m5-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M5_TIMEOUT || 1200);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
const INTERNET = process.env.SEVYN_V2_M5_INTERNET !== "0";
const HTTP_PORT = 18080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function logLines(path) {
  return readLog(path).split("\n");
}

async function waitForLog(path, pattern, timeoutMs, sinceLines = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = logLines(path).slice(sinceLines);
    const hit = lines.find((l) => pattern.test(l));
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

// --- PPM parsing + pixel counting (as m2/m3-check) ---
function parsePPM(path) {
  const buf = readFileSync(path);
  let i = 0;
  const nextToken = () => {
    while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i++;
    if (buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      return nextToken();
    }
    let s = "";
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) {
      s += String.fromCharCode(buf[i++]);
    }
    return s;
  };
  const magic = nextToken();
  if (magic !== "P6") throw new Error(`${path}: not P6 (${magic})`);
  const width = parseInt(nextToken(), 10);
  const height = parseInt(nextToken(), 10);
  const maxval = parseInt(nextToken(), 10);
  i++;
  const pixels = buf.subarray(i, i + width * height * 3);
  if (pixels.length < width * height * 3) throw new Error(`${path}: truncated`);
  return { width, height, maxval, pixels };
}

function countColor(img, r, g, b, tol = 10, box = null) {
  const { width: W, height: H, pixels } = img;
  const x0 = box?.x0 ?? 0;
  const y0 = box?.y0 ?? 0;
  const x1 = box?.x1 ?? W;
  const y1 = box?.y1 ?? H;
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

// Find an app window's header bar (a solid 44px band of the given
// colour, 800px wide) and return its bounds.
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

// --- data disk (debugfs, read-only from the harness) ---
async function readState() {
  const out = await execAsync("debugfs", ["-R", "cat /slot-state.json", DISK]);
  return JSON.parse(out);
}

async function dumpSlot(slot, tag) {
  const kern = join(OUT, `m5-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m5-boot-${tag}-initramfs.cpio.gz`);
  await execAsync("debugfs", ["-R", `dump /slots/${slot}/vmlinuz ${kern}`, DISK]);
  await execAsync("debugfs", [
    "-R",
    `dump /slots/${slot}/initramfs.cpio.gz ${initrd}`,
    DISK,
  ]);
  return { kern, initrd };
}

// --- one QEMU boot ---
let currentBoot = null;

async function boot(tag) {
  const state = await readState();
  const bootSlot = state.active;
  const { kern, initrd } = await dumpSlot(bootSlot, tag);
  const logPath = join(OUT, `m5-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `m5-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m5-${tag}-appd.sock`);
  const updSock = join(OUT, `m5-${tag}-upd.sock`);
  const aidSock = join(OUT, `m5-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m5-${tag}-qmp.sock`);
  const qemu = spawn(
    QEMU,
    [
      "-machine",
      "q35",
      // Chromium + code-server need the headroom: the M4/M4.5 boots
      // ran -m 2048; the M5 boot notes say -m 4096.
      "-m",
      "4096",
      "-smp",
      "2",
      "-kernel",
      kern,
      "-initrd",
      initrd,
      "-append",
      `console=ttyS0 sevyn.slot=${bootSlot}`,
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
      `socket,id=appd,path=${appdSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=appd",
      "-chardev",
      `socket,id=upd,path=${updSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=upd",
      // The AI daemon's control serial (ttyS4): PING/LIST/SELECT/
      // STATUS/ASK, replies as AID log lines on the console. QEMU's
      // q35 machine caps ISA serial ports at 4 (ttyS0-3 are already
      // taken), so aid rides a PCI serial card — the guest kernel
      // has 8250_pci built in, and PCI UARTs enumerate as ttyS4+.
      "-chardev",
      `socket,id=aid,path=${aidSock},server=on,wait=off`,
      "-device",
      "pci-serial,chardev=aid",
      "-chardev",
      `socket,id=qmp,path=${qmpSock},server=on,wait=off`,
      "-mon",
      "chardev=qmp,mode=control",
      "-drive",
      `file=${DISK},format=raw,if=virtio`,
      "-device",
      "virtio-gpu-pci",
      "-device",
      "qemu-xhci",
      "-device",
      "usb-tablet",
      // User networking with the virtio NIC: the guest gets eth0
      // (10.0.2.15, gateway 10.0.2.2, slirp DNS 10.0.2.3). The plain
      // `-nic user` default is an e1000 with no guest driver — no
      // eth0 at all. The host's test-page server is reachable by the
      // guest at 10.0.2.2:18080.
      "-nic",
      "user,model=virtio-net-pci",
      "-no-reboot",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  qemu.stdout.pipe(logStream);
  qemu.stderr.pipe(logStream);
  const b = {
    tag,
    qemu,
    logPath,
    ctlSock,
    appdSock,
    updSock,
    aidSock,
    qmpSock,
    slot: bootSlot,
    exited: false,
    ctl: null,
    appd: null,
    upd: null,
    aid: null,
    qmp: null,
  };
  qemu.on("exit", () => {
    b.exited = true;
  });
  currentBoot = b;
  return b;
}

function waitForSocketFile(path, timeoutMs = 30000) {
  // QEMU creates its chardev sockets a moment after spawn; connecting
  // before the file exists fails ENOENT.
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await sleep(200);
    }
    return false;
  })();
}

async function connectSockets(b) {
  const qmpPath = join(OUT, `m5-${b.tag}-qmp.sock`);
  if (!(await waitForSocketFile(qmpPath))) {
    throw new Error(`QMP socket never appeared: ${qmpPath}`);
  }
  // The socket file can appear a beat before QEMU's monitor is
  // listening; retry the connect (a failed attempt is discarded).
  let qmp = null;
  const deadline = Date.now() + 30000;
  for (;;) {
    qmp = new QMP(qmpPath);
    try {
      await qmp.ready();
      break;
    } catch (e) {
      try {
        qmp.close();
      } catch {}
      if (Date.now() >= deadline) throw e;
      await sleep(200);
    }
  }
  await qmp.capabilities();
  b.qmp = qmp;
  const connect = async (path) => {
    if (!(await waitForSocketFile(path))) {
      throw new Error(`control socket never appeared: ${path}`);
    }
    // The file can appear a beat before the listener is ready.
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.connect(path);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
      } catch (e) {
        if (Date.now() >= deadline) throw e;
        await sleep(200);
      }
    }
  };
  b.ctl = await connect(join(OUT, `m5-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m5-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m5-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m5-${b.tag}-aid.sock`));
}

async function waitExit(b, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (b.exited) return true;
    await sleep(500);
  }
  return b.exited;
}

function closeBoot(b) {
  try {
    b.qmp?.close();
  } catch {}
  for (const s of [b.ctl, b.appd, b.upd, b.aid]) {
    try {
      s?.destroy();
    } catch {}
  }
  try {
    b.qemu.kill("SIGKILL");
  } catch {}
}

// Wait for the M5 boot markers on the console. SEVYNOS_M5_READY is
// last in init (after the net probe), so waiting for it first implies
// the M4.5 markers are already in the log.
async function waitReady(b, version) {
  const ready5 = await waitForLog(b.logPath, /SEVYNOS_M5_READY/, 300000);
  if (!ready5) return null;
  const ready45 = await waitForLog(b.logPath, /SEVYNOS_M4_5_READY/, 30000);
  const ready = await waitForLog(b.logPath, /SEVYNOS_M4_READY/, 30000);
  const marker = await waitForLog(
    b.logPath,
    new RegExp(
      `SEVYNOS_M4_SLOT ${b.slot} VERSION ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    30000,
  );
  const serving = await waitForLog(b.logPath, /M4 init: code-server serving/, 30000);
  const good = await waitForLog(
    b.logPath,
    new RegExp(`UPDATE SLOT GOOD ${b.slot}`),
    30000,
  );
  const netIf = await waitForLog(b.logPath, /M5 init: interface: eth0/, 30000);
  return { ready5, ready45, ready, marker, serving, good, netIf };
}

// Drive appd over its control serial; replies arrive as APPD log
// lines on the console (the boot log).
async function appdCmd(b, cmd, pattern, timeoutMs = 15000) {
  const before = logLines(b.logPath).length;
  b.appd.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

// Drive aid over its control serial; replies arrive as AID log
// lines on the console (the boot log).
async function aidCmd(b, cmd, pattern, timeoutMs = 15000) {
  const before = logLines(b.logPath).length;
  b.aid.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 30000) {
  const shotPath = join(OUT, `m5-shot-${b.tag}.ppm`);
  const settleStart = Date.now();
  while (Date.now() - settleStart < timeoutMs) {
    try {
      const img = await shot(b.qmp, shotPath);
      const topBar = countColor(img, 21, 21, 28, 10, {
        x0: 0,
        y0: 0,
        x1: img.width,
        y1: 48,
      });
      const dockBg = countColor(img, 16, 16, 20, 10, {
        x0: 0,
        y0: 672,
        x1: img.width,
        y1: 768,
      });
      if (topBar > 10000 && dockBg > 2000) return img;
    } catch {
      // No readable frame yet; keep polling.
    }
    await sleep(1000);
  }
  return null;
}

// Poll screendumps until `pred(img)` returns a truthy count, or time
// out. Returns { count, img } on success, null on timeout.
async function pollPixels(b, name, pred, timeoutMs = 120000) {
  const shotPath = join(OUT, `m5-shot-${name}.ppm`);
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const img = await shot(b.qmp, shotPath);
      const n = pred(img);
      last = n;
      if (n) return { count: n, img };
    } catch {
      // No readable frame yet; keep polling.
    }
    await sleep(2000);
  }
  return { count: last, img: null };
}

// --- the host test-page server ------------------------------------------
// Serves the two test pages on 127.0.0.1:18080; the guest reaches them
// at 10.0.2.2:18080. Both pages paint their FULL viewport one flat
// colour (red / green): any visible sliver of the Chromium window is
// detectable in a screendump and clickable to raise it, even with
// the Terminal window on top — the old build's "browser dead" failure
// would show nothing at all. The white heading proves text paints
// too. Page A is the render proof; page B is the Browser-app
// navigation proof.
const PAGE_A = `<!doctype html><html><head><title>SevynOS M5 Test Page</title><style>
body { margin: 0; background: #ff0000; font-family: sans-serif; }
h1 { color: #ffffff; font-size: 28px; margin: 24px 0 0 50px; }
</style></head><body><h1>SevynOS M5 Test Page</h1></body></html>`;
const PAGE_B = `<!doctype html><html><head><title>Second Page</title><style>
body { margin: 0; background: #00c853; font-family: sans-serif; }
h1 { color: #ffffff; font-size: 28px; margin: 24px 0 0 50px; }
</style></head><body><h1>Second Page</h1></body></html>`;

function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/m5-page.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_A);
    } else if (req.url === "/m5-page2.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_B);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(HTTP_PORT, "127.0.0.1", () => resolve(server));
  });
}

// Count a colour inside `rect`, skipping the pixels inside
// `exclude` (used to count the IDE workbench inside Chromium's
// viewport while the Terminal window sits on top of part of it).
function countColorInRect(img, r, g, b, tol, rect, exclude = null) {
  const { width: W, pixels } = img;
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      if (
        exclude &&
        x >= exclude.x0 &&
        x < exclude.x1 &&
        y >= exclude.y0 &&
        y < exclude.y1
      ) {
        continue;
      }
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

// Bounding box of a colour in the frame (null when absent). The test
// pages paint the full viewport one flat colour, so the box is the
// visible part of Chromium's viewport — clickable to raise it.
function findColorBBox(img, r, g, b, tol = 10) {
  const { width: W, height: H, pixels } = img;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pixels[i] - r) <= tol &&
        Math.abs(pixels[i + 1] - g) <= tol &&
        Math.abs(pixels[i + 2] - b) <= tol
      ) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1 };
}

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m5-image.sh first`,
      );
      process.exit(1);
    }
  }
  const versionV1 = readFileSync(join(OUT, "os-version"), "utf8").trim();
  let internetSkipped = false;

  // 0. Setup: data disk (slot A = the built image) + the host
  // test-page server.
  await execAsync("python3", [
    join(ROOT, "image", "make-data-disk.py"),
    "--kernel",
    join(OUT, "vmlinuz"),
    "--initramfs",
    join(OUT, "initramfs.cpio.gz"),
    "--version",
    versionV1,
    "--out",
    DISK,
  ]);
  check("setup: data disk created (slot A = built image)", existsSync(DISK));
  const state0 = await readState();
  check(
    "setup: slot state starts at A/A/0",
    state0.active === "A" &&
      state0.good === "A" &&
      state0.attempts === 0 &&
      state0.version === versionV1,
    JSON.stringify(state0),
  );
  const server = await startTestServer();
  check("setup: host test-page server on 127.0.0.1:18080", true);

  // 1. Boot.
  const b = await boot("1");
  await connectSockets(b);
  check("boot: QMP + control serials connected", true);
  const r1 = await waitReady(b, versionV1);
  check("boot: M5 ready (SEVYNOS_M5_READY)", !!r1?.ready5);
  check("boot: M4.5 stack intact (SEVYNOS_M4_5_READY)", !!r1?.ready45);
  check("boot: M4 stack intact (SEVYNOS_M4_READY)", !!r1?.ready);
  check(
    "boot: slot/version marker (A, v1)",
    !!r1?.marker && r1.marker.includes(`VERSION ${versionV1}`),
    r1?.marker || "(no marker)",
  );
  check("boot: code-server serving", !!r1?.serving, r1?.serving || "(no serving line)");
  check("boot: slot A marked good", !!r1?.good);
  check("boot: init net probe found eth0", !!r1?.netIf, r1?.netIf || "(no M5 init line)");
  const img1 = await screenSettled(b);
  check(
    "boot: shell on screen (top bar + dock)",
    !!img1,
    img1 ? `${img1.width}x${img1.height}` : "no settled frame in 30s",
  );
  {
    const pong = await appdCmd(b, "PING", /APPD PONG/);
    check("boot: appd answers PING (M3 stack intact)", !!pong);
  }
  {
    const pong = await aidCmd(b, "PING", /AID PONG/);
    check("boot: aid answers PING on its control serial", !!pong);
  }

  // Input helpers (QMP input-send-event, as m3-check).
  const toAbs = (px, size) => Math.round((px / size) * 32767);
  const moveTo = async (x, y, w, h) => {
    await b.qmp.input([
      { type: "abs", data: { axis: "x", value: toAbs(x, w) } },
      { type: "abs", data: { axis: "y", value: toAbs(y, h) } },
    ]);
  };
  const click = async () => {
    await b.qmp.input([{ type: "btn", data: { button: "left", down: true } }]);
    await sleep(120);
    await b.qmp.input([{ type: "btn", data: { button: "left", down: false } }]);
  };
  const keyDown = async (qcode) => {
    await b.qmp.input([
      { type: "key", data: { down: true, key: { type: "qcode", data: qcode } } },
    ]);
  };
  const keyUp = async (qcode) => {
    await b.qmp.input([
      { type: "key", data: { down: false, key: { type: "qcode", data: qcode } } },
    ]);
  };
  const keyTap = async (qcode) => {
    await keyDown(qcode);
    await sleep(120);
    await keyUp(qcode);
  };
  const key = async (qcode) => {
    await keyTap(qcode);
    await sleep(180);
  };
  // QKeyCode names for the characters the check types. Shifted
  // characters hold left Shift while tapping the base key.
  const QCODE_FOR = {
    " ": "spc",
    "/": "slash",
    ".": "dot",
    "-": "minus",
  };
  const SHIFT_QCODE_FOR = {
    ":": "semicolon",
    "?": "slash",
    "=": "equal",
    "&": "7",
    "%": "5",
  };
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") QCODE_FOR[c] = c;
  const typeText = async (s) => {
    for (const ch of s) {
      if (ch >= "A" && ch <= "Z") {
        await keyDown("shift");
        await keyTap(QCODE_FOR[ch.toLowerCase()]);
        await keyUp("shift");
        await sleep(60);
        continue;
      }
      const shiftQc = SHIFT_QCODE_FOR[ch];
      if (shiftQc) {
        await keyDown("shift");
        await keyTap(shiftQc);
        await keyUp("shift");
        await sleep(60);
        continue;
      }
      const qc = QCODE_FOR[ch];
      if (!qc) throw new Error(`m5-check: no QKeyCode for ${JSON.stringify(ch)}`);
      await keyTap(qc);
      await sleep(60);
    }
  };
  // Type a command into the Terminal's input and submit it; wait for
  // the host's EXEC log line (proves the command ran) and, when
  // given, a JS marker pattern from the app. The EXEC wait is 120 s:
  // typing under TCG is slow. `browser open` returns in seconds now
  // (launch-and-return: "opened" on a fast start, "launched" on a
  // slow one — the caller polls `browser status` / `browser tabs`
  // for readiness), so the 120 s is typing headroom, not a CDP wait.
  // execRe overrides the expected EXEC line (the default is `-> 0`);
  // pass /-> [01]/ when the command legitimately exits 1, e.g.
  // `browser status` while Chromium is still starting.
  const termCmd = async (cmd, marker = null, execRe = null, execTimeoutMs = 120000) => {
    const before = logLines(b.logPath).length;
    await typeText(cmd);
    await key("ret");
    const exec = await waitForLog(
      b.logPath,
      execRe ??
        new RegExp(`EXEC sevyn ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> 0`),
      execTimeoutMs,
      before,
    );
    let hit = null;
    if (marker) {
      hit = await waitForLog(b.logPath, marker, 15000, before);
    }
    return { exec, hit };
  };
  // Poll `browser status` until the marker reports Chromium running
  // (the open returns "launched" on a slow start, so the check must
  // wait for CDP before asserting on tabs or pixels). Retries up to
  // `attempts` times; returns the marker line or null.
  const pollBrowserReady = async (attempts = 6) => {
    for (let i = 0; i < attempts; i++) {
      // Chromium takes keyboard focus when its window opens, so the
      // Terminal must be raised + refocused before typing into it.
      await refocusTerminal();
      const { hit } = await termCmd(
        "browser status",
        /TERMINAL browser-status running=yes/,
        /EXEC sevyn browser status -> [01]/,
        20000,
      );
      if (hit) return hit;
      await sleep(5000);
    }
    return null;
  };
  // Run `browser tabs` until the marker line matches `pattern`
  // (the title arrives over CDP once the page loads). Retries up to
  // `attempts` times; returns the marker line or null.
  const pollTabsTitle = async (pattern, attempts = 4) => {
    for (let i = 0; i < attempts; i++) {
      const { hit } = await termCmd("browser tabs", pattern);
      if (hit) return hit;
      await sleep(5000);
    }
    return null;
  };
  const parseTabsMarker = (line) => {
    // Titles contain spaces ('SevynOS M5 Test Page'), so [^ ]* would
    // stop at the first one and the tab id would never be recorded.
    const titles = line.match(/titles=(.*?) ids=/)?.[1]?.split("|") ?? [];
    const ids = line.match(/ids=(\S+)/)?.[1]?.split("|") ?? [];
    return { titles, ids };
  };
  // Click the Terminal's input row to give it keyboard focus again
  // (Chromium's window takes focus when it opens). The click is at
  // the LEFT end of the input row: the Terminal window is recorded
  // from the first shot and never moves, and the left end stays
  // visible under the most window placements.
  let termPos = null;
  const refocusTerminal = async () => {
    if (!termPos) return false;
    const shotNow = await shot(b.qmp, join(OUT, "m5-shot-refocus.ppm"));
    // Raise first: Chromium's window is cascaded on top of the
    // Terminal when it opens, so the input row may be covered. The
    // title bar peeks out above the cascaded window — clicking it
    // raises the Terminal. Then click the input row to focus the
    // command input for typing.
    await moveTo(termPos.left + 50, termPos.top + 15, shotNow.width, shotNow.height);
    await sleep(300);
    await click();
    await sleep(300);
    await moveTo(termPos.left + 50, termPos.top + 482, shotNow.width, shotNow.height);
    await sleep(300);
    await click();
    await sleep(300);
    return true;
  };
  // Raise Chromium by clicking the middle of its visible viewport
  // (the test pages paint the full viewport one flat colour, so the
  // colour's bounding box IS the visible viewport). Returns the
  // post-click frame + colour count, or null when the colour is
  // nowhere on screen.
  const raiseChromium = async (r, g, bl, name) => {
    // Poll for the colour: the page may not have painted yet when
    // the navigation confirms. Retry for ~60s before giving up.
    let before = null;
    let box = null;
    for (let i = 0; i < 12; i++) {
      before = await shot(b.qmp, join(OUT, `m5-shot-${name}-before.ppm`));
      box = findColorBBox(before, r, g, bl);
      if (box) break;
      await sleep(5000);
    }
    if (!box) return null;
    await moveTo(
      Math.round((box.x0 + box.x1) / 2),
      Math.round((box.y0 + box.y1) / 2),
      before.width,
      before.height,
    );
    await sleep(300);
    await click();
    await sleep(1000);
    const after = await shot(b.qmp, join(OUT, `m5-shot-${name}.ppm`));
    return { img: after, count: countColor(after, r, g, bl) };
  };

  // 2. Network via the Terminal.
  {
    const launched = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
    check("terminal: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) terminal/,
      30000,
    );
    check("terminal: host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotTerm = await shot(b.qmp, join(OUT, "m5-shot-terminal.ppm"));
  // The Terminal window header is #111827.
  const termHeader = findWindowHeader(shotTerm, 17, 24, 39);
  check("terminal: window on screen (header found)", !!termHeader);
  if (termHeader) {
    termPos = termHeader;
    await moveTo(
      termHeader.left + 200,
      termHeader.top + 482,
      shotTerm.width,
      shotTerm.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
  }
  {
    const { exec, hit } = await termCmd(
      "net status",
      /TERMINAL net-status interface=eth0 wifi=on/,
    );
    check("net: `net status` runs (EXEC 0)", !!exec, exec || "");
    check(
      "net: eth0 up, wifi on",
      !!hit,
      hit || "(no net-status marker — check the interface/gateway in the log)",
    );
  }
  {
    const { exec, hit } = await termCmd(
      "net dns localhost",
      /TERMINAL net-dns host=localhost ip=127\.0\.0\.1/,
    );
    check("net: `net dns localhost` runs (EXEC 0)", !!exec, exec || "");
    check("net: localhost resolves to 127.0.0.1", !!hit, hit || "");
  }
  if (INTERNET) {
    const { exec, hit } = await termCmd(
      "net dns example.com",
      /TERMINAL net-dns host=example\.com ip=\d+\.\d+\.\d+\.\d+/,
    );
    check("net: `net dns example.com` runs (EXEC 0)", !!exec, exec || "");
    check("net: example.com resolves over the guest DNS", !!hit, hit || "");
  } else {
    internetSkipped = true;
    check(
      "net: `net dns example.com` SKIPPED (SEVYN_V2_M5_INTERNET=0 — no guest internet in the sandbox; CI is the gate)",
      true,
      "skipped",
    );
  }

  // 3. The acceptance test: the local page must RENDER.
  // `browser open` launches Chromium and returns at once
  // ("opened" on a fast start, "launched" on a slow one — the URL
  // opens as Chromium's first tab once it is up); the check polls
  // `browser status` until CDP answers, then polls the screen for
  // the red viewport. The page is served by the host over the guest
  // network. Chromium takes focus when it opens, so the red viewport
  // is polled straight after the open — before the Terminal is
  // refocused. The viewport box is recorded for the IDE step.
  let chromiumViewport = null;
  let redTabId = null;
  {
    const { exec } = await termCmd("browser open http://10.0.2.2:18080/m5-page.html");
    check("browser: `browser open` the local page runs (EXEC 0)", !!exec, exec || "");
  }
  {
    const ready = await pollBrowserReady();
    check(
      "browser: Chromium answers CDP after the open",
      !!ready,
      ready || "(browser status never reported running=yes)",
    );
  }
  {
    const found = await pollPixels(
      b,
      "red",
      (img) => {
        const n = countColor(img, 255, 0, 0);
        if (n > 40000) {
          const box = findColorBBox(img, 255, 0, 0);
          if (box) chromiumViewport = box;
        }
        return n > 40000 ? n : 0;
      },
      180000,
    );
    check(
      "browser: the local page RENDERS (red viewport on screen)",
      !!found?.img,
      found?.img ? `red=${found.count}px` : `red=${found?.count ?? 0}px after 180s`,
    );
    // Re-record the viewport from a settled frame: the poll's first
    // over-threshold frame can be a half-painted one.
    if (found?.img) {
      const settled = await shot(b.qmp, join(OUT, "m5-shot-red-settled.ppm"));
      const box = findColorBBox(settled, 255, 0, 0);
      if (box) chromiumViewport = box;
    }
  }
  await refocusTerminal();
  {
    const marker = await pollTabsTitle(
      /TERMINAL browser-tabs n=\d+ titles=.*SevynOS M5 Test Page/,
    );
    check(
      "browser: CDP sees the local page's title",
      !!marker,
      marker || "(no tabs marker with the title)",
    );
    if (marker) {
      const { titles, ids } = parseTabsMarker(marker);
      const i = titles.indexOf("SevynOS M5 Test Page");
      if (i >= 0 && ids[i]) redTabId = ids[i];
    }
  }
  {
    const { exec, hit } = await termCmd(
      "browser status",
      /TERMINAL browser-status running=yes tabs=1/,
    );
    check("browser: `browser status` runs (EXEC 0)", !!exec, exec || "");
    check("browser: Chromium running, 1 tab", !!hit, hit || "");
  }

  // 4. A real public page over the internet (gated like step 2).
  if (INTERNET) {
    {
      const { exec } = await termCmd("browser open https://example.com");
      check("browser: `browser open` example.com runs (EXEC 0)", !!exec, exec || "");
    }
    // The page loads over the internet — give it time, then confirm
    // the title over CDP before looking at pixels.
    await sleep(15000);
    await refocusTerminal();
    {
      const marker = await pollTabsTitle(
        /TERMINAL browser-tabs n=\d+ titles=.*Example Domain/,
      );
      check(
        "browser: CDP sees the Example Domain title",
        !!marker,
        marker || "(no tabs marker with the title)",
      );
    }
    // Opening a new tab in an already-running Chromium does not raise
    // its window above the Terminal, so a full-screen white poll sees
    // the Terminal instead of the page. Click the visible left strip
    // of Chromium's viewport (left of the Terminal window) to raise
    // it, then count white inside the viewport (same pattern as the
    // IDE step below).
    // M9: re-detect the Terminal header fresh before computing the
    // strip — `termPos` was recorded when the Terminal launched, and
    // the refocus clicks since can nudge the window; a stale left
    // edge puts the strip click inside the Terminal instead of on
    // Chromium, so the white poll sees the Terminal for 180s.
    if (chromiumViewport && termPos) {
      const shotFresh = await shot(b.qmp, join(OUT, "m5-shot-strip-fresh.ppm"));
      const termFresh = findWindowHeader(shotFresh, 17, 24, 39);
      if (termFresh) termPos = termFresh;
      const stripX = Math.round((chromiumViewport.x0 + termPos.left) / 2);
      const stripY = Math.round((chromiumViewport.y0 + chromiumViewport.y1) / 2);
      // M9: the shell flex-sizes to the surface (no longer a fixed
      // 1024x768), so the screen is 1280x800 here — a moveTo scaled
      // for 1024x768 lands ~25% right of the strip and never raises
      // Chromium, so the white poll sees the Terminal instead. Scale
      // by the real frame size.
      const shotStrip = await shot(b.qmp, join(OUT, "m5-shot-strip.ppm"));
      await moveTo(stripX, stripY, shotStrip.width, shotStrip.height);
      await sleep(300);
      await click();
      await sleep(1000);
      // If the first click only focused Chromium without raising it
      // above the Terminal, click the strip once more.
      await moveTo(stripX, stripY, shotStrip.width, shotStrip.height);
      await sleep(300);
      await click();
      await sleep(1000);
      const found = await pollPixels(
        b,
        "example",
        (img) => {
          // example.com's background is #eeeeee (238,238,238), not
          // pure white — count both and take the larger.
          const n = Math.max(
            countColorInRect(img, 255, 255, 255, 15, chromiumViewport),
            countColorInRect(img, 238, 238, 238, 15, chromiumViewport),
          );
          return n > 100000 ? n : 0;
        },
        180000,
      );
      check(
        "browser: example.com renders (white page on screen)",
        !!found?.img,
        found?.img
          ? `white=${found.count}px in viewport ${JSON.stringify(chromiumViewport)}`
          : `white=${found?.count ?? 0}px after 180s`,
      );
    } else {
      check(
        "browser: example.com renders (white page on screen)",
        false,
        "no recorded Chromium viewport (the red page never rendered)",
      );
    }
    // The strip-click above gave Chromium keyboard focus — hand it
    // back to the Terminal so the IDE open below lands in its input.
    await refocusTerminal();
  } else {
    check("browser: example.com open SKIPPED (SEVYN_V2_M5_INTERNET=0)", true, "skipped");
    check(
      "browser: example.com render SKIPPED (SEVYN_V2_M5_INTERNET=0)",
      true,
      "skipped",
    );
    check(
      "browser: Example Domain title SKIPPED (SEVYN_V2_M5_INTERNET=0)",
      true,
      "skipped",
    );
  }

  // 5. Sevyn Code paints in a window (the M4 open item): the IDE
  // workbench over loopback, through the same Chromium/CDP path.
  // The workbench is a heavy JS app — give it time to paint, then
  // read its title over CDP and count its dark workbench inside
  // Chromium's recorded viewport (excluding the Terminal window,
  // which sits on top of part of it).
  {
    const { exec } = await termCmd("browser open http://127.0.0.1:8080/");
    check("browser: `browser open` the IDE runs (EXEC 0)", !!exec, exec || "");
  }
  await sleep(60000);
  await refocusTerminal();
  {
    const marker = await pollTabsTitle(
      /TERMINAL browser-tabs n=\d+ titles=.*(Visual Studio Code|code-server)/,
      12,
    );
    check(
      "ide: CDP sees the workbench title",
      !!marker,
      marker || "(no tabs marker with a workbench title)",
    );
  }
  if (chromiumViewport && termPos) {
    // Raise Chromium: click the visible left strip of its viewport
    // (left of the Terminal window) so the workbench comes forward.
    // M9: scale by the real frame size (see the example.com strip
    // click above) — the screen is 1280x800, not 1024x768.
    const stripX = Math.round((chromiumViewport.x0 + termPos.left) / 2);
    const stripY = Math.round((chromiumViewport.y0 + chromiumViewport.y1) / 2);
    const shotStripIde = await shot(b.qmp, join(OUT, "m5-shot-strip-ide.ppm"));
    await moveTo(stripX, stripY, shotStripIde.width, shotStripIde.height);
    await sleep(300);
    await click();
    await sleep(1000);
    const shotIde = await shot(b.qmp, join(OUT, "m5-shot-ide.ppm"));
    // The workbench renders LIGHT (white) in this image, not dark —
    // count both and pass when either paints the viewport.
    const dark = countColorInRect(shotIde, 30, 30, 30, 15, chromiumViewport);
    const light = countColorInRect(shotIde, 255, 255, 255, 15, chromiumViewport);
    check(
      "ide: the workbench paints inside Chromium's viewport",
      Math.max(dark, light) > 20000,
      `dark=${dark}px light=${light}px in viewport ${JSON.stringify(chromiumViewport)}`,
    );
  } else {
    check(
      "ide: the workbench paints inside Chromium's viewport",
      false,
      "no recorded Chromium viewport (the red page never rendered)",
    );
  }

  // 6. Tab switching: activate the first (red) tab again and the
  // red page comes back on screen.
  if (redTabId) {
    await refocusTerminal();
    const { exec } = await termCmd(`browser activate ${redTabId}`);
    check("browser: `browser activate` the red tab runs (EXEC 0)", !!exec, exec || "");
    const raised = await raiseChromium(255, 0, 0, "red-again");
    check(
      "browser: the red page comes back after the tab switch",
      !!raised && raised.count > 40000,
      raised ? `red=${raised.count}px` : "no red on screen",
    );
  } else {
    check(
      "browser: `browser activate` the red tab runs (EXEC 0)",
      false,
      "no red tab id recorded",
    );
    check(
      "browser: the red page comes back after the tab switch",
      false,
      "no red tab id recorded",
    );
  }

  // 7. The Browser app (tabs + address bar) drives the browser:
  // launch it, type the second test page's URL into its address
  // bar, and the green page renders in Chromium.
  {
    const launched = await appdCmd(b, "LAUNCH browser", /APPD LAUNCH OK browser/);
    check("browser-app: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) browser/,
      30000,
    );
    check("browser-app: host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotBrowser = await shot(b.qmp, join(OUT, "m5-shot-browser.ppm"));
  // The Browser window header is its registered colour #0ea5e9.
  const browserHeader = findWindowHeader(shotBrowser, 14, 165, 233);
  check("browser-app: window on screen (header found)", !!browserHeader);
  if (browserHeader) {
    // Address input: header (44) + tab strip (36), input centred in
    // its 44px row -> top + 44 + 36 + 22.
    await moveTo(
      browserHeader.left + 200,
      browserHeader.top + 102,
      shotBrowser.width,
      shotBrowser.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
    await typeText("http://10.0.2.2:18080/m5-page2.html");
    const before = logLines(b.logPath).length;
    await key("ret");
    // Tabs before this navigation: red + IDE (+ example.com when
    // the internet steps ran). The new page adds one more.
    const expectedTabs = (INTERNET ? 3 : 2) + 1;
    const tabs = await waitForLog(
      b.logPath,
      new RegExp(`BROWSER tabs ${expectedTabs}`),
      60000,
      before,
    );
    check(
      `browser-app: the address bar opens the second page (BROWSER tabs ${expectedTabs})`,
      !!tabs,
      tabs || `(no BROWSER tabs ${expectedTabs} line)`,
    );
    const raised = await raiseChromium(0, 200, 83, "green");
    check(
      "browser-app: the green page renders in Chromium",
      !!raised && raised.count > 40000,
      raised ? `green=${raised.count}px` : "no green on screen",
    );
  } else {
    check(
      "browser-app: the address bar opens the second page",
      false,
      "no Browser window",
    );
    check("browser-app: the green page renders in Chromium", false, "no Browser window");
  }

  // Final frame + clean poweroff.
  const shotFinal = join(OUT, "m5-shot-final.ppm");
  const imgFinal = await shot(b.qmp, shotFinal);
  const fTop = countColor(imgFinal, 21, 21, 28, 10, {
    x0: 0,
    y0: 0,
    x1: imgFinal.width,
    y1: 48,
  });
  const fDock = countColor(imgFinal, 16, 16, 20, 10, {
    x0: 0,
    y0: 672,
    x1: imgFinal.width,
    y1: 768,
  });
  check(
    "screen: shell still visible at end",
    fTop > 10000 && fDock > 2000,
    `topBar=${fTop} dockBg=${fDock}`,
  );
  b.ctl.write("POWEROFF\n");
  const exited = await waitExit(b, 30000);
  check("shutdown: guest powers off on request", exited);
  closeBoot(b);
  try {
    server.close();
  } catch {}
  finish(
    checks.every((c) => c.ok),
    {
      internet: INTERNET,
      internet_skipped: internetSkipped,
      screen: { width: imgFinal.width, height: imgFinal.height },
    },
  );
}

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m5-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M5 CHECK PASSED" : "M5 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M5 check crashed:", e);
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  const result = {
    pass: false,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    error: String(e),
  };
  try {
    writeFileSync(join(OUT, "m5-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
