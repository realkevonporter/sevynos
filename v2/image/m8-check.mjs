#!/usr/bin/env node
// M8 check: boot the SevynOS v2 M8 image in QEMU and prove the milestone.
//
// What it proves, in order:
//   0. Setup: the data disk (ext4, slot A = the built image) and the
//      update fixtures (v2 + bad images, signed manifest templates)
//      are built; a local HTTP server serves the feed.
//   1. Boot slot A (v1): the shell mounts (SEVYNOS_M2_READY), the
//      slot/version marker reads (A, m8-test-1), the shell is on
//      screen, sevyn-updated is ready and marks slot A good, and the
//      app daemon answers PING (the M3 stack still works in the M8
//      image).
//   2. CHECK with a same-version feed reports NONE.
//   3. CHECK with the v2 feed reports AVAILABLE m8-test-2.
//   4. APPLY installs the verified v2 image into the idle slot B,
//      flips the state (active=B, good stays A), and reboots.
//      The state on the data disk confirms the flip.
//   5. Boot slot B (v2): READY, marker (B, m8-test-2), shell on
//      screen, slot B marked good. Done-when part 1: the system
//      updated to the next nightly in place and booted it.
//   6. Negative checks on slot B: a bad-signature feed is refused;
//      a correctly-signed feed with a wrong artifact hash is refused
//      at the download check, with no state change and no reboot.
//   7. APPLY the bad image (verifies fine — it is signed): it lands
//      in the idle slot A, flips the state, reboots.
//   8. Fallback: the bad slot is booted twice and fails to reach
//      READY both times (the shell bundle is corrupt; init runs and
//      the updater records each boot attempt). The third boot falls
//      back to the good slot B automatically: READY, marker
//      (B, m8-test-2), shell on screen, slot B good again. Done-when
//      part 2: a failed update falls back to the previous working
//      system automatically. Clean poweroff.
//
// Two modes:
//   Test-key mode (no anchor committed): the image trusts a fresh
//     per-image TEST keypair; the harness signs every feed with the
//     test private key and proves the full positive flow (steps 2-5,
//     7-8 above).
//   Anchor mode (v2/update/trusted-update-keys.json committed): the
//     image trusts the committed anchor (e.g. the real nightly key),
//     so no feed the harness can sign will verify. The harness
//     instead proves: the staged anchor in the image is byte-identical
//     to the committed anchor; a feed signed by an untrusted throwaway
//     key is refused; a corrupted-signature feed is refused; and a
//     malformed committed anchor fails the run. The positive apply
//     path with the real key is proven later by the real nightly feed
//     + an in-place update on hardware, not by this check.
//
// Slot selection (the harness plays the bootloader): before each
// boot it reads /data/slot-state.json from the disk with debugfs and
// boots the active slot — unless attempts >= 2, in which case it
// boots the good slot. The harness also keeps its own consecutive
// failure count per slot as a safety net for a guest that cannot even
// run init (a kernel/init failure can never increment attempts).
// One QEMU run at a time — never concurrent. Results go to
// m8-check.json; boot logs, screendumps and the data disk stay in the
// build dir as artifacts.
//
// Usage: node v2/image/m8-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M8_TIMEOUT (seconds, default 1500),
//      SEVYN_V2_QEMU (default qemu-system-x86_64),
//      SEVYN_V2_QEMU_EXTRA_ARGS (space-separated, appended to QEMU).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "v2", "image", "build");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M8_TIMEOUT || 1500);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
const QEMU_EXTRA = (process.env.SEVYN_V2_QEMU_EXTRA_ARGS || "")
  .split(/\s+/)
  .filter(Boolean);
