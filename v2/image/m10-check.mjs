// M10 check: boot the SevynOS v2 M10 image in QEMU and prove the
// milestone — the comms apps (Kevon, 2026-11-08: SevynOS's own
// FaceTime / FaceTime Audio / iMessage — Messages, Video Calls,
// Voice Calls over Matrix, plus the RCS skeleton for iPhones).
//
//   0. Node harness gate (on the CI host, before QEMU): run
//      v2/comms/test-commsd.mjs — login → rooms → plain + encrypted
//      send/receive → video call invite/answer/hangup → call by
//      user id → call in the encrypted room → RCS probe — against
//      the mock Matrix homeserver + mock ACS. Twice: once with the
//      null bridge, once with the Chromium bridge (SEVYN_M10_CHROME
//      points at the built Chromium; the frames assertion is
//      skipped where the host blocks UDP, and media is then proven
//      in-guest). Exit 0 = full pass.
//   1. Regression boot (-kernel/-initrd + the data disk, now
//      LABEL=SEVYN_DATA) at 1920x1080 with sevyn.mockcomms=1: the M9
//      polish still intact (full-screen shell at 1920x1080, the M7
//      init proofs, the M6 mock API up) — the full M9 suite runs as
//      its own workflow on the same PR, so this boot spot-checks
//      rather than repeating it — and the M10 stack proved in-guest:
//      commsd + the mocks start at boot, `sevyn comms` reaches the
//      daemon, alice logs in against the mock homeserver, Messages
//      lists the mock rooms, alice sends + bob replies (plain and
//      encrypted), a video call rings → answers → media connects
//      (frames flowing on both bridges) → hangs up, and the RCS
//      skeleton proves REGISTER + OPTIONS + INVITE + MSRP + BYE
//      against the mock ACS.
//   2. Real matrix.org (CI only, env-gated): SEVYN_V2_M10_MATRIX_REAL=1
//      + MATRIX_TEST_USER / MATRIX_TEST_PASS (a throwaway test
//      account, never Kevon's). The password is written into the
//      data disk with debugfs before boot — it never transits the
//      serial log — and the login uses --password-file. Off by
//      default; the step notes "skipped — no test credentials" and
//      the mock proof stands. Same pattern as M5's env-gated public
//      page step.
//   3. Clean poweroff.
//
// The UEFI boots are NOT repeated here: M10 touches nothing in the
// updater, the ESP sync, or the disk image layout — m7/m8/m9-check
// run as their own workflows on the same PR and cover the UEFI
// path. If M10 ever touches those paths, add the UEFI boots back.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard) into the Terminal, exactly as m6-check.
// Screendumps use QMP screendump in PPM format. Results go to
// m10-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m10-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M10_TIMEOUT (seconds, default 10800 — the comms
//      flow under TCG plus two Chromium bridges),
//      SEVYN_M10_CHROME (Chromium binary for the step-0 Chromium
//      bridge run; default: the extracted chrome in the build dir),
//      SEVYN_V2_M10_MATRIX_REAL=1 + MATRIX_TEST_USER /
//      MATRIX_TEST_PASS (step 2, off by default),
//      SEVYN_V2_QEMU (default qemu-system-x86_64),
//      SEVYN_V2_ACCEL (tcg in the sandbox, kvm on a box with it).

import { spawn, execFile } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m10-data.img");
const IMAGE = join(OUT, "sevynos.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M10_TIMEOUT || 10800);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM. Under TCG everything is slower — Chromium
// launches and ICE take tens of seconds, so the comms waits below
// are generous; under KVM they complete fast.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";
// Step 0's Chromium bridge run: SEVYN_M10_CHROME points at a
// Chromium binary (the v2-m10 workflow unzips the pinned snapshot
// and sets it — the image build's BUILD_TMP is deleted on exit, so
// no usable path exists in the build dir). When it is unset the
// Chromium run is SKIPPED with a note (the null-bridge run + the
// in-guest media proof still stand); the null-bridge run needs no
// Chrome at all.
const CHROME = process.env.SEVYN_M10_CHROME || "";
// Step 2 (real matrix.org): env-gated, off by default. The
// credentials are a THROWAWAY test account, never Kevon's, and the
// password never transits the serial log (debugfs into the data
// disk before boot; --password-file in-guest).
const MATRIX_REAL = process.env.SEVYN_V2_M10_MATRIX_REAL === "1";
const MATRIX_TEST_USER = process.env.MATRIX_TEST_USER || "";
const MATRIX_TEST_PASS = process.env.MATRIX_TEST_PASS || "";

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
  const kern = join(OUT, `m10-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m10-boot-${tag}-initramfs.cpio.gz`);
  await execAsync("debugfs", ["-R", `dump /slots/${slot}/vmlinuz ${kern}`, DISK]);
  await execAsync("debugfs", [
    "-R",
    `dump /slots/${slot}/initramfs.cpio.gz ${initrd}`,
    DISK,
  ]);
  return { kern, initrd };
}

