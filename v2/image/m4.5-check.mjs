// M4.5 check: boot the SevynOS v2 M4.5 image in QEMU and prove the
// milestone — the AI connector.
//
//   1. Boot: SEVYNOS_M4_5_READY + AID READY (backends echo-ai,
//      plan-ai, selected echo-ai) + the M4 stack still intact
//      (SEVYNOS_M4_READY, code-server serving, slot marked good).
//      The shell is on screen (top bar + dock settled), appd answers
//      PING, aid answers PING on its control serial.
//   2. Backend A (echo-ai, the default) via the Terminal: `ai
//      status` selects echo-ai; `ai ask set volume 42` drives a
//      system value through the permission (STATUSD SET + the shell
//      tray repaints); `ai ask launch files` launches an app through
//      the permission (APPD LAUNCH OK + the Files window on screen).
//   3. The permission boundary: `ai ask uninstall files and reboot`
//      is refused (allowed=0 denied=2, AID DENIED lines for
//      app.uninstall + system.reboot), nothing reaches appd, and
//      files is still installed.
//   4. Swap through the Settings UI: Tab x5 to plan-ai + Enter, the
//      SETTINGS ai=plan-ai log line, and the aid control serial
//      reads the new selection back (STATUS).
//   5. Backend B (plan-ai) via the Terminal, same boot, no rebuild:
//      `ai ask list open files and set the volume to 55` plans the goal
//      differently (allowed=3: LIST + LAUNCH + SET) and drives it.
//   6. Clean poweroff.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM
// format. statusd takes commands on the first control serial (ttyS1);
// appd takes LAUNCH/CLOSE/LIST on the second (ttyS2); the updater
// takes STATUS/CHECK/APPLY on the third (ttyS3); aid takes
// PING/LIST/SELECT/STATUS/ASK on the fourth (ttyS4). Results go to
// m4.5-check.json; boot logs, screendumps and the data disk stay in
// the build dir as artifacts.
//
// Usage: node v2/image/m4.5-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M4_5_TIMEOUT (seconds, default 900).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m4.5-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M4_5_TIMEOUT || 900);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";

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
  const kern = join(OUT, `m4.5-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m4.5-boot-${tag}-initramfs.cpio.gz`);
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
  const logPath = join(OUT, `m4.5-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `m4.5-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m4.5-${tag}-appd.sock`);
  const updSock = join(OUT, `m4.5-${tag}-upd.sock`);
  const aidSock = join(OUT, `m4.5-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m4.5-${tag}-qmp.sock`);
  const qemu = spawn(
    QEMU,
    [
      "-machine",
      "q35",
      "-m",
      // 4096 (was 2048): the M5 image carries Chromium + code-server,
      // so its initramfs cannot decompress in 2 GB — the guest
      // panics with 'VFS: Unable to mount root fs'. The m5-check
      // already boots the same image at -m 4096.
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
      "-nic",
      "none",
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
  const qmpPath = join(OUT, `m4.5-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m4.5-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m4.5-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m4.5-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m4.5-${b.tag}-aid.sock`));
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

// Wait for the M4.5 boot markers on the console. SEVYNOS_M4_5_READY
// is last in init (after the AI probe), so waiting for it first
// implies the M4 markers are already in the log.
async function waitReady(b, version) {
  const ready45 = await waitForLog(b.logPath, /SEVYNOS_M4_5_READY/, 300000);
  if (!ready45) return null;
  const aidReady = await waitForLog(
    b.logPath,
    /AID ready .*backends=echo-ai,plan-ai selected=echo-ai/,
    30000,
  );
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
  return { ready45, aidReady, ready, marker, serving, good };
}

// Drive the updater over its control serial; replies arrive as
// UPDATE log lines on the console (the boot log).
async function updCmd(b, cmd, pattern, timeoutMs = 60000) {
  const before = logLines(b.logPath).length;
  b.upd.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

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

// Count pixels that differ between two frames inside a box (any
// channel > 10 apart). The tray repaint check: the volume text in
// the shell's top bar changes when the AI sets a new volume, so the
// top-bar region must differ between the before/after shots.
function diffPixels(a, b, box) {
  const { width: W, pixels: pa } = a;
  const { pixels: pb } = b;
  let n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pa[i] - pb[i]) > 10 ||
        Math.abs(pa[i + 1] - pb[i + 1]) > 10 ||
        Math.abs(pa[i + 2] - pb[i + 2]) > 10
      ) {
        n++;
      }
    }
  }
  return n;
}

// Poll screendumps until the top bar differs from `before` by more
// than `minDiff` pixels (the shell repainted the tray), or time out.
async function trayRepainted(b, before, minDiff = 50, timeoutMs = 10000) {
  const shotPath = join(OUT, `m4.5-shot-tray.ppm`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const img = await shot(b.qmp, shotPath);
      const d = diffPixels(before, img, {
        x0: 0,
        y0: 0,
        x1: img.width,
        y1: 48,
      });
      if (d > minDiff) return d;
    } catch {
      // No readable frame yet; keep polling.
    }
    await sleep(1000);
  }
  return 0;
}

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 30000) {
  const shotPath = join(OUT, `m4.5-shot-${b.tag}.ppm`);
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

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m4.5-image.sh first`,
      );
      process.exit(1);
    }
  }
  const versionV1 = readFileSync(join(OUT, "os-version"), "utf8").trim();

  // 0. Setup: data disk (slot A = the built image).
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

  // 1. Boot.
  const b = await boot("1");
  await connectSockets(b);
  check("boot: QMP + control serials connected", true);
  const r1 = await waitReady(b, versionV1);
  check("boot: AI daemon ready (SEVYNOS_M4_5_READY)", !!r1?.ready45);
  check(
    "boot: aid found both backends, echo-ai selected",
    !!r1?.aidReady,
    r1?.aidReady || "(no AID READY line)",
  );
  check("boot: M4 stack intact (SEVYNOS_M4_READY)", !!r1?.ready);
  check(
    "boot: slot/version marker (A, v1)",
    !!r1?.marker && r1.marker.includes(`VERSION ${versionV1}`),
    r1?.marker || "(no marker)",
  );
  check("boot: code-server serving", !!r1?.serving, r1?.serving || "(no serving line)");
  check("boot: slot A marked good", !!r1?.good);
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
  // QKeyCode names for the characters the check types.
  const QCODE_FOR = {
    " ": "spc",
    "/": "slash",
    ".": "dot",
    "-": "minus",
  };
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") QCODE_FOR[c] = c;
  const typeText = async (s) => {
    for (const ch of s) {
      if (ch >= "A" && ch <= "Z") {
        // Uppercase: hold left Shift (QKeyCode "shift") and tap the
        // lowercase key; the host tracks Shift and maps the shifted
        // character.
        await keyDown("shift");
        await keyTap(QCODE_FOR[ch.toLowerCase()]);
        await keyUp("shift");
        await sleep(60);
        continue;
      }
      const qc = QCODE_FOR[ch];
      if (!qc) throw new Error(`m4.5-check: no QKeyCode for ${JSON.stringify(ch)}`);
      await keyTap(qc);
      await sleep(60);
    }
  };
  // Type a command into the Terminal's input and submit it; wait for
  // the host's EXEC log line (proves the command ran) and, when
  // given, a JS marker pattern from the app.
  const termCmd = async (cmd, marker = null) => {
    const before = logLines(b.logPath).length;
    await typeText(cmd);
    await key("ret");
    const exec = await waitForLog(
      b.logPath,
      new RegExp(`EXEC sevyn ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> 0`),
      // 60 s, not 30: typing a long command under TCG is slow (each
      // QMP key event is a round trip), and the ASK itself spawns a
      // host for the LAUNCH before the exec returns.
      60000,
      before,
    );
    let hit = null;
    if (marker) {
      hit = await waitForLog(b.logPath, marker, 15000, before);
    }
    return { exec, hit };
  };

  // 2. Backend A (echo-ai, the default) via the Terminal.
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
  const shotTerm = await shot(b.qmp, join(OUT, "m4.5-shot-terminal.ppm"));
  // The Terminal window header is #111827.
  const termHeader = findWindowHeader(shotTerm, 17, 24, 39);
  check("terminal: window on screen (header found)", !!termHeader);
  if (termHeader) {
    // Click the prompt input (bottom row of the 800x500 window).
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
      "ai status",
      /TERMINAL ai-status selected=echo-ai/,
    );
    check("ai-a: `ai status` runs (EXEC 0)", !!exec, exec || "");
    check("ai-a: echo-ai is the selected backend", !!hit, hit || "");
  }
  // The tray repaint check needs a settled before-shot of the top bar
  // (taken now, with the volume still at its boot value).
  const imgBeforeVol = await shot(b.qmp, join(OUT, "m4.5-shot-tray-before.ppm"));
  {
    const { exec, hit } = await termCmd(
      "ai ask set volume 42",
      /TERMINAL ai-ask allowed=1 denied=0/,
    );
    check("ai-a: `ai ask set volume 42` runs (EXEC 0)", !!exec, exec || "");
    check("ai-a: echo-ai allowed the SET (allowed=1 denied=0)", !!hit, hit || "");
    const setLine = await waitForLog(b.logPath, /STATUSD SET volume 42/, 15000);
    check("ai-a: statusd got SET volume 42", !!setLine, setLine || "");
    const repainted = await trayRepainted(b, imgBeforeVol);
    check(
      "ai-a: shell tray repainted on the new volume",
      repainted > 50,
      `changed=${repainted}px`,
    );
  }
  {
    // Capture `before` first: the launch wait must find THIS launch,
    // not the stale line from the earlier step (waitForLog defaults
    // to searching the whole log).
    const beforeLaunch = logLines(b.logPath).length;
    const { exec, hit } = await termCmd(
      "ai ask launch files",
      /TERMINAL ai-ask allowed=1 denied=0/,
    );
    check("ai-a: `ai ask launch files` runs (EXEC 0)", !!exec, exec || "");
    check("ai-a: echo-ai allowed the LAUNCH (allowed=1 denied=0)", !!hit, hit || "");
    const launched = await waitForLog(
      b.logPath,
      // launch_app logs this for every launch, whatever path drove
      // it. (The "APPD LAUNCH OK" line is control-serial-only; a
      // socket launch — the path the AI daemon uses — replies OK
      // launched without logging it.)
      /APPD launched files \(pid \d+\)/,
      15000,
      beforeLaunch,
    );
    check("ai-a: appd launched files for the AI", !!launched, launched || "");
    // Wait for the app to mount in its own runtime BEFORE the shot:
    // the LAUNCH line fires when appd forks the host, and the window
    // does not exist until the bundle loads and presents (the first
    // run's 800 ms sleep raced it).
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) files/,
      30000,
      beforeLaunch,
    );
    check("ai-a: Files host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotFilesA = await shot(b.qmp, join(OUT, "m4.5-shot-files-a.ppm"));
  // The Files window header is its registered colour #3b82f6.
  const filesHeaderA = findWindowHeader(shotFilesA, 59, 130, 246);
  check("ai-a: Files window on screen after the AI launch", !!filesHeaderA);
  {
    const closed = await appdCmd(b, "CLOSE files", /APPD CLOSE OK files/);
    check("ai-a: CLOSE files accepted", !!closed, closed || "");
  }

  // 3. The permission boundary: uninstall + reboot are refused, and
  // nothing outside the grant ever reaches appd. Re-click the
  // Terminal input first: closing Files stole keyboard focus, and
  // typing straight after the CLOSE drops the first keystrokes (the
  // first run lost "ai " this way and executed a bare `ask`).
  const shotTermB = await shot(b.qmp, join(OUT, "m4.5-shot-terminal-b.ppm"));
  const termHeaderB = findWindowHeader(shotTermB, 17, 24, 39);
  check("boundary: Terminal window still up for the boundary step", !!termHeaderB);
  if (termHeaderB) {
    await moveTo(
      termHeaderB.left + 200,
      termHeaderB.top + 482,
      shotTermB.width,
      shotTermB.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
  }
  {
    const before = logLines(b.logPath).length;
    const { exec, hit } = await termCmd(
      "ai ask uninstall files and reboot",
      /TERMINAL ai-ask allowed=0 denied=2/,
    );
    check(
      "boundary: `ai ask uninstall files and reboot` runs (EXEC 0)",
      !!exec,
      exec || "",
    );
    check(
      "boundary: nothing allowed, both refused (allowed=0 denied=2)",
      !!hit,
      hit || "",
    );
    const deniedUn = await waitForLog(
      b.logPath,
      /AID DENIED echo-ai UNINSTALL files \(app\.uninstall\)/,
      15000,
      before,
    );
    check("boundary: UNINSTALL refused as app.uninstall", !!deniedUn, deniedUn || "");
    const deniedRb = await waitForLog(
      b.logPath,
      /AID DENIED echo-ai REBOOT \(system\.reboot\)/,
      15000,
      before,
    );
    check("boundary: REBOOT refused as system.reboot", !!deniedRb, deniedRb || "");
    const afterLines = logLines(b.logPath).slice(before);
    check(
      "boundary: nothing reached appd (no APPD UNINSTALL)",
      !afterLines.some((l) => /APPD UNINSTALL/.test(l)),
    );
    // The control-serial LIST logs "APPD LIST <id>|..." per app on
    // the console (the socket reply format "APP <id>|..." never
    // reaches the log).
    const listed = await appdCmd(b, "LIST", /APPD LIST files\|/);
    check("boundary: files is still installed", !!listed, listed || "");
  }

  // 4. Swap through the Settings UI: Tab x5 to plan-ai + Enter, then
  // read the new selection back over the aid control serial.
  {
    const launched = await appdCmd(b, "LAUNCH settings", /APPD LAUNCH OK settings/);
    check("settings: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) settings/,
      30000,
    );
    check("settings: host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotSettings = await shot(b.qmp, join(OUT, "m4.5-shot-settings.ppm"));
  // The Settings window header is its registered colour #6b7280.
  // Click the header title (left of the X) to activate the surface.
  const settingsHeader = findWindowHeader(shotSettings, 107, 113, 128);
  check("settings: window on screen (header found)", !!settingsHeader);
  if (settingsHeader) {
    await moveTo(
      settingsHeader.left + 100,
      settingsHeader.top + 22,
      shotSettings.width,
      shotSettings.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
  }
  // M9: the Wi-Fi section comes first in Settings, so its Scan button
  // is focusable before the channel buttons — the focus order is now
  // [X, Scan, Nightly, Stable, echo-ai, plan-ai]. Tab x6 -> plan-ai.
  await key("tab");
  await key("tab");
  await key("tab");
  await key("tab");
  await key("tab");
  await key("tab");
  {
    const before = logLines(b.logPath).length;
    await key("ret");
    const hit = await waitForLog(b.logPath, /SETTINGS ai=plan-ai/, 15000, before);
    check("settings: plan-ai applies (SETTINGS ai=plan-ai)", !!hit, hit || "");
    const st = await aidCmd(
      b,
      "STATUS",
      /AID STATUS selected=plan-ai backends=echo-ai,plan-ai/,
    );
    check("settings: aid reads the new selection back (STATUS)", !!st, st || "");
  }
  {
    const closed = await appdCmd(b, "CLOSE settings", /APPD CLOSE OK settings/);
    check("settings: CLOSE accepted", !!closed, closed || "");
  }

  // 5. Backend B (plan-ai) via the Terminal: same boot, no rebuild,
  // no code change — the same connector, a different AI.
  const shotTerm2 = await shot(b.qmp, join(OUT, "m4.5-shot-terminal-2.ppm"));
  const termHeader2 = findWindowHeader(shotTerm2, 17, 24, 39);
  check("ai-b: Terminal window still up after the swap", !!termHeader2);
  if (termHeader2) {
    // Re-focus the Terminal input (Settings was on top).
    await moveTo(
      termHeader2.left + 200,
      termHeader2.top + 482,
      shotTerm2.width,
      shotTerm2.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
  }
  {
    const beforeLaunch = logLines(b.logPath).length;
    const { exec, hit } = await termCmd(
      // "list" first so plan-ai plans all three actions (LIST +
      // LAUNCH + SET = allowed=3): the plan shape, not just the
      // keyword shape.
      "ai ask list open files and set the volume to 55",
      /TERMINAL ai-ask allowed=3 denied=0/,
    );
    check(
      "ai-b: `ai ask list open files and set the volume to 55` runs (EXEC 0)",
      !!exec,
      exec || "",
    );
    check(
      "ai-b: plan-ai planned all three actions (allowed=3 denied=0)",
      !!hit,
      hit || "",
    );
    const launched = await waitForLog(
      b.logPath,
      /APPD launched files \(pid \d+\)/,
      15000,
      beforeLaunch,
    );
    check("ai-b: appd launched files for plan-ai", !!launched, launched || "");
    const setLine = await waitForLog(b.logPath, /STATUSD SET volume 55/, 15000);
    check("ai-b: statusd got SET volume 55", !!setLine, setLine || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) files/,
      30000,
      beforeLaunch,
    );
    check("ai-b: Files host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  const shotFilesB = await shot(b.qmp, join(OUT, "m4.5-shot-files-b.ppm"));
  const filesHeaderB = findWindowHeader(shotFilesB, 59, 130, 246);
  check("ai-b: Files window on screen after plan-ai's launch", !!filesHeaderB);
  {
    const closed = await appdCmd(b, "CLOSE files", /APPD CLOSE OK files/);
    check("ai-b: CLOSE files accepted", !!closed, closed || "");
  }

  // Final frame + clean poweroff.
  const shotFinal = join(OUT, "m4.5-shot-final.ppm");
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
  finish(
    checks.every((c) => c.ok),
    { screen: { width: imgFinal.width, height: imgFinal.height } },
  );
}

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m4.5-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M4.5 CHECK PASSED" : "M4.5 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M4.5 check crashed:", e);
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
    writeFileSync(join(OUT, "m4.5-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