const DISK = join(OUT, "data-disk.img");
const FIXTURES = join(OUT, "fixtures");
const KEY_FILE = join(OUT, "update-signing-key.json");
const SIGN_FEED = join(ROOT, "tools", "update-signing", "sign-feed.mjs");
const GEN_KEY = join(ROOT, "tools", "update-signing", "generate-key.mjs");
const ANCHOR_FILE = join(ROOT, "v2", "update", "trusted-update-keys.json");
// Anchor mode: a real trust anchor is committed, so the image trusts
// the committed key(s) and the test-key path is gone. The harness
// signs test feeds with a throwaway keypair it generates itself
// (harness-only, in the git-ignored build dir, never staged into any
// image) and asserts the image refuses them.
const ANCHOR_MODE = existsSync(ANCHOR_FILE);
const THROWAWAY_KEY_FILE = join(OUT, "throwaway-signing-key.json");
let signKeyFile = KEY_FILE;

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

function execAsync(cmd, args, opts = {}) {
  // The harness shells out to cpio/debugfs/mkfs.ext4 (via the fixture
  // and data-disk scripts). Locally those live next to the sysroot's
  // QEMU binary, not on the host PATH — so the QEMU directory goes
  // first on the child PATH (in CI it is /usr/bin, which is harmless).
  const env = { ...process.env };
  if (QEMU.includes("/")) {
    const qdir = dirname(QEMU);
    env.PATH = `${qdir}:${env.PATH || ""}`;
  }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
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
  // Drop the trailing "" from a file ending in "\n" (the m1-check
  // off-by-one: without this, waitForLog skips the first line appended
  // after `sinceLines` was captured).
  const lines = readLog(path).split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function waitForLog(path, pattern, timeoutMs, sinceLines = 0) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const lines = logLines(path);
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
  const { stdout } = await execAsync("debugfs", ["-R", "cat /slot-state.json", DISK]);
  return JSON.parse(stdout);
}

