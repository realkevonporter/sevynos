// M12 check: boot the SevynOS v2 M12 image in QEMU and prove Genesis,
// the GPU compositor — it lifts the whole desktop to the GPU, and the
// 60 fps bar is proven on the GF65 only (QEMU/TCG software rendering
// runs ~10–30 fps and cannot prove the bar).
//
//   1. Genesis boot (-kernel/-initrd + the data disk): Weston starts
//      on the GL renderer (FAIL if the pixman fallback engaged —
//      QEMU must expose virgl (virtio-gpu-pci,virgl=on + egl-headless
//      display) so the guest has a real 3D device; without virgl the
//      guest reports -virgl / 0 cap sets and Weston falls back to
//      pixman, which is a harness gap, not a Genesis bug); the
//      host's GPU present path is live (GENESIS EGL renderer line +
//      GENESIS present path=gpu + GENESIS first present); frames flow
//      (a GENESIS fps sample); the shell mounts (SEVYNOS_M2_READY)
//      and paints (screendump: top bar + dock present, as m7-check).
//   2. Fallback boot (same image, sevyn.genesis=0 on the cmdline):
//      the host reports Genesis disabled, never takes the GPU path,
//      and the shell still mounts and paints on the CPU painter —
//      proving a GPU failure can never brick the desktop.
//   3. Clean poweroff (both boots).
//
// The fps sample is a liveness signal only: the presenter logs it
// every 10 presents or 30 s after the first present in the window,
// whichever comes first. The number is meaningless under TCG; the
// check asserts the line exists, never its value.
//
// Results go to m12-check.json; boot logs and screendumps stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m12-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M12_TIMEOUT (seconds, default 3600),
//      SEVYN_V2_QEMU (default qemu-system-x86_64),
//      SEVYN_V2_ACCEL (default tcg).
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
const DISK = join(OUT, "m12-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M12_TIMEOUT || 3600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
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
  // end-anchored patterns match.
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

function logHas(path, pattern) {
  return logLines(path).some((l) => pattern.test(l));
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

// --- QMP client (as m7-check) ---
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
  const kern = join(OUT, `m12-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m12-boot-${tag}-initramfs.cpio.gz`);
  await execAsync("debugfs", ["-R", `dump /slots/${slot}/vmlinuz ${kern}`, DISK]);
  await execAsync("debugfs", [
    "-R",
    `dump /slots/${slot}/initramfs.cpio.gz ${initrd}`,
    DISK,
  ]);
  return { kern, initrd };
}

// --- one QEMU boot (kernel mode, as m7-check) ---
let currentBoot = null;

async function boot(tag, extraAppend = "") {
  const state = await readState();
  const bootSlot = state.active;
  const { kern, initrd } = await dumpSlot(bootSlot, tag);
  const logPath = join(OUT, `m12-boot-${tag}.log`);
  try {
    if (existsSync(logPath) && statSync(logPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(logPath, join(OUT, `m12-boot-${tag}-${stamp}.log`));
    }
  } catch {}
  writeFileSync(logPath, "");
  const logFd = openSync(logPath, "w");
  const appendLog = (chunk) => {
    try {
      writeSync(logFd, chunk);
    } catch {}
  };
  const ctlSock = join(OUT, `m12-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m12-${tag}-appd.sock`);
  const updSock = join(OUT, `m12-${tag}-upd.sock`);
  const aidSock = join(OUT, `m12-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m12-${tag}-qmp.sock`);
  const args = [
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
    `console=ttyS0 sevyn.slot=${bootSlot} sevyn.mockapi=1${extraAppend}`,
    "-display",
    "egl-headless",
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
    "virtio-gpu-pci,virgl=on",
    "-device",
    "qemu-xhci",
    "-device",
    "usb-tablet",
    "-nic",
    "user,model=virtio-net-pci",
    "-no-reboot",
  ];
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

async function connectQmp(b) {
  const qmpPath = join(OUT, `m12-${b.tag}-qmp.sock`);
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
}

function closeBoot(b) {
  try {
    b.qmp?.close();
  } catch {}
  try {
    b.qemu.kill("SIGKILL");
  } catch {}
  try {
    if (b.logFd !== undefined) closeSync(b.logFd);
  } catch {}
}

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). Same colour bands as m7-check's
// screenSettled. Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 120000) {
  const shotPath = join(OUT, `m12-shot-${b.tag}.ppm`);
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
      const dockBg = countColor(img, 57, 57, 59, 10, {
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

function finish(ok, extra = {}) {
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    ...extra,
  };
  writeFileSync(join(OUT, "m12-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M12 CHECK PASSED" : "M12 CHECK FAILED");
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const src of [
      join(OUT, "m12-boot-main.log"),
      join(OUT, "m12-boot-fallback.log"),
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

async function main() {
  const deadline = started + TIMEOUT_S * 1000;
  const timedOut = () => Date.now() > deadline;

  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version", "sevynos.img"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m12-image.sh first`,
      );
      process.exit(1);
    }
  }
  const version = readFileSync(join(OUT, "os-version"), "utf8").trim();
  await execAsync("python3", [
    join(ROOT, "image", "make-data-disk.py"),
    "--kernel",
    join(OUT, "vmlinuz"),
    "--initramfs",
    join(OUT, "initramfs.cpio.gz"),
    "--version",
    version,
    "--out",
    DISK,
    "--label",
    "SEVYN_DATA",
  ]);
  check("setup: data disk created (slot A = built image)", existsSync(DISK));

  // --- Boot 1: Genesis on ---
  let b = await boot("main");
  const ready1 = await waitForLog(b.logPath, /SEVYNOS_M2_READY/, 600000);
  check("genesis: shell mounts (SEVYNOS_M2_READY)", !!ready1);
  if (!ready1) {
    finish(false, { boot: "main" });
    return;
  }
  const renderer = await waitForLog(b.logPath, /GENESIS weston renderer=(\w+)/, 60000);
  const rendererName = renderer ? renderer.match(/renderer=(\w+)/)?.[1] : null;
  check(
    "genesis: Weston runs the GL renderer (not the pixman fallback)",
    rendererName === "gl",
    renderer ? renderer.trim() : "no GENESIS weston renderer line",
  );
  const egl = await waitForLog(b.logPath, /GENESIS EGL renderer=/, 120000);
  check("genesis: host EGL initialized", !!egl, egl ? egl.trim().slice(0, 200) : "");
  const gpuPath = await waitForLog(b.logPath, /GENESIS present path=gpu/, 120000);
  check("genesis: host GPU present path live", !!gpuPath);
  const first = await waitForLog(b.logPath, /GENESIS first present/, 120000);
  check("genesis: first GPU frame presented", !!first);
  const fps = await waitForLog(b.logPath, /GENESIS fps /, 300000);
  check(
    "genesis: frames flow (GENESIS fps sample)",
    !!fps,
    fps ? fps.trim() : "no fps sample in 300 s",
  );
  check(
    "genesis: no GPU fallback engaged",
    !logHas(b.logPath, /GENESIS unavailable|falling back to CPU painter/),
  );
  await connectQmp(b);
  const img1 = await screenSettled(b);
  check("genesis: desktop paints on the GPU path (top bar + dock in screendump)", !!img1);
  closeBoot(b);

  if (timedOut()) {
    finish(false, { timeout: true });
    return;
  }

  // --- Boot 2: Genesis off (sevyn.genesis=0) — the CPU fallback ---
  b = await boot("fallback", " sevyn.genesis=0");
  const ready2 = await waitForLog(b.logPath, /SEVYNOS_M2_READY/, 600000);
  check("fallback: shell mounts with Genesis off (SEVYNOS_M2_READY)", !!ready2);
  if (!ready2) {
    finish(false, { boot: "fallback" });
    return;
  }
  const disabled = await waitForLog(
    b.logPath,
    /GENESIS disabled \(SEVYN_GENESIS=0\)/,
    120000,
  );
  check("fallback: host reports Genesis disabled", !!disabled);
  check(
    "fallback: GPU path never taken",
    !logHas(b.logPath, /GENESIS present path=gpu|GENESIS EGL renderer=/),
  );
  await connectQmp(b);
  const img2 = await screenSettled(b);
  check(
    "fallback: desktop paints on the CPU path (top bar + dock in screendump)",
    !!img2,
  );
  closeBoot(b);

  finish(checks.every((c) => c.ok));
}

main().catch((e) => {
  console.error("M12 check crashed:", e);
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
    writeFileSync(join(OUT, "m12-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
