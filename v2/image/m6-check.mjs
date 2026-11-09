// M6 check: boot the SevynOS v2 M6 image in QEMU and prove the
// milestone — Tokrah runs as a third-party app.
//
//   0. Node harness gate (on the CI host, before QEMU): build the
//      Tokrah bundle from v2/tokrah and run drive-live.js — login →
//      home feed → go-live → start live → socket live:join → host
//      screen → end live — against the mock API. Exit 0 = full pass.
//      This is the live-session proof with Tokrah's real client code.
//   1. Boot (sevyn.mockapi=1 on the kernel cmdline): the M5 stack
//      still intact (SEVYNOS_M5_READY etc.), the mock API listening
//      on 127.0.0.1:7070 in-guest, appd answers PING.
//   2. Headless mount: `sevyn tokrah run --seconds 8` in the
//      Terminal — the bundle executes in the real Hermes host, mounts,
//      and presents the login screen (the compact ops log on the
//      serial console carries the TOKRAH + Sign In texts).
//   3. Headless live session, driven by scripted input files the
//      check builds from each run's ops log (click by coordinates
//      from the previous screen): login → feed (POST /v1/auth/login
//      in the mock log) → go-live → start live (POST /v1/live +
//      socket live:join) → host screen (End button paints) → end
//      live (POST /v1/live/:id/end). Each step is asserted on the
//      mock server's serial log, not on a publish confirmation.
//   4. Interactive: launch Tokrah from the dock (registry-driven —
//      the image seeds tokrah.sevyn from pristine) and the login
//      screen paints in its own 800x500 window (Tokrah-red header +
//      #f9fafb background pixels).
//   5. Clean poweroff.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard) into the Terminal, exactly as m5-check.
// Screendumps use QMP screendump in PPM format. Results go to
// m6-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m6-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M6_TIMEOUT (seconds, default 3600),
//      TOKRAH_SRC (Tokrah repo root — required for step 0;
//      the workflow clones with TOKRAH_READ_TOKEN).
import { spawn, execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m6-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M6_TIMEOUT || 3600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM. The go-live mount flush is 727-956ms under TCG
// and a retry tap landing mid-flush wedges it; under KVM the flush
// is fast and the wedge should vanish.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";
const TOKRAH_SRC = process.env.TOKRAH_SRC || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
// Informational only: logged, but does not gate the final result.
// Used for harness-health lines (e.g. "input written") whose
// downstream outcome checks are the real proof — a flaky match on
// the EXEC echo must not fail a run whose product flow passed.
function note(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000, ...opts }, (err, stdout, stderr) => {
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
  // The serial console writes CRLF; strip the trailing \r so
  // end-anchored patterns (e.g. the ops JSON) match.
  return readLog(path)
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
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
  const kern = join(OUT, `m6-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m6-boot-${tag}-initramfs.cpio.gz`);
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
  const logPath = join(OUT, `m6-boot-${tag}.log`);
  // Archive the previous run's log before overwriting: a failing
  // run destroys its own evidence otherwise (the serial log is
  // overwritten every check run). Timestamped so runs don't clobber
  // each other.
  try {
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(logPath, join(OUT, `m6-boot-${tag}-${stamp}.log`));
    }
  } catch {}
  writeFileSync(logPath, "");
  // Synchronous appends, not a piped write stream: a stream buffers
  // in userspace, so readFileSync (which waitForLog polls) could not
  // see a line for minutes while the guest was idle — the EXEC line
  // for a files-write sat in the buffer through the whole 180s wait
  // and termCmd timed out even though the write had run (checks
  // 40/41/43). writeSync lands in the kernel page cache at once, so
  // a later readFileSync sees it.
  const logFd = openSync(logPath, "w");
  const appendLog = (chunk) => {
    try {
      writeSync(logFd, chunk);
    } catch {}
  };
  const ctlSock = join(OUT, `m6-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m6-${tag}-appd.sock`);
  const updSock = join(OUT, `m6-${tag}-upd.sock`);
  const aidSock = join(OUT, `m6-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m6-${tag}-qmp.sock`);
  const qemu = spawn(
    QEMU,
    [
      "-machine",
      `q35,accel=${ACCEL}`,
      "-m",
      "4096",
      "-smp",
      "2",
      "-kernel",
      kern,
      "-initrd",
      initrd,
      "-append",
      `console=ttyS0 sevyn.slot=${bootSlot} sevyn.mockapi=1`,
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
      "user,model=virtio-net-pci",
      "-no-reboot",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  qemu.stdout.on("data", appendLog);
  qemu.stderr.on("data", appendLog);
  const b = {
    tag,
    qemu,
    logPath,
    logFd,
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
  const qmpPath = join(OUT, `m6-${b.tag}-qmp.sock`);
  if (!(await waitForSocketFile(qmpPath))) {
    throw new Error(`QMP socket never appeared: ${qmpPath}`);
  }
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
    const deadline2 = Date.now() + 10000;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.connect(path);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
      } catch (e) {
        if (Date.now() >= deadline2) throw e;
        await sleep(200);
      }
    }
  };
  b.ctl = await connect(join(OUT, `m6-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m6-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m6-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m6-${b.tag}-aid.sock`));
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
  try {
    if (b.logFd !== undefined) closeSync(b.logFd);
  } catch {}
}