async function dumpSlot(slot, tag) {
  const kern = join(OUT, `boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `boot-${tag}-initramfs.cpio.gz`);
  await execAsync("debugfs", ["-R", `dump /slots/${slot}/vmlinuz ${kern}`, DISK]);
  await execAsync("debugfs", [
    "-R",
    `dump /slots/${slot}/initramfs.cpio.gz ${initrd}`,
    DISK,
  ]);
  return { kern, initrd };
}

async function slotHasFiles(slot) {
  const { stdout } = await execAsync("debugfs", ["-R", `ls -l /slots/${slot}`, DISK]);
  return stdout.includes("vmlinuz") && stdout.includes("initramfs.cpio.gz");
}

// --- feed server + signing ---
let feedPort = 0;
let feedServer = null;

function startFeedServer() {
  return new Promise((resolve) => {
    feedServer = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
      const path = join(FIXTURES, name);
      // Serve only files inside the fixtures dir.
      if (!path.startsWith(FIXTURES) || !existsSync(path)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        const data = readFileSync(path);
        res.writeHead(200, { "Content-Length": data.length });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end("read error");
      }
    });
    feedServer.listen(0, "127.0.0.1", () => {
      feedPort = feedServer.address().port;
      resolve(feedPort);
    });
  });
}

// Copy a manifest template to updates.json (the URL the daemon
// fetches), substitute the server port, optionally override the
// version, and sign it with the test key. When corruptSig is set,
// flip one base64 character of the signature after signing.
async function serveFeed(template, { version = null, corruptSig = false } = {}) {
  const feed = JSON.parse(readFileSync(join(FIXTURES, template), "utf8"));
  if (version !== null) feed.version = version;
  const text = JSON.stringify(feed, null, 2).replaceAll("__PORT__", String(feedPort));
  const live = join(FIXTURES, "updates.json");
  writeFileSync(live, text + "\n");
  await execAsync("node", [SIGN_FEED, "--feed", live, "--key-file", signKeyFile]);
  if (corruptSig) {
    const signed = JSON.parse(readFileSync(live, "utf8"));
    const kid = Object.keys(signed.signatures)[0];
    const sig = signed.signatures[kid];
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    signed.signatures[kid] = flipped;
    writeFileSync(live, JSON.stringify(signed, null, 2) + "\n");
  }
  return live;
}

// --- one QEMU boot ---
const failures = { A: 0, B: 0 }; // harness-side consecutive failures

// The boot currently running (if any) — killed if the harness crashes,
// so a failed run never orphans a QEMU holding the data disk.
let currentBoot = null;

async function boot(tag) {
  const state = await readState();
  // Bootloader rule: a slot that failed twice is never booted again.
  // The state file's attempts counter is primary; the harness-side
  // count covers a guest that cannot even run init.
  const bootSlot =
    state.attempts >= 2 || failures[state.active] >= 2 ? state.good : state.active;
  const { kern, initrd } = await dumpSlot(bootSlot, tag);
  const logPath = join(OUT, `m8-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `m8-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m8-${tag}-appd.sock`);
  const updSock = join(OUT, `m8-${tag}-upd.sock`);
  const qmpSock = join(OUT, `m8-${tag}-qmp.sock`);

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
      kern,
      "-initrd",
      initrd,
      "-append",
      `console=ttyS0 sevyn.slot=${bootSlot} sevyn.update_url=http://10.0.2.2:${feedPort}/updates.json`,
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
      // Second control serial: appd on /dev/ttyS2.
      "-chardev",
      `socket,id=appd,path=${appdSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=appd",
      // Third control serial: sevyn-updated on /dev/ttyS3.
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
      "-netdev",
      "user,id=net0",
      "-device",
      "virtio-net-pci,netdev=net0",
      "-device",
      "virtio-gpu-pci",
      "-device",
      "qemu-xhci",
      "-device",
      "usb-tablet",
      "-no-reboot",
      ...QEMU_EXTRA,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  qemu.stdout.pipe(logStream);
  qemu.stderr.pipe(logStream);
  let qemuExited = false;
  let qemuCode = null;
  qemu.on("exit", (code) => {
    qemuExited = true;
    qemuCode = code;
  });

  const b = {
    tag,
    slot: bootSlot,
    state,
    logPath,
    qemu,
    qmp: null,
    ctl: null,
    appd: null,
    upd: null,
    get exited() {
      return qemuExited;
    },
    get code() {
      return qemuCode;
    },
  };
  currentBoot = b;
  return b;
}

async function waitForSocket(path, timeoutMs = 30000) {
  // QEMU creates its chardev sockets a moment after spawn; connecting
  // before the file exists fails ENOENT (the M3 harness avoids this by
  // connecting only after READY, but M8 drives the updater during the
  // run, so it attaches earlier and waits here instead).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(200);
  }
  return false;
}

async function connectSockets(b) {
  const qmpPath = join(OUT, `m8-${b.tag}-qmp.sock`);
  if (!(await waitForSocket(qmpPath))) {
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
    if (!(await waitForSocket(path))) {
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
  b.ctl = await connect(join(OUT, `m8-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m8-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m8-${b.tag}-upd.sock`));
}

async function waitReady(b, timeoutMs = 280000) {
  const ready = await waitForLog(b.logPath, /SEVYNOS_M2_READY/, timeoutMs);
  if (!ready) return null;
  const marker = await waitForLog(
    b.logPath,
    new RegExp(`SEVYNOS_M8_SLOT ${b.slot} VERSION (\\S+)`),
    30000,
  );
  const good = await waitForLog(
    b.logPath,
    new RegExp(`UPDATE SLOT GOOD ${b.slot}`),
    30000,
  );
  failures[b.slot] = 0;
  return { ready, marker, good };
}

async function waitExit(b, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (b.exited) return true;
    await sleep(500);
  }
  return false;
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
  const shotPath = join(OUT, `m8-shot-${b.tag}.ppm`);
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
// Full extraction (no cpio pattern): the exact command the fixture
// builder already uses in CI, so no new tool dependency.
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

// Final frame + clean poweroff on the current boot. Used by both
// modes: test-key mode ends on the fallback good slot, anchor mode
// ends on slot A.
async function shutdown(b) {
  const shotFinal = join(OUT, "m8-shot-final.ppm");
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
  return imgFinal;
}

async function main() {
  // In anchor mode the test keypair is never generated, so the check
  // must not require it (that was the PR #95 failure).
  const required = ["vmlinuz", "initramfs.cpio.gz", "os-version"];
  if (!ANCHOR_MODE) required.push("update-signing-key.json");
  for (const f of required) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m8-image.sh first`,
      );
      process.exit(1);
    }
  }
  const versionV1 = readFileSync(join(OUT, "os-version"), "utf8").trim();

  // Anchor mode setup: validate the committed anchor, generate the
  // throwaway signing key for the negative checks, and prove the
  // image trusts exactly the committed anchor.
  if (ANCHOR_MODE) {
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
  }

  // 0. Setup: data disk + fixtures + feed server.
  await execAsync("python3", [
    join(ROOT, "v2", "image", "make-data-disk.py"),
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
  await execAsync("python3", [
    join(ROOT, "v2", "image", "make-update-fixtures.py"),
    "--build-dir",
    OUT,
    "--out-dir",
    FIXTURES,
    "--version-v1",
    versionV1,
  ]);
  check(
    "setup: update fixtures built (v2 + bad images, 4 manifests)",
    [
      "vmlinuz-v2",
      "initramfs-v2.cpio.gz",
      "vmlinuz-bad",
      "initramfs-bad.cpio.gz",
      "updates-v2.json",
      "updates-bad.json",
      "updates-badsig.json",
      "updates-badhash.json",
    ].every((f) => existsSync(join(FIXTURES, f))),
  );
  const port = await startFeedServer();
  check("setup: feed server listening", port > 0, `port ${port}`);
  const state0 = await readState();
  check(
    "setup: slot state starts at A/A/0",
    state0.active === "A" &&
      state0.good === "A" &&
      state0.attempts === 0 &&
      state0.version === versionV1,
    JSON.stringify(state0),
  );

  // 1. Boot slot A (v1).
  let b = await boot("1a");
  await connectSockets(b);
  check("boot 1: QMP + control serials connected", true);
  const r1 = await waitReady(b);
  check("boot 1: shell mounted (SEVYNOS_M2_READY)", !!r1?.ready);
  check(
    "boot 1: slot/version marker (A, v1)",
    !!r1?.marker && r1.marker.includes(`VERSION ${versionV1}`),
    r1?.marker || "(no marker)",
  );
  check("boot 1: slot A marked good", !!r1?.good);
  const updReady = await waitForLog(b.logPath, /UPDATE ready version=/, 30000);
  check("boot 1: sevyn-updated ready", !!updReady, updReady || "(no UPDATE ready)");
  const img1 = await screenSettled(b);
  check(
    "boot 1: shell on screen (top bar + dock)",
    !!img1,
    img1 ? `${img1.width}x${img1.height}` : "no settled frame in 30s",
  );
  {
    const pong = await appdCmd(b, "PING", /APPD PONG/);
    check("boot 1: appd answers PING (M3 stack intact)", !!pong);
  }
  {
    const st = await updCmd(
      b,
      "STATUS",
      new RegExp(
        `UPDATE STATUS version=${versionV1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ` +
          "channel=nightly active=A good=A attempts=0 applying=no available=unknown",
      ),
    );
    check("boot 1: STATUS reports A/A/0, up to date unknown", !!st, st || "");
  }

  if (ANCHOR_MODE) {
    // Anchor mode: no feed the harness can sign will verify, so the
    // positive flow (steps 2-5, 7-8) is unprovable here — it is proven
    // later by the real nightly feed + an in-place update on hardware.
    // What this mode proves instead: the image refuses feeds it does
    // not trust, and nothing else changes.
    await serveFeed("updates-v2.json");
    {
      const fail = await updCmd(
        b,
        "CHECK",
        /UPDATE CHECK FAIL .* no signature from a trusted key/,
      );
      check(
        "negative: feed signed by an untrusted throwaway key is refused",
        !!fail,
        fail || "",
      );
    }
    await serveFeed("updates-badsig.json", { corruptSig: true });
    {
      const fail = await updCmd(
        b,
        "CHECK",
        /UPDATE CHECK FAIL .* no signature from a trusted key/,
      );
      check("negative: corrupt-signature feed is refused", !!fail, fail || "");
    }
    {
      const st = await readState();
      check(
        "negative: refused checks leave state untouched (A, v1)",
        st.active === "A" && st.version === versionV1,
        JSON.stringify(st),
      );
      const daemonStatus = await updCmd(
        b,
        "STATUS",
        new RegExp(
          `UPDATE STATUS version=${versionV1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ` +
            "channel=nightly active=A good=A attempts=0 applying=no available=unknown",
        ),
      );
      check(
        "negative: STATUS still reports A/A/0 after refusals",
        !!daemonStatus,
        daemonStatus || "",
      );
    }
    // Final frame + clean poweroff (on slot A).
    const imgFinal = await shutdown(b);
    feedServer.close();
    finish(
      checks.every((c) => c.ok),
      { screen: { width: imgFinal.width, height: imgFinal.height } },
    );
  }

  // 2. CHECK with a same-version feed -> NONE.
  await serveFeed("updates-v2.json", { version: versionV1 });
  {
    const none = await updCmd(b, "CHECK", new RegExp(`UPDATE CHECK NONE ${versionV1}`));
    check("check: same-version feed reports NONE", !!none, none || "");
  }

  // 3. CHECK with the v2 feed -> AVAILABLE.
  await serveFeed("updates-v2.json");
  {
    const avail = await updCmd(b, "CHECK", /UPDATE CHECK AVAILABLE m8-test-2/);
    check("check: v2 feed reports AVAILABLE m8-test-2", !!avail, avail || "");
  }

  // 4. APPLY v2 -> idle slot B, state flips, reboot.
  {
    const started = await updCmd(b, "APPLY", /UPDATE APPLY STARTED m8-test-2/);
    check("apply: APPLY accepted (v2)", !!started, started || "");
    const applied = await waitForLog(
      b.logPath,
      /UPDATE APPLIED m8-test-2 slot=B/,
      300000,
    );
    check("apply: v2 installed into slot B", !!applied, applied || "");
    const exited = await waitExit(b, 30000);
    check("apply: guest rebooted after APPLY", exited);
    closeBoot(b);
    const st = await readState();
    check(
      "apply: state flipped to B (good stays A, attempts 0)",
      st.active === "B" &&
        st.good === "A" &&
        st.attempts === 0 &&
        st.version === "m8-test-2",
      JSON.stringify(st),
    );
    check("apply: slot B holds vmlinuz + initramfs", await slotHasFiles("B"));
  }

  // 5. Boot slot B (v2) — done-when part 1.
  b = await boot("5b");
  await connectSockets(b);
  const r5 = await waitReady(b);
  check("boot 5: shell mounted on slot B (SEVYNOS_M2_READY)", !!r5?.ready);
  check(
    "boot 5: slot/version marker (B, m8-test-2)",
    !!r5?.marker && r5.marker.includes("VERSION m8-test-2"),
    r5?.marker || "(no marker)",
  );
  check("boot 5: slot B marked good", !!r5?.good);
  const img5 = await screenSettled(b);
  check("boot 5: shell on screen on the new slot", !!img5);
  {
    const st = await updCmd(
      b,
      "STATUS",
      /UPDATE STATUS version=m8-test-2 channel=nightly active=B good=B attempts=0 applying=no available=unknown/,
    );
    check("boot 5: STATUS reports B/B/0, version m8-test-2", !!st, st || "");
  }

  // 6. Negative checks on slot B.
  await serveFeed("updates-badsig.json", { corruptSig: true });
  {
    const fail = await updCmd(b, "CHECK", /UPDATE CHECK FAIL .* does not verify/);
    check("negative: bad-signature feed refused", !!fail, fail || "");
  }
  await serveFeed("updates-badhash.json");
  {
    const avail = await updCmd(b, "CHECK", /UPDATE CHECK AVAILABLE m8-test-3/);
    check("negative: bad-hash feed passes signature (available)", !!avail, avail || "");
    const before = logLines(b.logPath).length;
    b.upd.write("APPLY\n");
    const fail = await waitForLog(
      b.logPath,
      /UPDATE APPLY FAIL .* sha256 mismatch/,
      300000,
      before,
    );
    check("negative: bad-hash apply refused at download", !!fail, fail || "");
    check("negative: guest did NOT reboot on refused apply", !b.exited);
    const st = await readState();
    check(
      "negative: refused apply leaves state untouched (B, m8-test-2)",
      st.active === "B" && st.version === "m8-test-2",
      JSON.stringify(st),
    );
  }

  // 7. APPLY the bad image (verifies fine — it is signed).
  await serveFeed("updates-bad.json");
  {
    const started = await updCmd(b, "APPLY", /UPDATE APPLY STARTED m8-test-bad/);
    check("apply: APPLY accepted (bad image)", !!started, started || "");
    const applied = await waitForLog(
      b.logPath,
      /UPDATE APPLIED m8-test-bad slot=A/,
      300000,
    );
    check("apply: bad image installed into slot A", !!applied, applied || "");
    const exited = await waitExit(b, 30000);
    check("apply: guest rebooted after bad APPLY", exited);
    closeBoot(b);
    const st = await readState();
    check(
      "apply: state flipped to A (good stays B, attempts 0)",
      st.active === "A" &&
        st.good === "B" &&
        st.attempts === 0 &&
        st.version === "m8-test-bad",
      JSON.stringify(st),
    );
  }

  // 8. Fallback: the bad slot fails twice, the third boot falls back.
  for (let attempt = 1; attempt <= 2; attempt++) {
    b = await boot(`8bad${attempt}`);
    // The bad guest powers off quickly on its own; the control sockets
    // are not needed here, so a connect race must not crash the run.
    try {
      await connectSockets(b);
    } catch {
      // QMP/control attach is best-effort on a failing boot.
    }
    const exited = await waitExit(b, 180000);
    check(`fallback: bad boot ${attempt} powers off without READY`, exited);
    const log = readLog(b.logPath);
    check(
      `fallback: bad boot ${attempt} never reached READY`,
      !log.includes("SEVYNOS_M2_READY"),
    );
    check(
      `fallback: bad boot ${attempt} failed at the shell (host never ready)`,
      log.includes("shell host never became ready"),
    );
    failures[b.slot]++;
    closeBoot(b);
    const st = await readState();
    check(
      `fallback: boot attempt ${attempt} recorded (attempts=${attempt})`,
      st.attempts === attempt,
      JSON.stringify(st),
    );
  }
  b = await boot("8good");
  await connectSockets(b);
  const r8 = await waitReady(b);
  check("fallback: good slot boots (SEVYNOS_M2_READY)", !!r8?.ready);
  check(
    "fallback: slot/version marker (B, m8-test-2)",
    !!r8?.marker && r8.marker.includes("VERSION m8-test-2"),
    r8?.marker || "(no marker)",
  );
  check("fallback: slot B marked good again", !!r8?.good);
  const img8 = await screenSettled(b);
  check("fallback: shell on screen on the good slot", !!img8);
  {
    const st = await updCmd(
      b,
      "STATUS",
      /UPDATE STATUS version=m8-test-2 channel=nightly active=B good=B attempts=0 applying=no available=unknown/,
    );
    check("fallback: STATUS reports B/B/0 (fallback permanent)", !!st, st || "");
  }

  // Final frame + clean poweroff (on the fallback good slot).
  const imgFinal = await shutdown(b);
  feedServer.close();
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
  writeFileSync(join(OUT, "m8-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M8 CHECK PASSED" : "M8 CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M8 check crashed:", e);
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  try {
    feedServer?.close();
  } catch {}
  const result = {
    pass: false,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    error: String(e),
  };
  try {
    writeFileSync(join(OUT, "m8-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
