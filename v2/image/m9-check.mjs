// M9 check: boot the SevynOS v2 M9 image in QEMU and prove the
// milestone — desktop polish (Kevon, 2026-11-09: full-screen desktop,
// wifi in Settings, movable/resizable windows, real app content)
// plus the installer (in-place updates on bare metal via the ESP
// sync).
//
//   0. Node harness gate (on the CI host, before QEMU): build the
//      Tokrah bundle from v2/tokrah and run drive-live.js — login →
//      home feed → go-live → start live → socket live:join → host
//      screen → end live — against the mock API. Exit 0 = full pass.
//      This is the live-session proof with Tokrah's real client code.
//   1. Regression boot (-kernel/-initrd + the data disk, now
//      LABEL=SEVYN_DATA) at 1920x1080: the M6 stack still intact
//      (SEVYNOS_M5_READY etc.), the M7 init changes proved — DHCP
//      leases an address on eth0, the data disk mounts by label
//      (/dev/vda fallback), the real-hardware modules loaded (i915,
//      iwlwifi, nvme) — the M9 polish proved (full-screen shell at
//      1920x1080, move/resize drags, Settings wifi UI + app screens
//      via `sevyn app run --headless`, wifi no-hardware state) — and
//      the full Tokrah live flow still works in-guest (phases A–D +
//      interactive dock launch, as M6).
//   2. UEFI boot — ESP-sync apply (OVMF Secure Boot firmware + the
//      GPT disk image sevynos.img on a QEMU NVMe device — the boot
//      path the GF65 will use): a test-signed feed (version
//      m9-test-2, initramfs carrying a marker file) is served over
//      HTTP from the host (slirp 10.0.2.2); the update URL is set in
//      the data partition's update-config.json before boot; APPLY is
//      driven over the updater control serial; the VM reboots; the
//      harness then proves from the host that the ESP holds the new
//      kernel + initramfs, the old ones are preserved as .prev, and
//      grub.cfg has the default + previous entries.
//   3. UEFI boot — post-apply: the updated image boots the NEW
//      initramfs (the marker file reads back from the Terminal) and
//      the new slot marks itself good.
//   4. UEFI boot — fallback: the slot state is tampered
//      (attempts=2, active=B, good=A) before boot; the daemon
//      restores the ESP from the good slot, flips active back, and
//      reboots; the harness proves the ESP + state are back on A.
//   5. UEFI boot — post-restore: the restored system boots clean.
//   6. Shutdown/restart (the shutdown fix): `sevyn reboot` from the
//      Terminal tears the guest down cleanly (daemons stopped, /data
//      unmounted) and the guest reboots (QEMU exits under
//      -no-reboot); a second boot proves `sevyn poweroff` the same
//      way; a third boot proves the tray power menu (tap Power, tap
//      Shut Down). The Settings Power section is proved by the
//      headless Settings run in step 1.
//
// Two modes for the UEFI boots (step 2-5), mirroring m8-check:
//   Test-key mode (no anchor committed): the image trusts a fresh
//     per-image TEST keypair; the harness signs the test feed with
//     the test private key and proves the full positive flow (apply
//     + ESP sync + post-apply boot + fallback + post-restore).
//   Anchor mode (v2/update/trusted-update-keys.json committed): the
//     image trusts the committed anchor (e.g. the real nightly key),
//     so no feed the harness can sign will verify. The harness
//     instead proves: the staged anchor in the image is byte-identical
//     to the committed anchor; a feed signed by an untrusted throwaway
//     key is refused on APPLY; and the ESP + slot state are unchanged
//     by the refusal. The positive apply path with the real key is
//     proven later by the real nightly feed + an in-place update on
//     hardware, not by this check.
//
// The UEFI boots prove the whole Secure Boot chain the same way the
// M7 check did — if one boots under the secboot OVMF, shim + GRUB +
// kernel are all signed by the chain the firmware trusts.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard) into the Terminal, exactly as m6-check.
// Screendumps use QMP screendump in PPM format. Results go to
// m9-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m9-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M9_TIMEOUT (seconds, default 10800 — five boots
//      under TCG plus the Tokrah flow),
//      TOKRAH_SRC (Tokrah repo root — required for step 0;
//      the workflow clones with TOKRAH_READ_TOKEN),
//      SEVYN_V2_SYSROOT (default / — the OVMF files live under
//      $SYSROOT/usr/share/OVMF),
//      SEVYN_V2_OVMF_CODE / SEVYN_V2_OVMF_VARS (OVMF firmware paths;
//      default the secboot CODE + the Microsoft-keys VARS).
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m9-data.img");
const IMAGE = join(OUT, "sevynos.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M9_TIMEOUT || 10800);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM. The go-live mount flush is 727-956ms under TCG
// and a retry tap landing mid-flush wedges it; under KVM the flush
// is fast and the wedge should vanish.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";
const TOKRAH_SRC = process.env.TOKRAH_SRC || "";
const ANCHOR_FILE = join(ROOT, "update", "trusted-update-keys.json");
const GEN_KEY = join(ROOT, "..", "tools", "update-signing", "generate-key.mjs");
// Anchor mode: a real trust anchor is committed, so the image trusts
// the committed key(s) and the test-key path is gone. The harness
// signs the test feed with a throwaway keypair it generates itself
// (harness-only, in the git-ignored build dir, never staged into any
// image) and asserts the image refuses it.
const ANCHOR_MODE = existsSync(ANCHOR_FILE);
const THROWAWAY_KEY_FILE = join(OUT, "throwaway-signing-key.json");
let signKeyFile = join(OUT, "update-signing-key.json");
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
    // A dead QEMU must surface as an error, not a hang: when the
    // socket closes, every pending waiter rejects instead of waiting
    // forever. A tap that powers the guest off (the tray shutdown
    // probe) kills the socket mid-drag — without this, Node's event
    // loop empties and the check exits 0 without a verdict.
    const failWaiters = (err) => {
      for (const w of this.waiters.splice(0)) w({ error: err });
    };
    this.sock.on("close", () => failWaiters({ message: "qmp socket closed" }));
    this.sock.on("error", (e) => failWaiters(e));
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
  const kern = join(OUT, `m9-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m9-boot-${tag}-initramfs.cpio.gz`);
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
// menuentry carries console=tty0 console=ttyS0 sevyn.slot=A (no mockapi
// — the real flow).
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
  const logPath = join(OUT, uefi ? `m9-uefi-boot-${tag}.log` : `m9-boot-${tag}.log`);
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
          uefi ? `m9-uefi-boot-${tag}-${stamp}.log` : `m9-boot-${tag}-${stamp}.log`,
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
  const ctlSock = join(OUT, `m9-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m9-${tag}-appd.sock`);
  const updSock = join(OUT, `m9-${tag}-upd.sock`);
  const aidSock = join(OUT, `m9-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m9-${tag}-qmp.sock`);
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
    varsCopy = join(OUT, `m9-uefi-vars-${tag}.fd`);
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
      `console=ttyS0 sevyn.slot=${bootSlot} sevyn.mockapi=1`,
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
    args.push("-drive", `file=${DISK},format=raw,if=virtio`);
  }
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
  const qmpPath = join(OUT, `m9-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m9-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m9-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m9-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m9-${b.tag}-aid.sock`));
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
  const shotPath = join(OUT, `m9-shot-${b.tag}.ppm`);
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
  return hit;
}
// Write an input file and verify it is readable: termCmd's
// EXEC-prefix match is a false negative when QMP drops a character
// in the typed command, so confirm the file is actually on disk via
// `files cat`. The cat's exit code (0) is the verification — its
// OUTPUT is not in the boot log, so waiting for the file's content
// (the login email) to appear in the log can never succeed: the
// email only shows up later, when the headless run types it into
// the login form. (That is why the old waitForLog read-back timed
// out on every probe even though the file was written and the
// downstream login/live flows all passed.) The content itself is
// proven downstream: a mistyped file makes the login POST / live
// start fail, and those checks gate the run.
async function writeInputFile(b, path, content) {
  await termCmd(b, `files write ${path} ${content}`);
  await termCmd(b, `files cat ${path}`);
  return true;
}

// --- compact ops log parsing ---
// The headless host logs one `HOST headless ops {json}` line per
// screen (texts + pressable rects). Return the latest one.
// sinceLines scopes the scan to lines after a run started: without
// it a caller reads the PREVIOUS probe's ops (the Notes screen's 4
// texts) and mistakes them for the current run's — the M9 Phase A
// failure mode (the ops wait below matched a stale line instantly
// and the check killed the guest before the Tokrah run could beat).
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

// --- M9 helpers: pointer drags, colour boxes, ESP + feed ---
// Type a command and wait for a specific exit code (termCmd only
// matches -> 0; the wifi no-hardware state exits 1 by design).
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

// Absolute-pointer drag on the usb-tablet (axes 0..32767): move to
// the start, press left, step to the end, release. The Wayland host
// turns the button press on a title bar / edge strip into an
// interactive move / resize.
// Absolute-pointer click on the usb-tablet (axes 0..32767): move,
// press left, release. A click on the shell's desktop area
// activates the shell surface; a click on a dock tile hits the
// tile's Pressable.
async function pointerClick(qmp, W, H, x, y) {
  const ax = Math.max(0, Math.min(32767, Math.round((x / W) * 32767)));
  const ay = Math.max(0, Math.min(32767, Math.round((y / H) * 32767)));
  await qmp.input([
    { type: "abs", data: { axis: "x", value: ax } },
    { type: "abs", data: { axis: "y", value: ay } },
  ]);
  await sleep(300);
  await qmp.input([{ type: "btn", data: { down: true, button: "left" } }]);
  await sleep(200);
  await qmp.input([{ type: "btn", data: { down: false, button: "left" } }]);
  await sleep(500);
}

