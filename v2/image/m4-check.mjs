// M4 check: boot the SevynOS v2 M4 image in QEMU and prove the milestone.
//
//   1. Boot: SEVYNOS_M4_READY + slot/version marker + code-server
//      serving + slot marked good. The shell is on screen (top bar +
//      dock settled), appd answers PING (the M3 stack still works).
//   2. Terminal (the recovery path): launched via appd; typing
//      `code status` proves Sevyn Code is present and serving with
//      its terminal defaulting to the Sevyn CLI; `files cat` on the
//      code-server settings.json proves the terminal profile;
//      `update status` proves the CLI reaches the updater.
//   3. Shell recovery: `shell kill` from the Terminal drops the top
//      bar + dock from the screen; `shell start` brings the shell
//      back (top bar + dock settle again).
//   4. Settings: launched via appd; Tab to Stable + Enter changes
//      the update channel; the persisted value is read back over the
//      updater's control serial (STATUS), not just the UI. Then back
//      to nightly, verified the same way.
//   5. Files: a directory + file are created from the Terminal
//      (`files mkdir` / `files write`); the Files app is launched and
//      lists the real /data directory; Tab to the new directory +
//      Enter navigates into it and lists its one file.
//   6. Clean poweroff.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM
// format. statusd takes commands on the first control serial (ttyS1);
// appd takes LAUNCH/CLOSE/LIST on the second (ttyS2); the updater
// takes STATUS/CHECK/APPLY on the third (ttyS3). Results go to
// m4-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m4-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M4_TIMEOUT (seconds, default 900).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m4-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M4_TIMEOUT || 900);
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
  const kern = join(OUT, `m4-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m4-boot-${tag}-initramfs.cpio.gz`);
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
  const logPath = join(OUT, `m4-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `m4-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m4-${tag}-appd.sock`);
  const updSock = join(OUT, `m4-${tag}-upd.sock`);
  const qmpSock = join(OUT, `m4-${tag}-qmp.sock`);
  const qemu = spawn(
    QEMU,
    [
      "-machine",
      "q35",
      "-m",
      "2048",
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
    qmpSock,
    slot: bootSlot,
    exited: false,
    ctl: null,
    appd: null,
    upd: null,
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
  const qmpPath = join(OUT, `m4-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m4-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m4-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m4-${b.tag}-upd.sock`));
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
  for (const s of [b.ctl, b.appd, b.upd]) {
    try {
      s?.destroy();
    } catch {}
  }
  try {
    b.qemu.kill("SIGKILL");
  } catch {}
}

// Wait for the M4 boot markers on the console.
async function waitReady(b, version) {
  const ready = await waitForLog(b.logPath, /SEVYNOS_M4_READY/, 300000);
  if (!ready) return null;
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
  return { ready, marker, serving, good };
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

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 30000) {
  const shotPath = join(OUT, `m4-shot-${b.tag}.ppm`);
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
        `error: missing ${join(OUT, f)} — run v2/image/build-m4-image.sh first`,
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
  check("boot: Sevyn Code serving (SEVYNOS_M4_READY)", !!r1?.ready);
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
      if (!qc) throw new Error(`m4-check: no QKeyCode for ${JSON.stringify(ch)}`);
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
      30000,
      before,
    );
    let hit = null;
    if (marker) {
      hit = await waitForLog(b.logPath, marker, 15000, before);
    }
    return { exec, hit };
  };

  // 2. Terminal: launch, click the input, prove Sevyn Code + the CLI.
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
  const shotTerm = await shot(b.qmp, join(OUT, "m4-shot-terminal.ppm"));
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
      "code status",
      /TERMINAL code-status running=yes serving=yes terminal-shell=\/usr\/local\/bin\/sevyn/,
    );
    check("terminal: `code status` runs (EXEC 0)", !!exec, exec || "");
    check(
      "terminal: Sevyn Code running + serving, terminal is the Sevyn CLI",
      !!hit,
      hit || "",
    );
  }
  {
    const { exec, hit } = await termCmd(
      "files cat /root/.local/share/code-server/User/settings.json",
      /TERMINAL settings-json defaultProfile=sevyn/,
    );
    check("terminal: `files cat` runs (EXEC 0)", !!exec, exec || "");
    check("terminal: code-server settings defaultProfile is sevyn", !!hit, hit || "");
  }
  {
    const { exec, hit } = await termCmd(
      "update status",
      /TERMINAL update-status channel=nightly/,
    );
    check("terminal: `update status` runs (EXEC 0)", !!exec, exec || "");
    check("terminal: update channel starts at nightly", !!hit, hit || "");
  }
  // Create the directory + file the Files app will open.
  {
    const { exec } = await termCmd("files mkdir /data/m4-files-test");
    check("terminal: `files mkdir /data/m4-files-test` runs", !!exec, exec || "");
  }
  {
    const { exec } = await termCmd("files write /data/m4-files-test/hello.txt hello m4");
    check("terminal: `files write` runs", !!exec, exec || "");
  }

  // 3. Shell recovery: kill the shell from the Terminal, prove the
  // shell is gone from the screen, then start it back.
  {
    const { exec } = await termCmd("shell kill");
    check("terminal: `shell kill` runs (EXEC 0)", !!exec, exec || "");
    await sleep(2000);
    const shotDead = await shot(b.qmp, join(OUT, "m4-shot-shell-dead.ppm"));
    const deadTop = countColor(shotDead, 21, 21, 28, 10, {
      x0: 0,
      y0: 0,
      x1: shotDead.width,
      y1: 48,
    });
    // The dock's background #101014 is indistinguishable from
    // Weston's desktop background (16,16,16) at tolerance 10, so the
    // dock is proven gone by its tiles instead: the first dock tile
    // is Browser blue #0ea5e9, which vanishes with the shell.
    const deadTile = countColor(shotDead, 14, 165, 233, 12, {
      x0: 0,
      y0: 672,
      x1: shotDead.width,
      y1: 768,
    });
    check(
      "recovery: top bar + dock gone after `shell kill`",
      deadTop < 1000 && deadTile < 100,
      `topBar=${deadTop} dockTileBlue=${deadTile}`,
    );
    // Re-focus the Terminal input (the surface stays up; the click
    // re-activates it after the shell died).
    const shotTerm2 = await shot(b.qmp, join(OUT, "m4-shot-terminal-2.ppm"));
    const termHeader2 = findWindowHeader(shotTerm2, 17, 24, 39);
    check("recovery: Terminal window still up after kill", !!termHeader2);
    if (termHeader2) {
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
    const start = await termCmd("shell start");
    check("terminal: `shell start` runs (EXEC 0)", !!start.exec, start.exec || "");
    const imgBack = await screenSettled(b, 60000);
    check(
      "recovery: shell back on screen after `shell start`",
      !!imgBack,
      imgBack ? `${imgBack.width}x${imgBack.height}` : "no settled frame in 60s",
    );
  }
  {
    const closed = await appdCmd(b, "CLOSE terminal", /APPD CLOSE OK terminal/);
    check("terminal: CLOSE accepted", !!closed, closed || "");
  }

  // 4. Settings: launch, Tab to Stable + Enter, verify the persisted
  // channel over the updater's control serial; then back to nightly.
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
  const shotSettings = await shot(b.qmp, join(OUT, "m4-shot-settings.ppm"));
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
  // [X, Scan, Nightly, Stable, echo-ai, plan-ai], and Tab x3 lands on
  // Nightly, not Stable. Click the Stable button directly (like the
  // Nightly step below): it sits in the same row as Nightly, 132px
  // right of it (120px button + 12px gap), centre (+208, +135) from
  // the window's top-left. Verify the top edge first, fall back to
  // Tab x4 if the pixel is not the inactive button.
  const beforeStable = logLines(b.logPath).length;
  let clickedStable = false;
  if (settingsHeader) {
    const vx = settingsHeader.left + 160;
    const vy = settingsHeader.top + 120;
    const i = (vy * shotSettings.width + vx) * 3;
    const [pr, pg, pb] = [
      shotSettings.pixels[i],
      shotSettings.pixels[i + 1],
      shotSettings.pixels[i + 2],
    ];
    const isStableButton =
      Math.abs(pr - 229) <= 10 && Math.abs(pg - 231) <= 10 && Math.abs(pb - 235) <= 10;
    if (isStableButton) {
      await moveTo(
        settingsHeader.left + 208,
        settingsHeader.top + 135,
        shotSettings.width,
        shotSettings.height,
      );
      await sleep(300);
      await click();
      await sleep(300);
      clickedStable = true;
    }
  }
  if (!clickedStable) {
    // Fallback: Tab x4 -> Stable (X, Scan, Nightly, Stable).
    await key("tab");
    await key("tab");
    await key("tab");
    await key("tab");
    await key("ret");
  }
  {
    const hit = await waitForLog(
      b.logPath,
      /SETTINGS channel=stable/,
      15000,
      beforeStable,
    );
    check("settings: Stable applies (SETTINGS channel=stable)", !!hit, hit || "");
    const st = await updCmd(b, "STATUS", /UPDATE STATUS .* channel=stable /);
    check("settings: persisted channel reads back as stable", !!st, st || "");
  }
  // Back to nightly — by CLICKING the Nightly button, not by counting
  // Tabs across the wrap. The Tab path flaked in CI (PR #91's
  // standalone M4 run): one Tab was lost under TCG load, focus landed
  // on X, and Enter closed the window instead of applying nightly —
  // no SETTINGS line at all, and the CLOSE after it failed because
  // the window was already gone. A pointer click cannot land on the
  // wrong button: the channel buttons sit at fixed window-relative
  // offsets (Nightly centre ≈ +76, +135 from the window's top-left;
  // measured on a real frame), and the click is verified by sampling
  // the pixel first — after Stable applies, Nightly is the inactive
  // #e5e7eb button and Stable is the active #111827 one. If the pixel
  // is not the inactive button, fall back to the Tab path.
  // M9: the Nightly click is timing-sensitive under TCG load (the
  // pixel sample or the click can miss on a slow frame), so retry the
  // whole sample+click up to 3 times with a fresh screenshot each
  // time before falling back to Tabs.
  const beforeNightly = logLines(b.logPath).length;
  let clickedNightly = false;
  let sawWindow = false;
  for (let attempt = 0; attempt < 3 && !clickedNightly; attempt++) {
    const shotTry = await shot(
      b.qmp,
      join(OUT, `m4-shot-settings-nightly-${attempt}.ppm`),
    );
    const headerTry = findWindowHeader(shotTry, 107, 113, 128);
    if (!headerTry) break;
    sawWindow = true;
    // Verify at the button's TOP EDGE, centre-x (+76, +120), not the
    // left edge: the top-left corner is rounded (radius 8), so a
    // sample 14px from the left edge sits on the curve and can miss
    // the fill. Centre-x is safely inside the button; the label sits
    // ~7px lower, so the top edge is pure button background.
    const vx = headerTry.left + 76;
    const vy = headerTry.top + 120;
    const i = (vy * shotTry.width + vx) * 3;
    const [pr, pg, pb] = [
      shotTry.pixels[i],
      shotTry.pixels[i + 1],
      shotTry.pixels[i + 2],
    ];
    const isNightlyButton =
      Math.abs(pr - 229) <= 10 && Math.abs(pg - 231) <= 10 && Math.abs(pb - 235) <= 10;
    if (isNightlyButton) {
      // Click the button's centre (+76, +135): a press on the label
      // still hits the Pressable.
      await moveTo(
        headerTry.left + 76,
        headerTry.top + 135,
        shotTry.width,
        shotTry.height,
      );
      await sleep(300);
      await click();
      await sleep(500);
      // If the click applied nightly, the log line appears quickly;
      // stop retrying as soon as it does.
      const hit = await waitForLog(
        b.logPath,
        /SETTINGS channel=nightly/,
        5000,
        beforeNightly,
      );
      if (hit) {
        clickedNightly = true;
      }
    }
  }
  check("settings: Settings window still up for the nightly step", sawWindow);
  if (!clickedNightly) {
    // Fallback: Tab from Stable wraps through the AI buttons to X,
    // then Scan, then Nightly. M9: the Wi-Fi Scan button is in the
    // focus order, so it is Tab x5 from Stable, not x4.
    await key("tab");
    await key("tab");
    await key("tab");
    await key("tab");
    await key("tab");
    await key("ret");
  }
  {
    const hit = await waitForLog(
      b.logPath,
      /SETTINGS channel=nightly/,
      15000,
      beforeNightly,
    );
    check("settings: Nightly applies (SETTINGS channel=nightly)", !!hit, hit || "");
    const st = await updCmd(b, "STATUS", /UPDATE STATUS .* channel=nightly /);
    check("settings: persisted channel reads back as nightly", !!st, st || "");
  }
  {
    const closed = await appdCmd(b, "CLOSE settings", /APPD CLOSE OK settings/);
    check("settings: CLOSE accepted", !!closed, closed || "");
  }

  // 5. Files: launch, verify the real /data listing, navigate into
  // the directory the Terminal created.
  {
    const launched = await appdCmd(b, "LAUNCH files", /APPD LAUNCH OK files/);
    check("files: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) files/,
      30000,
    );
    check("files: host ready in its own runtime", !!appReady);
  }
  await sleep(800);
  {
    const listed = await waitForLog(b.logPath, /FILES listed \/data \(\d+\)/, 15000);
    check("files: lists the real /data directory", !!listed, listed || "");
  }
  const shotFiles = await shot(b.qmp, join(OUT, "m4-shot-files.ppm"));
  // The Files window header is its registered colour #3b82f6.
  // Click the header title (left of the X) to activate the surface.
  const filesHeader = findWindowHeader(shotFiles, 59, 130, 246);
  check("files: window on screen (header found)", !!filesHeader);
  if (filesHeader) {
    await moveTo(
      filesHeader.left + 100,
      filesHeader.top + 22,
      shotFiles.width,
      shotFiles.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
  }
  // Focus order: [X, .., lost+found, m4-files-test, slots] — /data
  // always carries lost+found (ext4) and slots/, both directories, so
  // m4-files-test is the fourth Tab from no-focus (files are not
  // pressable, so the two .json files never enter the order).
  await key("tab");
  await key("tab");
  await key("tab");
  await key("tab");
  {
    const before = logLines(b.logPath).length;
    await key("ret");
    const hit = await waitForLog(
      b.logPath,
      /FILES listed \/data\/m4-files-test \(1\)/,
      15000,
      before,
    );
    check("files: navigates into m4-files-test (1 entry)", !!hit, hit || "");
  }
  {
    const closed = await appdCmd(b, "CLOSE files", /APPD CLOSE OK files/);
    check("files: CLOSE accepted", !!closed, closed || "");
  }

  // Final frame + clean poweroff.
  const shotFinal = join(OUT, "m4-shot-final.ppm");
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
  writeFileSync(join(OUT, "m4-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M4 CHECK PASSED" : "M4 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M4 check crashed:", e);
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
    writeFileSync(join(OUT, "m4-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