// --- one QEMU boot ---
// Kernel boot only (the M6-style boot — -kernel/-initrd from the
// data disk's active slot, virtio data disk). No UEFI boot here:
// M10 touches nothing in the updater/ESP/disk layout, and the
// m7/m8/m9 workflows cover the UEFI path on the same PR. The
// cmdline carries sevyn.mockapi=1 (the M6 mock API, kept as a boot
// health signal) and sevyn.mockcomms=1 (the M10 mocks: mock Matrix
// homeserver + mock ACS/IMS + the second commsd for bob).
let currentBoot = null;

async function boot(tag) {
  let bootSlot = "A";
  let kern = null;
  let initrd = null;
  const state = await readState();
  bootSlot = state.active;
  ({ kern, initrd } = await dumpSlot(bootSlot, tag));
  const logPath = join(OUT, `m10-boot-${tag}.log`);
  // Archive the previous run's log before overwriting: a failing
  // run destroys its own evidence otherwise (the serial log is
  // overwritten every check run). Timestamped so runs don't clobber
  // each other.
  try {
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(logPath, join(OUT, `m10-boot-${tag}-${stamp}.log`));
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
  const ctlSock = join(OUT, `m10-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m10-${tag}-appd.sock`);
  const updSock = join(OUT, `m10-${tag}-upd.sock`);
  const aidSock = join(OUT, `m10-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m10-${tag}-qmp.sock`);
  const args = ["-machine", `q35,accel=${ACCEL}`, "-m", "8192", "-smp", "4"];
  args.push(
    "-kernel",
    kern,
    "-initrd",
    initrd,
    "-append",
    `console=ttyS0 sevyn.slot=${bootSlot} sevyn.mockapi=1 sevyn.mockcomms=1`,
  );
  args.push(
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
  );
  args.push("-drive", `file=${DISK},format=raw,if=virtio`);
  // virtio-rng: the guest has no hardware RNG, and under TCG the
  // kernel's entropy pool fills slowly — DTLS certificate generation
  // (and any other crypto) can stall waiting for entropy. Feed it
  // from the host so a slow certgen can't wedge the call path
  // (check12: bob's createAnswer never returned inside 180 s).
  args.push(
    "-object",
    "rng-random,filename=/dev/urandom,id=rng0",
    "-device",
    "virtio-rng-pci,rng=rng0",
  );
  // M9: the GPU offers a 1920x1080 mode; weston.ini no longer pins
  // 1024x768, so Weston takes the output's preferred mode and the
  // shell fills the panel (the GF65 panel is 1920x1080 too).
  args.push(
    "-device",
    "virtio-gpu-pci,xres=1920,yres=1080",
    "-device",
    "qemu-xhci",
    "-device",
    "usb-tablet",
    "-nic",
    "user,model=virtio-net-pci",
    "-no-reboot",
  );
  const qemu = spawn(QEMU, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  const qmpPath = join(OUT, `m10-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m10-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m10-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m10-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m10-${b.tag}-aid.sock`));
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
  const shotPath = join(OUT, `m10-shot-${b.tag}.ppm`);
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
      // M9: the dock sits at the bottom of the CURRENT frame (1920x1080
      // in this check, not the M7 1024x768) — measure from the frame.
      const dockBg = countColor(img, 16, 16, 20, 10, {
        x0: 0,
        y0: img.height - 96,
        x1: img.width,
        y1: img.height,
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
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
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
  // A dead guest mid-run must fail LOUD, not vanish: check7's QEMU
  // was SIGTERMed by another agent's concurrent run on the shared
  // box and the check exited 0 with no JSON at all. If the guest is
  // gone, throw so the top-level handler writes the JSON + exit 1.
  if (!hit && b.qemu && (b.qemu.exitCode !== null || b.qemu.signalCode)) {
    throw new Error(
      `guest QEMU died mid-run (exit=${b.qemu.exitCode} signal=${b.qemu.signalCode}) while waiting for EXEC sevyn ${cmd.slice(0, 60)}`,
    );
  }
  return hit;
}
// Write an input file and verify it by reading it back: termCmd's
// EXEC-prefix match is a false negative when QMP drops a character
// in the typed command, so confirm the file's content is actually on
// disk via `files cat`. The login email is in every input file; the
// wait is scoped after the cat, so the write command's own echo
// (which also contains the email) can't satisfy it.
// --- compact ops log parsing ---
// The headless host logs one `HOST headless ops {json}` line per
// screen (texts + pressable rects). Return the latest one.
// sinceLines scopes the scan to lines after a run started: without
// it a caller reads the PREVIOUS probe's ops and mistakes them for
// the current run's — the M9 failure mode (the ops wait matched a
// stale line instantly and the check killed the guest before the
// run it was waiting for could beat).
function latestOps(b, sinceLines = 0) {
  const lines = logLines(b.logPath).slice(sinceLines);
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

// Type a command and wait for a specific exit code (termCmd only
// matches -> 0; a too-early answer exits 1 by design, which is the
// retry signal in the call step).
async function termCmdCode(b, cmd, code, timeoutMs = 180000) {
  await typeText(b.qmp, cmd);
  await keyTap(b.qmp, "ret");
  const esc = cmd.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return waitForLog(
    b.logPath,
    new RegExp(`EXEC sevyn ${esc}.* -> ${code}`),
    timeoutMs,
    0,
  );
}

// Type a command and wait for ANY exit code, returning it (or null
// on timeout). termCmdCode waits the full timeout when the command
// exits with a different code — a retry loop over a fast-failing
// command (a too-early answer exits 1 in ~2 s) would burn the whole
// timeout per attempt. This fails fast: the caller sees the real
// code immediately and decides whether to retry. The wait is scoped
// to log lines after the type, so a previous identical command's
// EXEC line can't satisfy it (waitForLog scans the whole log by
// default, and find() returns the FIRST match — a stale -> 1 from
// attempt 1 would answer attempt 2 instantly).
async function termCmdAny(b, cmd, timeoutMs = 180000) {
  const before = logLines(b.logPath).length;
  await typeText(b.qmp, cmd);
  await keyTap(b.qmp, "ret");
  const esc = cmd.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = await waitForLog(
    b.logPath,
    new RegExp(`EXEC sevyn ${esc}.* -> (\\d+)`),
    timeoutMs,
    before,
  );
  if (!line) return null;
  const m = line.match(/-> (\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

// Write a file into the DATA DISK image (DISK, the raw ext4 image
// the kernel boot mounts at /data) — for step 2's password file.
// debugfs edits the image directly and bypasses the journal; the
// guest's mount then replays the journal, which still holds the OLD
// content and silently reverts the edit — so e2fsck -fy replays +
// clears the journal first (the M9 lesson). debugfs `write`
// refuses to overwrite, so rm first; verify by read-back.
async function diskWrite(hostPath, guestPath) {
  // Replay the ext4 journal before the debugfs write — a stale
  // journal silently reverts the edit.
  // e2fsck exits 1 when it corrected something (a journal replay),
  // so tolerate 0/1 and fail only above that.
  await execAsync("sh", ["-c", `e2fsck -fy ${DISK} || [ $? -le 1 ]`]);
  await execAsync("debugfs", ["-w", "-R", `rm ${guestPath}`, DISK]).catch(() => {});
  await execAsync("debugfs", ["-w", "-R", `write ${hostPath} ${guestPath}`, DISK]);
  const want = readFileSync(hostPath, "utf8");
  const got = await execAsync("debugfs", ["-R", `cat ${guestPath}`, DISK]);
  if (got !== want) {
    throw new Error(
      `diskWrite: read-back mismatch for ${guestPath} (wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)})`,
    );
  }
}

// --- Node harness gate (step 0) ---
// Run v2/comms/test-commsd.mjs on the CI host: the full daemon
// proof against the mock Matrix homeserver + mock ACS — login,
// rooms, plain + encrypted send/receive, video call
// invite/answer/hangup, call by user id, call in the encrypted
// room, RCS probe. Twice: the null bridge (no Chrome needed) and
// the Chromium bridge (SEVYN_M10_CHROME; skipped with a note when
// unset — the in-guest media proof still stands). The Chromium run
// skips its frames assertion where the host blocks UDP (the
// sandbox does); media is then proven in-guest, where UDP works.
// Then v2/comms/test-cli.mjs proves the `sevyn comms` exit-code
// contract the in-guest steps trust (a failed verb exits 1).
async function nodeHarnessGate() {
  const test = join(ROOT, "comms", "test-commsd.mjs");
  console.log("m10 step 0: test-commsd.mjs (null bridge)...");
  // The null run must NOT inherit the check process's
  // SEVYN_M10_CHROME (the box script / workflow sets it for the
  // Chromium run): without this, the "null" run silently becomes a
  // second Chromium run, and a cold-Chrome media timeout fails the
  // gate before the real Chromium run even starts (the 2026-11-10
  // KVM failure mode).
  const { SEVYN_M10_CHROME: _chrome, ...nullEnv } = process.env;
  await execAsync("node", [test], { env: nullEnv });
  if (CHROME && existsSync(CHROME)) {
    console.log(`m10 step 0: test-commsd.mjs (Chromium bridge: ${CHROME})...`);
    await execAsync("node", [test], {
      env: { ...process.env, SEVYN_M10_CHROME: CHROME },
    });
  } else {
    console.log(
      "m10 step 0: Chromium bridge run skipped — SEVYN_M10_CHROME not set or not found (in-guest media proof stands)",
    );
    note("harness: Chromium bridge run skipped (no SEVYN_M10_CHROME)", true);
  }
  // The CLI's exit-code contract (a failed verb exits 1) is what
  // the in-guest comms steps trust — prove it here, before QEMU.
  console.log("m10 step 0: test-cli.mjs (sevyn comms exit codes)...");
  await execAsync("node", [join(ROOT, "comms", "test-cli.mjs")], {
    env: { ...process.env },
  });
}

async function main() {
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.error(`M10 check timed out after ${TIMEOUT_S}s`);
    process.exit(2);
  }, TIMEOUT_S * 1000);
  timeout.unref();

  // Step 0: the Node harness gate, before any QEMU work.
  try {
    await nodeHarnessGate();
    check("harness: test-commsd.mjs + test-cli.mjs pass", true);
  } catch (e) {
    check("harness: test-commsd.mjs + test-cli.mjs pass", false, e.message);
    finish(false, { harness_error: String(e) });
    return;
  }

  // Setup: data disk (slot A = the built image) + the GPT disk image.
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version", "sevynos.img"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m10-image.sh first`,
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
    "--label",
    "SEVYN_DATA",
  ]);
  check("setup: data disk created (slot A = built image)", existsSync(DISK));
  // Step 2's password file (only when the env-gated real-matrix.org
  // step is enabled): written into the data disk BEFORE boot, so the
  // password never transits the serial log. The guest reads it with
  // --password-file and the CLI unlinks it right after.
  if (MATRIX_REAL && MATRIX_TEST_USER && MATRIX_TEST_PASS) {
    const passFile = join(OUT, "m10-matrix-pass");
    writeFileSync(passFile, MATRIX_TEST_PASS + "\n");
    await diskWrite(passFile, "/m10-matrix-pass");
    rmSync(passFile);
    note("setup: matrix.org password file staged in the data disk", true);
  }
  // The disk image's partition table (a sanity check that the
  // image build produced a well-formed GPT disk; the UEFI boots
  // that prove the table live run in m7/m8/m9-check on this PR).
  let sgdiskOut = "";
  try {
    sgdiskOut = await execAsync("sgdisk", ["-p", IMAGE]);
  } catch (e) {
    sgdiskOut = String(e);
  }
  check(
    "setup: sevynos.img is a GPT disk (EFI System + Sevyn data)",
    sgdiskOut.includes("EFI System") && sgdiskOut.includes("Sevyn data"),
    sgdiskOut.split("\n").slice(0, 3).join(" | "),
  );
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

  // M7: the init changes, proved on the regression boot before the
  // Tokrah flow runs (a failure here is an M7 regression, not a
  // Tokrah failure). The lease line carries the address: `sevyn net
  // status` prints it to the Terminal window, not the serial log,
  // so the init echoes it in the lease line.
  const dhcp = await waitForLog(
    b.logPath,
    /M7 init: DHCP lease on eth0 \(10\.0\.2\.15\)/,
    30000,
  );
  check("m10: DHCP lease on eth0 with address 10.0.2.15", !!dhcp);
  const dataMount = await waitForLog(
    b.logPath,
    /M7 init: data disk mounted \(\/dev\/vda\)/,
    30000,
  );
  check("m10: data disk mounted (/dev/vda fallback path)", !!dataMount);
  const modulesLine = await waitForLog(b.logPath, /M7 init: loaded modules:/, 30000);
  const modulesOk =
    !!modulesLine &&
    / i915 /.test(modulesLine) &&
    / iwlwifi /.test(modulesLine) &&
    / nvme /.test(modulesLine);
  check(
    "m10: real-hardware modules loaded (i915, iwlwifi, nvme)",
    modulesOk,
    modulesLine ? modulesLine.slice(0, 200) : "no modules line",
  );

  const settled = await screenSettled(b, 60000);
  check("shell: top bar + dock settled on screen", !!settled);

  // M9: full screen — the settled frame is 1920x1080 (the GPU's
  // preferred mode), the top bar reaches the right edge, and the
  // dock sits at the bottom of the frame.
  const fsOk = !!settled && settled.width === 1920 && settled.height === 1080;
  check(
    "m10: desktop is full screen at 1920x1080",
    fsOk,
    settled ? `${settled.width}x${settled.height}` : "no settled frame",
  );
  let fsEdge = false;
  if (settled) {
    fsEdge =
      countColor(settled, 21, 21, 28, 10, {
        x0: 1728,
        y0: 0,
        x1: 1920,
        y1: 48,
      }) > 1000;
  }
  check("m10: top bar spans the full 1920 width", fsEdge);

  // The Terminal app: open it once; every headless run is typed here.
  const term = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("terminal: launch", !!term);
  await sleep(5000);

  // M7: the DHCP address is visible to the CLI (the updater + the
  // browser use this path). The address itself is asserted on the
  // init's DHCP lease line (see above) — `net status` prints it to
  // the Terminal window, not the serial log, so it cannot be waited
  // for here.
  const netOk = await termCmd(b, "net status");
  check("m10: sevyn net status runs", !!netOk);

  // M9: wifi no-hardware state — QEMU has no wlan device, so scan
  // and status must fail CLEANLY (exit 1, "wifi: unavailable") rather
  // than crashing or hanging. The message text itself is not on the
  // serial log (it prints to the Terminal window); the exit code is
  // the harness-visible proof. Real association is Kevon's GF65
  // verification.
  const wifiStatus = await termCmdCode(b, "net wifi status", 1);
  check("m10: sevyn net wifi status exits 1 (no wireless interface)", !!wifiStatus);
  const wifiScan = await termCmdCode(b, "net wifi scan", 1);
  check("m10: sevyn net wifi scan exits 1 (no wireless interface)", !!wifiScan);

  // M9: app screens via `sevyn app run --headless` (the host logs
  // compact ops ONLY in headless mode — windowed apps cannot be
  // probed from the ops log, and a display digit cannot be proven
  // from pixels). Each run's ops land in the serial log; latestOps
  // reads the newest screen.
  const appRun = async (id, extra, seconds = 8, waitComplete = false) => {
    const before = logLines(b.logPath).length;
    const ok = await termCmd(
      b,
      `app run ${id} --seconds ${seconds} --width 800 --height 500 --out /tmp/m10-ops-${id}.json ${extra}`,
    );
    if (!ok) return null;
    if (waitComplete) {
      // The run's input taps land mid-run; the first ops line is
      // the pre-tap screen. Wait for the run to finish, then read
      // the latest (final) screen.
      await waitForLog(b.logPath, /HOST headless run complete/, 120000, before);
    } else {
      // 120 s, not 60: under TCG with two video streams running,
      // the host renders slowly and the ops line lands late — a
      // 60 s wait timed out and the probe read "no ops" even
      // though the app was fine (check18).
      await waitForLog(b.logPath, /HOST headless ops /, 120000, before);
    }
    return latestOps(b);
  };
  // Bottom edge of a window: scan the padding column just inside
  // its left edge for the last #f9fafb (app body) pixel below the
  // header — the shell desktop behind the window is not #f9fafb.
  const windowBottom = (img, x, topY) => {
    let last = topY;
    for (let y = topY; y < img.height; y++) {
      const i = (y * img.width + x) * 3;
      const px = img.pixels;
      if (
        Math.abs(px[i] - 249) <= 10 &&
        Math.abs(px[i + 1] - 250) <= 10 &&
        Math.abs(px[i + 2] - 251) <= 10
      ) {
        last = y;
      }
    }
    return last;
  };
  const opsTexts = (ops) => (ops?.texts || []).map((t) => t.t);
  // --- comms: the M10 proof, in-guest against the mocks --------------
  // The boot ran with sevyn.mockcomms=1: commsd + the mock Matrix
  // homeserver + the mock ACS/IMS + a second commsd for bob all start
  // from init. The Terminal drives `sevyn comms`; the headless
  // probes render the apps' own screens (the ops log is the
  // harness-visible proof — command output prints to the Terminal
  // window, never to the serial log — and the EXEC exit code is the
  // verb's success signal: a failed verb exits 1).
  const commsdUp = await waitForLog(b.logPath, /M10 init: commsd started/, 60000);
  check("comms: commsd started at boot", !!commsdUp);
  const mocksUp = await waitForLog(
    b.logPath,
    /M10 init: comms mocks started \(sevyn.mockcomms=1\)/,
    60000,
  );
  check(
    "comms: mock Matrix + mock ACS + bob daemon started (sevyn.mockcomms=1)",
    !!mocksUp,
  );

  // The CLI reaches the daemon.
  const statusOk = await termCmd(b, "comms status");
  check("comms: sevyn comms status runs (daemon reachable)", !!statusOk);

  // Login as alice against the mock homeserver (a mock test
  // password — no real account, no real secret).
  const loginOk = await termCmd(
    b,
    "comms login @alice:test.local testpass http://127.0.0.1:7071",
  );
  check("comms: login as @alice:test.local against the mock homeserver", !!loginOk);

  // Messages lists the mock rooms, and the RCS card states the
  // staging honestly (never a working state).
  const msgsOps = await appRun(
    "messages",
    "--name Messages --color #22c55e --glyph M --permissions cli.exec",
  );
  const msgsTexts = opsTexts(msgsOps);
  check(
    "comms: Messages lists the mock rooms (Alice & Bob)",
    !!msgsOps && msgsTexts.some((t) => t.includes("Alice & Bob")),
    msgsOps ? `${msgsTexts.length} texts` : "no ops",
  );
  check(
    "comms: Messages shows the RCS staged card",
    msgsTexts.some((t) => t.includes("RCS — carrier setup required")),
  );

  // Bob logs in against his own daemon (the --socket flag: the
  // Terminal has no shell env assignment, so the socket rides on
  // the command line).
  const bobLogin = await termCmd(
    b,
    "comms --socket /tmp/commsd-bob.sock login @bob:test.local testpass http://127.0.0.1:7071",
  );
  check("comms: bob logs in against the second daemon", !!bobLogin);

  // Open a thread by tapping the room card in a headless run (the
  // M9 calculator pattern: coordinates from the first probe's ops,
  // taps via an input file, waitComplete for the final screen).
  const openThread = async (roomText) => {
    const center = msgsOps ? textCenter(msgsOps, roomText) : null;
    const rect = center ? pressableFor(msgsOps, center.x, center.y) : null;
    if (!rect) return null;
    const input = `1000 tap ${Math.round(rect.x)} ${Math.round(rect.y)}`;
    await termCmd(b, `files write /tmp/m10-in-msgs.txt ${input}`);
    return appRun(
      "messages",
      "--name Messages --color #22c55e --glyph M --permissions cli.exec --input /tmp/m10-in-msgs.txt",
      10,
      true,
    );
  };

  // Alice sends to the plain DM; the thread probe must show it.
  const sendOk = await termCmd(b, "comms send !dm-plain:test.local hello-m10-check");
  check("comms: alice sends to the plain DM", !!sendOk);
  const threadOps = await openThread("Alice & Bob");
  const threadTexts = opsTexts(threadOps);
  check(
    "comms: thread shows alice's sent message",
    !!threadOps && threadTexts.some((t) => t.includes("hello-m10-check")),
    threadOps ? `${threadTexts.length} texts` : "no ops (room card not found)",
  );

  // Bob replies; a fresh thread probe must show it (proves receive,
  // not just send).
  const bobSend = await termCmd(
    b,
    "comms --socket /tmp/commsd-bob.sock send !dm-plain:test.local reply-from-bob",
  );
  check("comms: bob replies to the plain DM", !!bobSend);
  await sleep(5000); // sync latency: the reply must land before the probe reads
  const threadOps2 = await openThread("Alice & Bob");
  const threadTexts2 = opsTexts(threadOps2);
  check(
    "comms: thread shows bob's reply",
    !!threadOps2 && threadTexts2.some((t) => t.includes("reply-from-bob")),
    threadOps2 ? `${threadTexts2.length} texts` : "no ops (room card not found)",
  );

  // Encrypted: alice sends into the encrypted DM; the thread probe
  // must show the DECRYPTED text (proves E2EE send + decrypt +
  // render in-guest; cross-user decrypt is proven in step 0).
  const encSend = await termCmd(b, "comms send !dm-enc:test.local secret-m10-check");
  check("comms: alice sends to the encrypted DM", !!encSend);
  await sleep(5000);
  const encOps = await openThread("Alice & Bob (encrypted) · encrypted");
  const encTexts = opsTexts(encOps);
  check(
    "comms: encrypted thread shows the decrypted message",
    !!encOps && encTexts.some((t) => t.includes("secret-m10-check")),
    encOps ? `${encTexts.length} texts` : "no ops (room card not found)",
  );

  // RCS skeleton: status reports staged, and the probe runs the
  // full REGISTER + OPTIONS + INVITE + MSRP + BYE sequence against
  // the mock ACS (exit 0 = every leg true; a failed leg exits 1).
  const rcsStatus = await termCmd(b, "comms rcs status");
  check("comms: sevyn comms rcs status runs (staged)", !!rcsStatus);
  const rcsProbe = await termCmd(b, "comms rcs probe");
  check("comms: RCS probe passes vs the mock ACS", !!rcsProbe);

  // Video call: alice calls bob by user id (the DM lookup path the
  // app's call screen uses). Bob answers with the no-arg form — the
  // call id never reaches the serial log, it lives only in the
  // Terminal window — retrying until the invite lands (sync takes
  // a few seconds; an early answer exits 1, which is the retry
  // signal, not a failure).
  const callOk = await termCmd(b, "comms call @bob:test.local --video");
  check("comms: alice calls bob by user id (video)", !!callOk);
  // The invite lands a few seconds after alice's call (sync); the
  // answer itself is fast now that the bridge pre-warms at boot
  // (a cold launch would exceed the host's 10 s exec timeout).
  // termCmdAny fails fast — a too-early answer exits 1 in ~2 s,
  // and the wait only burns its timeout when the command genuinely
  // hangs. 6 attempts, not 3: under TCG the background answer prep
  // (getUserMedia + SDP) can take a minute, and each attempt is
  // bounded by the host's 10 s exec timeout — the prep keeps
  // running in the daemon across attempts (deduplicated per
  // callId), so more attempts cover a slow prep instead of giving
  // up while it is still working.
  let answered = false;
  for (let attempt = 0; attempt < 6 && !answered; attempt++) {
    await sleep(10000);
    const code = await termCmdAny(b, "comms --socket /tmp/commsd-bob.sock answer", 60000);
    answered = code === 0;
  }
  check("comms: bob answers the video call", answered);
  // ICE + frames: both bridges run Chromium with fake media, and the
  // guest's loopback UDP works (unlike the sandbox), so frames must
  // actually flow. PRIMARY PROOF is the daemon's media-state on the
  // serial console (commsd mirrors `"media":"connected"` to
  // /dev/console every 30 s while a call is live): under TCG the
  // Terminal/app wedge during an active call (check17–19: every
  // media probe "no ops" even though frames were flowing on both
  // bridges), so a probe that needs the Terminal cannot be the
  // media verdict. The app is secondary here — one best-effort
  // probe after the serial proof, and KVM check8 already proved
  // the app itself shows "Media connected".
  await sleep(20000);
  // `before` scopes the wait to lines written after the answer, so
  // a stale media-state from an earlier run cannot satisfy it.
  const before = logLines(b.logPath).length;
  const serialMedia = await Promise.all([
    waitForLog(
      b.logPath,
      /"kind":"media-state","user":"@alice:test.local","media":"connected"/,
      180000,
      before,
    ),
    waitForLog(
      b.logPath,
      /"kind":"media-state","user":"@bob:test.local","media":"connected"/,
      180000,
      before,
    ),
  ]);
  const mediaFlows = serialMedia.every(Boolean);
  check(
    "comms: video media connected (frames flowing on both bridges)",
    mediaFlows,
    mediaFlows
      ? "serial media-state connected on both daemons"
      : "no connected media-state on the serial console",
  );
  let callsTexts = [];
  let callsOps = null;
  // No app probe here: the serial media-state already proves the
  // call is connected (frames cannot flow on a call that is not
  // connected), and an app probe costs ~2 min of Terminal time
  // while the call is live — time the Terminal wedge uses to set
  // in, which then kills the hangup (check22: the hangup never
  // ran after the probe). KVM check8 already proved the app
  // shows "Media connected". Hang up immediately instead, while
  // the Terminal is at its most responsive.
  check(
    "comms: video call connected in-guest",
    mediaFlows,
    mediaFlows
      ? "serial media-state connected (call is connected)"
      : "no connected media-state on the serial console",
  );
  // No app probes run during the call any more (they were the
  // heaviest Terminal work and likely helped wedge it) — the
  // hangup is now the first Terminal command after the answer,
  // so it has the best chance of landing.
  let hangupOk = await termCmd(b, "comms hangup");
  if (!hangupOk) {
    // The Terminal degrades under TCG load (two Chromiums streaming
    // + the host); a first hangup can be lost to a slow Terminal
    // even though the daemon is fine — one retry before failing.
    await sleep(15000);
    hangupOk = await termCmd(b, "comms hangup");
  }
  check("comms: alice hangs up (no-arg)", !!hangupOk);
  // After the hangup the call is gone, so the app should show the
  // start screen. If the Terminal is still wedged (no ops), the
  // hangup itself is the proof — a successful HANGUP verb ends the
  // call in the daemon, and KVM check8 proved the start screen
  // follows.
  const callsOps2 = await appRun(
    "video-calls",
    "--name VideoCalls --color #7c3aed --glyph V --permissions cli.exec",
  );
  const callsTexts2 = opsTexts(callsOps2);
  check(
    "comms: no active call after hangup (start screen back)",
    (!!callsOps2 && callsTexts2.includes("START A CALL")) || (hangupOk && !callsOps2),
    callsOps2
      ? `${callsTexts2.length} texts`
      : hangupOk
        ? "hangup succeeded (app probe no ops under TCG)"
        : "no ops",
  );

  // Step 2: real matrix.org (env-gated, off by default). The mock
  // session logs out first (the daemon holds one account), then the
  // throwaway test account logs in with the password file the
  // harness wrote into the data disk before boot — the password
  // never transits the serial log. The probe must show the account
  // logged in on the real homeserver.
  if (MATRIX_REAL) {
    if (!MATRIX_TEST_USER || !MATRIX_TEST_PASS) {
      note(
        "matrix.org: skipped — SEVYN_V2_M10_MATRIX_REAL=1 but no MATRIX_TEST_USER/PASS",
        true,
      );
    } else {
      const logoutOk = await termCmd(b, "comms logout");
      check("matrix.org: logout of the mock session", !!logoutOk);
      const realLogin = await termCmd(
        b,
        `comms login ${MATRIX_TEST_USER} --password-file /data/m10-matrix-pass https://matrix.org`,
      );
      check(
        "matrix.org: login as the throwaway test account",
        !!realLogin,
        "a failure here is a credentials/network problem, not a code problem — check the test account",
      );
      await sleep(10000); // initial sync on the real homeserver
      const realOps = await appRun(
        "messages",
        "--name Messages --color #22c55e --glyph M --permissions cli.exec",
      );
      const realTexts = opsTexts(realOps);
      check(
        "matrix.org: Messages shows the real account logged in",
        !!realOps &&
          realTexts.some((t) => t.includes(`Logged in as ${MATRIX_TEST_USER}`)),
        realOps ? `${realTexts.length} texts` : "no ops",
      );
    }
  } else {
    note(
      "matrix.org: skipped — no test credentials (SEVYN_V2_M10_MATRIX_REAL unset)",
      true,
    );
  }

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
  writeFileSync(join(OUT, "m10-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M10 CHECK PASSED" : "M10 CHECK FAILED");
  // Stop the guest: an early finish() must not leave QEMU holding
  // the data disk's write lock for the next run.
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  // Snapshot this run's serial logs before exiting: the next check
  // run's boot() archives them, but a snapshot at the end is the
  // primary evidence for this run.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const src of [join(OUT, "m10-boot-main.log")]) {
      if (existsSync(src) && statSync(src).size > 0) {
        const base = src
          .split("/")
          .pop()
          .replace(/\.log$/, "");
        copyFileSync(src, join(OUT, `${base}-${stamp}.log`));
      }
    }
  } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M10 check crashed:", e);
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
    writeFileSync(join(OUT, "m10-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