async function pointerDrag(qmp, W, H, x0, y0, x1, y1, steps = 12) {
  const ax = (x) => Math.max(0, Math.min(32767, Math.round((x / W) * 32767)));
  const ay = (y) => Math.max(0, Math.min(32767, Math.round((y / H) * 32767)));
  await qmp.input([
    { type: "abs", data: { axis: "x", value: ax(x0) } },
    { type: "abs", data: { axis: "y", value: ay(y0) } },
  ]);
  await sleep(300);
  await qmp.input([{ type: "btn", data: { down: true, button: "left" } }]);
  await sleep(200);
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    await qmp.input([
      { type: "abs", data: { axis: "x", value: ax(x) } },
      { type: "abs", data: { axis: "y", value: ay(y) } },
    ]);
    await sleep(80);
  }
  await qmp.input([{ type: "btn", data: { down: false, button: "left" } }]);
  await sleep(500);
}

// Bounding box of a colour in a frame (null when absent).
function colorBox(img, r, g, b, tol = 10, box = null) {
  const { width: W, height: H, pixels } = img;
  const x0 = box?.x0 ?? 0;
  const y0 = box?.y0 ?? 0;
  const x1 = box?.x1 ?? W;
  const y1 = box?.y1 ?? H;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
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
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!n) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n };
}

// --- ESP + data partition surgery (host-side, rootless) ---
// The GPT image's partitions are addressed by byte offset (mtools
// @@offset for the FAT ESP; dd extract + debugfs for the ext4 data
// partition — debugfs cannot take an offset).
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function partRange(partNum) {
  const out = await execAsync("sgdisk", ["-p", IMAGE]);
  const line = out.split("\n").find((l) => new RegExp(`^\\s*${partNum}\\s`).test(l));
  if (!line) throw new Error(`sgdisk: no partition ${partNum} in ${IMAGE}`);
  const cols = line.trim().split(/\s+/);
  const start = Number(cols[1]);
  const end = Number(cols[2]);
  if (!start || !end || end < start) throw new Error(`sgdisk: bad range: ${line}`);
  return { startByte: start * 512, sectors: end - start + 1 };
}

const MTOOLS_ENV = { ...process.env, MTOOLS_SKIP_CHECK: "1" };

async function espRead(guestPath, outPath) {
  const { startByte } = await partRange(1);
  await execAsync("mcopy", ["-i", `${IMAGE}@@${startByte}`, `::${guestPath}`, outPath], {
    env: MTOOLS_ENV,
  });
  return outPath;
}

async function espWrite(hostPath, guestPath) {
  const { startByte } = await partRange(1);
  await execAsync(
    "mcopy",
    ["-o", "-i", `${IMAGE}@@${startByte}`, hostPath, `::${guestPath}`],
    { env: MTOOLS_ENV },
  );
}

async function dataExtract() {
  const { startByte, sectors } = await partRange(2);
  const part = join(OUT, "m9-data-part.img");
  await execAsync("dd", [
    `if=${IMAGE}`,
    `of=${part}`,
    "bs=512",
    `skip=${startByte / 512}`,
    `count=${sectors}`,
    "status=none",
  ]);
  return part;
}

async function dataWriteBack(part) {
  const { startByte } = await partRange(2);
  await execAsync("dd", [
    `if=${part}`,
    `of=${IMAGE}`,
    "bs=512",
    `seek=${startByte / 512}`,
    "conv=notrunc",
    "status=none",
  ]);
}

async function dataRead(guestPath) {
  const part = await dataExtract();
  return execAsync("debugfs", ["-R", `cat ${guestPath}`, part]);
}

async function dataWrite(hostPath, guestPath) {
  const part = await dataExtract();
  // Replay the ext4 journal before the debugfs write. debugfs edits
  // the partition image directly and bypasses the journal; the guest's
  // mount then replays the journal, which still holds the OLD file
  // content (the esp-boot daemon's write) and silently reverts the
  // debugfs change — the daemon reads attempts=0 and the fallback
  // never triggers (run13/run15). e2fsck -fy replays + clears the
  // journal so the guest mounts a clean filesystem and sees the
  // debugfs write. e2fsck exits 1 when it corrected something
  // (a journal replay), so tolerate 0/1 and fail only above that.
  await execAsync("sh", ["-c", `e2fsck -fy ${part} || [ $? -le 1 ]`]);
  // debugfs `write` refuses to overwrite an existing file ("Ext2 file
  // already exists", exit 0 — a silent no-op), so remove it first.
  // The rm fails when the file is absent; that is fine, the write
  // creates it. Without the rm the fallback's tampered state never
  // lands and the daemon reads attempts=0 (run11).
  await execAsync("debugfs", ["-w", "-R", `rm ${guestPath}`, part]).catch(() => {});
  await execAsync("debugfs", ["-w", "-R", `write ${hostPath} ${guestPath}`, part]);
  // Verify the write landed on the extracted partition before writing
  // it back: a silent debugfs no-op must fail loudly here, not surface
  // later as a fallback that never triggers (run12).
  const want = readFileSync(hostPath, "utf8");
  const got = await execAsync("debugfs", ["-R", `cat ${guestPath}`, part]);
  if (got !== want) {
    throw new Error(
      `dataWrite: read-back mismatch for ${guestPath} (wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)})`,
    );
  }
  await dataWriteBack(part);
}

// Parse the committed anchor. Returns { anchor } on success or
// { error } when it is missing, malformed, or empty — a malformed
// anchor is refused, never trusted (the image build refuses it too).
function readAnchor() {
  let anchor;
  try {
    anchor = JSON.parse(readFileSync(ANCHOR_FILE, "utf8"));
  } catch (e) {
    return { error: `committed anchor is not valid JSON: ${e.message}` };
  }
  if (
    !anchor ||
    typeof anchor !== "object" ||
    !Array.isArray(anchor.keys) ||
    anchor.keys.length === 0
  ) {
    return { error: "committed anchor needs a non-empty keys array" };
  }
  for (const entry of anchor.keys) {
    const kid = entry?.keyId;
    const jwk = entry?.publicKeyJwk;
    if (typeof kid !== "string" || kid.length === 0) {
      return { error: "anchor entry without a keyId" };
    }
    if (
      !jwk ||
      jwk.kty !== "OKP" ||
      jwk.crv !== "Ed25519" ||
      typeof jwk.x !== "string" ||
      jwk.x.length === 0
    ) {
      return {
        error: `anchor key ${kid}: publicKeyJwk is not an Ed25519 OKP JWK`,
      };
    }
    if (Buffer.from(jwk.x, "base64url").length !== 32) {
      return { error: `anchor key ${kid}: public key is not 32 bytes` };
    }
  }
  return { anchor };
}

// Extract the trust anchor staged in the built initramfs and compare
// it byte-for-byte with the committed anchor. The image must trust
// exactly the committed key(s) — nothing else, nothing malformed.
async function stagedAnchorEqualsCommitted() {
  const tmp = join(OUT, "anchor-extract");
  await execAsync("mkdir", ["-p", tmp]);
  try {
    await execAsync("sh", [
      "-c",
      `gzip -dc "${join(OUT, "initramfs.cpio.gz")}" | (cd "${tmp}" && cpio -id --quiet)`,
    ]);
    const staged = readFileSync(
      join(tmp, "usr", "share", "sevyn", "trusted-update-keys.json"),
    );
    return staged.equals(readFileSync(ANCHOR_FILE));
  } finally {
    await execAsync("rm", ["-rf", tmp]);
  }
}

// Build the test feed: the built kernel + a marker initramfs (the
// built initramfs plus /m9-esp-marker), signed with the build's TEST
// keypair, served over HTTP from the host. The guest reaches the
// host at 10.0.2.2 (slirp). Returns the feed facts the assertions
// need. The server stays up until the caller closes it.
async function buildTestFeed() {
  const feedDir = join(OUT, "m9-test-feed");
  rmSync(feedDir, { recursive: true, force: true });
  mkdirSync(feedDir, { recursive: true });
  const markerDir = join(OUT, "m9-marker-initramfs");
  rmSync(markerDir, { recursive: true, force: true });
  mkdirSync(markerDir, { recursive: true });
  await execAsync("sh", [
    "-c",
    `gzip -dc ${join(OUT, "initramfs.cpio.gz")} | (cd ${markerDir} && cpio -id --quiet)`,
  ]);
  writeFileSync(join(markerDir, "m9-esp-marker"), "M9-ESP-TEST-2\n");
  // The marker initramfs must report the FEED version (m9-test-2),
  // not the build version: the daemon's check_health syncs the slot
  // state's version to the running OS version, so a marker that still
  // says the build version would clobber m9-test-2 back to it on boot
  // and the fallback's tampered state would not match.
  writeFileSync(join(markerDir, "usr", "share", "sevyn", "os-version"), "m9-test-2\n");
  await execAsync("sh", [
    "-c",
    `(cd ${markerDir} && find . | cpio -o -H newc --quiet | gzip -9 > ${join(feedDir, "initramfs.cpio.gz")})`,
  ]);
  copyFileSync(join(OUT, "vmlinuz"), join(feedDir, "vmlinuz"));
  // In anchor mode the signing key is the harness throwaway keypair
  // (generated by the anchor-mode setup before this runs); in
  // test-key mode it is the build-time TEST keypair.
  const keyFile = signKeyFile;
  if (!existsSync(keyFile)) {
    throw new Error(
      `no signing key at ${keyFile} — ` +
        (ANCHOR_MODE
          ? `anchor mode needs the harness throwaway keypair`
          : `the build uses a committed anchor; the M9 check needs the build-time TEST keypair`),
    );
  }
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const file = join(feedDir, name);
    if (!name || !file.startsWith(feedDir) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(readFileSync(file));
  });
  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  const feed = {
    version: "m9-test-2",
    channel: "nightly",
    publishedAt: new Date().toISOString(),
    releaseNotes: "SevynOS M9 ESP-sync test.",
    artifacts: [
      {
        kind: "vmlinuz",
        url: `http://10.0.2.2:${port}/vmlinuz`,
        sha256: sha256File(join(feedDir, "vmlinuz")),
        sizeBytes: statSync(join(feedDir, "vmlinuz")).size,
      },
      {
        kind: "initramfs",
        url: `http://10.0.2.2:${port}/initramfs.cpio.gz`,
        sha256: sha256File(join(feedDir, "initramfs.cpio.gz")),
        sizeBytes: statSync(join(feedDir, "initramfs.cpio.gz")).size,
      },
    ],
  };
  writeFileSync(join(feedDir, "updates.json"), JSON.stringify(feed, null, 2) + "\n");
  await execAsync("node", [
    join(ROOT, "..", "tools", "update-signing", "sign-feed.mjs"),
    "--feed",
    join(feedDir, "updates.json"),
    "--key-file",
    keyFile,
  ]);
  return {
    dir: feedDir,
    port,
    server,
    url: `http://10.0.2.2:${port}/updates.json`,
    kernHash: feed.artifacts[0].sha256,
    initHash: feed.artifacts[1].sha256,
    origKernHash: sha256File(join(OUT, "vmlinuz")),
    origInitHash: sha256File(join(OUT, "initramfs.cpio.gz")),
  };
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
  const bundle = join(OUT, "m9-tokrah.bundle.js");
  console.log("m9 step 0: building the Tokrah bundle (Node harness gate)...");
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
  console.log("m9 step 0: running drive-live.js against the mock API...");
  await execAsync("node", [join(tokrahDir, "harness", "drive-live.js"), bundle], {
    env: { ...process.env, TOKRAH_SRC },
  });
}

