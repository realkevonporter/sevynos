// M7 check: boot the SevynOS v2 M7 image in QEMU and prove the
// milestone — it boots on real hardware (bare metal), not just QEMU.
//
//   0. (Removed while Tokrah is out of the build — Kevon,
//      2026-11-25: the Node harness gate built the Tokrah bundle
//      and ran drive-live.js against the mock API. It comes back
//      with Tokrah; v2/tokrah/ stays in the tree, dormant.)
//   1. Regression boot (-kernel/-initrd + the data disk, now
//      LABEL=SEVYN_DATA): the M6 stack still intact (SEVYNOS_M5_READY
//      etc.), the M7 init changes proved — DHCP leases an address on
//      eth0, the data disk mounts by label (/dev/vda fallback), the
//      real-hardware modules loaded (i915, iwlwifi, nvme). (The full
//      Tokrah live flow in-guest — phases A–D + interactive dock
//      launch — is removed with it until Tokrah comes back.)
//   2. UEFI boot (OVMF Secure Boot firmware + the GPT disk image
//      sevynos.img on a QEMU NVMe device — the boot path the GF65
//      will use): shim loads, GRUB loads the ESP kernel, the
//      NVMe data partition mounts by label, DHCP leases, the shell
//      paints. No -kernel/-initrd: the bootloader does the work.
//      If this boots under the secboot OVMF, the whole Secure Boot
//      chain verified (shim + GRUB + kernel are all signed
//      by the chain the firmware trusts) — there is no finer signal
//      to read, the boot itself is the proof.
//   3. Clean poweroff (both boots).
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard) into the Terminal, exactly as m6-check.
// Screendumps use QMP screendump in PPM format. Results go to
// m7-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m7-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M7_TIMEOUT (seconds, default 5400 — the UEFI boot
//      under TCG adds firmware init on top of the M6 flow),
//      SEVYN_V2_SYSROOT (default / — the OVMF files live under
//      $SYSROOT/usr/share/OVMF),
//      SEVYN_V2_OVMF_CODE / SEVYN_V2_OVMF_VARS (OVMF firmware paths;
//      default the secboot CODE + the Microsoft-keys VARS).
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
const DISK = join(OUT, "m7-data.img");
const IMAGE = join(OUT, "sevynos.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M7_TIMEOUT || 5400);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";
// OVMF firmware for the UEFI boot. CI installs ovmf on the runner
// (host sysroot /); the sandbox passes SEVYN_V2_SYSROOT to the
// fetched sysroot. The secboot CODE + the Microsoft-keys VARS is the
// pair that boots with Secure Boot ON and the MS certs enrolled —
// the GF65's firmware carries the same MS UEFI CA.
const SYSROOT = process.env.SEVYN_V2_SYSROOT || "/";
const OVMF_CODE =
  process.env.SEVYN_V2_OVMF_CODE ||
  join(SYSROOT, "usr/share/OVMF/OVMF_CODE_4M.secboot.fd");
const OVMF_VARS =
  process.env.SEVYN_V2_OVMF_VARS || join(SYSROOT, "usr/share/OVMF/OVMF_VARS_4M.ms.fd");

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
  const kern = join(OUT, `m7-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m7-boot-${tag}-initramfs.cpio.gz`);
  await execAsync("debugfs", ["-R", `dump /slots/${slot}/vmlinuz ${kern}`, DISK]);
  await execAsync("debugfs", [
    "-R",
    `dump /slots/${slot}/initramfs.cpio.gz ${initrd}`,
    DISK,
  ]);
  return { kern, initrd };
}

// --- one QEMU boot ---
// mode "kernel": the M6-style boot — -kernel/-initrd from the data
// disk's active slot, mock API on the cmdline, virtio data disk.
// mode "uefi": the M7 boot — OVMF (Secure Boot firmware) + the GPT
// disk image on a QEMU NVMe device; the bootloader (shim +
// GRUB on the ESP) loads the kernel, so there is no
// -kernel/-initrd/-append and no separate data disk. The GRUB
// menuentry carries console=tty0 console=ttyS0 sevyn.slot=A.
let currentBoot = null;