// Drive appd over its control serial; replies arrive as APPD log
// lines on the console (the boot log).
async function appdCmd(b, cmd, pattern, timeoutMs = 15000) {
  const before = logLines(b.logPath).length;
  b.appd.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 30000) {
  const shotPath = join(OUT, `m6-shot-${b.tag}.ppm`);
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

// --- Terminal input helpers (QMP input-send-event, as m5-check) ---
// QMP key events carry qcodes, not evdev numbers:
//   { type: "key", data: { down, key: { type: "qcode", data } } }.
// Typing under TCG is slow (~360 ms/char: keyTap 120 ms + 180 ms
// sleep + 60 ms), so the headless input files keep the typed
// commands short and the in-bundle typing is done by the host's
// `type` event, not here.
async function keyDown(qmp, qcode) {
  await qmp.input([
    { type: "key", data: { down: true, key: { type: "qcode", data: qcode } } },
  ]);
}
async function keyUp(qmp, qcode) {
  await qmp.input([
    { type: "key", data: { down: false, key: { type: "qcode", data: qcode } } },
  ]);
}
async function keyTap(qmp, qcode) {
  await keyDown(qmp, qcode);
  await sleep(120);
  await keyUp(qmp, qcode);
}
// QKeyCode names for the characters the check types. Shifted
// characters hold left Shift while tapping the base key.
const QCODE_FOR = {
  " ": "spc",
  "/": "slash",
  ".": "dot",
  "-": "minus",
  ";": "semicolon",
};
const SHIFT_QCODE_FOR = {
  ":": "semicolon",
  "!": "1",
  "@": "2",
  "=": "equal",
  _: "minus",
  "+": "equal",
  "?": "slash",
};
for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") QCODE_FOR[c] = c;
async function typeText(qmp, text) {
  for (const ch of text) {
    if (ch >= "A" && ch <= "Z") {
      await keyDown(qmp, "shift");
      await keyTap(qmp, QCODE_FOR[ch.toLowerCase()]);
      await keyUp(qmp, "shift");
      await sleep(60);
      continue;
    }
    const shiftQc = SHIFT_QCODE_FOR[ch];
    if (shiftQc) {
      await keyDown(qmp, "shift");
      await keyTap(qmp, shiftQc);
      await keyUp(qmp, "shift");
      await sleep(60);
      continue;
    }
    const qc = QCODE_FOR[ch];
    if (!qc) throw new Error(`typeText: no QKeyCode for ${JSON.stringify(ch)}`);
    await keyTap(qmp, qc);
    await sleep(180);
  }
  await sleep(60);
}
// Type a command into the Terminal app and wait for the sevyn exec
// line `EXEC sevyn <cmd> -> 0` on the console (its stdout/stderr
// follow on the log). The regex escapes the command, so `;` and `=`
// inside it are literal.
async function termCmd(b, cmd, timeoutMs = 180000) {
  await typeText(b.qmp, cmd);
  await keyTap(b.qmp, "ret");
  // Match a prefix, not the whole command verbatim: QMP typing under
  // TCG occasionally drops a character, and the longest commands
  // (the C/D input files) would then never match and time out. The
  // prefix identifies the command; `-> 0` confirms it ran. A dropped
  // character inside the input file is caught downstream instead —
  // the run's outcome checks (POST /v1/live, ENDED) fail if a
  // coordinate was mangled. 80 chars, not 40: `tokrah run` commands
  // share their first 40 chars and only diverge at `--seconds` /
  // `--input`, so a 40-char prefix matched a stale earlier run
  // (check 45: the C run "completed" on the probe run's EXEC line).
  const esc = cmd.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Search the whole log, not just lines after `before`: the 40-char
  // prefix includes the target filename, which is unique per command
  // in a run, so a stale match is impossible — and the `before` count
  // proved racy (checks 40/41: the write's EXEC line was in the log
  // with `-> 0` yet the scoped wait timed out).
  const hit = await waitForLog(
    b.logPath,
    new RegExp(`EXEC sevyn ${esc}.* -> 0`),
    timeoutMs,
    0,
  );
  return hit;
}
// Write an input file and verify it by reading it back: termCmd's
// EXEC-prefix match is a false negative when QMP drops a character
// in the typed command, so confirm the file's content is actually on
// disk via `files cat`. The login email is in every input file; the
// wait is scoped after the cat, so the write command's own echo
// (which also contains the email) can't satisfy it.
async function writeInputFile(b, path, content) {
  await termCmd(b, `files write ${path} ${content}`);
  const beforeCat = logLines(b.logPath).length;
  await termCmd(b, `files cat ${path}`);
  return waitForLog(b.logPath, /m6@sevynos\.test/, 30000, beforeCat);
}

// --- compact ops log parsing ---
// The headless host logs one `HOST headless ops {json}` line per
// screen (texts + pressable rects). Return the latest one.
function latestOps(b) {
  const lines = logLines(b.logPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/HOST headless ops (\{.*\})$/);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // The guest writes long ops lines in pieces; a line caught
        // mid-flush is unparseable. Keep scanning back for the last
        // complete one instead of giving up.
        continue;
      }
    }
  }
  return null;
}
// Centre of a text rect (exact match, or first of several).
function textCenter(ops, text) {
  const t = (ops?.texts || []).find((t) => t.t === text);
  if (!t) return null;
  return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
}
// The LOWEST text with this string (the login screen has two
// "Sign In" texts; the button is the lower one).
function textCenterLowest(ops, text) {
  const ts = (ops?.texts || []).filter((t) => t.t === text);
  if (!ts.length) return null;
  const t = ts.reduce((a, b) => (b.y > a.y ? b : a));
  return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
}
// Centre of the pressable rect containing a point (a button's
// Pressable wraps its label text; clicking the text alone does not
// hit-test). Falls back to the point itself.
// The pressable containing a point. Returns the SMALLEST containing
// pressable (the most specific / topmost element): the first match can
// be a full-screen overlay (check 47: the "Double tap to like"
// overlay, 800x400, contains the End button's point and was returned
// instead of the 44x32 End button itself).
function pressableFor(ops, x, y) {
  let best = null;
  for (const p of ops?.press || []) {
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) {
      if (!best || p.w * p.h < best.w * best.h) best = p;
    }
  }
  if (best) return { x: best.x + best.w / 2, y: best.y + best.h / 2 };
  return { x, y };
}
// Centre of a pressable rect of a given colour (the go-live button
// is the red #E52B42 pressable on the feed). The red lives on the
// button's outer View, not its Pressable, so also search the coloured
// rects — clicking the rect's centre hit-tests to the Pressable on
// top of it.
function pressableByColor(ops, color) {
  const p = (ops?.press || []).find((p) => p.color === color);
  if (p) return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  const r = (ops?.rects || []).find((r) => r.color === color);
  if (!r) return null;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// --- Node harness gate (step 0) ---
// Build the Tokrah bundle from v2/tokrah and run the mock-harness
// driver end to end on the CI host. This is the live-session proof
// with Tokrah's real client code; the QEMU steps then prove the same
// flow runs in the real Hermes host in-guest.
async function nodeHarnessGate() {
  if (!TOKRAH_SRC) {
    throw new Error(
      "TOKRAH_SRC is not set — the Tokrah source tree is required. " +
        "Locally: TOKRAH_SRC=/path/to/tokrah. CI: clone with TOKRAH_READ_TOKEN.",
    );
  }
  const tokrahDir = join(ROOT, "tokrah");
  const bundle = join(OUT, "m6-tokrah.bundle.js");
  console.log("m6 step 0: building the Tokrah bundle (Node harness gate)...");
  await execAsync(
    "node",
    [
      join(tokrahDir, "build-tokrah.mjs"),
      join(tokrahDir, "entry-tokrah.js"),
      bundle,
      "ios",
    ],
    {
      // The bundle must point at the in-guest mock API, not prod:
      // endpoints.ts inlines EXPO_PUBLIC_API_URL at transform time,
      // and Metro's transform cache does NOT key on env — a warm
      // cache from an image build once masked a missing var here.
      env: {
        ...process.env,
        TOKRAH_SRC,
        EXPO_PUBLIC_API_URL: "http://127.0.0.1:7070",
      },
    },
  );
  console.log("m6 step 0: running drive-live.js against the mock API...");
  await execAsync("node", [join(tokrahDir, "harness", "drive-live.js"), bundle], {
    env: { ...process.env, TOKRAH_SRC },
  });
}

async function main() {
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.error(`M6 check timed out after ${TIMEOUT_S}s`);
    process.exit(2);
  }, TIMEOUT_S * 1000);
  timeout.unref();

  // Step 0: the Node harness gate, before any QEMU work.
  try {
    await nodeHarnessGate();
    check("harness: bundle builds + drive-live.js passes 9/9 (mock API)", true);
  } catch (e) {
    check(
      "harness: bundle builds + drive-live.js passes 9/9 (mock API)",
      false,
      e.message,
    );
    finish(false, { harness_error: String(e) });
    return;
  }

  // Setup: data disk (slot A = the built image).
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m6-image.sh first`,
      );
      process.exit(1);
    }
  }
  const versionV1 = readFileSync(join(OUT, "os-version"), "utf8").trim();
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

  const b = await boot("main");
  await connectSockets(b);

  // Boot: the M5 stack still intact + the mock API listening.
  const ready = await waitForLog(b.logPath, /SEVYNOS_M5_READY/, 300000);
  check("boot: SEVYNOS_M5_READY", !!ready);
  const ready45 = await waitForLog(b.logPath, /SEVYNOS_M4_5_READY/, 30000);
  check("boot: SEVYNOS_M4_5_READY (M4.5 stack intact)", !!ready45);
  const mockUp = await waitForLog(
    b.logPath,
    /MOCK mock API listening on 127\.0\.0\.1:7070/,
    60000,
  );
  check("boot: mock Tokrah API listening in-guest (sevyn.mockapi=1)", !!mockUp);
  const ping = await appdCmd(b, "PING", /APPD PONG/);
  check("appd: PING -> PONG", !!ping);

  const settled = await screenSettled(b, 60000);
  check("shell: top bar + dock settled on screen", !!settled);

  // The Terminal app: open it once; every headless run is typed here.
  const term = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("terminal: launch", !!term);
  await sleep(5000);

  // --- Phase A: headless mount, no input — the login screen. ---
  const runA = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 8 --out /tmp/m6-ops-a.json",
  );
  check("headless A: sevyn tokrah run completes (8s, no input)", !!runA);
  const presentA = await waitForLog(b.logPath, /HOST headless first present/, 30000);
  check("headless A: bundle presents (mount + first present)", !!presentA);
  // The run is detached (the CLI returns at once), so the ops line
  // lands after the first present — wait for it before reading.
  // (Guest time runs ~0.5x wall under TCG, so waits are generous.)
  await waitForLog(b.logPath, /HOST headless ops/, 60000);
  const opsA = latestOps(b);
  check(
    "headless A: login screen ops logged (TOKRAH + Sign In)",
    !!opsA &&
      opsA.texts.some((t) => t.t === "TOKRAH") &&
      opsA.texts.some((t) => t.t === "Sign In"),
    opsA ? `${opsA.texts.length} texts` : "no ops line",
  );
  if (!opsA) {
    finish(false, { phase: "A" });
    return;
  }

  // --- Phase B: login, driven by the ops log's coordinates. ---
  const emailC = textCenter(opsA, "you@example.com");
  const passC = textCenter(opsA, "Enter your password");
  const signInC = textCenterLowest(opsA, "Sign In");
  check(
    "headless B: login controls found in ops log",
    !!(emailC && passC && signInC),
    `email=${JSON.stringify(emailC)} pass=${JSON.stringify(passC)} signin=${JSON.stringify(signInC)}`,
  );
  if (!emailC || !passC || !signInC) {
    finish(false, { phase: "B" });
    return;
  }
  const eBtn = pressableFor(opsA, emailC.x, emailC.y);
  const pBtn = pressableFor(opsA, passC.x, passC.y);
  const sBtn = pressableFor(opsA, signInC.x, signInC.y);
  const inB = [
    `8000 tap ${Math.round(eBtn.x)} ${Math.round(eBtn.y)}`,
    `8500 type m6@sevynos.test`,
    `10000 tap ${Math.round(pBtn.x)} ${Math.round(pBtn.y)}`,
    `10500 type M6pass123!`,
    `12000 tap ${Math.round(sBtn.x)} ${Math.round(sBtn.y)}`,
    // The (tabs) pager sometimes lands on the live tab after login
    // (check 46: live tab active, home feed stuck on "Loading").
    // Tap the Feed tab (first tab-bar button, y=1154 h=46) to force
    // the home feed active; harmless if already there.
    `20000 tap 80 1177`,
  ].join(";");
  const beforeB = logLines(b.logPath).length;
  const wroteB = await writeInputFile(b, "/tmp/m6-in-b.txt", inB);
  note("headless B: input file written", !!wroteB);
  const runB = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 30 --input /tmp/m6-in-b.txt --out /tmp/m6-ops-b.json",
    240000,
  );
  check("headless B: sevyn tokrah run completes (login input)", !!runB);
  const loginPost = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"http","method":"POST","path":"\/v1\/auth\/login"/,
    120000,
  );
  check("headless B: mock API saw POST /v1/auth/login", !!loginPost);
  // The feed paints after the login: wait for the red go-live
  // pressable in the ops log before reading coordinates. Scope the
  // wait to after the B run started: the login screen's own ops can
  // already contain #e52b42, which would end the wait immediately.
  await waitForLog(b.logPath, /#e52b42/i, 120000, beforeB);
  const opsB = latestOps(b);
  const goLive = opsB ? pressableByColor(opsB, "#e52b42") : null;
  check(
    "headless B: home feed paints (red go-live button)",
    !!goLive,
    opsB ? `${opsB.texts.length} texts` : "no ops line",
  );
  if (!opsB || !goLive) {
    finish(false, { phase: "B" });
    return;
  }

  // --- Phase C: go-live + start live. ---
  // Every headless run starts a FRESH app (SecureStore is in-memory
  // per launch), so every run logs in first, then taps go-live.
  // The go-live screen's title field placeholder is "What's
  // happening?" — read its coordinates from the ops log after the
  // go-live click, in a short probe run, then run the full start.
  const loginSeqC1 = [
    `8000 tap ${Math.round(eBtn.x)} ${Math.round(eBtn.y)}`,
    `8500 type m6@sevynos.test`,
    `10000 tap ${Math.round(pBtn.x)} ${Math.round(pBtn.y)}`,
    `10500 type M6pass123!`,
    `12000 tap ${Math.round(sBtn.x)} ${Math.round(sBtn.y)}`,
  ];
  const inC1 = [
    ...loginSeqC1,
    // Go-live at 28000, not 20000: the login navigation is still
    // settling at 20000 (home feed appears ~21000ms under TCG) and a
    // navigate fired mid-settle wedges flushSyncWork (check 42).
    // SINGLE tap, no retries: the retry taps at +2s/+4s re-enter
    // router.navigate + flushSyncWork while tap 1's mount flush is
    // still running (727-956ms under TCG) and the update gets
    // dropped — no error, feed stays on screen. The probe retry loop
    // (fresh host process) is the fallback, not in-run re-taps.
    `28000 tap ${Math.round(goLive.x)} ${Math.round(goLive.y)}`,
  ].join(";");
  const wroteC1 = await writeInputFile(b, "/tmp/m6-in-c1.txt", inC1);
  note("headless C: probe input written", !!wroteC1);
  // Retry the probe once on a fresh host process: the go-live
  // navigate can wedge flushSyncWork under TCG (onPress fires, no
  // navigation, beats stop — checks 37/39/42/52) and a fresh
  // process almost always gets through. The retry uses distinct
  // filenames so termCmd's 80-char prefix can't match the first
  // run's stale EXEC line.
  let opsC1 = null;
  let titleT = null;
  let ageT = null;
  let startT = null;
  for (let attempt = 0; attempt < 2 && !(titleT && ageT && startT); attempt++) {
    if (attempt > 0) {
      await writeInputFile(b, "/tmp/m6-in-c1-retry.txt", inC1);
    }
    const beforeC1 = logLines(b.logPath).length;
    const runC1 = await termCmd(
      b,
      attempt === 0
        ? "tokrah run --width 800 --height 1200 --seconds 60 --input /tmp/m6-in-c1.txt --out /tmp/m6-ops-c1.json"
        : "tokrah run --width 800 --height 1200 --seconds 60 --input /tmp/m6-in-c1-retry.txt --out /tmp/m6-ops-c1-retry.json",
      240000,
    );
    check(
      `headless C: probe run completes (go-live click${attempt > 0 ? ", retry" : ""})`,
      !!runC1,
    );
    const loginPostC = await waitForLog(
      b.logPath,
      /MOCK \{"kind":"http","method":"POST","path":"\/v1\/auth\/login"/,
      120000,
      beforeC1,
    );
    check("headless C: login replayed in probe run", !!loginPostC);
    // Log the wait's own outcome: a timeout here is "screen didn't
    // appear in 120s", not "screen absent" — conflating the two hid
    // the wedge (the run ended before the flush finished).
    const goLiveSeen = await waitForLog(
      b.logPath,
      /What’s happening\?/,
      120000,
      beforeC1,
    );
    note("headless C: go-live screen text seen in log", !!goLiveSeen);
    opsC1 = latestOps(b);
    titleT = opsC1 ? textCenter(opsC1, "What’s happening?") : null;
    ageT = opsC1 ? textCenter(opsC1, "I confirm I’m at least 18 years old.") : null;
    startT = opsC1 ? textCenter(opsC1, "Start Live") : null;
  }
  check(
    "headless C: go-live screen found (title + age + Start)",
    !!(titleT && ageT && startT),
    `title=${JSON.stringify(titleT)} age=${JSON.stringify(ageT)} start=${JSON.stringify(startT)}`,
  );
  if (!titleT || !ageT || !startT) {
    finish(false, { phase: "C" });
    return;
  }
  const titleBtn = pressableFor(opsC1, titleT.x, titleT.y);
  const ageBtn = pressableFor(opsC1, ageT.x, ageT.y);
  const startBtn = pressableFor(opsC1, startT.x, startT.y);
  // The Go Live screen flexes its preview with the viewport, so the
  // age checkbox and Start button sit below the fold (y > 1200).
  // Scroll first, then tap them at their scrolled positions. The
  // scroll clamps at the content edge, so the applied scroll is
  // min(requested, maxScroll); dy is the scrollY delta (positive =
  // content moves up, revealing below).
  const contentBottom = Math.max(
    ...opsC1.texts.map((t) => t.y + t.h),
    ...(opsC1.press || []).map((p) => p.y + p.h),
    ...(opsC1.rects || []).map((r) => r.y + r.h),
  );
  const maxScroll = Math.max(0, contentBottom - 1200);
  const scrollDy = Math.min(Math.max(0, startT.y - 1100), maxScroll);
  const startLiveSeq = [
    `28000 tap ${Math.round(goLive.x)} ${Math.round(goLive.y)}`,
    // Single go-live tap (same reasoning as the probe): retry taps
    // re-enter navigate mid-flush and wedge it.
    `34000 tap ${Math.round(titleBtn.x)} ${Math.round(titleBtn.y)}`,
    `34500 type M6 test live`,
    // Scroll AT the title: the point must be inside the Go Live form's
    // own ScrollView. (400,600) is inside the feed's ScrollView, which
    // stays mounted under the go-live overlay — scrolling there moves
    // the feed, not the form, and the form's Start stays below the fold.
    `36500 scroll ${Math.round(titleBtn.x)} ${Math.round(titleBtn.y)} 0 ${Math.round(scrollDy)}`,
    // 2s gaps after the age tap: the age checkbox's state update must
    // flush before Start, or canStart is still false and begin()
    // bails (check 45: Start fired 500ms after age, no POST /v1/live).
    `37500 tap ${Math.round(ageBtn.x)} ${Math.round(ageBtn.y - scrollDy)}`,
    `39500 tap ${Math.round(startBtn.x)} ${Math.round(startBtn.y - scrollDy)}`,
  ];
  const inC = [...loginSeqC1, ...startLiveSeq].join(";");
  const wroteC = await writeInputFile(b, "/tmp/m6-in-c.txt", inC);
  note("headless C: start-live input written", !!wroteC);
  const beforeC = logLines(b.logPath).length;
  const runC = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 50 --input /tmp/m6-in-c.txt --out /tmp/m6-ops-c.json",
    240000,
  );
  check("headless C: sevyn tokrah run completes (start-live input)", !!runC);
  const livePost = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"http","method":"POST","path":"\/v1\/live"/,
    120000,
    beforeC,
  );
  check("headless C: mock API saw POST /v1/live (startLive)", !!livePost);
  const liveJoin = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"socket","event":"live:join"/,
    120000,
    beforeC,
  );
  check("headless C: mock API saw socket live:join", !!liveJoin);
  // The host screen paints after the join: wait for its End button
  // in the ops log before reading coordinates. 240s: the [id] route's
  // effect can re-run on a param change, dropping the single-use
  // remembered credentials and falling back to the joinLive network
  // call, which is slow under TCG (check 41).
  const endSeen = await waitForLog(b.logPath, /"t":"End"/, 240000, beforeC);
  note("headless C: End button text seen in log", !!endSeen);
  const opsC = latestOps(b);
  const endT = opsC ? textCenter(opsC, "End") : null;
  check(
    "headless C: host screen paints (End button)",
    !!endT,
    opsC ? `${opsC.texts.length} texts` : "no ops line",
  );
  if (!endT) {
    finish(false, { phase: "C" });
    return;
  }

  // Reset the mock's live state before phase D: phase C's live is
  // still LIVE, and the next run's home feed would show the "Resume
  // your live" banner and auto-land on the live tab, shifting every
  // coordinate the check derived from the probe (check 40).
  const beforeReset = logLines(b.logPath).length;
  const resetOk = await termCmd(
    b,
    "net fetch --method POST http://127.0.0.1:7070/v1/live/reset",
  );
  check("headless C: mock live state reset", !!resetOk);
  // Capture the wait: if the reset never landed, phase D's home
  // feed shows "Resume your live" and the title tap joins the old
  // live instead of starting a new one (run 53).
  const resetSeen = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"http","method":"POST","path":"\/v1\/live\/reset"/,
    60000,
    beforeReset,
  );
  note("headless C: mock reset confirmed in log", !!resetSeen);

  // --- Phase D: end the live. ---
  // The End confirm modal's "End live" button: its coordinates are
  // unknown until the modal paints. Phase D first taps End and reads
  // the modal's ops log; a second run then taps "End live".
  const endBtn = pressableFor(opsC, endT.x, endT.y);
  const inD = [
    ...loginSeqC1,
    ...startLiveSeq,
    `55000 tap ${Math.round(endBtn.x)} ${Math.round(endBtn.y)}`,
  ].join(";");
  const wroteD = await writeInputFile(b, "/tmp/m6-in-d.txt", inD);
  note("headless D: end-live input written", !!wroteD);
  const runD = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 65 --input /tmp/m6-in-d.txt --out /tmp/m6-ops-d.json",
    240000,
  );
  check("headless D: sevyn tokrah run completes (end tap)", !!runD);
  // The confirm modal paints after the End tap: wait for its
  // "End live" text in the ops log before reading coordinates.
  // Retry the whole D run once if the modal never paints: a headless
  // run can wedge mid-flow under TCG (the host loop stalls inside a
  // state-update flush — checks 37/39/42/43), and a fresh host
  // process almost always gets through. The retry replays the same
  // input file, so it re-does login + start + End from scratch.
  let endLiveT = null;
  let opsD = null;
  for (let attempt = 0; attempt < 2 && !endLiveT; attempt++) {
    if (attempt > 0) {
      // The retry must use a DIFFERENT input filename: termCmd
      // matches the first 80 chars of the command, and an identical
      // command would "complete" on the first run's stale EXEC line
      // (check 47: the retry never actually ran).
      await writeInputFile(b, "/tmp/m6-in-d-retry.txt", inD);
      const runD2try = await termCmd(
        b,
        "tokrah run --width 800 --height 1200 --seconds 65 --input /tmp/m6-in-d-retry.txt --out /tmp/m6-ops-d-retry.json",
        240000,
      );
      check("headless D: sevyn tokrah run completes (end tap, retry)", !!runD2try);
    }
    await waitForLog(b.logPath, /"End live"/, 120000);
    opsD = latestOps(b);
    endLiveT = opsD ? textCenter(opsD, "End live") : null;
  }
  check(
    "headless D: confirm modal paints (End live)",
    !!endLiveT,
    opsD ? `${opsD.texts.length} texts` : "no ops line",
  );
  if (!endLiveT) {
    finish(false, { phase: "D" });
    return;
  }
  const endLiveBtn = pressableFor(opsD, endLiveT.x, endLiveT.y);
  // Reset again before the confirm run: the D run's live is still
  // LIVE, and D2 replays the full start flow from a clean state.
  const beforeReset2 = logLines(b.logPath).length;
  const reset2Ok = await termCmd(
    b,
    "net fetch --method POST http://127.0.0.1:7070/v1/live/reset",
  );
  check("headless D: mock live state reset (before confirm)", !!reset2Ok);
  await waitForLog(
    b.logPath,
    /MOCK \{"kind":"http","method":"POST","path":"\/v1\/live\/reset"/,
    60000,
    beforeReset2,
  );
  const inD2 = [
    ...loginSeqC1,
    ...startLiveSeq,
    `55000 tap ${Math.round(endBtn.x)} ${Math.round(endBtn.y)}`,
    `60000 tap ${Math.round(endLiveBtn.x)} ${Math.round(endLiveBtn.y)}`,
  ].join(";");
  const wroteD2 = await writeInputFile(b, "/tmp/m6-in-d2.txt", inD2);
  note("headless D: confirm input written", !!wroteD2);
  const beforeD2 = logLines(b.logPath).length;
  const runD2 = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 70 --input /tmp/m6-in-d2.txt --out /tmp/m6-ops-d2.json",
    240000,
  );
  check("headless D: sevyn tokrah run completes (confirm tap)", !!runD2);
  const endPost = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"http","method":"POST","path":"\/v1\/live\/[^"]+\/end"/,
    120000,
    beforeD2,
  );
  check("headless D: mock API saw POST /v1/live/:id/end", !!endPost);
  const ended = await waitForLog(
    b.logPath,
    /MOCK \{"kind":"live","status":"ENDED"/,
    120000,
    beforeD2,
  );
  check("headless D: mock live session ENDED", !!ended);

  // --- Interactive: launch Tokrah from the dock. ---
  const launch = await appdCmd(b, "LAUNCH tokrah", /APPD LAUNCH OK tokrah/);
  check("interactive: appd LAUNCH tokrah", !!launch);
  const hostRun = await waitForLog(b.logPath, /HOST app running .* tokrah/, 60000);
  check("interactive: host runs Tokrah as a windowed app", !!hostRun);
  // No "first present" log for windowed apps — the screendump poll
  // below is the proof the window paints. The window's title bar is
  // drawn by the Wayland compositor, NOT the app, so its colour is
  // the compositor's (check 48: no Tokrah-red header exists at all).
  // The proof is the login screen's #f9fafb background painting
  // inside the window: count it over the screen below the shell's
  // top bar (y<48). A painting login screen is ~97k px; a blank
  // window is ~0.
  let bg = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(3000);
    try {
      const winImg = await shot(b.qmp, join(OUT, "m6-shot-tokrah.ppm"));
      bg = countColor(winImg, 249, 250, 251, 10, {
        x0: 0,
        y0: 48,
        x1: winImg.width,
        y1: winImg.height,
      });
      if (bg > 50000) break;
    } catch {}
  }
  check("interactive: login screen paints (#f9fafb background)", bg > 50000, `bg=${bg}`);
  const close = await appdCmd(b, "CLOSE tokrah", /APPD CLOSE OK tokrah/);
  check("interactive: appd CLOSE tokrah", !!close);

  // Clean poweroff.
  b.ctl.write("POWEROFF\n");
  const exited = await waitExit(b, 30000);
  check("shutdown: guest powers off on request", exited);
  closeBoot(b);
  finish(
    checks.every((c) => c.ok),
    {
      duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
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
  writeFileSync(join(OUT, "m6-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M6 CHECK PASSED" : "M6 CHECK FAILED");
  // Stop the guest: an early finish() must not leave QEMU holding
  // the data disk's write lock for the next run.
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  // Snapshot this run's serial log before exiting: the next check
  // run's boot() archives it, but a snapshot at the end is the
  // primary evidence for this run.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const src = join(OUT, "m6-boot-main.log");
    if (existsSync(src) && statSync(src).size > 0) {
      copyFileSync(src, join(OUT, `m6-boot-main-${stamp}.log`));
    }
  } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M6 check crashed:", e);
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
    writeFileSync(join(OUT, "m6-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