async function main() {
  const t0 = Date.now();
  const timeout = setTimeout(() => {
    console.error(`M9 check timed out after ${TIMEOUT_S}s`);
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

  // Setup: data disk (slot A = the built image) + the GPT disk image.
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version", "sevynos.img"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m9-image.sh first`,
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
  check("m9: DHCP lease on eth0 with address 10.0.2.15", !!dhcp);
  const dataMount = await waitForLog(
    b.logPath,
    /M7 init: data disk mounted \(\/dev\/vda\)/,
    30000,
  );
  check("m9: data disk mounted (/dev/vda fallback path)", !!dataMount);
  const modulesLine = await waitForLog(b.logPath, /M7 init: loaded modules:/, 30000);
  const modulesOk =
    !!modulesLine &&
    / i915 /.test(modulesLine) &&
    / iwlwifi /.test(modulesLine) &&
    / nvme /.test(modulesLine);
  check(
    "m9: real-hardware modules loaded (i915, iwlwifi, nvme)",
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
    "m9: desktop is full screen at 1920x1080",
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
  check("m9: top bar spans the full 1920 width", fsEdge);

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
  check("m9: sevyn net status runs", !!netOk);

  // M9: wifi no-hardware state — QEMU has no wlan device, so scan
  // and status must fail CLEANLY (exit 1, "wifi: unavailable") rather
  // than crashing or hanging. The message text itself is not on the
  // serial log (it prints to the Terminal window); the exit code is
  // the harness-visible proof. Real association is Kevon's GF65
  // verification.
  const wifiStatus = await termCmdCode(b, "net wifi status", 1);
  check("m9: sevyn net wifi status exits 1 (no wireless interface)", !!wifiStatus);
  const wifiScan = await termCmdCode(b, "net wifi scan", 1);
  check("m9: sevyn net wifi scan exits 1 (no wireless interface)", !!wifiScan);

  // M9: app screens via `sevyn app run --headless` (the host logs
  // compact ops ONLY in headless mode — windowed apps cannot be
  // probed from the ops log, and a display digit cannot be proven
  // from pixels). Each run's ops land in the serial log; latestOps
  // reads the newest screen.
  const appRun = async (id, extra, seconds = 8, waitComplete = false) => {
    const before = logLines(b.logPath).length;
    const ok = await termCmd(
      b,
      `app run ${id} --seconds ${seconds} --width 800 --height 500 --out /tmp/m9-ops-${id}.json ${extra}`,
    );
    if (!ok) return null;
    if (waitComplete) {
      // The run's input taps land mid-run; the first ops line is
      // the pre-tap screen. Wait for the run to finish, then read
      // the latest (final) screen.
      await waitForLog(b.logPath, /HOST headless run complete/, 120000, before);
    } else {
      await waitForLog(b.logPath, /HOST headless ops /, 60000, before);
    }
    // The ops line is written in pieces; waitForLog matches its
    // prefix as soon as the first piece flushes, so the newest line
    // may be unparseable mid-flush. latestOps then falls back to the
    // last COMPLETE line — a stale screen from the previous app
    // (CI: the Store check read the Calendar's 44-text ops because
    // the Store line was mid-flush). Retry until a parseable ops
    // line from THIS run appears; never accept a stale line.
    const opsDeadline = Date.now() + 30000;
    let ops = null;
    while (Date.now() < opsDeadline) {
      ops = latestOps(b, before);
      if (ops) break;
      await sleep(1000);
    }
    return ops;
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
  const settingsOps = await appRun(
    "settings",
    "--name Settings --color #6b7280 --glyph S --permissions cli.exec",
  );
  const settingsTexts = opsTexts(settingsOps);
  check(
    "m9: Settings shows the Wi-Fi section",
    !!settingsOps &&
      settingsTexts.includes("Wi-Fi") &&
      settingsTexts.includes("Scan") &&
      // QEMU has no wlan device, so the status line reads "No Wi-Fi
      // hardware on this device." — on real hardware it reads
      // "Not connected" (or the SSID). Either status line proves
      // the section renders; real association is Kevon's GF65 check.
      settingsTexts.some(
        (t) => t.includes("Not connected") || t.includes("No Wi-Fi hardware"),
      ),
    settingsOps ? `${settingsTexts.length} texts` : "no ops",
  );
  check(
    "m9: Settings still shows the update channel below Wi-Fi",
    settingsTexts.some((t) => t.includes("Channel: nightly")),
  );
  check(
    "shutdown: Settings shows the Power section (Shut Down + Restart)",
    settingsTexts.includes("Power") &&
      settingsTexts.includes("Shut Down") &&
      settingsTexts.includes("Restart"),
    `${settingsTexts.length} texts`,
  );
  const calcProbe = await appRun(
    "calculator",
    "--name Calculator --color #8b5cf6 --glyph =",
  );
  const calcKeys = ["2", "+", "3", "="].map((k) => {
    const c = calcProbe ? textCenter(calcProbe, k) : null;
    return c ? pressableFor(calcProbe, c.x, c.y) : null;
  });
  check(
    "m9: Calculator keys found in ops",
    calcKeys.every(Boolean),
    calcKeys.map((k) => JSON.stringify(k)).join(" "),
  );
  if (calcKeys.every(Boolean)) {
    const inCalc = [
      `1000 tap ${Math.round(calcKeys[0].x)} ${Math.round(calcKeys[0].y)}`,
      `1500 tap ${Math.round(calcKeys[1].x)} ${Math.round(calcKeys[1].y)}`,
      `2000 tap ${Math.round(calcKeys[2].x)} ${Math.round(calcKeys[2].y)}`,
      `2500 tap ${Math.round(calcKeys[3].x)} ${Math.round(calcKeys[3].y)}`,
    ].join(";");
    // writeInputFile's read-back waits for the login email, which
    // this file does not contain. The write itself is proven by
    // termCmd (EXEC ... -> 0); the file's content is proven by the
    // display-5 check below — the second run reads this file and
    // taps 2 + 3 = 5 only if every line landed. (`files cat`
    // prints into the Terminal window, never to the serial log, so
    // a log read-back of the content can never match.)
    await termCmd(b, `files write /tmp/m9-in-calc.txt ${inCalc}`);
    const calcOps = await appRun(
      "calculator",
      "--name Calculator --color #8b5cf6 --glyph = --input /tmp/m9-in-calc.txt",
      10,
      true,
    );
    const displayFive = (calcOps?.texts || []).some((t) => t.t === "5" && t.y < 144);
    check(
      "m9: Calculator 2 + 3 = 5 (display reads 5)",
      displayFive,
      calcOps ? `${calcOps.texts.length} texts` : "no ops",
    );
  } else {
    check("m9: Calculator 2 + 3 = 5 (display reads 5)", false, "keys not found");
  }
  const monthName = new Date().toLocaleString("en-US", { month: "long" });
  const calOps = await appRun("calendar", "--name Calendar --color #ef4444 --glyph C");
  const calTexts = opsTexts(calOps);
  check(
    "m9: Calendar shows the current month",
    !!calOps &&
      calTexts.some(
        (t) => t.includes(monthName) && t.includes(String(new Date().getFullYear())),
      ),
    calOps ? calTexts.filter((t) => t.includes(monthName)).join(",") : "no ops",
  );
  const storeOps = await appRun("store", "--name Store --color #f97316 --glyph S");
  const storeTexts = opsTexts(storeOps);
  check(
    "m9: Store lists installed apps",
    !!storeOps &&
      storeTexts.includes("Installed apps") &&
      storeTexts.includes("Settings") &&
      storeTexts.includes("Terminal"),
    storeOps ? `${storeTexts.length} texts` : "no ops",
  );
  // Notes: seed one real note, then the headless run must list it.
  await termCmd(b, "files mkdir /data/notes");
  await termCmd(b, "files write /data/notes/hello.txt Hello M9");
  const notesOps = await appRun(
    "notes",
    "--name Notes --color #eab308 --glyph N --permissions cli.exec",
  );
  const notesTexts = opsTexts(notesOps);
  check(
    "m9: Notes lists a real note from /data/notes",
    !!notesOps && notesTexts.some((t) => t.includes("hello")),
    notesOps ? `${notesTexts.length} texts` : "no ops",
  );

  // M9: move + resize, windowed, via QMP drags. The calculator
  // window's header is #8b5cf6; its box is found from the pixels,
  // dragged, and found again. (The headless probes above prove the
  // content; these drags prove the windowing.)
  const calcLaunch = await appdCmd(b, "LAUNCH calculator", /APPD LAUNCH OK calculator/);
  check("m9: calculator launches windowed", !!calcLaunch);
  await waitForLog(b.logPath, /HOST app running .* calculator/, 60000);
  await sleep(3000);
  const calcShot0 = await shot(b.qmp, join(OUT, "m9-shot-calc0.ppm"));
  const header0 = colorBox(calcShot0, 139, 92, 246, 12, {
    x0: 0,
    y0: 48,
    x1: calcShot0.width,
    y1: calcShot0.height - 96, // above the dock (its icon is #8b5cf6 too)
  });
  check("m9: calculator window header found", !!header0, JSON.stringify(header0));
  if (header0) {
    const fromX = header0.x + Math.round(header0.w / 2);
    const fromY = header0.y + 22;
    const toX = fromX + 200;
    const toY = fromY + 100;
    await pointerDrag(b.qmp, calcShot0.width, calcShot0.height, fromX, fromY, toX, toY);
    await sleep(2000);
    const calcShot1 = await shot(b.qmp, join(OUT, "m9-shot-calc1.ppm"));
    const header1 = colorBox(calcShot1, 139, 92, 246, 12, {
      x0: 0,
      y0: 48,
      x1: calcShot1.width,
      y1: calcShot1.height - 96, // above the dock (its icon is #8b5cf6 too)
    });
    const moved =
      !!header1 &&
      Math.abs(header1.x - header0.x - 200) < 40 &&
      Math.abs(header1.y - header0.y - 100) < 40;
    check(
      "m9: window drags to move (title bar, +200/+100)",
      moved,
      `before=${JSON.stringify(header0)} after=${JSON.stringify(header1)}`,
    );
    if (header1) {
      // Resize: drag the bottom-right corner outward; the header
      // (which spans the window width) must get wider. The corner
      // is measured from the shot (bottom edge via the body-colour
      // column scan), not guessed — the window's height is whatever
      // the host opened it at.
      const bottom1 = windowBottom(calcShot1, header1.x + 8, header1.y + 44);
      const cornerX = header1.x + header1.w - 4;
      const cornerY = bottom1 - 4;
      await pointerDrag(
        b.qmp,
        calcShot1.width,
        calcShot1.height,
        cornerX,
        cornerY,
        cornerX + 150,
        cornerY + 100,
      );
      await sleep(2000);
      const calcShot2 = await shot(b.qmp, join(OUT, "m9-shot-calc2.ppm"));
      const header2 = colorBox(calcShot2, 139, 92, 246, 12, {
        x0: 0,
        y0: 48,
        x1: calcShot2.width,
        y1: calcShot2.height - 96, // above the dock (its icon is #8b5cf6 too)
      });
      const grew = !!header2 && header2.w > header1.w + 100 && header2.h === 44;
      check(
        "m9: window drags to resize (corner, header wider by ~150)",
        grew,
        `before w=${header1.w} after w=${header2 ? header2.w : "none"}`,
      );
      if (header2) {
        // Minimum clamp: drag the corner far inward; the window
        // must stay >= 480 wide (the host clamps at 480x320).
        const bottom2 = windowBottom(calcShot2, header2.x + 8, header2.y + 44);
        const c2x = header2.x + header2.w - 4;
        const c2y = bottom2 - 4;
        await pointerDrag(
          b.qmp,
          calcShot2.width,
          calcShot2.height,
          c2x,
          c2y,
          c2x - 1000,
          c2y - 1000,
        );
        await sleep(2000);
        const calcShot3 = await shot(b.qmp, join(OUT, "m9-shot-calc3.ppm"));
        const header3 = colorBox(calcShot3, 139, 92, 246, 12, {
          x0: 0,
          y0: 48,
          x1: calcShot3.width,
          y1: calcShot3.height - 96, // above the dock (its icon is #8b5cf6 too)
        });
        check(
          "m9: resize clamps at the 480px minimum width",
          !!header3 && header3.w >= 470,
          `w=${header3 ? header3.w : "none"}`,
        );
      } else {
        check(
          "m9: resize clamps at the 480px minimum width",
          false,
          "no header after grow",
        );
      }
    } else {
      check(
        "m9: window drags to resize (corner, header wider by ~150)",
        false,
        "window did not move",
      );
      check("m9: resize clamps at the 480px minimum width", false, "window did not move");
    }
  } else {
    check("m9: window drags to move (title bar, +200/+100)", false, "no header");
    check(
      "m9: window drags to resize (corner, header wider by ~150)",
      false,
      "no header",
    );
    check("m9: resize clamps at the 480px minimum width", false, "no header");
  }
  const calcClose = await appdCmd(b, "CLOSE calculator", /APPD CLOSE OK calculator/);
  check("m9: calculator closes", !!calcClose);

  // Window fix: focus restore + minimize/maximize + multi-window.
  // The calculator is closed above, so launch it fresh for these
  // checks (a clean window at Weston's default position).
  const win = {};
  // Find a window's header box by its title-bar colour, searching
  // only above the dock (the dock tile shares the colour). A real
  // header is an 800x44 solid strip (~34000 pixels); a covered
  // window shows only a few stray pixels, which is not "found".
  const findHeader = async (tag, r, g, bl, tol = 12, y0 = 48) => {
    const img = await shot(b.qmp, join(OUT, `m9-shot-win-${tag}.ppm`));
    const box = colorBox(img, r, g, bl, tol, {
      x0: 0,
      y0,
      x1: img.width,
      y1: img.height - 96,
    });
    return {
      img,
      box: box && box.n >= 1000 ? box : null,
    };
  };
  // Poll for a window header matching `pred`, screenshotting until
  // it appears (up to timeoutMs). The compositor repositions a
  // maximized window on the first commit at the new size; under TCG
  // the configure round-trip + present + reposition takes seconds,
  // so a fixed 2s wait is not enough — polling the end state is
  // robust to that timing. (The stuck-at-cascade-position failure
  // was NOT timing: an old-size commit after set_maximized poisoned
  // the reposition. Fixed in the host by deferring presents while a
  // maximize/unmaximize is in flight — see sizeChangePending_ in
  // v2/rn/host/wayland.h.) A maximized window's header sits at
  // y=0..44, above findHeader's y0=48 band, so the maximize poll
  // searches from y0=0.
  const waitHeader = async (tag, r, g, bl, pred, timeoutMs = 15000, y0 = 48) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      last = await findHeader(tag, r, g, bl, 12, y0);
      if (last.box && pred(last.box)) return last;
      await sleep(500);
    } while (Date.now() < deadline);
    return last;
  };
  // Centre of a dock tile by its colour (the dock band only). The
  // tile is an 80px-wide solid block, but stray pixels of the same
  // colour elsewhere in the dock band stretch a plain bounding box
  // and skew its centre onto the wrong tile (in CI the store tile
  // caught both the settings and the terminal clicks). Find the tile
  // by column density instead: the longest run of columns each
  // holding >= 30 matching pixels.
  const dockTile = (img, r, g, bl, tol = 12) => {
    const { width: W, height: H, pixels } = img;
    const y0 = H - 96;
    const colCount = new Array(W).fill(0);
    for (let y = y0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        if (
          Math.abs(pixels[i] - r) <= tol &&
          Math.abs(pixels[i + 1] - g) <= tol &&
          Math.abs(pixels[i + 2] - bl) <= tol
        ) {
          colCount[x]++;
        }
      }
    }
    let best = null;
    let runStart = -1;
    for (let x = 0; x <= W; x++) {
      const dense = x < W && colCount[x] >= 30;
      if (dense && runStart < 0) runStart = x;
      if (!dense && runStart >= 0) {
        const run = { x0: runStart, x1: x - 1 };
        if (!best || run.x1 - run.x0 > best.x1 - best.x0) best = run;
        runStart = -1;
      }
    }
    if (!best || best.x1 - best.x0 < 40) return null;
    return { x: Math.round((best.x0 + best.x1) / 2), y: H - 48 };
  };
  // Click a point on the shell desktop (not covered by any window in
  // `covered`, a list of {x, y, w, h} rects). Tries candidates until
  // one is free; returns the point used, or null.
  const clickDesktop = async (covered) => {
    const W = 1920;
    const H = 1080;
    const candidates = [
      [100, 100],
      [1820, 100],
      [100, 900],
      [1820, 900],
      [960, 60],
    ];
    for (const [x, y] of candidates) {
      const hit = (covered || []).some(
        (r) =>
          x >= r.x - 10 && x <= r.x + r.w + 10 && y >= r.y - 10 && y <= r.y + r.h + 10,
      );
      if (hit) continue;
      await pointerClick(b.qmp, W, H, x, y);
      return { x, y };
    }
    return null;
  };
  const countLog = (substr) =>
    logLines(b.logPath).filter((l) => l.includes(substr)).length;
  // Distinct pids for "APPD launched <id> (pid N)" lines: the serial
  // log duplicates APPD lines, so a raw line count is 2x the real
  // launch count.
  const countLaunches = (id) => {
    const pids = new Set();
    const re = new RegExp(`APPD launched ${id} \\(pid (\\d+)\\)`);
    for (const l of logLines(b.logPath)) {
      const m = l.match(re);
      if (m) pids.add(m[1]);
    }
    return pids.size;
  };

  const calcLaunch2 = await appdCmd(b, "LAUNCH calculator", /APPD LAUNCH OK calculator/);
  check("window: calculator launches (focus checks)", !!calcLaunch2);
  await waitForLog(b.logPath, /HOST app running .* calculator/, 60000);
  await sleep(3000);
  let calcH = await findHeader("calc-a", 139, 92, 246);
  check("window: calculator header found", !!calcH.box, JSON.stringify(calcH.box));
  if (calcH.box) {
    // Focus restore: click the desktop so the fullscreen shell
    // covers the window, then click the dock tile to bring it back.
    const winRect = {
      x: calcH.box.x,
      y: calcH.box.y,
      w: calcH.box.w,
      h: 500,
    };
    const deskPt = await clickDesktop([winRect]);
    check("window: a free desktop point exists", !!deskPt, JSON.stringify(deskPt));
    await sleep(2000);
    const covered = await findHeader("calc-covered", 139, 92, 246);
    check(
      "window: desktop click covers the window (header hidden)",
      !covered.box,
      covered.box ? JSON.stringify(covered.box) : "hidden",
    );
    // Dock tile: the calculator tile is #8b5cf6 in the dock band.
    const tile = dockTile(covered.img, 139, 92, 246);
    check("window: calculator dock tile found", !!tile, JSON.stringify(tile));
    if (tile) {
      await pointerClick(b.qmp, covered.img.width, covered.img.height, tile.x, tile.y);
      const remap = await waitForLog(b.logPath, /HOST FOCUS remap calculator/, 30000);
      check("window: FOCUS remap logged by the app host", !!remap);
      await sleep(2000);
      const restored = await findHeader("calc-restored", 139, 92, 246);
      check(
        "window: dock click restores the covered window",
        !!restored.box,
        JSON.stringify(restored.box),
      );
      win.calc = restored.box;
    } else {
      check("window: FOCUS remap logged by the app host", false, "no dock tile");
      check("window: dock click restores the covered window", false, "no dock tile");
    }
  } else {
    check("window: a free desktop point exists", false, "no header");
    check("window: desktop click covers the window (header hidden)", false, "no header");
    check("window: calculator dock tile found", false, "no header");
    check("window: FOCUS remap logged by the app host", false, "no header");
    check("window: dock click restores the covered window", false, "no header");
  }
  if (win.calc) {
    // Minimize: the — button is the leftmost of the three title-bar
    // buttons (— ▢ ✕, each 28px, 12px right padding).
    const minX = win.calc.x + win.calc.w - 82;
    const minY = win.calc.y + 22;
    const stoppedBefore = countLog("APP STOPPED calculator");
    await pointerClick(b.qmp, 1920, 1080, minX, minY);
    await sleep(2000);
    const minimized = await findHeader("calc-min", 139, 92, 246);
    check(
      "window: minimize hides the window",
      !minimized.box,
      minimized.box ? JSON.stringify(minimized.box) : "hidden",
    );
    check(
      "window: minimize does not stop the app",
      countLog("APP STOPPED calculator") === stoppedBefore,
      `stopped=${countLog("APP STOPPED calculator")} before=${stoppedBefore}`,
    );
    // Restore from minimized: dock click → focus remap.
    const tileMin = dockTile(minimized.img, 139, 92, 246);
    if (tileMin) {
      await pointerClick(
        b.qmp,
        minimized.img.width,
        minimized.img.height,
        tileMin.x,
        tileMin.y,
      );
      await sleep(2000);
      const unmin = await findHeader("calc-unmin", 139, 92, 246);
      check(
        "window: dock click restores a minimized window",
        !!unmin.box,
        JSON.stringify(unmin.box),
      );
      win.calc = unmin.box;
    } else {
      check("window: dock click restores a minimized window", false, "no dock tile");
    }
  } else {
    check("window: minimize hides the window", false, "no restored window");
    check("window: minimize does not stop the app", false, "no restored window");
    check("window: dock click restores a minimized window", false, "no restored window");
  }
  if (win.calc) {
    // Maximize: the ▢ button is the middle of the three (✕ is the
    // rightmost 28px + 12px padding). Restore is the same spot.
    const maxX = win.calc.x + win.calc.w - 54;
    const maxY = win.calc.y + 22;
    await pointerClick(b.qmp, 1920, 1080, maxX, maxY);
    const maxed = await waitHeader(
      "calc-max",
      139,
      92,
      246,
      (box) => box.w >= 1800 && box.h === 44 && box.y <= 44,
      15000,
      0,
    );
    check(
      "window: maximize fills the screen",
      !!maxed.box && maxed.box.w >= 1800 && maxed.box.h === 44,
      JSON.stringify(maxed.box),
    );
    if (maxed.box) {
      const resX = maxed.box.x + maxed.box.w - 54;
      const resY = maxed.box.y + 22;
      await pointerClick(b.qmp, 1920, 1080, resX, resY);
      const restored2 = await waitHeader(
        "calc-restored2",
        139,
        92,
        246,
        (box) => box.w < 1000 && box.w > 400,
      );
      check(
        "window: restore returns to a windowed size",
        !!restored2.box && restored2.box.w < 1000 && restored2.box.w > 400,
        JSON.stringify(restored2.box),
      );
      win.calc = restored2.box;
    } else {
      check("window: restore returns to a windowed size", false, "not maximized");
    }
  } else {
    check("window: maximize fills the screen", false, "no restored window");
    check("window: restore returns to a windowed size", false, "no restored window");
  }
  // Multi-window: Files (multi-instance) + Calculator side by side,
  // then the single-instance rule (Settings) and the multi-instance
  // dock rule (Files opens a second window).
  const filesLaunch = await appdCmd(b, "LAUNCH files", /APPD LAUNCH OK files/);
  check("window: files launches", !!filesLaunch);
  await waitForLog(b.logPath, /HOST app running .* files/, 60000);
  await sleep(3000);
  let filesH = await findHeader("files-a", 59, 130, 246);
  check("window: files header found", !!filesH.box, JSON.stringify(filesH.box));
  if (filesH.box && win.calc) {
    // Drag Files by its title bar so its header no longer overlaps
    // the calculator's; then each dock click must bring its own
    // window to the front.
    const fromX = filesH.box.x + Math.round(filesH.box.w / 2);
    const fromY = filesH.box.y + 22;
    await pointerDrag(
      b.qmp,
      filesH.img.width,
      filesH.img.height,
      fromX,
      fromY,
      fromX + 200,
      fromY + 100,
    );
    await sleep(2000);
    const filesMoved = await findHeader("files-moved", 59, 130, 246);
    check(
      "window: files window drags to a new position (+200/+100)",
      !!filesMoved.box &&
        Math.abs(filesMoved.box.x - filesH.box.x - 200) < 40 &&
        Math.abs(filesMoved.box.y - filesH.box.y - 100) < 40,
      `before=${JSON.stringify(filesH.box)} after=${JSON.stringify(filesMoved.box)}`,
    );
    const calcTile = dockTile(filesMoved.img, 139, 92, 246);
    if (calcTile) {
      await pointerClick(
        b.qmp,
        filesMoved.img.width,
        filesMoved.img.height,
        calcTile.x,
        calcTile.y,
      );
      await sleep(2000);
    }
    const calcFront = await findHeader("calc-front", 139, 92, 246);
    const filesTile = dockTile(calcFront.img, 59, 130, 246);
    if (filesTile) {
      await pointerClick(
        b.qmp,
        calcFront.img.width,
        calcFront.img.height,
        filesTile.x,
        filesTile.y,
      );
      await sleep(2000);
    }
    const filesFront = await findHeader("files-front", 59, 130, 246);
    check(
      "window: two different apps coexist (dock switches between them)",
      !!calcFront.box && !!filesFront.box,
      `calc=${JSON.stringify(calcFront.box)} files=${JSON.stringify(filesFront.box)}`,
    );
    win.files = filesFront.box;
  } else {
    check(
      "window: two different apps coexist (dock switches between them)",
      false,
      "no files/calc header",
    );
  }
  // Single-instance: Settings focuses on dock click, never relaunches.
  const settingsLaunch = await appdCmd(b, "LAUNCH settings", /APPD LAUNCH OK settings/);
  check("window: settings launches", !!settingsLaunch);
  await waitForLog(b.logPath, /HOST app running .* settings/, 60000);
  await sleep(3000);
  const settingsH = await findHeader("settings-a", 107, 114, 128);
  check("window: settings header found", !!settingsH.box, JSON.stringify(settingsH.box));
  if (settingsH.box) {
    const before = countLaunches("settings");
    const settingsTile = dockTile(settingsH.img, 107, 114, 128);
    check(
      "window: settings dock tile found",
      !!settingsTile,
      JSON.stringify(settingsTile),
    );
    if (settingsTile) {
      await pointerClick(
        b.qmp,
        settingsH.img.width,
        settingsH.img.height,
        settingsTile.x,
        settingsTile.y,
      );
      await sleep(2000);
      const settingsFront = await findHeader("settings-front", 107, 114, 128);
      check(
        "window: dock click on a running single-instance app focuses it",
        !!settingsFront.box && countLaunches("settings") === before,
        `header=${JSON.stringify(settingsFront.box)} launches=${countLaunches("settings")} before=${before}`,
      );
    } else {
      check(
        "window: dock click on a running single-instance app focuses it",
        false,
        "no dock tile",
      );
    }
  } else {
    check("window: settings dock tile found", false, "no header");
    check(
      "window: dock click on a running single-instance app focuses it",
      false,
      "no header",
    );
  }
  // Multi-instance dock rule: a dock click on running Files opens a
  // NEW window (a second "APPD launched files" line).
  const filesLaunchesBefore = countLaunches("files");
  const filesShot = await shot(b.qmp, join(OUT, "m9-shot-win-files-tile.ppm"));
  const filesTile2 = dockTile(filesShot, 59, 130, 246);
  if (filesTile2) {
    const filesLinesBefore = logLines(b.logPath).length;
    await pointerClick(
      b.qmp,
      filesShot.width,
      filesShot.height,
      filesTile2.x,
      filesTile2.y,
    );
    const second = await waitForLog(
      b.logPath,
      /APPD launched files/,
      30000,
      filesLinesBefore,
    );
    check(
      "window: dock click on a running multi-instance app opens a new window",
      !!second && countLaunches("files") === filesLaunchesBefore + 1,
      `launches=${countLaunches("files")} before=${filesLaunchesBefore}`,
    );
  } else {
    check(
      "window: dock click on a running multi-instance app opens a new window",
      false,
      "no files tile",
    );
  }
  // Close the extra windows; the calculator close below settles
  // focus back onto the Terminal.
  await appdCmd(b, "CLOSE files", /APPD CLOSE OK files/);
  await appdCmd(b, "CLOSE settings", /APPD CLOSE OK settings/);
  await sleep(2000);
  // Focus settles back onto the Terminal a beat after the close —
  // typing at once lost the first keys ("tokrah" arrived as "krah").
  // Wait for the refocus, and retry the Phase A command once if the
  // first attempt still mistypes (the bad command already submitted,
  // so the line is clear for a fresh type).
  await sleep(3000);

  // Keyboard focus: the Terminal is multi-instance, so a dock click
  // opens a NEW window — it never focuses the covered one (that is
  // the single-instance restore path, already proven with the
  // calculator above). Prove the new window takes keyboard focus.
  // Close the calculator first (still open from the focus checks),
  // and the old terminal too: CLOSE ends every instance of the id,
  // so the dock click below opens the ONLY terminal — the typed
  // command can only run there, which is what proves focus. (The
  // dock lists all installed apps, so the terminal tile stays.)
  await appdCmd(b, "CLOSE calculator", /APPD CLOSE OK calculator/);
  await appdCmd(b, "CLOSE terminal", /APPD CLOSE OK terminal/);
  await sleep(2000);
  const termLaunchesBefore = countLaunches("terminal");
  const termShot0 = await shot(b.qmp, join(OUT, "m9-shot-win-term-tile0.ppm"));
  const termTile0 = dockTile(termShot0, 17, 24, 39, 8);
  check("window: terminal dock tile found", !!termTile0, JSON.stringify(termTile0));
  if (termTile0) {
    const termLinesBefore = logLines(b.logPath).length;
    await pointerClick(
      b.qmp,
      termShot0.width,
      termShot0.height,
      termTile0.x,
      termTile0.y,
    );
    const termLaunch = await waitForLog(
      b.logPath,
      /APPD launched terminal/,
      30000,
      termLinesBefore,
    );
    check(
      "window: dock click on the running terminal opens a new window",
      !!termLaunch && countLaunches("terminal") === termLaunchesBefore + 1,
      `launches=${countLaunches("terminal")} before=${termLaunchesBefore}`,
    );
    await sleep(2000);
    const termH = await findHeader("term-a", 17, 24, 39, 8);
    check("window: terminal window found", !!termH.box, JSON.stringify(termH.box));
    if (termH.box) {
      // `sevyn echo` is not a subcommand (exit 1) — the old check
      // failed even though typing reached a terminal. Use a real
      // command; the old terminal is closed above, so only the new
      // window can produce this EXEC line.
      const focusOk = await termCmd(b, "update status", 60000);
      check(
        "window: new terminal window takes keyboard focus (typed command runs)",
        !!focusOk,
      );
    } else {
      check(
        "window: new terminal window takes keyboard focus (typed command runs)",
        false,
        "no terminal window",
      );
    }
  } else {
    check(
      "window: dock click on the running terminal opens a new window",
      false,
      "no dock tile",
    );
    check("window: terminal window found", false, "no dock tile");
    check(
      "window: new terminal window takes keyboard focus (typed command runs)",
      false,
      "no dock tile",
    );
  }

  // --- Phase A: headless mount, no input — the login screen. ---
  // Scope both waits to lines after this run started: the log
  // already holds "first present" / "ops" lines from the Settings,
  // Calculator, Calendar, Store and Notes probes, and an unscoped
  // wait matches the first of those instantly — the check then reads
  // the Notes screen's stale 4-text ops, fails, and kills the guest
  // before the Tokrah run can beat or log its own ops (the M9
  // "headless hang": the loop never stalled, the harness never
  // waited). appRun scopes the same way; Phase B/C already do.
  const beforeA = logLines(b.logPath).length;
  let runA = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 8 --out /tmp/m9-ops-a.json",
  );
  if (!runA) {
    await sleep(2000);
    runA = await termCmd(
      b,
      "tokrah run --width 800 --height 1200 --seconds 8 --out /tmp/m9-ops-a.json",
    );
  }
  check("headless A: sevyn tokrah run completes (8s, no input)", !!runA);
  const presentA = await waitForLog(
    b.logPath,
    /HOST headless first present/,
    30000,
    beforeA,
  );
  check("headless A: bundle presents (mount + first present)", !!presentA);
  // The run is detached (the CLI returns at once), so the ops line
  // lands after the first present — wait for it before reading.
  // (Guest time runs ~0.5x wall under TCG, so waits are generous.)
  await waitForLog(b.logPath, /HOST headless ops/, 60000, beforeA);
  const opsA = latestOps(b, beforeA);
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
    `8500 type m7@sevynos.test`,
    `10000 tap ${Math.round(pBtn.x)} ${Math.round(pBtn.y)}`,
    `10500 type M7pass123!`,
    `12000 tap ${Math.round(sBtn.x)} ${Math.round(sBtn.y)}`,
    // The (tabs) pager sometimes lands on the live tab after login
    // (check 46: live tab active, home feed stuck on "Loading").
    // Tap the Feed tab (first tab-bar button, y=1154 h=46) to force
    // the home feed active; harmless if already there.
    `20000 tap 80 1177`,
  ].join(";");
  const beforeB = logLines(b.logPath).length;
  const wroteB = await writeInputFile(b, "/tmp/m9-in-b.txt", inB);
  note("headless B: input file written", !!wroteB);
  const runB = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 30 --input /tmp/m9-in-b.txt --out /tmp/m9-ops-b.json",
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
    `8500 type m7@sevynos.test`,
    `10000 tap ${Math.round(pBtn.x)} ${Math.round(pBtn.y)}`,
    `10500 type M7pass123!`,
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
  const wroteC1 = await writeInputFile(b, "/tmp/m9-in-c1.txt", inC1);
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
      await writeInputFile(b, "/tmp/m9-in-c1-retry.txt", inC1);
    }
    const beforeC1 = logLines(b.logPath).length;
    const runC1 = await termCmd(
      b,
      attempt === 0
        ? "tokrah run --width 800 --height 1200 --seconds 60 --input /tmp/m9-in-c1.txt --out /tmp/m9-ops-c1.json"
        : "tokrah run --width 800 --height 1200 --seconds 60 --input /tmp/m9-in-c1-retry.txt --out /tmp/m9-ops-c1-retry.json",
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
    `34500 type M7 test live`,
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
  const wroteC = await writeInputFile(b, "/tmp/m9-in-c.txt", inC);
  note("headless C: start-live input written", !!wroteC);
  const beforeC = logLines(b.logPath).length;
  const runC = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 50 --input /tmp/m9-in-c.txt --out /tmp/m9-ops-c.json",
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
  const wroteD = await writeInputFile(b, "/tmp/m9-in-d.txt", inD);
  note("headless D: end-live input written", !!wroteD);
  const runD = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 65 --input /tmp/m9-in-d.txt --out /tmp/m9-ops-d.json",
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
      await writeInputFile(b, "/tmp/m9-in-d-retry.txt", inD);
      const runD2try = await termCmd(
        b,
        "tokrah run --width 800 --height 1200 --seconds 65 --input /tmp/m9-in-d-retry.txt --out /tmp/m9-ops-d-retry.json",
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
  const wroteD2 = await writeInputFile(b, "/tmp/m9-in-d2.txt", inD2);
  note("headless D: confirm input written", !!wroteD2);
  const beforeD2 = logLines(b.logPath).length;
  const runD2 = await termCmd(
    b,
    "tokrah run --width 800 --height 1200 --seconds 70 --input /tmp/m9-in-d2.txt --out /tmp/m9-ops-d2.json",
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

  // --- Headless S: stock-app ScrollViews scroll (GF65 fix). ---
  // The Store list (12+ apps) is taller than its 800x500 window, so
  // it only reaches its tail after a scroll — this proves the
  // App.tsx ScrollView wrap end-to-end in-guest. The scroll input
  // line drives the synthetic headless path (dispatchScroll ->
  // scrollAt); a real Wayland axis event cannot be injected through
  // QEMU 8.2's QMP input-send-event (pointer moves only, no wheel
  // event exists), so the axis -> dispatchScroll hop is proven by
  // inspection + the renderer unit test, and the GF65 is the final
  // gate for real wheel/trackpad scrolling.
  await termCmd(b, `files write /tmp/m9-in-scroll.txt 5000 scroll 400 250 0 200`);
  const beforeS = logLines(b.logPath).length;
  const runS = await termCmd(
    b,
    "app run store --name Store --color #f97316 --glyph S --seconds 15 --input /tmp/m9-in-scroll.txt --out /tmp/m9-ops-scroll.json",
    240000,
  );
  check("headless S: sevyn app run store completes (scroll input)", !!runS);
  const scrollLine = await waitForLog(
    b.logPath,
    /SCROLL \(400,250\) by \(0,200\) -> scrollY 0 -> 200/,
    60000,
    beforeS,
  );
  check(
    "headless S: Store scrolls to scrollY 200 (ScrollView under the point)",
    !!scrollLine,
    scrollLine || "no SCROLL line — without the App.tsx wrap scrollAt finds no scroller",
  );

  // --- Headless T: Terminal scrollback scrolls (GF65 fix). ---
  // Two `sevyn help` runs overflow the ~420px scrollback viewport;
  // the app autoscrolls to the bottom after each command, so a
  // wheel-UP input must move scrollY back down. This proves the
  // Terminal's ScrollView wrap (full scrollback, not the old
  // last-21 slice) and the autoscroll in one run. Terminal needs
  // cli.exec to run commands. (No --glyph: `>` is not typeable
  // through QMP; the header shows the app name, not the glyph.)
  const inTerm = [
    "1000 type sevyn help",
    "2000 key 28 down 0",
    "2100 key 28 up 0",
    "5000 type sevyn help",
    "6000 key 28 down 0",
    "6100 key 28 up 0",
    "10000 scroll 400 250 0 -200",
  ].join(";");
  await termCmd(b, `files write /tmp/m9-in-term.txt ${inTerm}`);
  const beforeT = logLines(b.logPath).length;
  const runT = await termCmd(
    b,
    "app run terminal --name Terminal --color #111827 --permissions cli.exec --seconds 15 --input /tmp/m9-in-term.txt --out /tmp/m9-ops-term.json",
    240000,
  );
  check("headless T: sevyn app run terminal completes (scroll input)", !!runT);
  const termScroll = await waitForLog(
    b.logPath,
    /SCROLL \(400,250\) by \(0,-200\) -> scrollY [0-9]+ -> [0-9]+/,
    60000,
    beforeT,
  );
  let termScrolled = false;
  if (termScroll) {
    const m = termScroll.match(/scrollY ([0-9]+) -> ([0-9]+)/);
    termScrolled = !!m && Number(m[1]) > Number(m[2]) && Number(m[1]) > 0;
  }
  check(
    "headless T: Terminal scrolls up from the autoscrolled bottom (scrollY drops)",
    termScrolled,
    termScroll || "no SCROLL line — without the Terminal wrap scrollAt finds no scroller",
  );

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
      const winImg = await shot(b.qmp, join(OUT, "m9-shot-tokrah.ppm"));
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

  // --- Shutdown/restart: the power verbs + clean teardown. ---
  // The Terminal lost focus to the Tokrah window above, and a
  // re-LAUNCH of a running app is a no-op (no focus restore yet —
  // the window fix), so close it and launch it fresh: a fresh
  // launch is focused, and the typed commands land in it.
  const termClose = await appdCmd(b, "CLOSE terminal", /APPD CLOSE OK terminal/);
  check("shutdown: terminal closes before the reboot probe", !!termClose);
  const termReopen = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("shutdown: terminal relaunches (focused) for the reboot probe", !!termReopen);
  await sleep(5000);
  // Search the whole log, not just lines after `before`: the `before`
  // count overcounts by one when the file ends with "\n" (split yields
  // a trailing ""), so the first line written after capture is skipped
  // — the request line was in the log yet the scoped wait timed out
  // (the same race termCmd already works around). The patterns are
  // unique per boot log, so a stale match is impossible.
  await typeText(b.qmp, "reboot");
  await keyTap(b.qmp, "ret");
  const rebootReq = await waitForLog(b.logPath, /STATUSD power reboot requested/, 60000);
  check("shutdown: sevyn reboot reaches statusd", !!rebootReq);
  const rebootTeardown = await waitForLog(
    b.logPath,
    /SEVYNOS power: clean teardown done/,
    60000,
  );
  check(
    "shutdown: reboot teardown runs (daemons stopped, /data unmounted)",
    !!rebootTeardown,
  );
  const rebooted = await waitExit(b, 60000);
  check("shutdown: guest reboots on sevyn reboot (QEMU exits, -no-reboot)", rebooted);
  closeBoot(b);

  // The guest rebooted cleanly: boot it again and prove `sevyn
  // poweroff` from the Terminal ends it the same way.
  const b2 = await boot("power-off");
  await connectSockets(b2);
  const ready2 = await waitForLog(b2.logPath, /SEVYNOS_M5_READY/, 300000);
  check("shutdown: guest boots again after reboot", !!ready2);
  const settled2 = await screenSettled(b2, 60000);
  check("shutdown: shell settles after reboot", !!settled2);
  const term2 = await appdCmd(b2, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("shutdown: terminal launches after reboot", !!term2);
  await sleep(5000);
  await typeText(b2.qmp, "poweroff");
  await keyTap(b2.qmp, "ret");
  const offReq = await waitForLog(b2.logPath, /STATUSD power poweroff requested/, 60000);
  check("shutdown: sevyn poweroff reaches statusd", !!offReq);
  const offUnmount = await waitForLog(
    b2.logPath,
    /SEVYNOS power: \/data unmounted/,
    60000,
  );
  check("shutdown: poweroff teardown unmounts /data", !!offUnmount);
  const offDone = await waitForLog(
    b2.logPath,
    /SEVYNOS power: clean teardown done/,
    60000,
  );
  check("shutdown: poweroff teardown completes", !!offDone);
  const offExited = await waitExit(b2, 60000);
  check("shutdown: guest powers off on sevyn poweroff", offExited);
  closeBoot(b2);

  // Tray power menu: boot a third time, tap the Power button in the
  // top bar (fixed 64px wide, right edge at 1920-16 — centre
  // 1872,24), prove the menu paints, then tap Shut Down and prove
  // the guest powers off through the tray path.
  const b3 = await boot("power-tray");
  await connectSockets(b3);
  const ready3 = await waitForLog(b3.logPath, /SEVYNOS_M5_READY/, 300000);
  check("shutdown: guest boots for the tray probe", !!ready3);
  const settled3 = await screenSettled(b3, 60000);
  check("shutdown: shell settles for the tray probe", !!settled3);
  let powerBtn = 0;
  if (settled3) {
    powerBtn = countColor(settled3, 38, 38, 46, 10, {
      x0: 1840,
      y0: 6,
      x1: 1904,
      y1: 42,
    });
  }
  check(
    "shutdown: tray Power button paints (#26262e)",
    powerBtn > 500,
    `btn=${powerBtn}`,
  );
  await pointerDrag(b3.qmp, 1920, 1080, 1872, 24, 1872, 24);
  const powerTap = await waitForLog(
    b3.logPath,
    /POINTER nodeId \d+ inst Pressable onPress true testID tray-power/,
    30000,
  );
  check("shutdown: tapping Power opens the menu (onPress tray-power)", !!powerTap);
  await sleep(1000);
  let menuPx = 0;
  try {
    const menuShot = await shot(b3.qmp, join(OUT, "m9-shot-power-menu.ppm"));
    menuPx = countColor(menuShot, 31, 41, 55, 10, {
      x0: 1704,
      y0: 48,
      x1: 1904,
      y1: 136,
    });
  } catch {}
  check("shutdown: power menu paints (#1f2937)", menuPx > 10000, `menu=${menuPx}`);
  // The tap powers the guest off, so QEMU can die mid-drag and the
  // QMP socket closes under the last steps — a rejected drag is the
  // expected outcome here, not a failure. The tap itself is proven
  // by the log + exit checks below, which still gate the probe.
  try {
    await pointerDrag(b3.qmp, 1920, 1080, 1804, 70, 1804, 70);
  } catch (e) {
    console.log(`note: tray shutdown drag ended with the guest: ${e.message}`);
  }
  const shutTap = await waitForLog(
    b3.logPath,
    /POINTER nodeId \d+ inst Pressable onPress true testID power-shutdown/,
    30000,
  );
  check("shutdown: tapping Shut Down fires (onPress power-shutdown)", !!shutTap);
  const trayOff = await waitForLog(b3.logPath, /STATUSD power poweroff requested/, 60000);
  check("shutdown: tray Shut Down reaches statusd", !!trayOff);
  const trayExited = await waitExit(b3, 60000);
  check("shutdown: guest powers off from the tray menu", trayExited);
  closeBoot(b3);

  // --- UEFI boots: the ESP-sync installer proof (M9) ---
  // The test feed (m9-test-2, marker initramfs) is served from the
  // host; the update URL is written into the data partition's
  // update-config.json before the first UEFI boot. The plain UEFI
  // boot proof (shim + GRUB + kernel, data by label, DHCP, shell)
  // is folded into the apply boot — it boots the same unmodified
  // kernel from the same ESP, so a separate plain boot would prove
  // nothing new.
  if (ANCHOR_MODE) {
    // Anchor mode: no feed the harness can sign will verify, so the
    // positive flow (apply + ESP sync + post-apply + fallback +
    // post-restore) is unprovable here — it is proven later by the
    // real nightly feed + an in-place update on hardware. What this
    // mode proves instead: the image trusts exactly the committed
    // anchor, the image refuses a feed signed by an untrusted
    // throwaway key, and nothing changes.
    const { anchor, error } = readAnchor();
    check(
      "anchor: committed anchor is well-formed (non-empty keys, Ed25519 JWKs)",
      !error,
      error || `keyIds: ${anchor.keys.map((k) => k.keyId).join(", ")}`,
    );
    if (error) finish(false);
    await execAsync("node", [
      GEN_KEY,
      "--key-id",
      "throwaway",
      "--out",
      THROWAWAY_KEY_FILE,
    ]);
    signKeyFile = THROWAWAY_KEY_FILE;
    check(
      "anchor: throwaway signing key generated (harness-only)",
      existsSync(THROWAWAY_KEY_FILE),
    );
    let stagedMatches = false;
    let stagedDetail = "";
    try {
      stagedMatches = await stagedAnchorEqualsCommitted();
      stagedDetail = stagedMatches
        ? `keyIds: ${anchor.keys.map((k) => k.keyId).join(", ")}`
        : "staged anchor differs from the committed anchor";
    } catch (e) {
      stagedDetail = `could not extract staged anchor: ${e.message}`;
    }
    check(
      "anchor: staged anchor in image equals committed anchor",
      stagedMatches,
      stagedDetail,
    );
    if (!stagedMatches) finish(false);

    const feed = await buildTestFeed();
    const configPath = join(OUT, "m9-update-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ channel: "nightly", url: feed.url }, null, 2) + "\n",
    );
    await dataWrite(configPath, "/update-config.json");
    check("esp: test feed URL written to the data partition", true);

    // Boot 2 (anchor mode): the UEFI boot proofs still hold, and
    // the APPLY of the throwaway-signed feed must be refused.
    const u = await boot("esp-apply", "uefi");
    await connectSockets(u);
    const uReady = await waitForLog(u.logPath, /SEVYNOS_M5_READY/, 600000);
    check("esp-apply: SEVYNOS_M5_READY (shim + GRUB + kernel verified)", !!uReady);
    check(
      "esp-apply: boot under Secure Boot OVMF (the whole chain verified)",
      !!uReady,
      "a bad shim/GRUB/kernel signature would have refused to boot",
    );
    const uData = await waitForLog(
      u.logPath,
      /M7 init: data disk mounted \(\/dev\/disk\/by-label\/SEVYN_DATA\)/,
      60000,
    );
    check("esp-apply: NVMe data partition mounts by label", !!uData);
    const uDhcp = await waitForLog(
      u.logPath,
      /M7 init: DHCP lease on eth0 \(10\.0\.2\.15\)/,
      60000,
    );
    check("esp-apply: DHCP lease on eth0 with address 10.0.2.15", !!uDhcp);
    const uUpdReady = await waitForLog(u.logPath, /UPDATE ready/, 60000);
    check("esp-apply: update daemon ready", !!uUpdReady);
    const beforeApply = logLines(u.logPath).length;
    u.upd.write("APPLY\n");
    const refused = await waitForLog(
      u.logPath,
      /UPDATE APPLY FAIL the feed carries no signature from a trusted key/,
      300000,
      beforeApply,
    );
    check(
      "negative: feed signed by an untrusted throwaway key is refused",
      !!refused,
      refused || "",
    );
    // The refusal must not have applied anything: the ESP still holds
    // the original kernel + initramfs, and the slot state is still A.
    u.ctl.write("POWEROFF\n");
    const uExited = await waitExit(u, 30000);
    check("esp-apply: guest powers off on request", uExited);
    closeBoot(u);
    const espKern = join(OUT, "m9-esp-vmlinuz");
    const espInit = join(OUT, "m9-esp-initramfs.cpio.gz");
    await espRead("/vmlinuz", espKern);
    await espRead("/initramfs.cpio.gz", espInit);
    check(
      "negative: refused APPLY left ESP /vmlinuz unchanged",
      sha256File(espKern) === feed.origKernHash,
    );
    check(
      "negative: refused APPLY left ESP /initramfs.cpio.gz unchanged",
      sha256File(espInit) === feed.origInitHash,
    );
    const stateAfter = JSON.parse(await dataRead("/slot-state.json"));
    check(
      "negative: refused APPLY left slot state on A",
      stateAfter.active === "A" &&
        stateAfter.good === "A" &&
        stateAfter.version === versionV1,
      JSON.stringify(stateAfter),
    );
    feed.server.close();
    finish(
      checks.every((c) => c.ok),
      {
        duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
      },
    );
    return;
  }

  const feed = await buildTestFeed();
  const configPath = join(OUT, "m9-update-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channel: "nightly", url: feed.url }, null, 2) + "\n",
  );
  await dataWrite(configPath, "/update-config.json");
  check("esp: test feed URL written to the data partition", true);

  // Boot 2: ESP-sync apply.
  const u = await boot("esp-apply", "uefi");
  await connectSockets(u);
  const uReady = await waitForLog(u.logPath, /SEVYNOS_M5_READY/, 600000);
  check("esp-apply: SEVYNOS_M5_READY (shim + GRUB + kernel verified)", !!uReady);
  check(
    "esp-apply: boot under Secure Boot OVMF (the whole chain verified)",
    !!uReady,
    "a bad shim/GRUB/kernel signature would have refused to boot",
  );
  const uData = await waitForLog(
    u.logPath,
    /M7 init: data disk mounted \(\/dev\/disk\/by-label\/SEVYN_DATA\)/,
    60000,
  );
  check("esp-apply: NVMe data partition mounts by label", !!uData);
  const uDhcp = await waitForLog(
    u.logPath,
    /M7 init: DHCP lease on eth0 \(10\.0\.2\.15\)/,
    60000,
  );
  check("esp-apply: DHCP lease on eth0 with address 10.0.2.15", !!uDhcp);
  const uUpdReady = await waitForLog(u.logPath, /UPDATE ready/, 60000);
  check("esp-apply: update daemon ready", !!uUpdReady);
  // Drive APPLY over the updater control serial (ttyS3, the upd
  // socket). The daemon fetches the test feed from the host,
  // verifies it, installs slot B, syncs the ESP, and reboots — the
  // VM exits on reboot -f (QEMU -no-reboot).
  const beforeApply = logLines(u.logPath).length;
  u.upd.write("APPLY\n");
  const applied = await waitForLog(
    u.logPath,
    /UPDATE APPLIED m9-test-2 slot=B/,
    300000,
    beforeApply,
  );
  check("esp-apply: UPDATE APPLIED m9-test-2 slot=B", !!applied);
  const uRebooted = await waitExit(u, 60000);
  check("esp-apply: guest reboots into the new slot", uRebooted);
  closeBoot(u);
  // Host-side proof of the ESP sync (before any further boot):
  const espKern = join(OUT, "m9-esp-vmlinuz");
  const espInit = join(OUT, "m9-esp-initramfs.cpio.gz");
  const espKernPrev = join(OUT, "m9-esp-vmlinuz.prev");
  const espInitPrev = join(OUT, "m9-esp-initramfs.prev.cpio.gz");
  const espGrub = join(OUT, "m9-esp-grub.cfg");
  await espRead("/vmlinuz", espKern);
  await espRead("/initramfs.cpio.gz", espInit);
  await espRead("/vmlinuz.prev", espKernPrev);
  await espRead("/initramfs.prev.cpio.gz", espInitPrev);
  await espRead("/EFI/ubuntu/grub.cfg", espGrub);
  check(
    "esp-apply: ESP /vmlinuz is the new kernel",
    sha256File(espKern) === feed.kernHash,
  );
  check(
    "esp-apply: ESP /initramfs.cpio.gz is the marker initramfs",
    sha256File(espInit) === feed.initHash,
  );
  check(
    "esp-apply: ESP /vmlinuz.prev preserves the old kernel",
    sha256File(espKernPrev) === feed.origKernHash,
  );
  check(
    "esp-apply: ESP /initramfs.prev.cpio.gz preserves the old initramfs",
    sha256File(espInitPrev) === feed.origInitHash,
  );
  const grubAfter = readFileSync(espGrub, "utf8");
  check(
    "esp-apply: grub.cfg default boots the new slot",
    grubAfter.includes("linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=B"),
    grubAfter.slice(0, 200),
  );
  check(
    "esp-apply: grub.cfg previous boots the good slot from .prev",
    grubAfter.includes("linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=A") &&
      grubAfter.includes("initrd /initramfs.prev.cpio.gz"),
  );
  const stateAfter = JSON.parse(await dataRead("/slot-state.json"));
  check(
    "esp-apply: slot state flipped to B (good stays A)",
    stateAfter.active === "B" &&
      stateAfter.good === "A" &&
      stateAfter.version === "m9-test-2",
    JSON.stringify(stateAfter),
  );

  // Boot 3: post-apply — the NEW initramfs boots, the marker reads
  // back, the new slot marks itself good. The marker and the boot
  // slot are read from the serial log, not the Terminal: init prints
  // /m9-esp-marker (when present) and "M4 init: boot slot=B" during
  // boot, while `files cat` output renders to the Terminal window and
  // never reaches the serial log (run11).
  const u2 = await boot("esp-boot", "uefi");
  await connectSockets(u2);
  const u2Ready = await waitForLog(u2.logPath, /SEVYNOS_M5_READY/, 600000);
  check("esp-boot: SEVYNOS_M5_READY on the new slot", !!u2Ready);
  const u2Good = await waitForLog(u2.logPath, /UPDATE SLOT GOOD B/, 120000);
  check("esp-boot: new slot B marked good", !!u2Good);
  const marker = await waitForLog(u2.logPath, /M9-ESP-TEST-2/, 60000, 0);
  check("esp-boot: marker file reads back (the NEW initramfs booted)", !!marker);
  const stateLine = await waitForLog(u2.logPath, /M4 init: boot slot=B/, 60000, 0);
  check("esp-boot: slot state on the booted system is active B", !!stateLine);
  const u2Term = await appdCmd(u2, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("esp-boot: terminal launches", !!u2Term);
  u2.ctl.write("POWEROFF\n");
  const u2Exited = await waitExit(u2, 30000);
  check("esp-boot: guest powers off on request", u2Exited);
  closeBoot(u2);

  // Boot 4: fallback — tamper the state (attempts=2, active=B,
  // good=A) and boot. The daemon restores the ESP from A, flips
  // active back, and reboots; the VM exits. (grub.cfg already
  // defaults to slot B from the apply, so only the state needs
  // tampering.)
  const fbState = join(OUT, "m9-fallback-state.json");
  writeFileSync(
    fbState,
    JSON.stringify(
      { active: "B", good: "A", attempts: 2, version: "m9-test-2" },
      null,
      2,
    ) + "\n",
  );
  await dataWrite(fbState, "/slot-state.json");
  // Confirm the tamper persisted to the image before booting: a
  // silent dataWrite no-op would otherwise surface only as a fallback
  // that never triggers (run12).
  const fbStateBack = JSON.parse(await dataRead("/slot-state.json"));
  check(
    "esp-fallback: tampered state (attempts=2, good=A) persisted to disk",
    fbStateBack.active === "B" &&
      fbStateBack.good === "A" &&
      fbStateBack.attempts === 2 &&
      fbStateBack.version === "m9-test-2",
    JSON.stringify(fbStateBack),
  );
  const u3 = await boot("esp-fallback", "uefi");
  await connectSockets(u3);
  const restored = await waitForLog(
    u3.logPath,
    /UPDATE ESP restored from slot A/,
    300000,
  );
  check("esp-fallback: daemon restores the ESP from good slot A", !!restored);
  const u3Rebooted = await waitExit(u3, 60000);
  check("esp-fallback: guest reboots after the restore", u3Rebooted);
  closeBoot(u3);
  const espKernFb = join(OUT, "m9-esp-fb-vmlinuz");
  const espInitFb = join(OUT, "m9-esp-fb-initramfs.cpio.gz");
  await espRead("/vmlinuz", espKernFb);
  await espRead("/initramfs.cpio.gz", espInitFb);
  check(
    "esp-fallback: ESP /vmlinuz restored to the good kernel",
    sha256File(espKernFb) === feed.origKernHash,
  );
  check(
    "esp-fallback: ESP /initramfs.cpio.gz restored to the good initramfs",
    sha256File(espInitFb) === feed.origInitHash,
  );
  const stateFb = JSON.parse(await dataRead("/slot-state.json"));
  check(
    "esp-fallback: slot state flipped back to A (attempts 0)",
    stateFb.active === "A" && stateFb.good === "A" && stateFb.attempts === 0,
    JSON.stringify(stateFb),
  );

  // Boot 5: post-restore — the restored system boots clean.
  const u4 = await boot("esp-restored", "uefi");
  await connectSockets(u4);
  const u4Ready = await waitForLog(u4.logPath, /SEVYNOS_M5_READY/, 600000);
  check("esp-restored: SEVYNOS_M5_READY on the restored slot A", !!u4Ready);
  const u4Good = await waitForLog(u4.logPath, /UPDATE SLOT GOOD A/, 120000);
  check("esp-restored: slot A marked good again", !!u4Good);
  u4.ctl.write("POWEROFF\n");
  const u4Exited = await waitExit(u4, 30000);
  check("esp-restored: guest powers off on request", u4Exited);
  closeBoot(u4);
  feed.server.close();
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
  writeFileSync(join(OUT, "m9-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M9 CHECK PASSED" : "M9 CHECK FAILED");
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
      join(OUT, "m9-boot-main.log"),
      join(OUT, "m9-uefi-boot-uefi.log"),
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
  console.error("M9 check crashed:", e);
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
    writeFileSync(join(OUT, "m9-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