async function boot(tag, mode = "kernel") {
  const uefi = mode === "uefi";
  let bootSlot = "A";
  let kern = null;
  let initrd = null;
  if (!uefi) {
    const state = await readState();
    bootSlot = state.active;
    ({ kern, initrd } = await dumpSlot(bootSlot, tag));
  }
  const logPath = join(OUT, uefi ? `m7-uefi-boot-${tag}.log` : `m7-boot-${tag}.log`);
  // Archive the previous run's log before overwriting: a failing
  // run destroys its own evidence otherwise (the serial log is
  // overwritten every check run). Timestamped so runs don't clobber
  // each other.
  try {
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(
        logPath,
        join(
          OUT,
          uefi ? `m7-uefi-boot-${tag}-${stamp}.log` : `m7-boot-${tag}-${stamp}.log`,
        ),
      );
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
  const ctlSock = join(OUT, `m7-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m7-${tag}-appd.sock`);
  const updSock = join(OUT, `m7-${tag}-upd.sock`);
  const aidSock = join(OUT, `m7-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m7-${tag}-qmp.sock`);
  // QEMU writes the NVRAM variables, so the UEFI boot gets a fresh
  // copy of the VARS file per run (never the shared original).
  let varsCopy = null;
  if (uefi) {
    if (!existsSync(OVMF_CODE)) {
      throw new Error(`OVMF code not found: ${OVMF_CODE}`);
    }
    if (!existsSync(OVMF_VARS)) {
      throw new Error(`OVMF vars not found: ${OVMF_VARS}`);
    }
    varsCopy = join(OUT, `m7-uefi-vars-${tag}.fd`);
    copyFileSync(OVMF_VARS, varsCopy);
  }
  const args = ["-machine", `q35,accel=${ACCEL}`, "-m", "4096", "-smp", "2"];
  if (uefi) {
    args.push(
      "-drive",
      `if=pflash,format=raw,unit=0,file=${OVMF_CODE},readonly=on`,
      "-drive",
      `if=pflash,format=raw,unit=1,file=${varsCopy}`,
      "-drive",
      `file=${IMAGE},format=raw,if=none,id=nvme0`,
      "-device",
      "nvme,drive=nvme0,serial=sevynos0",
    );
  } else {
    args.push(
      "-kernel",
      kern,
      "-initrd",
      initrd,
      "-append",
      `console=ttyS0 sevyn.slot=${bootSlot}`,
    );
  }
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
  if (!uefi) {
    args.push("-drive", `file=${DISK},format=raw,if=virtio,cache=writethrough`);
  }
  args.push(
    "-device",
    "virtio-gpu-pci",
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
  const qmpPath = join(OUT, `m7-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m7-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m7-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m7-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m7-${b.tag}-aid.sock`));
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
  const shotPath = join(OUT, `m7-shot-${b.tag}.ppm`);
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
      const dockBg = countColor(img, 52, 54, 59, 10, {
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
// sleep + 60 ms), so the typed commands are kept short.
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
  // the run's outcome checks fail if a coordinate was mangled.
  // 80 chars, not 40: the longest commands share their first 40
  // chars and only diverge later, so a 40-char prefix matched a
  // stale earlier run (check 45: the C run "completed" on the probe
  // run's EXEC line).
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
async function main() {
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.error(`M7 check timed out after ${TIMEOUT_S}s`);
    process.exit(2);
  }, TIMEOUT_S * 1000);
  timeout.unref();

  // Setup: data disk (slot A = the built image) + the GPT disk image.
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version", "sevynos.img"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m7-image.sh first`,
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
  // The disk image's partition table (verified again by the UEFI boot
  // itself, which only works if the table + ESP are right).
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

  // Boot: the M5 stack still intact.
  const ready = await waitForLog(b.logPath, /SEVYNOS_M5_READY/, 300000);
  check("boot: SEVYNOS_M5_READY", !!ready);
  const ready45 = await waitForLog(b.logPath, /SEVYNOS_M4_5_READY/, 30000);
  check("boot: SEVYNOS_M4_5_READY (M4.5 stack intact)", !!ready45);
  const ping = await appdCmd(b, "PING", /APPD PONG/);
  check("appd: PING -> PONG", !!ping);

  // M7: the init changes, proved on the regression boot. The lease
  // line carries the address: `sevyn net
  // status` prints it to the Terminal window, not the serial log,
  // so the init echoes it in the lease line.
  const dhcp = await waitForLog(
    b.logPath,
    /M7 init: DHCP lease on eth0 \(10\.0\.2\.15\)/,
    30000,
  );
  check("m7: DHCP lease on eth0 with address 10.0.2.15", !!dhcp);
  const dataMount = await waitForLog(
    b.logPath,
    /M7 init: data disk mounted \(\/dev\/vda\)/,
    30000,
  );
  check("m7: data disk mounted (/dev/vda fallback path)", !!dataMount);
  const modulesLine = await waitForLog(b.logPath, /M7 init: loaded modules:/, 30000);
  const modulesOk =
    !!modulesLine &&
    / i915 /.test(modulesLine) &&
    / iwlwifi /.test(modulesLine) &&
    / nvme /.test(modulesLine);
  check(
    "m7: real-hardware modules loaded (i915, iwlwifi, nvme)",
    modulesOk,
    modulesLine ? modulesLine.slice(0, 200) : "no modules line",
  );

  const settled = await screenSettled(b, 60000);
  check("shell: top bar + dock settled on screen", !!settled);

  // The Terminal app: open it once; the CLI checks below are typed here.
  const term = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("terminal: launch", !!term);
  await sleep(5000);

  // M7: the DHCP address is visible to the CLI (the updater + the
  // browser use this path). The address itself is asserted on the
  // init's DHCP lease line (see above) — `net status` prints it to
  // the Terminal window, not the serial log, so it cannot be waited
  // for here.
  const netOk = await termCmd(b, "net status");
  check("m7: sevyn net status runs", !!netOk);

  // Clean poweroff.
  b.ctl.write("POWEROFF\n");
  const exited = await waitExit(b, 30000);
  check("shutdown: guest powers off on request", exited);
  closeBoot(b);

  // --- UEFI boot: the GF65's boot path (OVMF Secure Boot + GPT disk
  // image on NVMe). The loader entry carries sevyn.slot=A. The
  // waits are generous: OVMF init under TCG is slow.
  const u = await boot("uefi", "uefi");
  await connectSockets(u);
  const uReady = await waitForLog(u.logPath, /SEVYNOS_M5_READY/, 600000);
  check("uefi: SEVYNOS_M5_READY (shim + GRUB + kernel verified)", !!uReady);
  check(
    "uefi: boot under Secure Boot OVMF (the whole chain verified)",
    !!uReady,
    "a bad shim/GRUB/kernel signature would have refused to boot",
  );
  const uData = await waitForLog(
    u.logPath,
    /M7 init: data disk mounted \(\/dev\/disk\/by-label\/SEVYN_DATA\)/,
    60000,
  );
  check("uefi: NVMe data partition mounts by label", !!uData);
  const uDhcp = await waitForLog(
    u.logPath,
    /M7 init: DHCP lease on eth0 \(10\.0\.2\.15\)/,
    60000,
  );
  check("uefi: DHCP lease on eth0 with address 10.0.2.15", !!uDhcp);
  const uModules = await waitForLog(u.logPath, /M7 init: loaded modules:/, 60000);
  const uModulesOk =
    !!uModules &&
    / i915 /.test(uModules) &&
    / iwlwifi /.test(uModules) &&
    / nvme /.test(uModules);
  check(
    "uefi: real-hardware modules loaded (i915, iwlwifi, nvme)",
    uModulesOk,
    uModules ? uModules.slice(0, 200) : "no modules line",
  );
  const uSettled = await screenSettled(u, 120000);
  check("uefi: shell top bar + dock settled on screen", !!uSettled);
  // The UEFI boot has no mock API, so `net status` is driven from
  // the Terminal the same way (the CLI path is identical). The
  // address is asserted on the init's DHCP lease line (see above).
  const uTerm = await appdCmd(u, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("uefi: terminal launches", !!uTerm);
  await sleep(5000);
  const uNetOk = await termCmd(u, "net status");
  check("uefi: sevyn net status runs", !!uNetOk);
  u.ctl.write("POWEROFF\n");
  const uExited = await waitExit(u, 30000);
  check("uefi: guest powers off on request", uExited);
  closeBoot(u);
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
  writeFileSync(join(OUT, "m7-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M7 CHECK PASSED" : "M7 CHECK FAILED");
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
    for (const src of [
      join(OUT, "m7-boot-main.log"),
      join(OUT, "m7-uefi-boot-uefi.log"),
    ]) {
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
  console.error("M7 check crashed:", e);
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
    writeFileSync(join(OUT, "m7-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
