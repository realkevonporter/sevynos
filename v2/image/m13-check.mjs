// M13 check: boot the SevynOS v2 M13 image in QEMU and prove the
// milestone — Chromium as a chromeless app-mode content window,
// paired with the Browser app window.
//
//   Fork: this check is forked from v2/image/m5-check.mjs (NOT
//   m12-check.mjs — m5 has all the input-driving primitives:
//   QMP input-send-event, Terminal typing, appd commands,
//   screendump pixel proofs; m12 has none). The boot, QMP,
//   Terminal-driving and pixel helpers are m5's, renamed to m13.
//   The Genesis assertions in step 1 are copied from
//   v2/image/m12-check.mjs.
//
//   1. Boot + Genesis intact (the m12 regression — step 1 IS the
//      regression; do NOT run m12-check.mjs on this image as a
//      separate step, it boots its own image): SEVYNOS_M2_READY;
//      `GENESIS weston renderer=gl`; `GENESIS EGL renderer=`
//      containing llvmpipe; `GENESIS present path=gpu`;
//      `GENESIS first present`; a `GENESIS fps` sample; no
//      `GENESIS unavailable|falling back to CPU painter`; the
//      desktop paints (top bar + dock).
//   2. Embed up: `browser open` the local page, then `browser
//      status` reports running=yes over CDP (running=yes is only
//      printed after a successful CDP /json/version probe, so it
//      entails cdp=yes). The `gpu:` value from status is recorded
//      in the check log — it is NOT a hard failure when
//      gpu=fallback (the software fallback is a designed path);
//      CI under llvmpipe should show gpu=yes, and the value must
//      be reported (see the gpu gate in step 4).
//   3. A real page renders: the host-served red page (page A)
//      renders (red viewport on screen + its title over CDP);
//      gated on SEVYN_V2_M13_INTERNET, the public example.com
//      page renders too (white / #eeeeee page on screen).
//   4. Address-bar input (the RN Browser app): launch it, type
//      the green page's URL into its address bar, and the green
//      page renders in Chromium; the app reports its gpu mode
//      (`BROWSER gpu=yes|fallback`).
//   5. In-page click navigation (NEW — m5 never clicks inside a
//      page): a BLUE link page with a centred link to the green
//      page (blue so the check can tell it apart from page A,
//      which is red); clicking the link navigates the tab (CDP
//      title changes + green renders).
//   6. Chromeless heuristic (NEW): the red viewport's bbox is
//      short and wide — height in [150, 360] AND aspect
//      width/height >= 2.0. Measured 768x225, aspect 3.41 (the
//      launched window is 800x348, but only Chromium renders
//      small — Browser 798 wide, Terminal 800 wide; see step 6).
//      The old M5 window was 500 tall with ~80px of Chromium
//      chrome, giving a viewport of ~420 (aspect ~1.9), which the
//      aspect bound rules out.
//   7. Close-tab (was: tab switching — CANNOT work under the
//      single-tab contract: warm `browser open` closes the
//      previous tab, so the red tab from step 3 is long gone by
//      now): close the current (only) tab and `browser tabs`
//      reports 0 tabs. Whether Chromium stays running with zero
//      tabs is recorded, not asserted.
//   8. Lifecycle (NEW): close the Browser app (its in-app close
//      button, falling back to appd CLOSE) and Chromium dies with
//      it: the in-app path must log `EXEC sevyn browser quit -> 0`,
//      and `browser status` must report not running within 60 s
//      (either close path — the appd-CLOSE fallback also kills
//      Chromium now). A `browser status` that produces no EXEC
//      line at all is a harness failure (Terminal focus lost),
//      reported distinctly from "still running".
//   9. Shell intact at end + clean poweroff.
//
// Single-tab contract (M13 is single-tab by design): a warm
// `browser open` leaves exactly ONE tab — the new one. After PUT
// /json/new it closes every other page tab and activates the new
// tab, so the new tab's window is frontmost by elimination. Each
// `browser open` replaces the current tab; closing the last tab
// empties the browser (`browser tabs` n=0). Tab ids recorded
// earlier in the run are stale by the next open and are never
// carried across steps. Multi-tab (a WebSocket client in the CLI
// driving Page.navigate / minimize-restore windows) is the
// principled follow-up, NOT this PR.
//
// The fps number is a liveness signal only: the presenter logs it
// every 10 presents or 30 s after the first present in the window,
// whichever comes first. The number is meaningless under TCG
// (QEMU software rendering runs ~10-30 fps and cannot prove the
// 60 fps bar); the check asserts the line exists, never its value.
// The 60 fps bar is proven on the GF65 hardware only.
//
// Input is driven with QMP input-send-event (usb-tablet for absolute
// pointer, PS/2 keyboard). Screendumps use QMP screendump in PPM
// format. statusd takes commands on the first control serial (ttyS1);
// appd takes LAUNCH/CLOSE/LIST on the second (ttyS2); the updater
// takes STATUS/CHECK/APPLY on the third (ttyS3); aid takes
// PING/LIST/SELECT/STATUS/ASK on the fourth (ttyS4). The host serves
// the test pages on an ephemeral 127.0.0.1 port — the guest reaches
// them at 10.0.2.2:<port> through QEMU user networking (virtio-net).
// Results go to m13-check.json; boot logs, screendumps and the data disk stay
// in the build dir as artifacts.
//
// Usage: node v2/image/m13-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_M13_TIMEOUT (seconds, default 3600),
//      SEVYN_V2_M13_INTERNET (1 = prove the public page, 0 = skip
//      the internet steps; default 1. The sandbox has no guest
//      internet, so local runs use 0 and CI is the gate),
//      SEVYN_V2_QEMU (default qemu-system-x86_64).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "m13-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_M13_TIMEOUT || 3600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
const INTERNET = process.env.SEVYN_V2_M13_INTERNET !== "0";
// The host test-page server binds an EPHEMERAL port (listen(0)):
// m5 and m13 share the KVM box, and two concurrent jobs binding
// the old fixed 18080 collided with EADDRINUSE (run 44803329836).
// The actual port is read back after the server starts; the guest
// reaches it at 10.0.2.2:<port> through QEMU user networking, so
// every guest URL below is built from HTTP_PORT.
let HTTP_PORT = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const timedOut = () => Date.now() > started + TIMEOUT_S * 1000;

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
  // The serial console writes CRLF; strip the trailing \r so
  // end-anchored patterns match (as m12-check).
  return readLog(path)
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function logHas(path, pattern) {
  return logLines(path).some((l) => pattern.test(l));
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

// Round 9 (PR #117, run 43720789371, head 242ad0ba): a
// Terminal-SCOPED EXEC wait. The shared boot log carries EXEC lines
// from every app, and the Browser app's refresh loop emits the
// SAME `EXEC sevyn browser status/tabs/open` lines the Terminal
// emits — so waitForLog on an EXEC pattern "verifies" focus and
// "proves" a command ran while the Terminal never received input
// at all (m5 check 43: zero `JS TERMINAL` lines after frame
// 420000, yet every verifyFocus + exec-wait passed on the
// Browser app's own traffic for ~8 minutes). The discriminator,
// proven on both 242ad0ba boot logs: the Terminal echoes every
// command it runs as `JS TERMINAL <app>-<verb> ...` 2–46 ms
// after its EXEC line, while the Browser app echoes `JS BROWSER
// ...` after its own. So an EXEC line counts as
// Terminal-originated ONLY when its own verb's `JS TERMINAL`
// echo follows it within 16 log lines and 5000 guest-ms (the
// serial log duplicates every line, so 16 lines is ~8 logical
// lines; the echo is normally 1–2). A `JS BROWSER` line first
// ends the search for that EXEC — the echo belongs to a later
// Terminal command, not this one. Returns the EXEC line, or null
// on timeout. Callers that pass no echoRe (verbs the Browser app
// never emits) keep using waitForLog directly.
async function waitForTerminalExec(path, execRe, echoRe, timeoutMs, sinceLines = 0) {
  const deadline = Date.now() + timeoutMs;
  const guestMs = (line) => {
    const m = line.match(/^\[(\d+)\]/);
    return m ? parseInt(m[1], 10) : null;
  };
  while (Date.now() < deadline) {
    const lines = logLines(path).slice(sinceLines);
    for (let i = 0; i < lines.length; i++) {
      if (!execRe.test(lines[i])) continue;
      for (let j = i + 1; j < Math.min(i + 17, lines.length); j++) {
        if (/JS BROWSER /.test(lines[j])) break;
        if (echoRe.test(lines[j])) {
          const eMs = guestMs(lines[i]);
          const tMs = guestMs(lines[j]);
          if (eMs === null || tMs === null || (tMs - eMs >= 0 && tMs - eMs <= 5000))
            return lines[i];
          break;
        }
      }
    }
    await sleep(500);
  }
  return null;
}

// The Terminal app's per-command echo, scoped by the command's OWN
// app token (first word) and verb (second word): the Terminal
// echoes every command it runs as `JS TERMINAL <app>-<verb> ...`
// a few ms after its EXEC line. Round 9 keyed on the verb alone,
// so `net status` was scoped to the `browser-status` echo it can
// never produce — m5 check 18 on head 96d36141 burned its full
// 120 s timeout on an EXEC that ran fine (boot log: `[48797]
// EXEC sevyn net status -> 0`, `[48812] JS TERMINAL net-status
// interface=eth0 wifi=on`, 15 ms later). Echo formats below are
// read off the 96d36141 boot logs, not guessed: `net dns ...` ->
// `JS TERMINAL net-dns ...` (EXEC [175714] -> echo [175717]);
// `browser open` -> `JS TERMINAL browser-open` (EXEC [201942] ->
// echo [201947]); `browser status` / `browser tabs` as before.
// Verbs with no echo return null and keep the plain wait:
// `activate` / `close` (no `JS TERMINAL` echo of their own
// follows their EXEC lines in either 96d36141 boot log) and
// `quit` (m13 log: the quit EXEC [867509] is followed by JS
// POINTER / GENESIS lines, no `JS TERMINAL browser-quit`) — but
// no other app runs those verbs either (the Browser app only ever
// runs open/status/tabs), so their EXEC lines are already
// Terminal-specific and need no scoping. `quit` is likewise never
// waited on via termCmd.
function terminalEchoRe(cmd) {
  const [app, verb] = cmd.split(" ");
  if (app === "browser") {
    if (verb === "status") return /JS TERMINAL browser-status/;
    if (verb === "tabs") return /JS TERMINAL browser-tabs/;
    if (verb === "open") return /JS TERMINAL browser-open/;
  }
  if (app === "net") {
    if (verb === "status") return /JS TERMINAL net-status/;
    if (verb === "dns") return /JS TERMINAL net-dns/;
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
//
// Round 7 (run 43709802164, dbdda2ae): `left`/`right` are taken
// ONLY from rows in the header band itself (top..top+43) that
// clear the 700px bar — NOT from every matching row in the frame.
// The old code took the min/max over all matching rows, so
// another window's same-colour body pixels in LOWER rows polluted
// the rect: in the dbdda2ae refocus-fresh frame the dragged-aside
// Browser window's dark body puts #111827 pixels at x0..14 on
// rows y545..552, merging with the Terminal's own rows, so the
// rect came back left=0 instead of left=103 — a 103px jump that
// fails the REFOCUS_JUMP_PX consistency gate and refuses the
// first-attempt clicks on a perfectly visible Terminal.
// `top`/`bottom` are unchanged (first/last row over 700px);
// `bottom` is still the band end, not the window's true bottom
// edge (see refocusFirstAttemptSafe).
function findWindowHeader(img, r, g, b) {
  const { width: W, pixels } = img;
  let top = -1;
  let bottom = -1;
  // Per-row match extents, kept so left/right can be recomputed
  // from the header band only (see below).
  const rows = [];
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
    }
    rows.push({ n, left: rowLeft, right: rowRight });
  }
  if (top < 0) return null;
  let left = W;
  let right = -1;
  for (let y = top; y <= Math.min(bottom, top + 43); y++) {
    const row = rows[y - 48];
    if (row.n > 700) {
      if (row.left < left) left = row.left;
      // Round 3 (run 43690022280): this was `rowRight = rowRight`
      // — a no-op that left `right` at -1 forever. Every consumer
      // of the rect then computed with right=-1: the refocus
      // second-attempt click landed at x=(103 + -1)/2 = 51,
      // off-window on bare desktop, which raised the shell so the
      // follow-up input click hit the Calculator dock icon and
      // launched Calculator; and visibleFragment could never
      // subtract the Terminal (a cover with x1=-1 overlaps
      // nothing), so raise clicks could land inside the Terminal.
      if (row.right > right) right = row.right;
    }
  }
  return { top, bottom, left, right };
}

// Partial header band (round 7, m13 only): a window dragged
// partly off-screen keeps a header band, but its rows hold fewer
// than the 700px findWindowHeader requires — the strict scan
// returns null even though the window plainly moved (dbdda2ae
// drag-aside: Browser header (107,193)-(904,234) -> rows y453..494
// x0..597, ~590px/row). This scan takes the longest consecutive
// run of rows holding >100 header-colour px as the band and
// returns its rect. It is used ONLY for the drag's after-frame,
// never for refocus: a fragment header must never gate a focus
// click. Returns null when no band of >=10 rows exists.
function findWindowHeaderPartial(img, r, g, b) {
  const { width: W, pixels } = img;
  let best = null;
  let cur = null;
  const close = () => {
    if (cur && (!best || cur.bottom - cur.top > best.bottom - best.top)) best = cur;
    cur = null;
  };
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
    if (n > 100) {
      if (!cur) cur = { top: y, bottom: y, left: rowLeft, right: rowRight };
      else {
        cur.bottom = y;
        if (rowLeft < cur.left) cur.left = rowLeft;
        if (rowRight > cur.right) cur.right = rowRight;
      }
    } else {
      close();
    }
  }
  close();
  if (!best || best.bottom - best.top + 1 < 10) return null;
  return best;
}

// A drag's start point, VERIFIED to be a header pixel (round 7,
// m13 only). After Chromium is raised, part of the Browser header
// is covered, so the usual start (left+200, top+22) can land
// inside Chromium — dragging from there would move Chromium, not
// the Browser window. Prefer the usual start; fall back to the
// centre of the longest run of header-colour pixels in the header
// band; refuse (null) when no run reaches 20px, so the caller
// never drags blind.
function dragStartPoint(frame, rect, r, g, b) {
  const sx = rect.left + 200;
  const sy = rect.top + 22;
  if (pixelMatches(frame, sx, sy, r, g, b)) return { x: sx, y: sy };
  let best = null;
  for (let y = rect.top; y <= rect.bottom; y++) {
    let s = -1;
    for (let x = 0; x <= frame.width; x++) {
      const m = x < frame.width && pixelMatches(frame, x, y, r, g, b);
      if (m && s < 0) s = x;
      if (!m && s >= 0) {
        if (x - s >= 20 && (!best || x - s > best.len))
          best = { x0: s, x1: x - 1, y, len: x - s };
        s = -1;
      }
    }
  }
  if (!best) return null;
  return { x: Math.round((best.x0 + best.x1) / 2), y: best.y };
}

// Do two window rects show the same window in the same place
// (every edge within `tol`)? Round 8: the drag-back verifier.
// A null rect never matches — an unverifiable position is not a
// returned window.
function rectsWithin(a, b, tol) {
  if (!a || !b) return false;
  return (
    Math.abs(a.top - b.top) <= tol &&
    Math.abs(a.left - b.left) <= tol &&
    Math.abs(a.bottom - b.bottom) <= tol &&
    Math.abs(a.right - b.right) <= tol
  );
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
  const kern = join(OUT, `m13-boot-${tag}-vmlinuz`);
  const initrd = join(OUT, `m13-boot-${tag}-initramfs.cpio.gz`);
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
  const logPath = join(OUT, `m13-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `m13-${tag}-ctl.sock`);
  const appdSock = join(OUT, `m13-${tag}-appd.sock`);
  const updSock = join(OUT, `m13-${tag}-upd.sock`);
  const aidSock = join(OUT, `m13-${tag}-aid.sock`);
  const qmpSock = join(OUT, `m13-${tag}-qmp.sock`);
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
      // sevyn.mockapi=1, as m12 does: the guest's mock API server
      // answers the shell's API calls without a network round-trip.
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
      // guest at 10.0.2.2:<port> (ephemeral; see HTTP_PORT).
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
  const qmpPath = join(OUT, `m13-${b.tag}-qmp.sock`);
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
  b.ctl = await connect(join(OUT, `m13-${b.tag}-ctl.sock`));
  b.appd = await connect(join(OUT, `m13-${b.tag}-appd.sock`));
  b.upd = await connect(join(OUT, `m13-${b.tag}-upd.sock`));
  b.aid = await connect(join(OUT, `m13-${b.tag}-aid.sock`));
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
// the M4.5 markers are already in the log. SEVYNOS_M2_READY was
// already waited for (step 1) before this runs.
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
// render-timing flake). 120 s, as m12-check: the Genesis first
// present lags further under TCG. Returns the settled frame or null.
async function screenSettled(b, timeoutMs = 120000) {
  const shotPath = join(OUT, `m13-shot-${b.tag}.ppm`);
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

// Poll screendumps until `pred(img)` returns a truthy count, or time
// out. Returns { count, img } on success, null on timeout.
async function pollPixels(b, name, pred, timeoutMs = 120000) {
  const shotPath = join(OUT, `m13-shot-${name}.ppm`);
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
// Serves the test pages on an ephemeral 127.0.0.1 port; the guest
// reaches them at 10.0.2.2:<port>. Pages A and B are m5's, verbatim (same names
// and URLs, so the server code is a verbatim copy): both paint their
// FULL viewport one flat colour (red / green): any visible sliver
// of the Chromium window is detectable in a screendump and clickable
// to raise it, even with the Terminal window on top — the old
// build's "browser dead" failure would show nothing at all. The
// white heading proves text paints too. Page A is the render proof;
// page B is the Browser-app navigation proof. The link page is NEW
// for M13: a BLUE page with one large link to the green page, for
// the in-page click-navigation step. Blue (#0000ff), not red:
// page A is red, so a red link page would be indistinguishable
// from it in a screendump — the check could not tell whether the
// link page or page A was frontmost.
const PAGE_A = `<!doctype html><html><head><title>SevynOS M5 Test Page</title><style>
body { margin: 0; background: #ff0000; font-family: sans-serif; }
h1 { color: #ffffff; font-size: 28px; margin: 24px 0 0 50px; }
</style></head><body><h1>SevynOS M5 Test Page</h1></body></html>`;
const PAGE_B = `<!doctype html><html><head><title>Second Page</title><style>
body { margin: 0; background: #00c853; font-family: sans-serif; }
h1 { color: #ffffff; font-size: 28px; margin: 24px 0 0 50px; }
</style></head><body><h1>Second Page</h1></body></html>`;
// The link is flex-centred mid-viewport, so its centre coincides
// with the blue viewport's bbox centre — the click step derives the
// click point from the blue bbox centre on exactly this assumption.
// If the link styling moves, the click misses and the check fails
// honestly (see step 5).
const PAGE_LINK = `<!doctype html><html><head><title>SevynOS M13 Link Page</title><style>
body { margin: 0; background: #0000ff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
a { color: #ffffff; font-size: 48px; }
</style></head><body><a href="/m13-page2.html">Go to green page</a></body></html>`;

function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/m5-page.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_A);
    } else if (req.url === "/m5-page2.html" || req.url === "/m13-page2.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_B);
    } else if (req.url === "/m13-link.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(PAGE_LINK);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Bounding box of a colour in the frame (null when absent), plus
// the matching-pixel count `n`. The test pages paint the full
// viewport one flat colour, so the box is the visible part of
// Chromium's viewport — a LOCATOR only, never a click target.
//
// ROUND 4 (run 43694717539): the round-2 DENSITY GATE is REMOVED.
// It required matching pixels to fill >=50% of the bbox, on the
// premise that "a real page fills ~100%". That premise is false
// for example.com: its #eeeeee background is a minority colour of
// the visible viewport (mostly white content box + #dde3e9/#edf2fa),
// and the visible fragment is a thin strip — measured density
// 0.016 on m13-shot-example-raise-fresh.ppm (bbox
// (19,17)-(1183,788), n=13,964). The gate rejected the real strip,
// so raiseChromiumFresh never clicked at all and the poll ran 180 s
// against the un-raised strip. A bbox must never gate on fill: the
// guard against a bad click is findSolidRunPoint, which requires
// actual page pixels (a >=100px solid run) inside the visible
// fragment. A scattered colour yields no solid run, so the raise
// still fails honestly — without ever rejecting a real strip.
function findColorBBox(img, r, g, b, tol = 10, box = null) {
  const { width: W, height: H, pixels } = img;
  // Round 7: `box` restricts the scan to a rect {x0, y0, x1, y1}
  // (e.g. the link text's white pixels inside the blue viewport);
  // null scans the full frame, so existing callers are unaffected.
  const bx0 = box?.x0 ?? 0;
  const by0 = box?.y0 ?? 0;
  const bx1 = box?.x1 ?? W - 1;
  const by1 = box?.y1 ?? H - 1;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  let n = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pixels[i] - r) <= tol &&
        Math.abs(pixels[i + 1] - g) <= tol &&
        Math.abs(pixels[i + 2] - b) <= tol
      ) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, n };
}

// All visible fragments of `box` (a viewport rect) on a W x H
// screen, after removing every `covers` rect (windows sitting on top
// of it — at minimum the Terminal rect). Rect subtraction splits a
// fragment into up to four pieces. Empty when no part of the box is
// visible at all — the caller must then report the raise as failed,
// never click a point it cannot see. A fragment is safe to click
// whatever the stacking order is: when the covered window is
// actually behind, the fragment is still Chromium pixels; when it
// is in front, the fragment is the only Chromium left showing.
function visibleFragments(box, covers, W, H) {
  if (!box) return [];
  let frags = [
    {
      x0: Math.max(box.x0, 0),
      y0: Math.max(box.y0, 0),
      x1: Math.min(box.x1, W - 1),
      y1: Math.min(box.y1, H - 1),
    },
  ];
  if (frags[0].x1 < frags[0].x0 || frags[0].y1 < frags[0].y0) return [];
  for (const cRaw of covers) {
    if (!cRaw) continue;
    // Covers arrive in either rect shape: window rects
    // ({left, top, right, bottom} from findWindowHeader) or colour
    // bboxes ({x0, y0, x1, y1} from findColorBBox). Normalise here
    // — the subtraction below reads x0/y0/x1/y1 only.
    const c = {
      x0: cRaw.x0 ?? cRaw.left,
      y0: cRaw.y0 ?? cRaw.top,
      x1: cRaw.x1 ?? cRaw.right,
      y1: cRaw.y1 ?? cRaw.bottom,
    };
    const next = [];
    for (const f of frags) {
      if (c.x1 < f.x0 || c.x0 > f.x1 || c.y1 < f.y0 || c.y0 > f.y1) {
        next.push(f);
        continue;
      }
      if (f.x0 < c.x0)
        next.push({ x0: f.x0, y0: f.y0, x1: Math.min(f.x1, c.x0 - 1), y1: f.y1 });
      if (f.x1 > c.x1)
        next.push({ x0: Math.max(f.x0, c.x1 + 1), y0: f.y0, x1: f.x1, y1: f.y1 });
      if (f.y0 < c.y0)
        next.push({
          x0: Math.max(f.x0, c.x0),
          y0: f.y0,
          x1: Math.min(f.x1, c.x1),
          y1: Math.min(f.y1, c.y0 - 1),
        });
      if (f.y1 > c.y1)
        next.push({
          x0: Math.max(f.x0, c.x0),
          y0: Math.max(f.y0, c.y1 + 1),
          x1: Math.min(f.x1, c.x1),
          y1: f.y1,
        });
    }
    frags = next;
    if (!frags.length) return [];
  }
  return frags;
}

// Largest visible fragment of `box` (see visibleFragments). Null
// when no part of the box is visible at all.
function visibleFragment(box, covers, W, H) {
  let best = null;
  let bestArea = -1;
  for (const f of visibleFragments(box, covers, W, H)) {
    const area = (f.x1 - f.x0 + 1) * (f.y1 - f.y0 + 1);
    if (area > bestArea) {
      bestArea = area;
      best = f;
    }
  }
  return best;
}

// MIN_SOLID_RUN_PX: a raise click must land on a solid run of page
// pixels at least this long (contiguous horizontally). Measured on
// the failed runs' frames, the real example.com strip's #eeeeee
// runs are 753px (rows y 272-285, x 129-881) and its white runs
// 768px — a 100px bar sits far below any real page strip and far
// above anything stray pixels form (they never run contiguously).
const MIN_SOLID_RUN_PX = 100;

// Centre of the LARGEST SOLID RUN of the target colour inside the
// given visible fragments — the round-4 raise target. A
// single-colour bbox centre is the WRONG target: the page strip is
// a thin horizontal band and stray pixels inflate the bbox, so the
// centre is usually NOT on the page (m13 run 43694717539: bbox
// (19,17)-(1183,788), centre (601,400) on bare desktop; m5 run
// 43694717554: bbox centre (503,152) on bare desktop, ~8px above
// the real band). The run is a cluster of ACTUAL page pixels, so
// its centre is on the page by construction. Ties (several rows
// share the longest run, e.g. a solid viewport) resolve to the
// median such row, i.e. the vertical centre of the solid block.
// Returns { x, y, run } or null when no run reaches
// MIN_SOLID_RUN_PX — the caller must then NOT click at all and
// report the raise as failed. The run is searched ONLY within the
// fragments (visible page area), never the whole screen.
function findSolidRunPoint(img, r, g, b, frags, tol = 10) {
  const { width: W, pixels } = img;
  const matches = (x, y) => {
    const i = (y * W + x) * 3;
    return (
      Math.abs(pixels[i] - r) <= tol &&
      Math.abs(pixels[i + 1] - g) <= tol &&
      Math.abs(pixels[i + 2] - b) <= tol
    );
  };
  let bestLen = 0;
  let bestRuns = [];
  for (const f of frags ?? []) {
    for (let y = f.y0; y <= f.y1; y++) {
      let run = 0;
      let start = f.x0;
      for (let x = f.x0; x <= f.x1 + 1; x++) {
        if (x <= f.x1 && matches(x, y)) {
          if (run === 0) start = x;
          run++;
        } else {
          if (run > bestLen) {
            bestLen = run;
            bestRuns = [{ x0: start, y, len: run }];
          } else if (run === bestLen && run > 0) {
            bestRuns.push({ x0: start, y, len: run });
          }
          run = 0;
        }
      }
    }
  }
  if (bestLen < MIN_SOLID_RUN_PX) return null;
  const mid = bestRuns[Math.floor((bestRuns.length - 1) / 2)];
  return { x: mid.x0 + Math.floor((mid.len - 1) / 2), y: mid.y, run: mid.len };
}

// Whether the pixel at (x, y) matches the colour — a point
// verification for click targets derived another way (e.g. the
// link-page click, whose point is the blue bbox centre because the
// link is flex-centred there).
function pixelMatches(img, x, y, r, g, b, tol = 10) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
  const i = (y * img.width + x) * 3;
  return (
    Math.abs(img.pixels[i] - r) <= tol &&
    Math.abs(img.pixels[i + 1] - g) <= tol &&
    Math.abs(img.pixels[i + 2] - b) <= tol
  );
}

// REFOCUS_JUMP_PX: the largest per-edge move accepted as "the same
// window" when a fresh header is compared with the last known good
// one. Windows do move mid-run, but only by a few px; a covered
// header jumps by hundreds.
const REFOCUS_JUMP_PX = 60;

// First-attempt refocus click gate (round 4, m5 run 43694717554):
// the title/input clicks may run ONLY when the Terminal header was
// freshly detected in the current frame AND the clicks land inside
// the detected window. The m5 failure clicked stale termPos points
// (title (153,301), input (303,768)) when NO Terminal was on
// screen at all — the input click hit the dock and launched
// Calendar (nodeId 43). `fresh` is this frame's findWindowHeader
// result (null when nothing was detected); `known` is the last
// known good rect (null on the very first refocus). The title point
// (left+50, top+15) must lie inside the fresh rect. The input point
// is (left+200, top+482): its x must lie inside the fresh rect and
// its y must be on screen — its y-containment is the fresh top
// itself (the input row is top+482 by construction), NOT
// findWindowHeader's bottom: its scan stops at y=672 while the
// window actually runs to ~top+499, so `bottom` is not the window's
// bottom edge. The 50/15/200/482 offsets must match
// clickTitleAndInput below. False means: do NOT click — the caller
// falls through to the guarded second attempt (or fails fast when
// no fresh header exists at all).
function refocusFirstAttemptSafe(fresh, known, W, H) {
  if (!fresh) return false;
  if (known) {
    if (
      Math.abs(fresh.top - known.top) > REFOCUS_JUMP_PX ||
      Math.abs(fresh.left - known.left) > REFOCUS_JUMP_PX ||
      Math.abs(fresh.bottom - known.bottom) > REFOCUS_JUMP_PX ||
      Math.abs(fresh.right - known.right) > REFOCUS_JUMP_PX
    ) {
      return false;
    }
  }
  const titleX = fresh.left + 50;
  const titleY = fresh.top + 15;
  if (titleX > fresh.right || titleY > fresh.bottom) return false;
  const inputX = fresh.left + 200;
  const inputY = fresh.top + 482;
  if (inputX > fresh.right || inputY < 0 || inputY >= H) return false;
  return true;
}

// Round 5 (runs 43699446057/43699446209): the refocus recovery
// helpers. The round-4 second attempt clicked the visible Terminal
// fragment centre ONCE and then verified — but that click raises
// the window at the compositor level while landing on the Terminal
// BODY, not the TextInput, so focus never transferred and the
// verify still failed. The recovery must therefore be two-phase:
// raise, then RE-DERIVE the header from a fresh frame, then click
// the input and verify. These pure helpers are the recovery's
// decisions, so the harness unit test can extract and drive them
// against the real failed-run frames.
//
// Geometry the guards rest on (measured from the aaef509c frames,
// 1280x800):
// - The Terminal window's TRUE bottom is top+499 (the window runs
//   to y~785 for a top of 286); findWindowHeader's `bottom` is
//   only the #111827 band's end (671 — its scan stops at y=672),
//   so it must never be used as the window's bottom edge.
// - The dock pill spans y~702-792 and its icons y~709-790; the
//   Terminal's input row (top+482, e.g. y=769) sits INSIDE the
//   dock's y-band. A click at the input point that misses the
//   Terminal therefore hits a dock icon: (303,768) is the red C
//   icon in the m5 refocus frame. DOCK_ICON_TOP_Y=740 is the
//   dock-band threshold (established in round 4): no blind click
//   may land at y>=740 unless the current frame proves Terminal
//   pixels are at that exact point.
// - A click on bare desktop HIDES all windows (m5 run
//   43699446209: the IDE step's stale-viewport click at (992,430)
//   hit desktop and the next two shots show the bare "Welcome to
//   SevynOS" desktop — Terminal and Chromium both gone). So a
//   recovery click must land on verified Terminal pixels (or the
//   Terminal's own dock icon), never on desktop.
const TERMINAL_WINDOW_HEIGHT_PX = 499;
const DOCK_BAND_TOP_Y = 700;
const DOCK_ICON_TOP_Y = 740;
const MIN_DOCK_ICON_RUN_PX = 20;
// The input row's background colour (#1f2937): the neighbourhood
// check in refocusInputPointSafe counts it around the click point.
const TERMINAL_INPUT_RGB = [31, 41, 55];

// Guarded centre of the visible Terminal fragment (round-4 second
// attempt, factored out unchanged): the fresh fragment
// INTERSECTED with the last known good window rect. Returns
// {x, y} or null when the intersection is empty or the centre
// would leave the known rect / the frame / the dock band. The
// centre is inside termPos, whose bottom (<=671) is far above the
// dock row, so it can never land on a dock icon; it may still
// land on Chromium where Chromium covers the fragment's centre —
// harmless (no RN Pressable there) — and the verify arbitrates.
function refocusFragmentRaisePoint(fresh, known, W, H) {
  if (!fresh || !known) return null;
  const ix0 = Math.max(fresh.left, known.left);
  const iy0 = Math.max(fresh.top, known.top);
  const ix1 = Math.min(fresh.right, known.right);
  const iy1 = Math.min(fresh.bottom, known.bottom);
  const cx = Math.round((ix0 + ix1) / 2);
  const cy = Math.round((iy0 + iy1) / 2);
  const safePoint =
    ix0 <= ix1 &&
    iy0 <= iy1 &&
    cx >= known.left &&
    cx <= known.right &&
    cy >= known.top &&
    cy <= known.bottom &&
    cy < DOCK_ICON_TOP_Y &&
    cx >= 0 &&
    cx < W &&
    cy >= 0 &&
    cy < H;
  return safePoint ? { x: cx, y: cy } : null;
}

// Raise point from a PARTIAL Terminal fragment (round 8, run
// 43715706248, head 0f82d7d9): the strict scan returns null when
// the header is covered, but the Terminal body still shows as a
// fragment — in the crash run, ~304px of #111827 at x599-902 on
// rows y492+ (the dragged-aside Browser window + raised Chromium
// cover the header). The fragment's rect comes from
// findWindowHeaderPartial; this helper finds the longest run of
// Terminal-colour pixels inside (fragment ∩ known window) and
// returns its centre — a VERIFIED Terminal pixel, so the raise
// click lands on the Terminal, never on the covering window.
// The plain intersection centre is NOT enough: the partial rect
// merges the fragment with the covering Browser window's own
// dark pixels — left=0 in the crash frame — so its centre
// (502,581) is Browser body (measured [229,231,235], not
// #111827), and clicking it would raise the Browser instead.
// Returns null when no run reaches 20px, when the point would
// leave the known rect / the frame / the dock band, or when
// either rect is null. Among the longest rows the one closest
// to the fragment's vertical centre wins, so the click lands
// mid-fragment, not on its edge.
function refocusFragmentRaisePointPartial(partial, known, img, W, H) {
  if (!partial || !known) return null;
  const ix0 = Math.max(partial.left, known.left);
  const iy0 = Math.max(partial.top, known.top);
  const ix1 = Math.min(partial.right, known.right);
  const iy1 = Math.min(partial.bottom, known.bottom);
  if (ix0 > ix1 || iy0 > iy1) return null;
  const midY = (iy0 + iy1) / 2;
  let best = null;
  for (let y = iy0; y <= iy1; y++) {
    let s = -1;
    for (let x = ix0; x <= ix1 + 1; x++) {
      const m = x <= ix1 && pixelMatches(img, x, y, 17, 24, 39);
      if (m && s < 0) s = x;
      if (!m && s >= 0) {
        const len = x - s;
        if (
          !best ||
          len > best.len ||
          (len === best.len && Math.abs(y - midY) < Math.abs(best.y - midY))
        ) {
          best = { x0: s, x1: x - 1, y, len };
        }
        s = -1;
      }
    }
  }
  if (!best || best.len < 20) return null;
  const cx = Math.round((best.x0 + best.x1) / 2);
  const cy = best.y;
  const safePoint =
    cx >= known.left &&
    cx <= known.right &&
    cy >= known.top &&
    cy <= known.bottom &&
    cy < DOCK_ICON_TOP_Y &&
    cx >= 0 &&
    cx < W &&
    cy >= 0 &&
    cy < H;
  return safePoint ? { x: cx, y: cy } : null;
}

// The Terminal's dock icon, found in the CURRENT frame: the only
// #111827 block in the dock band. The Terminal icon is dark navy
// (its window colour); every other dock icon is a bright colour
// and the dock background is #39393b, so a >=20px run of #111827
// in the dock band is the icon — measured on the m5 aaef509c
// refocus frame, where the icon is the unique such block
// (x968-1031, y709-772, runs up to 64px; scattered matches are
// <10px). `known` is the last known good window rect (null when
// there is none): pixels inside its constructed rect
// (top..top+499) are the window itself, not the icon, and are
// excluded. Returns the icon bbox centre {x, y} or null when no
// such block is visible. Clicking it raises the running
// Terminal's window (the dot under the icon marks it running);
// it is the ONLY on-screen affordance for the Terminal when no
// window is visible at all.
function findTerminalDockIcon(img, known) {
  const { width: W, height: H } = img;
  const runs = [];
  for (let y = DOCK_BAND_TOP_Y; y < H; y++) {
    let s = -1;
    for (let x = 0; x < W; x++) {
      const inWindow =
        known &&
        x >= known.left &&
        x <= known.right &&
        y >= known.top &&
        y <= known.top + TERMINAL_WINDOW_HEIGHT_PX;
      const m = !inWindow && pixelMatches(img, x, y, 17, 24, 39);
      if (m && s < 0) s = x;
      if (!m && s >= 0) {
        if (x - s >= MIN_DOCK_ICON_RUN_PX) runs.push({ x0: s, x1: x - 1, y });
        s = -1;
      }
    }
    if (s >= 0 && W - s >= MIN_DOCK_ICON_RUN_PX) {
      runs.push({ x0: s, x1: W - 1, y });
    }
  }
  if (runs.length === 0) return null;
  let longest = runs[0];
  for (const r of runs) {
    if (r.x1 - r.x0 > longest.x1 - longest.x0) longest = r;
  }
  // The icon's bbox: every qualifying run overlapping the longest
  // run's x-range (the white ">" glyph splits the icon's middle
  // rows into two shorter runs, which still overlap it).
  let x0 = longest.x0;
  let x1 = longest.x1;
  let y0 = longest.y;
  let y1 = longest.y;
  for (const r of runs) {
    if (r.x0 <= x1 + 10 && r.x1 >= x0 - 10) {
      if (r.x0 < x0) x0 = r.x0;
      if (r.x1 > x1) x1 = r.x1;
      if (r.y < y0) y0 = r.y;
      if (r.y > y1) y1 = r.y;
    }
  }
  return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) };
}

// Last-known-good input-click guard (round 5). The input point
// (left+200, top+482) is returned ONLY when the CURRENT frame
// proves the Terminal's input row is on screen at that exact
// point: the point must lie inside the constructed window rect
// (left..right, top..top+499 — the true bottom, not
// findWindowHeader's band end) and inside the frame, AND at least
// half the pixels in a 41x11 box around it must be the input-row
// background colour. That last clause is what makes the dock-band
// overlap safe: the input row sits in the dock's y-band, so a
// blind click there would hit a dock icon (m5's (303,768) is the
// red C icon when the Terminal is hidden — measured 0/451
// input-row pixels there, vs 0.82-0.92 when the row is present).
// When the Terminal is absent the frame shows the dock icon, not
// input-row pixels, so the guard refuses and the caller fails
// fast instead of launching an app. Returns {x, y} or null.
function refocusInputPointSafe(known, img, W, H) {
  if (!known) return null;
  const x = known.left + 200;
  const y = known.top + 482;
  if (
    x < known.left ||
    x > known.right ||
    y < known.top ||
    y > known.top + TERMINAL_WINDOW_HEIGHT_PX ||
    x < 0 ||
    x >= W ||
    y < 0 ||
    y >= H
  ) {
    return null;
  }
  let n = 0;
  let tot = 0;
  for (let yy = Math.max(0, y - 5); yy <= Math.min(H - 1, y + 5); yy++) {
    for (let xx = Math.max(0, x - 20); xx <= Math.min(W - 1, x + 20); xx++) {
      tot++;
      if (
        pixelMatches(
          img,
          xx,
          yy,
          TERMINAL_INPUT_RGB[0],
          TERMINAL_INPUT_RGB[1],
          TERMINAL_INPUT_RGB[2],
        )
      ) {
        n++;
      }
    }
  }
  return tot > 0 && n / tot >= 0.5 ? { x, y } : null;
}

// The gpu mode Chromium is running in, as reported in the boot log:
// the Browser app's `BROWSER gpu=yes|fallback` marker is the
// designed source; a `TERMINAL browser-status ... gpu=` field or a
// raw `gpu:` line is accepted too, in case the marker lands in a
// different form. Returns "yes" | "fallback" | null (latest match
// wins). The value is REPORTED, not gated, in step 2; step 4 gates
// on it being present (either designed value passes — fallback is a
// designed path, not a failure; CI under llvmpipe should show yes).
function gpuFromLog(path) {
  let gpu = null;
  for (const line of logLines(path)) {
    const m =
      line.match(/BROWSER gpu=(yes|fallback)/) ||
      line.match(/TERMINAL browser-status .*gpu=(yes|fallback)/) ||
      line.match(/gpu:\s*(yes|fallback)/);
    if (m) gpu = m[1];
  }
  return gpu;
}

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-m13-image.sh first`,
      );
      process.exit(1);
    }
  }
  const version = readFileSync(join(OUT, "os-version"), "utf8").trim();
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
    version,
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
      state0.version === version,
    JSON.stringify(state0),
  );
  const server = await startTestServer();
  HTTP_PORT = server.address().port;
  check(`setup: host test-page server on 127.0.0.1:${HTTP_PORT}`, true);

  // 1. Boot + Genesis intact (the m12 regression, first).
  const b = await boot("1");
  await connectSockets(b);
  check("boot: QMP + control serials connected", true);
  const ready2 = await waitForLog(b.logPath, /SEVYNOS_M2_READY/, 600000);
  check("genesis: shell mounts (SEVYNOS_M2_READY)", !!ready2);
  if (!ready2) {
    // Nothing else can pass on a shell that never mounted; fail
    // fast (m12 pattern) instead of burning every later timeout.
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
  check(
    "genesis: EGL renderer is software (llvmpipe — CPU-only path)",
    !!egl && /llvmpipe/i.test(egl),
    egl ? egl.trim().slice(0, 200) : "no GENESIS EGL renderer line",
  );
  const gpuPath = await waitForLog(b.logPath, /GENESIS present path=gpu/, 120000);
  check("genesis: host GPU present path live", !!gpuPath);
  const first = await waitForLog(b.logPath, /GENESIS first present/, 120000);
  check("genesis: first GPU frame presented", !!first);
  const fps = await waitForLog(b.logPath, /GENESIS fps /, 300000);
  check(
    "genesis: frames flow (GENESIS fps sample, liveness only — never its value)",
    !!fps,
    fps ? fps.trim() : "no fps sample in 300 s",
  );
  check(
    "genesis: no GPU fallback engaged",
    !logHas(b.logPath, /GENESIS unavailable|falling back to CPU painter/),
  );
  const r1 = await waitReady(b, version);
  check("boot: M5 ready (SEVYNOS_M5_READY)", !!r1?.ready5);
  check("boot: M4.5 stack intact (SEVYNOS_M4_5_READY)", !!r1?.ready45);
  check("boot: M4 stack intact (SEVYNOS_M4_READY)", !!r1?.ready);
  check(
    "boot: slot/version marker (A, v1)",
    !!r1?.marker && r1.marker.includes(`VERSION ${version}`),
    r1?.marker || "(no marker)",
  );
  check("boot: code-server serving", !!r1?.serving, r1?.serving || "(no serving line)");
  check("boot: slot A marked good", !!r1?.good);
  check("boot: init net probe found eth0", !!r1?.netIf, r1?.netIf || "(no M5 init line)");
  const img1 = await screenSettled(b);
  check(
    "boot: shell on screen (top bar + dock)",
    !!img1,
    img1 ? `${img1.width}x${img1.height}` : "no settled frame in 120s",
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
  // Pointer drag (round 6): press left at (x0, y0), step to
  // (x1, y1), release — the m9 pointerDrag pattern, on this
  // file's moveTo + QMP button events. The Wayland host turns a
  // button press on a title bar into an interactive window move
  // (m9 proves it for RN windows: "window drags to move (title
  // bar, +200/+100)"). The end point is clamped into the frame:
  // the pointer stops at the screen edge and the window follows
  // it that far, which is the most the drag can move it anyway.
  const dragPointer = async (x0, y0, x1, y1, w, h, steps = 12) => {
    const cx = (x) => Math.max(0, Math.min(x, w - 1));
    const cy = (y) => Math.max(0, Math.min(y, h - 1));
    await moveTo(cx(x0), cy(y0), w, h);
    await sleep(300);
    await b.qmp.input([{ type: "btn", data: { button: "left", down: true } }]);
    await sleep(200);
    for (let i = 1; i <= steps; i++) {
      await moveTo(
        cx(Math.round(x0 + ((x1 - x0) * i) / steps)),
        cy(Math.round(y0 + ((y1 - y0) * i) / steps)),
        w,
        h,
      );
      await sleep(80);
    }
    await b.qmp.input([{ type: "btn", data: { button: "left", down: false } }]);
    await sleep(500);
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
      if (!qc) throw new Error(`m13-check: no QKeyCode for ${JSON.stringify(ch)}`);
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
  // `browser status` while Chromium is still starting (or dead).
  // Round 9 (PR #117, run 43720789371, head 242ad0ba): re-click
  // the Terminal's input immediately before typing a command. The
  // refocus click that verified focus can LAND (nodeId 56,
  // TextInput) and the typed text still go nowhere — in the
  // failing run the Terminal never executed `browser tabs` in 8
  // minutes while the refocus click had landed, most plausibly
  // lost to a focus transition while Chromium was still
  // mapping/raising. So the click that focuses the input for THIS
  // command is taken from a FRESH frame right before typing,
  // guarded by refocusInputPointSafe (the point must provably be
  // the input row — a blind click at the last-known point can land
  // on a dock icon when the Terminal is hidden). When the guard
  // refuses, the command is typed anyway (same as before — the
  // caller already refocused); the re-click is best-effort, never
  // a gate.
  const clickTerminalInputNow = async () => {
    if (!termPos) return false;
    const frame = await shot(b.qmp, join(OUT, "m13-shot-termcmd-input.ppm"));
    const pt = refocusInputPointSafe(termPos, frame, frame.width, frame.height);
    if (!pt) return false;
    await moveTo(pt.x, pt.y, frame.width, frame.height);
    await sleep(300);
    await click();
    await sleep(300);
    return true;
  };
  const termCmd = async (cmd, marker = null, execRe = null, execTimeoutMs = 120000) => {
    const before = logLines(b.logPath).length;
    // Round 3 (runs 43690022156/43690022280): CLEAR the input
    // before typing. The Terminal app clears its input in submit()
    // (setInput("")), but only when a command is SUBMITTED — text
    // typed while focus was lost (Chromium steals focus as its
    // window maps, mid-typing) sits un-submitted in the input, and
    // the next command concatenates onto it: the failed run logged
    // `EXEC sevyn browser stabrowser status -> 1` ("browser sta"
    // left over from an interrupted typing + "browser status").
    // Ctrl+U / select-all are NOT used: the Terminal app has no key
    // handler for them and the host TextInput's control-key support
    // is unverified — but the app's own submit-clear IS proven, so
    // the harness flushes with Enter (an empty input submits "" and
    // only echoes, per run() — harmless) and waits 2 s for the
    // submit to settle. The typed command is queued after the clear
    // in the update order, so even a slow stale command cannot wipe
    // it. This is a harness workaround for a Terminal product bug
    // (the input does not reliably clear / focus loss leaves
    // partial text); the Terminal app itself is untouched.
    await key("ret");
    await sleep(2000);
    await clickTerminalInputNow();
    await typeText(cmd);
    await key("ret");
    // Round 9: the EXEC wait is Terminal-scoped (see
    // waitForTerminalExec) — an unscoped wait passes on the
    // Browser app's refresh-loop traffic while the Terminal never
    // ran the command. Verbs with no Terminal echo (activate,
    // close) are never emitted by any other app, so they keep the
    // plain wait.
    const execPattern =
      execRe ??
      new RegExp(`EXEC sevyn ${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} -> 0`);
    const echoRe = terminalEchoRe(cmd);
    const exec = echoRe
      ? await waitForTerminalExec(b.logPath, execPattern, echoRe, execTimeoutMs, before)
      : await waitForLog(b.logPath, execPattern, execTimeoutMs, before);
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
  // Poll `browser status` until the marker reports Chromium NOT
  // running (step 8: Chromium must die with the Browser app).
  // Bounded to 60 s by the caller-facing timeout: each attempt is a
  // short `browser status` (10 s EXEC wait) plus the marker wait.
  // Returns { hit, sawExec }: hit is the running=no marker line (or
  // null); sawExec is whether ANY attempt produced an EXEC line at
  // all. sawExec=false means the command never ran — a harness
  // failure (Terminal focus lost; one failed run typed the command
  // into Calculator) — which the lifecycle check reports distinctly
  // instead of claiming Chromium is still running.
  // 120 s cap (was 60 s): the stop poll passed in 44 s in run
  // 44803329836 — too thin a margin on the loaded 3-runner box.
  const pollBrowserStopped = async (timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    let sawExec = false;
    while (Date.now() < deadline) {
      await refocusTerminal();
      const { exec, hit } = await termCmd(
        "browser status",
        /TERMINAL browser-status running=no/,
        /EXEC sevyn browser status -> [01]/,
        10000,
      );
      if (exec) sawExec = true;
      if (hit) return { hit, sawExec };
      await sleep(3000);
    }
    return { hit: null, sawExec };
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
  // Run `browser tabs` until `title` appears `want` times in the
  // titles list. Single-tab contract: the link page is the ONLY tab,
  // so a successful click navigates it in place and `want` is 1 —
  // the count still proves the navigation (a missed click leaves
  // the title as the link page's, count 0). Refocuses the Terminal
  // before each attempt: the click gave Chromium keyboard focus.
  // Returns the last { hit, titles, n } seen, or null when no tabs
  // marker ever arrived.
  const pollTabsTitleCount = async (title, want, attempts = 6) => {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      await refocusTerminal();
      const { hit } = await termCmd("browser tabs", /TERMINAL browser-tabs n=\d+/);
      if (hit) {
        const { titles } = parseTabsMarker(hit);
        const n = titles.filter((t) => t === title).length;
        last = { hit, titles, n };
        if (n >= want) return last;
      }
      await sleep(5000);
    }
    return last;
  };
  // Poll `browser tabs` until the marker reports n=0 (no tabs
  // left — step 7, closing the last tab). Refocuses the Terminal
  // before each attempt; the EXEC wait is bounded (20 s) so a
  // lost-focus attempt does not burn the whole budget. Returns the
  // n=0 marker line or null.
  const pollTabsZero = async (attempts = 4) => {
    for (let i = 0; i < attempts; i++) {
      await refocusTerminal();
      // execRe [01]: closing the last tab may stop Chromium, and
      // then `browser tabs` exits 1 ("Chromium is not running") —
      // the Terminal still logs the n=0 marker from the empty
      // output, but the default EXEC -> 0 wait would burn its
      // whole timeout first.
      const { hit } = await termCmd(
        "browser tabs",
        /TERMINAL browser-tabs n=0/,
        /EXEC sevyn browser tabs -> [01]/,
        20000,
      );
      if (hit) return hit;
      await sleep(5000);
    }
    return null;
  };
  // The current (only) tab's id, from a fresh `browser tabs`
  // marker. Tab ids recorded earlier in the run are stale by
  // design — every warm `browser open` closes the previous tab
  // (single-tab contract) — so the id is re-read here, never
  // carried across steps. Returns the id or null.
  const currentTabId = async () => {
    await refocusTerminal();
    const marker = await pollTabsTitle(/TERMINAL browser-tabs n=\d+/);
    if (!marker) return null;
    const { ids } = parseTabsMarker(marker);
    return ids[0] ?? null;
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
  // the LEFT end of the input row: the left end stays visible under
  // the most window placements.
  //
  // ROUND 2 (run 14150434065): the Terminal position was RE-DERIVED
  // from a fresh frame on every call, and findWindowHeader matches
  // #111827 — the Terminal's BODY colour as well as its header.
  // Once Chromium covered the Terminal's header, the first visible
  // #111827 row dropped to y=544, so the title click computed
  // (153,559) (mid-body, not the title bar) and the input click
  // computed (153,1026) — off-screen, clamped to y=800 — and
  // neither focuses the TextInput. Every later refocus repeated the
  // same broken geometry, so no typed command ever ran and the
  // check burned its waits. So the fresh position is trusted ONLY
  // when it is consistent with the last known good one, the clicks
  // are clamped into the frame, and focus is VERIFIED: a cheap
  // `browser status` must produce an EXEC line within 25 s, or the
  // run fails fast with HARNESS FAILURE instead of burning 120 s
  // per step. A failed refocus throws: no later step can pass
  // without a focusable Terminal, and the main().catch handler
  // records the failure in m13-check.json.
  //
  // RED_MIN_WIDTH_PX: a rendered page's visible viewport must be
  // at least this wide — the full Chromium window measures 768
  // wide, while a Terminal-covered sliver is ~178 wide (round 2).
  const RED_MIN_WIDTH_PX = 400;
  // REFOCUS_JUMP_PX lives at the top level (used by the
  // refocusFirstAttemptSafe gate as well as the consistency check
  // below).
  let termPos = null;
  const refocusTerminal = async () => {
    const shotNow = await shot(b.qmp, join(OUT, "m13-shot-refocus.ppm"));
    const termFresh = findWindowHeader(shotNow, 17, 24, 39);
    if (termFresh) {
      if (!termPos) {
        termPos = termFresh;
      } else {
        // Accept the fresh rect only if it is the same window
        // (small delta on every edge) AND the input click it
        // implies lands inside the frame and inside the detected
        // window rect. A covered header fails both: the visible
        // #111827 fragment starts hundreds of px below the real
        // top, and top+482 lands past the frame / past the rect.
        const freshInputY = termFresh.top + 482;
        const consistent =
          Math.abs(termFresh.top - termPos.top) <= REFOCUS_JUMP_PX &&
          Math.abs(termFresh.left - termPos.left) <= REFOCUS_JUMP_PX &&
          Math.abs(termFresh.bottom - termPos.bottom) <= REFOCUS_JUMP_PX &&
          Math.abs(termFresh.right - termPos.right) <= REFOCUS_JUMP_PX &&
          freshInputY >= 0 &&
          freshInputY < shotNow.height &&
          freshInputY <= termFresh.bottom;
        if (consistent) termPos = termFresh;
        // else: keep the last known good position — the fresh rect
        // is a covered fragment, not the window.
      }
    }
    if (!termPos) {
      throw new Error(
        "HARNESS FAILURE: refocus failed — no Terminal header detected in the current frame and no known window position; the Terminal never regained focus, so no typed command can run",
      );
    }
    const clampX = (x) => Math.max(0, Math.min(x, shotNow.width - 1));
    const clampY = (y) => Math.max(0, Math.min(y, shotNow.height - 1));
    const clickTitleAndInput = async () => {
      // Raise first: Chromium's window is cascaded on top of the
      // Terminal when it opens, so the input row may be covered. The
      // title bar peeks out above the cascaded window — clicking it
      // raises the Terminal. The title click is a BEST-EFFORT
      // compositor raise only: the title bar has NO focusable target
      // (the title text is a non-pressable Text node — the failed
      // run logged nodeId -1 for it — and the only Pressables up
      // there are the window controls, which must never be clicked).
      // Focus comes from the input click below + the verify after
      // it, never from this click. Both clicks are clamped into the
      // frame — an off-screen click can never focus anything.
      await moveTo(
        clampX(termPos.left + 50),
        clampY(termPos.top + 15),
        shotNow.width,
        shotNow.height,
      );
      await sleep(300);
      await click();
      await sleep(300);
      // Input click: INSIDE the TextInput. Its left edge is ~left+69
      // (the yellow focus border starts at x=172 for a window at
      // left=103, measured from the failed run's screendumps);
      // left+50 lands on the `sevyn>` prompt label, ~19px short of
      // the input (nodeId -1 in both failed runs). left+200 is
      // proven: the launch click at left+200 hit the TextInput
      // (nodeId 56) and every command typed after it ran.
      await moveTo(
        clampX(termPos.left + 200),
        clampY(termPos.top + 482),
        shotNow.width,
        shotNow.height,
      );
      await sleep(300);
      await click();
      await sleep(300);
    };
    // Verify focus: type a cheap read-only command and require its
    // EXEC line within 25 s. `browser status` also confirms the CLI
    // path. Without this, a missed focus burns 120 s in the next
    // termCmd — and every step after it.
    // Round 7 (run 43709802164, dbdda2ae): the window was 10 s and
    // the run crashed on it three times in a row — every refocus
    // click LANDED on the TextInput (nodeId 56) and every EXEC
    // arrived, but 15.1–15.3 s after its click (1016055→1031307,
    // 1033113→1048189, 1051215→1066459), past the 10 s window.
    // Round 5 saw the same shape at 15.8 s. The guest is not
    // losing focus late in the run — its EXEC latency grows to
    // ~15 s with Chromium + the Browser app resident — so the
    // window is 25 s: it covers the worst observed latency
    // (15.8 s) with margin, and a genuinely lost focus still
    // fails fast instead of burning 120 s per step. If a future
    // run shows an EXEC later than 25 s, that is new evidence
    // for a late-EXEC re-check, not for another blind extension.
    const verifyFocus = async () => {
      const { exec } = await termCmd(
        "browser status",
        null,
        /EXEC sevyn browser status -> [01]/,
        25000,
      );
      return !!exec;
    };
    // Round 8 (run 43715706248, head 0f82d7d9): wait for a
    // Terminal RELAUNCHED from the dock to become ready — and
    // only then let the caller start a verify window. In the
    // crash run the dock click relaunched Terminal (new pid
    // 1290) and the harness gave up ~3.5 s later, while the
    // fresh app was still loading its bundle and initializing
    // EGL/llvmpipe: the fresh frame showed no header at all
    // (zero #111827 rows over 100px). A verify window started
    // at the dock click expires while the app is still booting,
    // so the clock must restart AFTER readiness: poll fresh
    // frames until the window is frame-proven ready — a strict
    // header the first-attempt gate accepts, or a guarded input
    // row — up to 30 s. A relaunched window is a NEW window, so
    // its header is adopted as termPos outright: the old
    // position cannot constrain it (the consistency jump check
    // is skipped by passing null as `known`). Returns the ready
    // frame, or null on timeout.
    const waitForRelaunchedTerminal = async (timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const frame = await shot(b.qmp, join(OUT, "m13-shot-refocus-fresh.ppm"));
        const header = findWindowHeader(frame, 17, 24, 39);
        if (header && refocusFirstAttemptSafe(header, null, frame.width, frame.height)) {
          termPos = header;
          return frame;
        }
        if (refocusInputPointSafe(termPos, frame, frame.width, frame.height)) {
          return frame;
        }
        if (Date.now() >= deadline) return null;
        await sleep(2000);
      }
    };
    // Round 4: the first-attempt clicks run ONLY when the gate
    // passes (fresh header detected this frame, consistent with the
    // known window, clicks inside the detected rect). When the gate
    // fails the clicks are SKIPPED, not attempted blind — the
    // recovery below is the path for a covered header, and a
    // missing header fails fast at the end instead of clicking
    // bare desktop / the dock (m5 run 43694717554 launched
    // Calendar this way).
    if (refocusFirstAttemptSafe(termFresh, termPos, shotNow.width, shotNow.height)) {
      await clickTitleAndInput();
      if (await verifyFocus()) return true;
      // Round 5 (m13 run 43699446057): a failed verify is NOT
      // proof of lost focus. That run's clicks LANDED on the
      // TextInput (boot log: pointer down (200,482) -> nodeId 56)
      // and the EXEC still arrived — 15.8 s after the click, past
      // the 10 s verify window, because the guest was starved by
      // Chromium's startup. So fall through to the recovery: it
      // re-clicks and re-verifies with a fresh window, once the
      // spike has passed, instead of throwing on the first late
      // EXEC.
    }
    // Round 5 recovery, TWO PHASES — reordered in round 6. Phase
    // 0 (round 6) — guarded input click FIRST: when the current
    // frame proves the Terminal's input row is on screen at the
    // last-known-good point (see refocusInputPointSafe), click it
    // and re-verify — the Terminal is focusable without touching
    // the dock at all. This is the m13 run 43705517505 geometry:
    // the Terminal header was fully covered by the Browser window
    // (phase 1 skipped, no fragment raise point) but its input
    // row showed below the Browser window, so the guard passes
    // there. The dock icon MUST NOT go first: in that run the
    // Terminal was the focused app, and clicking its dock icon
    // HID all windows (the dock toggles the focused app off)
    // instead of raising it — the fresh frame was bare desktop
    // and the guard then correctly refused. The proof must be
    // current: the first-attempt verify can take 25 s, so the
    // guard below runs on a FRESH shot, not shotNow — a stale
    // frame could put the click on a dock icon. Phase 1 — raise:
    // click the centre of the visible Terminal fragment (guarded:
    // inside the known rect, above the dock band) to raise the
    // window; when NO fragment is visible at all (the m5 run
    // 43699446209 frame: bare "Welcome to SevynOS" desktop, no
    // window on screen — a desktop click hid them) raise via the
    // Terminal's dock icon instead. The dock icon runs ONLY when
    // the guard refuses (input row not visible) AND no fragment
    // exists — i.e. the Terminal is verifiably not
    // focused/visible, so the toggle-hide cannot fire. There is
    // no third raise path: a blind click at the last-known-good
    // input point would land on a dock icon (the input row is in
    // the dock's y-band), and a click on bare desktop hides the
    // windows, so neither is ever attempted. Phase 2 — re-derive:
    // take a FRESH settled frame (the raise changes what is on
    // top) and accept its header only when it is consistent with
    // the known window; then click title + input and re-verify.
    // Only if the header is STILL undetectable after the raise
    // does the guarded last-known-good input click run — and only
    // when the fresh frame itself proves the input row is on
    // screen at that point (see refocusInputPointSafe). Anything
    // else fails fast with HARNESS FAILURE, as before.
    const shotRecovery = await shot(b.qmp, join(OUT, "m13-shot-refocus-recovery.ppm"));
    const guardedNow = refocusInputPointSafe(
      termPos,
      shotRecovery,
      shotRecovery.width,
      shotRecovery.height,
    );
    if (guardedNow) {
      await moveTo(guardedNow.x, guardedNow.y, shotRecovery.width, shotRecovery.height);
      await sleep(300);
      await click();
      await sleep(300);
      if (await verifyFocus()) return true;
      // A failed verify after a guarded click is NOT proof of
      // lost focus (round-5 slow-EXEC) — fall through to the
      // raise below, which re-clicks with a fresh window.
    }
    let raised = false;
    let relaunched = false;
    // Round 8: when the strict scan finds no header, the
    // Terminal may still be on screen as a fragment (see
    // refocusFragmentRaisePointPartial) — the crash run's
    // refocus frame shows ~304px of Terminal body at x599-902
    // on rows y492+, with the header covered. The fragment is
    // derived from shotNow, the same frame the strict scan and
    // the dock-icon search use — never from a stale frame.
    const termPartial = findWindowHeaderPartial(shotNow, 17, 24, 39);
    const raisePoint =
      refocusFragmentRaisePoint(termFresh, termPos, shotNow.width, shotNow.height) ??
      refocusFragmentRaisePointPartial(
        termPartial,
        termPos,
        shotNow,
        shotNow.width,
        shotNow.height,
      );
    if (raisePoint) {
      await moveTo(raisePoint.x, raisePoint.y, shotNow.width, shotNow.height);
      await sleep(300);
      await click();
      await sleep(300);
      raised = true;
    } else {
      const dockIcon = findTerminalDockIcon(shotNow, termPos);
      if (dockIcon) {
        // Round 8: record the log position BEFORE the click, so
        // the code below can tell a RELAUNCH (a fresh `APPD
        // launched terminal` line — the app was not running, or
        // the dock launched a new instance) from a plain raise
        // of the running window. A relaunch needs the readiness
        // wait below; a raise does not.
        const dockClickLines = logLines(b.logPath).length;
        await moveTo(dockIcon.x, dockIcon.y, shotNow.width, shotNow.height);
        await sleep(300);
        await click();
        await sleep(1000);
        raised = true;
        relaunched = !!(await waitForLog(
          b.logPath,
          /APPD launched terminal \(pid \d+\)/,
          5000,
          dockClickLines,
        ));
      }
    }
    if (raised) {
      // Round 8: when the dock click relaunched Terminal, do
      // NOT enter the attempt loop yet — the fresh app is still
      // booting, and the loop's two attempts + 25 s verify
      // windows would expire before it paints. Wait for
      // readiness first (up to 30 s); the 25 s verify window in
      // verifyFocus then starts FRESH, after the window is
      // frame-proven ready. A readiness timeout fails fast with
      // its own message, not the generic refocus one.
      if (relaunched) {
        const readyFrame = await waitForRelaunchedTerminal();
        if (!readyFrame) {
          throw new Error(
            "HARNESS FAILURE: refocus failed — Terminal relaunched from the dock but its window never became ready within 30s (no header the first-attempt gate accepts and no guarded input row); the relaunched Terminal never became focusable, so no typed command can run",
          );
        }
      }
      // The window needs a moment to come forward; re-shot once
      // if the first fresh frame still shows no header.
      for (let attempt = 0; attempt < 2; attempt++) {
        const shotFresh = await shot(b.qmp, join(OUT, "m13-shot-refocus-fresh.ppm"));
        const fresh2 = findWindowHeader(shotFresh, 17, 24, 39);
        if (fresh2) {
          const freshInputY = fresh2.top + 482;
          const consistent =
            Math.abs(fresh2.top - termPos.top) <= REFOCUS_JUMP_PX &&
            Math.abs(fresh2.left - termPos.left) <= REFOCUS_JUMP_PX &&
            Math.abs(fresh2.bottom - termPos.bottom) <= REFOCUS_JUMP_PX &&
            Math.abs(fresh2.right - termPos.right) <= REFOCUS_JUMP_PX &&
            freshInputY >= 0 &&
            freshInputY < shotFresh.height &&
            freshInputY <= fresh2.bottom;
          if (consistent) termPos = fresh2;
          if (
            refocusFirstAttemptSafe(fresh2, termPos, shotFresh.width, shotFresh.height)
          ) {
            await clickTitleAndInput();
            if (await verifyFocus()) return true;
          }
        }
        const guarded = refocusInputPointSafe(
          termPos,
          shotFresh,
          shotFresh.width,
          shotFresh.height,
        );
        if (guarded) {
          await moveTo(guarded.x, guarded.y, shotFresh.width, shotFresh.height);
          await sleep(300);
          await click();
          await sleep(300);
          if (await verifyFocus()) return true;
        }
        if (attempt === 0) await sleep(2000);
      }
    }
    throw new Error(
      "HARNESS FAILURE: refocus failed — no fresh Terminal header was detected in the current frame, or `browser status` produced no EXEC line within 25s after the refocus clicks; the Terminal never regained focus, so no typed command can run",
    );
  };
  // Raise Chromium by clicking a VERIFIED page pixel (round 4):
  // the centre of the largest solid run of the viewport colour
  // inside the largest visible fragment (see findSolidRunPoint).
  // A bbox-centre click is wrong for a thin strip (the centre is
  // usually bare desktop). Returns the post-click frame + colour
  // count, or null when the colour is nowhere on screen or forms
  // no solid run — the caller then fails honestly, never clicks.
  const raiseChromium = async (r, g, bl, name) => {
    // Poll for the colour: the page may not have painted yet when
    // the navigation confirms. Retry for ~60s before giving up.
    let before = null;
    let box = null;
    for (let i = 0; i < 12; i++) {
      before = await shot(b.qmp, join(OUT, `m13-shot-${name}-before.ppm`));
      box = findColorBBox(before, r, g, bl);
      if (box) break;
      await sleep(5000);
    }
    if (!box) return null;
    // Click a verified page pixel: the largest solid run of the
    // colour inside the visible fragments (viewport minus the
    // Terminal rect). A fragment centre is still a bbox centre by
    // another name — when the Terminal covers part of the viewport
    // the bbox spans the covered strip too, and stray pixels can
    // inflate it onto bare desktop. No solid run means the raise
    // fails — never click a point that is not Chromium.
    const frags = visibleFragments(box, [termPos], before.width, before.height);
    const run = findSolidRunPoint(before, r, g, bl, frags);
    if (!run) return null;
    await moveTo(run.x, run.y, before.width, before.height);
    await sleep(300);
    await click();
    // The click raises Chromium, but the repaint lags under load:
    // a single frame 1 s after the click can still show the old
    // strip (run 44803329836: green=10704px 2 s after the click,
    // full viewport ~166000px). Poll until the colour fills a real
    // viewport (count + width), up to 60 s — a fast raise still
    // passes on the first frame.
    const polled = await pollPixels(
      b,
      name,
      (img) => {
        const n = countColor(img, r, g, bl);
        if (n <= 40000) return 0;
        const bx = findColorBBox(img, r, g, bl);
        if (!bx || bx.x1 - bx.x0 < RED_MIN_WIDTH_PX) return 0;
        return n;
      },
      60000,
    );
    return { img: polled.img, count: polled.count };
  };
  // Raise Chromium by clicking a CORNER of its visible viewport.
  // Used where the viewport centre is itself clickable (step 5:
  // the link is centred, so raiseChromium's centre click would
  // navigate before the check intends it to). The top-left corner
  // of the blue link page has no link, so the click only raises.
  // Returns the post-click frame + colour count + box, or null
  // when the colour is nowhere on screen.
  const raiseChromiumCorner = async (r, g, bl, name) => {
    let before = null;
    let box = null;
    for (let i = 0; i < 12; i++) {
      before = await shot(b.qmp, join(OUT, `m13-shot-${name}-before.ppm`));
      box = findColorBBox(before, r, g, bl);
      if (box) break;
      await sleep(5000);
    }
    if (!box) return null;
    // Corner click on the largest VISIBLE fragment (viewport minus
    // the Terminal rect), not on the raw bbox corner: a covered
    // top-left corner would put the click inside the Terminal.
    // The offset is clamped inside the fragment, so a narrow
    // fragment still yields a click on Chromium. Round 4: the
    // corner point is VERIFIED to be a page pixel before clicking
    // (a solid page's corner is its own colour; a covered or
    // inflated corner is not) — an unverified corner fails the
    // raise instead of clicking blind.
    const frag = visibleFragment(box, [termPos], before.width, before.height);
    if (!frag) return null;
    const cx = Math.min(frag.x0 + 40, frag.x1);
    const cy = Math.min(frag.y0 + 30, frag.y1);
    if (!pixelMatches(before, cx, cy, r, g, bl)) return null;
    await moveTo(cx, cy, before.width, before.height);
    await sleep(300);
    await click();
    // Same repaint lag as raiseChromium (see above): poll until
    // the colour fills a real viewport, up to 60 s.
    const polled = await pollPixels(
      b,
      name,
      (img) => {
        const n = countColor(img, r, g, bl);
        if (n <= 40000) return 0;
        const bx = findColorBBox(img, r, g, bl);
        if (!bx || bx.x1 - bx.x0 < RED_MIN_WIDTH_PX) return 0;
        return n;
      },
      60000,
    );
    return { img: polled.img, count: polled.count, box };
  };
  // Raise Chromium by clicking a VERIFIED page pixel as seen in a
  // FRESH frame taken immediately before the click. Unlike
  // raiseChromium (which polls a recorded colour until it appears),
  // this one never trusts a bbox recorded steps earlier: windows
  // move mid-run, and both failed runs' strip clicks landed at
  // (400,144) on bare shell background because the viewport rect
  // they used was stale. Each attempt re-shoots and re-derives the
  // bbox from that frame; the click point is the largest solid run
  // of the colour in the latest frame (see findSolidRunPoint).
  // Returns the post-click frame + colour count, or null when the
  // colour is nowhere on screen or forms no solid run.
  const raiseChromiumFresh = async (r, g, bl, name) => {
    let frame = null;
    let box = null;
    for (let i = 0; i < 6; i++) {
      frame = await shot(b.qmp, join(OUT, `m13-shot-${name}-fresh.ppm`));
      box = findColorBBox(frame, r, g, bl);
      if (box) break;
      await sleep(2000);
    }
    if (!box) return null;
    // Round 4: the bbox centre assumed the whole bbox is visible
    // Chromium — the #eeeeee bbox was built from scattered pixels
    // across the whole screen, so its centre (601,400) was bare
    // desktop. The round-2 density gate that used to reject a
    // scattered colour outright is GONE (it also rejected the real
    // strip at density 0.016 — run 43694717539); the solid-run
    // check is the guard now. No solid run means the raise fails.
    const frags = visibleFragments(box, [termPos], frame.width, frame.height);
    const run = findSolidRunPoint(frame, r, g, bl, frags);
    if (!run) return null;
    await moveTo(run.x, run.y, frame.width, frame.height);
    await sleep(300);
    await click();
    // Same repaint lag as raiseChromium (see above): poll until
    // the colour fills a real viewport, up to 60 s.
    const polled = await pollPixels(
      b,
      name,
      (img) => {
        const n = countColor(img, r, g, bl);
        if (n <= 40000) return 0;
        const bx = findColorBBox(img, r, g, bl);
        if (!bx || bx.x1 - bx.x0 < RED_MIN_WIDTH_PX) return 0;
        return n;
      },
      60000,
    );
    return { img: polled.img, count: polled.count };
  };

  // Drag the Browser app window by its title bar (round 6).
  // Returns { before, after } (findWindowHeader rects) or null
  // when the window is not on screen or the drag did not move
  // it. The drag start (left+200, top+22) is empty header space
  // — the window controls sit at right-26 and must never be
  // dragged. `tag` names the diagnostic shots. The caller passes
  // the delta it wants; the window may move less (the pointer
  // clamps at the screen edge, and the compositor may clamp the
  // window to the screen) — what matters is the measured `after`
  // rect, which the caller re-derives from, never the requested
  // delta.
  const dragBrowserWindow = async (dx, dy, tag) => {
    const frame = await shot(b.qmp, join(OUT, `m13-shot-browser-drag-${tag}-before.ppm`));
    // Round 8 (run 43715706248, head 0f82d7d9): strict first,
    // partial fallback — the SAME fallback the after-frame
    // already had. The drag-back's before-frame is taken AFTER
    // Chromium was raised frontmost, so Chromium covers the
    // Browser header (max 120 #0ea5e9 px/row in the crash run's
    // back-before frame) and the strict scan returns null — the
    // round-7 code returned null here and the drag-back never
    // ran at all, leaving the window dragged aside over the
    // Terminal. The partial rect is enough to drag from:
    // dragStartPoint verifies its start pixel (in the crash
    // frame it finds (60,453), a real header pixel).
    const before =
      findWindowHeader(frame, 14, 165, 233) ??
      findWindowHeaderPartial(frame, 14, 165, 233);
    if (!before) return null;
    // Round 7: the drag starts on a VERIFIED header pixel — after
    // Chromium is raised the header is partly covered and the
    // usual start can land inside Chromium. Refuse when no header
    // pixel is verifiable (never drag blind).
    const start = dragStartPoint(frame, before, 14, 165, 233);
    if (!start) return null;
    await dragPointer(
      start.x,
      start.y,
      start.x + dx,
      start.y + dy,
      frame.width,
      frame.height,
    );
    const afterFrame = await shot(
      b.qmp,
      join(OUT, `m13-shot-browser-drag-${tag}-after.ppm`),
    );
    // Round 7: strict first, partial fallback for a window dragged
    // partly off-screen (see findWindowHeaderPartial). A null
    // `after` still means "unverifiable", not "no move" — the
    // caller reports it as such.
    const after =
      findWindowHeader(afterFrame, 14, 165, 233) ??
      findWindowHeaderPartial(afterFrame, 14, 165, 233);
    if (!after) return { before, after: null };
    const moved =
      Math.abs(after.top - before.top) > 10 || Math.abs(after.left - before.left) > 10;
    return moved ? { before, after } : null;
  };

  // Drag the Browser window BACK to where an earlier drag moved it
  // from (round 8: the verified drag-back, extracted here in round
  // 9 so steps 5–6 reuse the exact same loop). `aside` is the
  // { before, after } record of the aside drag; the return is by
  // the ACTUAL move — never the requested delta. The after rect's
  // left edge is screen-clamped (0) when the window was dragged
  // partly off-screen, so a left-edge delta understates the move
  // (dbdda2ae: left 107->0 suggests -107, but the right edge
  // 904->597 proves -307): use the right edge when the left is
  // clamped at 0, else the left edge. Retried up to twice by the
  // measured REMAINING delta, verified against the pre-drag
  // position within REFOCUS_JUMP_PX. Returns { ok, detail,
  // attempts }; a window that never returns is reported by the
  // caller as its own failing check, never silently accepted.
  const dragBrowserBack = async (aside, tagBase) => {
    let backOk = false;
    let backDetail = "";
    let backAttempts = 0;
    let backCur = aside.after;
    for (let attempt = 0; attempt < 3 && !backOk; attempt++) {
      const dxLeft = aside.before.left - backCur.left;
      const dxRight = aside.before.right - backCur.right;
      const dxBack = backCur.left > 0 ? dxLeft : dxRight;
      const dyBack = aside.before.top - backCur.top;
      const back = await dragBrowserWindow(
        dxBack,
        dyBack,
        attempt === 0 ? tagBase : `${tagBase}-retry${attempt}`,
      );
      backAttempts++;
      if (back?.after) {
        backOk = rectsWithin(back.after, aside.before, REFOCUS_JUMP_PX);
        backDetail =
          `attempt ${backAttempts}: ${JSON.stringify(backCur)} -> ` +
          `${JSON.stringify(back.after)} (target ${JSON.stringify(aside.before)})`;
        backCur = back.after;
      } else if (back?.before) {
        // The drag ran but its after-frame shows no header (still
        // covered, or the drag had no effect): the window is where
        // the before frame saw it — retry from there.
        backDetail =
          `attempt ${backAttempts}: no header in the after frame ` +
          `(before ${JSON.stringify(back.before)})`;
        backCur = back.before;
      } else {
        // No header in the before frame either: no position to
        // compute a retry delta from — stop.
        backDetail = `attempt ${backAttempts}: no Browser header in the before frame`;
        break;
      }
    }
    return { ok: backOk, detail: backDetail, attempts: backAttempts };
  };

  // Terminal launch (setup for step 2: every `browser ...` command
  // below is typed into it).
  {
    const launched = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
    check("terminal: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) terminal/,
      60000,
    );
    check("terminal: host ready in its own runtime", !!appReady);
  }
  // The window may not have painted yet when the host is ready
  // (run 44803329836: the check fired 1.1 s after host-ready and
  // saw no header). Poll for the header instead of trusting one
  // frame — a fast paint still passes on the first shot.
  let shotTerm = await shot(b.qmp, join(OUT, "m13-shot-terminal.ppm"));
  let termHeader = findWindowHeader(shotTerm, 17, 24, 39);
  const termHeaderDeadline = Date.now() + 30000;
  while (!termHeader && Date.now() < termHeaderDeadline) {
    await sleep(1000);
    shotTerm = await shot(b.qmp, join(OUT, "m13-shot-terminal.ppm"));
    termHeader = findWindowHeader(shotTerm, 17, 24, 39);
  }
  // The Terminal window header is #111827.
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

  // 2. Embed up: `browser open` the local page launches Chromium;
  // `browser status` must report running=yes over CDP. The Terminal
  // marker carries running + tabs only, so cdp is asserted by
  // entailment: sevyn prints running=yes only after its CDP
  // /json/version probe succeeds — a dead CDP can never produce
  // this line. The gpu value is recorded here (informational: the
  // Browser app has not launched yet, so the marker may not exist
  // until step 4, where it is gated).
  let chromiumViewport = null;
  // No redTabId is kept: under the single-tab contract the tab
  // opened here is closed by the very next warm `browser open`,
  // so any id recorded here would be dead by the time a later
  // step could use it. Steps that need the current tab re-read
  // its id fresh (see currentTabId).
  {
    const { exec } = await termCmd(
      `browser open http://10.0.2.2:${HTTP_PORT}/m5-page.html`,
    );
    check("embed: `browser open` the local page runs (EXEC 0)", !!exec, exec || "");
  }
  {
    const ready = await pollBrowserReady();
    check(
      "embed: Chromium answers CDP after the open (browser status running=yes)",
      !!ready,
      ready || "(browser status never reported running=yes)",
    );
  }
  {
    const gpu = gpuFromLog(b.logPath);
    check(
      "embed: gpu mode recorded at embed-up (informational — fallback is a designed path, not a failure)",
      true,
      gpu
        ? `gpu=${gpu}`
        : "gpu=unreported-yet (Browser app not launched; gated in step 4)",
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
  // refocused. The viewport box is recorded for the example.com step.
  {
    // Round 3 (run 43690022156): polling pixels alone can never
    // pass this gate. Chromium opens BEHIND the Terminal (the
    // Terminal was raised to type `browser open`), so the red
    // viewport shows only as a ~178px sliver past the Terminal's
    // right edge (red bbox x 903-1080) and the 400px width gate
    // never passes, however long the poll runs (180s, red=0px —
    // and no raise was ever attempted: the only click in that
    // window was the refocus fragment click, which raises the
    // TERMINAL). The sliver must be CLICKED to bring Chromium
    // forward: raiseChromium clicks the centre of the visible red
    // fragment (the bbox minus the Terminal rect), so the click
    // lands on Chromium pixels, never the Terminal — a nodeId of
    // -1 for that click is EXPECTED (Chromium is not an RN app, so
    // the host reports no node); the raise is judged by the NEXT
    // shot's pixels, never by nodeId. Up to three raises,
    // re-polling after each; no red at all means the page never
    // painted, and the check fails honestly.
    const redWide = (img) => {
      const n = countColor(img, 255, 0, 0);
      if (n > 40000) {
        const box = findColorBBox(img, 255, 0, 0);
        // Round 2: a 178px sliver of the red page (the part
        // sticking out past the Terminal's right edge) holds
        // 40050 red px — over the bare count threshold — while
        // the page is never actually visible. The visible
        // viewport must be a real window width (full window
        // measures 768), not a sliver.
        if (box && box.x1 - box.x0 + 1 >= RED_MIN_WIDTH_PX) {
          chromiumViewport = box;
          return n;
        }
      }
      return 0;
    };
    let found = await pollPixels(b, "red", redWide, 60000);
    for (let r = 0; r < 3 && !found?.img; r++) {
      // Null when no red is on screen at all: nothing to click, so
      // the next poll just waits for the page to paint.
      await raiseChromium(255, 0, 0, "red");
      found = await pollPixels(b, "red", redWide, 60000);
    }
    check(
      "browser: the local page RENDERS (red viewport on screen)",
      !!found?.img,
      found?.img
        ? `red=${found.count}px`
        : `red=${found?.count ?? 0}px after raises (visible red never reached ${RED_MIN_WIDTH_PX}px wide — a sliver past the Terminal does not count)`,
    );
    // Re-record the viewport from a settled frame: the poll's first
    // over-threshold frame can be a half-painted one. Same width
    // gate — a settled sliver must not replace the good rect.
    if (found?.img) {
      const settled = await shot(b.qmp, join(OUT, "m13-shot-red-settled.ppm"));
      const box = findColorBBox(settled, 255, 0, 0);
      if (box && box.x1 - box.x0 + 1 >= RED_MIN_WIDTH_PX) chromiumViewport = box;
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
  }
  {
    const { exec, hit } = await termCmd(
      "browser status",
      /TERMINAL browser-status running=yes tabs=1/,
    );
    check("browser: `browser status` runs (EXEC 0)", !!exec, exec || "");
    check("browser: Chromium running, 1 tab", !!hit, hit || "");
  }

  // 3b. A real public page over the internet (gated like step 2's
  // internet flag in m5).
  if (INTERNET) {
    {
      const { exec } = await termCmd("browser open https://example.com");
      check("browser: `browser open` example.com runs (EXEC 0)", !!exec, exec || "");
    }
    // The page loads over the internet — give it time, then confirm
    // the title over CDP before looking at pixels.
    await sleep(15000);
    await refocusTerminal();
    let exampleTabId = null;
    {
      const marker = await pollTabsTitle(
        /TERMINAL browser-tabs n=\d+ titles=.*Example Domain/,
      );
      check(
        "browser: CDP sees the Example Domain title",
        !!marker,
        marker || "(no tabs marker with the title)",
      );
      // Explicitly activate the example.com tab. Under the
      // single-tab contract it is the ONLY tab (the open closed
      // the red one), so this is a harmless no-op that exercises
      // the verb — the activation cannot race the load into
      // showing red, because there is no red tab anymore.
      if (marker) {
        const { titles, ids } = parseTabsMarker(marker);
        const idx = titles.findIndex((t) => t.includes("Example Domain"));
        if (idx >= 0 && ids[idx]) exampleTabId = ids[idx];
      }
    }
    if (exampleTabId) {
      const { exec } = await termCmd(`browser activate ${exampleTabId}`);
      check(
        "browser: `browser activate` the example.com tab runs (EXEC 0)",
        !!exec,
        exec || "",
      );
      await sleep(2000);
      await refocusTerminal();
    }
    // Opening a new tab in an already-running Chromium does not raise
    // its window above the Terminal, so a full-screen white poll sees
    // the Terminal instead of the page. Click the visible part of
    // Chromium's viewport to raise it, then count white (same
    // pattern as the IDE step in m5). The click point is re-derived
    // from a FRESH frame immediately before each click
    // (raiseChromiumFresh): the viewport rect recorded in step 3 is
    // stale by now — windows move mid-run (Terminal and Browser
    // both moved between frames in the failed runs) — and both
    // failed runs' strip clicks landed at (400,144) on bare shell
    // background because they used that stale rect. The visible
    // example.com viewport is the #eeeeee solid run in the fresh
    // frame (round 4 — never the bbox centre: the strip's bbox
    // centre was bare desktop in both failed runs); the run is on
    // Chromium wherever the window currently is.
    // M9: scale by the real frame size — the shell flex-sizes to
    // the surface (no longer a fixed 1024x768), so the screen is
    // 1280x800 here; a moveTo scaled for 1024x768 lands ~25% right
    // of the strip and never raises Chromium.
    if (chromiumViewport && termPos) {
      await raiseChromiumFresh(238, 238, 238, "example-raise");
      // If the first click only focused Chromium without raising it
      // above the Terminal, click the fresh centre once more.
      await raiseChromiumFresh(238, 238, 238, "example-raise-2");
      const found = await pollPixels(
        b,
        "example",
        (img) => {
          // example.com's background is #eeeeee (238,238,238), not
          // pure white — count both and take the larger, across the
          // FULL screen (not just the recorded viewport): the window
          // can shift when Chromium is raised for the new tab, so a
          // stale viewport rect would miss the rendered page even
          // though it is on screen.
          const n = Math.max(
            countColor(img, 255, 255, 255),
            countColor(img, 238, 238, 238),
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
    // back to the Terminal so the next open lands in its input.
    await refocusTerminal();
  } else {
    internetSkipped = true;
    check("browser: example.com open SKIPPED (SEVYN_V2_M13_INTERNET=0)", true, "skipped");
    check(
      "browser: example.com render SKIPPED (SEVYN_V2_M13_INTERNET=0)",
      true,
      "skipped",
    );
    check(
      "browser: Example Domain title SKIPPED (SEVYN_V2_M13_INTERNET=0)",
      true,
      "skipped",
    );
  }

  // 4. The Browser app (tabs + address bar) drives the browser:
  // launch it, type the second test page's URL into its address
  // bar, and the green page renders in Chromium. (m5 step 7,
  // verbatim apart from m13 names.)
  const browserLaunchBefore = logLines(b.logPath).length;
  {
    const launched = await appdCmd(b, "LAUNCH browser", /APPD LAUNCH OK browser/);
    check("browser-app: LAUNCH accepted", !!launched, launched || "");
    const appReady = await waitForLog(
      b.logPath,
      /HOST app running \(SEVYNOS_M3_APP_READY\) browser/,
      60000,
    );
    check("browser-app: host ready in its own runtime", !!appReady);
  }
  // Same single-frame hazard as the Terminal header above (the
  // browser header passed this run by only 1.1 s): poll up to 30 s.
  let shotBrowser = await shot(b.qmp, join(OUT, "m13-shot-browser.ppm"));
  let browserHeader = findWindowHeader(shotBrowser, 14, 165, 233);
  const browserHeaderDeadline = Date.now() + 30000;
  while (!browserHeader && Date.now() < browserHeaderDeadline) {
    await sleep(1000);
    shotBrowser = await shot(b.qmp, join(OUT, "m13-shot-browser.ppm"));
    browserHeader = findWindowHeader(shotBrowser, 14, 165, 233);
  }
  // The Browser window header is its registered colour #0ea5e9.
  check("browser-app: window on screen (header found)", !!browserHeader);
  if (browserHeader) {
    // Address input: header (44) + tab strip (36), input centred in
    // its 44px row -> top + 44 + 36 + 22.
    const page2Url = `http://10.0.2.2:${HTTP_PORT}/m5-page2.html`;
    await moveTo(
      browserHeader.left + 200,
      browserHeader.top + 102,
      shotBrowser.width,
      shotBrowser.height,
    );
    await sleep(300);
    await click();
    await sleep(300);
    await typeText(page2Url);
    const before = logLines(b.logPath).length;
    await key("ret");
    // Single-tab contract: the address bar runs `sevyn browser
    // open`, which closes the previous tab — after the navigation
    // there is exactly 1 tab, whatever ran before (red, or
    // example.com when the internet steps ran). But the app logs
    // its tab count exactly ONCE per go(), in the refresh() that
    // runs ~0.1 s after `browser open` returns, and at that
    // instant the count is TRANSIENT, not the steady state (run
    // 43709802164, head dbdda2ae — the same failure as m5's
    // run 43709802296): the warm open creates the new tab and
    // closes the old one, but the close is still in flight when
    // the refresh lists tabs ~140 ms later, so it logs
    // `BROWSER tabs 2` — and never re-logs, although CDP later
    // reports n=1 (TERMINAL browser-tabs n=1 titles=Second
    // Page at 598614). A literal `BROWSER tabs 1` poll therefore
    // waits 60 s for a line the app cannot emit on this build.
    // Gate instead on what the app CAN emit — its own post-go
    // confirmation — and verify the single-tab contract where
    // it IS measurable, in steady state over CDP (the CDP
    // check right after this one, tightened to n=1):
    //   `BROWSER open title=... url=<page2>` (go() matched the
    //   opened tab), or any post-go `BROWSER tabs N` with N>=1
    //   (the refresh ran and saw a live tab list).
    // If no app marker arrives within 15 s, re-go ONCE: click
    // the address bar (the input still holds the URL — go()
    // set it) and press Return. The re-go is a warm open
    // (Chromium is up by then), so its refresh sees a live tab
    // list and go() logs the open line. A re-go cannot produce
    // a stale `tabs 1` by itself — every warm open's refresh
    // samples the transient 2 — which is exactly why the gate
    // accepts the open line, not the count.
    // PRODUCT NOTE (not a harness fix — for the coordinator to
    // dispatch to Browser.tsx): the app's refresh() runs once
    // and never re-samples, so its tab strip shows a stale 0/2
    // until the next user action. Minimal product fix: in go(),
    // after the first refresh(), re-refresh until the opened
    // tab appears in the list (bounded, e.g. ~10 s) — that
    // re-emits `BROWSER tabs 1` in steady state and the literal
    // poll would pass again.
    const appMarkerRe = new RegExp(
      `BROWSER (open title=.* url=${page2Url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|tabs [1-9][0-9]*)`,
    );
    // 60 s (was 15 s): the Browser app's own marker log line lags
    // a slow warm open under load — run 44803329836 burned both
    // waits in full while the navigation itself had succeeded.
    let appMarker = await waitForLog(b.logPath, appMarkerRe, 60000, before);
    let regoed = false;
    if (!appMarker) {
      const shotAgain = await shot(b.qmp, join(OUT, "m13-shot-browser-again.ppm"));
      const headerAgain = findWindowHeader(shotAgain, 14, 165, 233);
      if (headerAgain) {
        regoed = true;
        await moveTo(
          headerAgain.left + 200,
          headerAgain.top + 102,
          shotAgain.width,
          shotAgain.height,
        );
        await sleep(300);
        await click();
        await sleep(300);
        await key("ret");
        appMarker = await waitForLog(b.logPath, appMarkerRe, 60000, before);
      }
    }
    check(
      "browser-app: the address bar opens the second page (BROWSER open line)",
      !!appMarker,
      `${appMarker ?? "(no BROWSER open/tabs marker)"}${regoed ? " (after one re-go)" : ""}`,
    );
    let raised = await raiseChromium(0, 200, 83, "green");
    let greenOk = !!raised && raised.count > 40000;
    let greenDetail = raised ? `green=${raised.count}px` : "no green on screen";
    if (!greenOk) {
      // Round 6 (run 43705517505): no green pixel is on screen
      // at all — NOT a load failure. The Chromium window sits at
      // x~130..900, y~180..490 (its 766x7 tab-strip sliver shows
      // above the Browser header at y185..191) and the Browser
      // window (x107..904, y193..682) covers it entirely, so no
      // green pixel exists to click — raiseChromium can never
      // raise a fully covered window. The app-issued open DID run
      // (EXEC 0, `JS BROWSER open` echoing the green URL); the
      // "(untitled)" tab + URL still in the address bar are
      // stale-app-state symptoms, not a failed navigation. So drag
      // the Browser window aside by its title bar (the m9-proven
      // move drag) to expose the Chromium window underneath,
      // then raise again. The drag is diagonal (-400,+260).
      // Round 7 (run 43709802164, dbdda2ae): the drag DID move
      // the window — header (107,193)-(904,234) -> rows y453..494
      // x0..597 (dx ~-309, dy +260; the pointer clamps at the
      // screen edge, so the window moves less than the requested
      // -400) — but the run still failed here, for TWO reasons
      // the round-6 code did not see:
      //   (a) The drag's own verification re-found the header
      //   with the strict >700px scan, which returns null for a
      //   partly off-screen header (~590px/row), so the code
      //   reported "drag did not move it" and NEVER attempted the
      //   raise — even though the after-frame already exposed
      //   green. dragBrowserWindow now falls back to the partial
      //   header scan (findWindowHeaderPartial) for the after
      //   frame, so the raise runs.
      //   (b) The exposed green is only a 14px strip (10,752px:
      //   green bbox (129,272)-(896,285)) — NOT ~39k px as round
      //   6 estimated. The Browser window is not the only cover:
      //   the Terminal window (top y287) sits over Chromium below
      //   y287, so dragging the Browser window aside can only
      //   expose the strip between Chromium's top (y272) and the
      //   Terminal's top (y287). The strip is the pre-raise
      //   exposure, and the raise is what turns it into proof:
      //   raiseChromium clicks the strip's 768px solid run and
      //   brings Chromium frontmost, so the post-raise frame
      //   shows the full viewport (~168k px). The after-drag gate
      //   below therefore still measures the POST-raise frame at
      //   count > 20000 AND width >= 400 — it is NOT lowered to
      //   ~5,000 for the strip: a 14px strip passing on count
      //   alone would certify the page without ever raising
      //   Chromium, which is weaker proof than the full
      //   viewport. Width >= 400 stays the anti-sliver guard (a
      //   178px sliver fails it, as in step 3).
      // The window is dragged back afterwards so the later steps
      // see it in place (step 8 re-derives the header fresh, so a
      // failed drag-back is noted, not fatal).
      const aside = await dragBrowserWindow(-400, 260, "aside");
      if (aside?.after) {
        const raisedAside = await raiseChromium(0, 200, 83, "green-aside");
        // After-drag gate: the drag exposes a strip of the page,
        // not the full viewport — the 14px strip is 10,752 px —
        // so the gate measures the POST-raise frame (the raise
        // brings the full viewport frontmost, ~168k px), not the
        // strip. Width >= 400 is the anti-sliver guard (a 178px
        // sliver fails it, as in step 3); 20000 px of solid green
        // across a full-window-wide strip is the render proof.
        const asideBox = raisedAside ? findColorBBox(raisedAside.img, 0, 200, 83) : null;
        const asideWide = !!asideBox && asideBox.x1 - asideBox.x0 + 1 >= RED_MIN_WIDTH_PX;
        if (raisedAside && raisedAside.count > 20000 && asideWide) {
          raised = raisedAside;
          greenOk = true;
          greenDetail =
            `green=${raisedAside.count}px after dragging the Browser window aside ` +
            `(${JSON.stringify(aside.before)} -> ${JSON.stringify(aside.after)}, ` +
            `green bbox ${JSON.stringify(asideBox)})`;
        } else {
          greenDetail =
            `no green on screen (Browser window dragged aside ` +
            `${JSON.stringify(aside.before)} -> ${JSON.stringify(aside.after)}; ` +
            `green after drag: ${raisedAside ? `${raisedAside.count}px` : "none"})`;
        }
        // Drag the Browser window back to where it was, by the
        // ACTUAL move (the drag may have been clamped) — never
        // the requested delta. Round 7: the after rect's left
        // edge is screen-clamped (0) when the window was dragged
        // partly off-screen, so a left-edge delta understates the
        // move (dbdda2ae: left 107->0 suggests -107, but the
        // right edge 904->597 proves -307). Use the right edge
        // when the left is clamped at 0, else the left edge.
        // Round 8 (run 43715706248, head 0f82d7d9): VERIFY the
        // drag-back — the round-7 code ran it once and only noted
        // "(Browser window drag-back unverified)" on a passing
        // green check, and the window in fact never moved back at
        // all (see dragBrowserWindow: the strict-only before-scan
        // returned null on the Chromium-covered header, so the
        // drag never ran). The Browser window stayed dragged
        // aside, covered the Terminal, and the next refocus
        // crashed. So the return is verified against the pre-drag
        // position, retried up to twice by the measured REMAINING
        // delta (right edge when the left is screen-clamped at 0,
        // else the left edge — the same rule as the first back
        // delta), and recorded as its own check: a window that
        // has not returned FAILS the drag-back step explicitly
        // instead of the run proceeding to refocus with the
        // Terminal covered and no record of why.
        // Round 9: the verified drag-back loop lives in
        // dragBrowserBack now (steps 5–6 reuse it) — same tags,
        // same deltas, same detail strings as the round-8 inline
        // loop it replaces.
        const back = await dragBrowserBack(aside, "back");
        const backOk = back.ok;
        const backDetail = back.detail;
        const backAttempts = back.attempts;
        check(
          "browser-app: Browser window dragged back to its place after the green raise",
          backOk,
          backOk
            ? `${backDetail} — verified within ${REFOCUS_JUMP_PX}px`
            : `${backDetail} after ${backAttempts} attempt(s) — the window did not return; the Terminal may still be covered`,
        );
      } else {
        greenDetail =
          "no green on screen (Browser window drag did not move it — no header, or the drag had no effect)";
      }
    }
    check("browser-app: the green page renders in Chromium", greenOk, greenDetail);
    await refocusTerminal();
    // Round 7: n=1, not n=\d+ — this is the steady-state
    // single-tab proof (see the tabs check above: the app's own
    // count is transient, so the contract is verified here, over
    // CDP, after the open has settled). The poll retries, so a
    // transient n=2 settles; a stuck n=2 fails honestly as a
    // single-tab violation.
    const greenMarker = await pollTabsTitle(
      /TERMINAL browser-tabs n=1 titles=.*Second Page/,
    );
    check(
      "browser-app: CDP sees the second page's title",
      !!greenMarker,
      greenMarker || "(no tabs marker with the title)",
    );
  } else {
    check(
      "browser-app: the address bar opens the second page",
      false,
      "no Browser window",
    );
    check("browser-app: the green page renders in Chromium", false, "no Browser window");
    check("browser-app: CDP sees the second page's title", false, "no Browser window");
  }
  {
    // The gpu gate: by now the Browser app has mounted and refreshed
    // at least once, so its `BROWSER gpu=` marker must be in the
    // log. Either designed value passes — fallback is a designed
    // path, not a failure — but the value MUST be reported: CI
    // under llvmpipe should show gpu=yes.
    const gpuLine =
      (await waitForLog(
        b.logPath,
        /BROWSER gpu=(yes|fallback)/,
        30000,
        browserLaunchBefore,
      )) ?? null;
    const gpu = gpuLine
      ? gpuLine.match(/BROWSER gpu=(yes|fallback)/)?.[1]
      : gpuFromLog(b.logPath);
    check(
      "browser-app: gpu mode reported (gpu=yes|fallback)",
      gpu === "yes" || gpu === "fallback",
      gpu
        ? `gpu=${gpu}`
        : "no BROWSER gpu= marker in log — expected gpu=yes under llvmpipe",
    );
  }

  // 5. In-page click navigation (NEW — m5 never clicks inside a
  // page): open the BLUE link page, click its centred link, and the
  // tab navigates to the green page. The click point is the blue
  // viewport's bbox centre: the link is flex-centred mid-viewport
  // (see PAGE_LINK), so the bbox centre IS the link centre. The
  // raise uses a corner click, not raiseChromium's centre click —
  // a centre click here would itself hit the link and navigate
  // before the check intends it to. Before clicking, a fresh
  // settled frame must show the blue page frontmost (full window
  // wide, not a covered sliver) — the page is blue precisely so
  // this can be told apart from page A, which is red.
  let linkFrame = null;
  let linkClick = null;
  // Round 9 (run 43720789358, head 242ad0ba): the Browser window's
  // aside record for the steps 5–6 occlusion raise. After step 4's
  // drag-back the Browser window is back on top and the refocus
  // raised the Terminal frontmost, so Chromium sits ENTIRELY
  // behind Browser + Terminal — the 242ad0ba link-before frame has
  // zero blue/red/green pixels in 60 s of polling, and the raise
  // helpers can only click a VISIBLE page pixel, so they can never
  // raise it (chicken-and-egg). The fix reuses step 4's proven
  // move: drag the Browser window aside again (same -400,+260
  // drag) to expose Chromium's top strip — the Browser header is
  // fully visible in the occluded frame (rows y193–234, x107–904),
  // so the drag starts on a verified header pixel — then raise
  // from the exposed strip. The window stays aside through step 6
  // (its chromeless raise needs the same exposure) and is dragged
  // back, verified, after the chromeless measurement, before step
  // 7 — so step 8's close-button click still finds the window in
  // place.
  let aside5 = null;
  {
    await refocusTerminal();
    const { exec } = await termCmd(
      `browser open http://10.0.2.2:${HTTP_PORT}/m13-link.html`,
    );
    check("link-nav: `browser open` the link page runs (EXEC 0)", !!exec, exec || "");
  }
  await refocusTerminal();
  {
    const marker = await pollTabsTitle(
      /TERMINAL browser-tabs n=\d+ titles=.*SevynOS M13 Link Page/,
    );
    check(
      "link-nav: CDP sees the link page's title",
      !!marker,
      marker || "(no tabs marker with the link title)",
    );
  }
  {
    // Round 9: drag the Browser window aside FIRST — with Chromium
    // fully occluded there is no visible blue pixel to raise from,
    // and raiseChromiumCorner would poll 60 s and fail. The drag
    // is the same one step 4 uses; if it cannot start (no header)
    // the raise below still runs and fails explicitly, exactly as
    // before — the drag is never a silent precondition.
    aside5 = await dragBrowserWindow(-400, 260, "aside-link");
    const raised = await raiseChromiumCorner(0, 0, 255, "link");
    check(
      "link-nav: the link page's blue viewport is on screen",
      !!raised && raised.count > 40000,
      raised
        ? `blue=${raised.count}px` +
            (aside5?.after
              ? ` (Browser window dragged aside ${JSON.stringify(aside5.before)} -> ${JSON.stringify(aside5.after)} to expose Chromium)`
              : " (no aside drag — Browser window header not found)")
        : "no blue on screen",
    );
    if (raised) {
      // Frontmost assert, from a fresh settled frame taken after
      // the raise: the full blue window is 768 wide (measured
      // 768x225, step 6), while a Terminal-covered sliver is only
      // ~178 wide — width >= 400 separates the two. The click
      // point is the centre of THIS bbox, not the raise frame's.
      const settledLink = await shot(b.qmp, join(OUT, "m13-shot-link-settled.ppm"));
      const linkBox = findColorBBox(settledLink, 0, 0, 255);
      const linkWide = !!linkBox && linkBox.x1 - linkBox.x0 + 1 >= 400;
      check(
        "link-nav: the blue link page is frontmost (full window in a fresh settled frame)",
        linkWide,
        linkBox ? `blue bbox ${JSON.stringify(linkBox)}` : "no blue on screen",
      );
      if (linkBox) {
        // Round 7 (run 43709802164, dbdda2ae): the round-4
        // single-pixel verification rejected a GOOD click point.
        // The blue bbox was exactly the Chromium window
        // (129,272)-(896,490), so its centre (513,381) IS the
        // flex-centred link's centre — but the check failed
        // instantly (same timestamp as the frontmost check, no
        // click attempted) because that one pixel was neither
        // pure blue nor pure white at tol 10: the centre falls
        // inside a glyph, where the pixel can be an antialiased
        // blend of the two. A single pixel is the wrong
        // instrument for "is this point on the page" — verify
        // the NEIGHBOURHOOD instead, and prove the link text
        // itself rendered (white pixels inside the blue
        // viewport — the page is blue except for the white link,
        // so >=500 white px means the link is really there; the
        // mouse cursor contributes only ~100-200). An inflated
        // bbox (stray blue pixels) would still put the centre on
        // bare desktop, where the neighbourhood check fails, so
        // the navigation still fails honestly instead of
        // clicking blind.
        const cx = Math.round((linkBox.x0 + linkBox.x1) / 2);
        const cy = Math.round((linkBox.y0 + linkBox.y1) / 2);
        const linkText = countColor(settledLink, 255, 255, 255, 10, {
          x0: linkBox.x0,
          y0: linkBox.y0,
          x1: linkBox.x1 + 1,
          y1: linkBox.y1 + 1,
        });
        const around = (x, y) => {
          const box = {
            x0: Math.max(0, x - 5),
            y0: Math.max(0, y - 5),
            x1: Math.min(settledLink.width, x + 6),
            y1: Math.min(settledLink.height, y + 6),
          };
          const area = (box.x1 - box.x0) * (box.y1 - box.y0);
          const page =
            countColor(settledLink, 0, 0, 255, 10, box) +
            countColor(settledLink, 255, 255, 255, 10, box);
          return area > 0 && page / area >= 0.5;
        };
        if (linkText >= 500 && around(cx, cy)) {
          linkFrame = settledLink;
          linkClick = { x: cx, y: cy };
        }
      }
    }
  }
  let navResult = null;
  if (linkClick && linkFrame) {
    await moveTo(linkClick.x, linkClick.y, linkFrame.width, linkFrame.height);
    await sleep(300);
    await click();
    await sleep(2000);
    navResult = await pollTabsTitleCount("Second Page", 1, 6);
    if (!navResult || navResult.n < 1) {
      // One re-click at a slightly different offset, still on the
      // link (the 48px "Go to green page" run is ~380px wide, so
      // +60px in x stays on the anchor). No further retries: if
      // the click misses twice, the check fails honestly.
      await moveTo(linkClick.x + 60, linkClick.y, linkFrame.width, linkFrame.height);
      await sleep(300);
      await click();
      await sleep(2000);
      navResult = await pollTabsTitleCount("Second Page", 1, 4);
    }
  }
  check(
    "link-nav: clicking the link navigates the tab (CDP title 'Second Page' in the only tab)",
    !!navResult && navResult.n >= 1,
    navResult
      ? `titles=${navResult.titles.join("|")}`
      : "no click point (link page never rendered) or no tabs marker",
  );
  {
    const raised = await raiseChromium(0, 200, 83, "green-link");
    check(
      "link-nav: the green page renders after the click",
      !!raised && raised.count > 40000,
      raised ? `green=${raised.count}px` : "no green on screen",
    );
  }

  // 6. Chromeless heuristic (NEW): the red viewport's bbox must be
  // short and wide — height in [150, 360] AND aspect width/height
  // >= 2.0.
  //   Probe (run 43676257443's artifacts: m13-check.json,
  //   m13-boot-1.log, /tmp/ppm13/*.ppm — all frames 1280x800):
  //   the launched app-mode window is 800x348, but the visible
  //   Chromium window is 768x225 — red bbox (313,318)-(1080,542),
  //   stable across frames, aspect 768/225 = 3.41. Only Chromium
  //   is small: the Browser app window is 798 wide (header
  //   (107,193)-(904,233)) and the Terminal is 800 wide, so this
  //   is NOT a systematic compositor/display shrink (that would
  //   scale every window by one factor); it is specific to the
  //   Chromium window. The [150, 360] height band plus aspect
  //   >= 2.0 still rules out the old chromed viewport (~420 tall,
  //   aspect ~1.9): a chromed window would fail the aspect bound
  //   even if its height fell in the band. Do NOT just widen
  //   [320, 360] — the measured 225px is outside it for a reason
  //   (the window itself renders smaller than launched), and a
  //   widened height-only band would admit the chromed viewport.
  //   The measurement is taken on a settled frame after raising
  //   Chromium, so the window is frontmost; partial occlusion
  //   would shrink the bbox and fail honestly. A fresh `browser
  //   open` of the red page precedes the measurement so the
  //   visible viewport is red. The measured size is emitted as a
  //   diagnostic line in the check detail.
  {
    await refocusTerminal();
    const { exec } = await termCmd(
      `browser open http://10.0.2.2:${HTTP_PORT}/m5-page.html`,
    );
    check(
      "chromeless: `browser open` the red page again runs (EXEC 0)",
      !!exec,
      exec || "",
    );
  }
  // The width-gated render assert runs AFTER the raise below, on
  // the settled frame: while the Terminal is frontmost (this poll
  // runs right after refocusTerminal) the red page shows only as a
  // sliver, so a width gate on the pre-raise poll would spin 180 s
  // and fail even though the page rendered. The poll is liveness
  // only; the "renders again" check gates on the settled width.
  let redChromePoll = null;
  {
    const found = await pollPixels(
      b,
      "red-chrome",
      (img) => {
        const n = countColor(img, 255, 0, 0);
        return n > 40000 ? n : 0;
      },
      180000,
    );
    redChromePoll = found;
  }
  let chromeWidth = null;
  let chromeHeight = null;
  let chromeBox = null;
  {
    const raised = await raiseChromium(255, 0, 0, "red-chrome");
    if (raised) {
      const settled = await shot(b.qmp, join(OUT, "m13-shot-red-chrome-settled.ppm"));
      const box = findColorBBox(settled, 255, 0, 0);
      if (box) {
        chromeBox = box;
        chromeWidth = box.x1 - box.x0 + 1;
        chromeHeight = box.y1 - box.y0 + 1;
      }
    }
  }
  // Round 2: the pre-raise sliver alone (40050 red px in 178px)
  // passed the old bare-count render assert while the page was
  // never visible. The settled viewport must be a real window
  // width (full window measures 768).
  check(
    "chromeless: the red page renders again",
    chromeWidth !== null && chromeWidth >= RED_MIN_WIDTH_PX,
    chromeWidth !== null
      ? `red viewport ${chromeWidth}x${chromeHeight} ${JSON.stringify(chromeBox)}`
      : `red=${redChromePoll?.count ?? 0}px in the pre-raise poll, no raisable red viewport after 180s`,
  );
  const chromeAspect =
    chromeWidth !== null && chromeHeight ? chromeWidth / chromeHeight : null;
  check(
    "chromeless: viewport is app-mode content (short + wide), not chromed (~420 tall, aspect ~1.9)",
    chromeHeight !== null &&
      chromeHeight >= 150 &&
      chromeHeight <= 360 &&
      chromeAspect !== null &&
      chromeAspect >= 2.0,
    chromeHeight !== null
      ? `measured Chromium window ${chromeWidth}x${chromeHeight} aspect=${chromeAspect.toFixed(2)} (launched 800x348) ${JSON.stringify(chromeBox)}`
      : "no red bbox (page never rendered)",
  );
  // Round 9: drag the Browser window back after the steps 5–6
  // occlusion raise (same verified dragBrowserBack as step 4) —
  // steps 7–8 need it in place, and step 8's close-button click
  // re-derives its header fresh. A window that never returns
  // FAILS this check explicitly instead of the run proceeding
  // with the Terminal covered and no record of why. When no aside
  // drag ran (Chromium was raisable without one) there is nothing
  // to return; when the aside drag ran but its after-frame showed
  // no header, there is no verified position to drag back from,
  // and that fails explicitly too.
  {
    let back5Ok = true;
    let back5Note = "no aside drag ran (Chromium was raisable without one)";
    if (aside5?.after) {
      const back5 = await dragBrowserBack(aside5, "back-link");
      back5Ok = back5.ok;
      back5Note = back5.ok
        ? `${back5.detail} — verified within ${REFOCUS_JUMP_PX}px`
        : `${back5.detail} after ${back5.attempts} attempt(s) — the window did not return; the Terminal may still be covered`;
    } else if (aside5) {
      back5Ok = false;
      back5Note =
        "aside drag ran but its after-frame showed no Browser header — no verified position to drag back from";
    }
    check(
      "link-nav/chromeless: Browser window dragged back after the occlusion raise",
      back5Ok,
      back5Note,
    );
  }

  // 7. Close-tab (was: tab switching — CANNOT work under the
  // single-tab contract: the red tab from step 3 was closed when
  // example.com opened, and every open since replaced the tab
  // again; there is no first tab left to switch back to). Close
  // the current (only) tab — its id is re-read fresh here, never
  // carried across steps — and assert `browser tabs` reports 0
  // tabs. Whether Chromium stays running with zero tabs is
  // RECORDED, not asserted: closing the last tab may leave it
  // running with an empty tab list, or stop it outright.
  {
    const tabId = await currentTabId();
    check(
      "tabs: current tab id re-read fresh (single-tab: earlier ids are stale)",
      !!tabId,
      tabId || "(no tabs marker — Chromium may already be gone)",
    );
    if (tabId) {
      await refocusTerminal();
      const { exec } = await termCmd(`browser close ${tabId}`);
      check("tabs: `browser close` the current tab runs (EXEC 0)", !!exec, exec || "");
      const zero = await pollTabsZero();
      check(
        "tabs: closing the last tab empties the browser (browser tabs n=0)",
        !!zero,
        zero || "(browser tabs never reported n=0)",
      );
      await refocusTerminal();
      const { hit: statusHit } = await termCmd(
        "browser status",
        /TERMINAL browser-status running=(yes|no)/,
        /EXEC sevyn browser status -> [01]/,
        20000,
      );
      const runningAfterClose = statusHit?.match(/running=(yes|no)/)?.[1] ?? "unknown";
      check(
        "tabs: Chromium liveness after the last tab closes (recorded — either outcome is accepted)",
        true,
        `running=${runningAfterClose} (${
          runningAfterClose === "no"
            ? "closing the last tab stopped Chromium"
            : runningAfterClose === "yes"
              ? "Chromium still running with 0 tabs"
              : "no status marker — could not be determined"
        })`,
      );
    } else {
      check("tabs: `browser close` the current tab runs (EXEC 0)", false, "no tab id");
      check(
        "tabs: closing the last tab empties the browser (browser tabs n=0)",
        false,
        "no tab id",
      );
      check(
        "tabs: Chromium liveness after the last tab closes (recorded — either outcome is accepted)",
        true,
        "running=unknown (no tab id to close)",
      );
    }
  }

  if (timedOut()) {
    finish(false, { timeout: true });
    return;
  }

  // 8. Lifecycle (NEW): close the Browser app, and Chromium must
  // die with it (`sevyn browser quit` runs when the app closes).
  // The close-button click is tried first — it exercises the real
  // path (the in-app X → `sevyn browser quit` → Sevyn.closeApp())
  // — and appd CLOSE is the fallback when the click misses. appd
  // CLOSE is the more reliable primitive (a control-serial command,
  // no pixel coordinates), but it does not exercise the app's own
  // teardown, so the click goes first and the fallback is noted
  // in the check detail when it runs. Either close path must leave
  // Chromium actually stopped: the in-app path is proven by the
  // `EXEC sevyn browser quit -> 0` line in the serial log, and
  // both paths are proven by `browser status` reporting
  // running=no. (The appd-CLOSE fallback kills Chromium via the
  // parallel appd fix; before it, closing by appd CLOSE left
  // Chromium running and this step failed.)
  //   Close-button geometry: the header is 44px tall with 12px
  //   right padding; the close Pressable is the last 28px button
  //   in the header row, so its centre is (right - 12 - 14,
  //   top + 22) = (right - 26, top + 22). The header is derived
  //   from a FRESH SETTLED frame immediately before the click —
  //   windows move mid-run, so a header found steps earlier can
  //   point at bare shell.
  let closedHow = null;
  let closeNote = "";
  const closeBefore = logLines(b.logPath).length;
  {
    const settledClose = await screenSettled(b);
    const browserHeader2 = settledClose
      ? findWindowHeader(settledClose, 14, 165, 233)
      : null;
    if (browserHeader2) {
      await moveTo(
        browserHeader2.right - 26,
        browserHeader2.top + 22,
        settledClose.width,
        settledClose.height,
      );
      await sleep(300);
      await click();
      // Round 9 (run 43720789358, head 242ad0ba): the click WORKED
      // but the check failed anyway — the quit-Chromium-then-close
      // path takes longer than 1 s, so the single +1 s frame still
      // showed the window (`m13-shot-close-after.ppm`: cursor on
      // the X, window still present) and the code declared a miss.
      // The boot log proves the click: `[1180749] EXEC sevyn
      // browser quit -> 0` and `[1181080] HOST app exiting`, and
      // the final frame confirms the window is gone. So poll for
      // the window's disappearance (bounded, up to 10 s) instead
      // of one +1 s shot — gone means BOTH the strict and the
      // partial header scans find nothing, so a partly-covered
      // header is never mistaken for a closed window. The close
      // still fails explicitly when the window is still present
      // after the poll.
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) {
        await sleep(1000);
        const shotAfter = await shot(b.qmp, join(OUT, "m13-shot-close-after.ppm"));
        gone =
          !findWindowHeader(shotAfter, 14, 165, 233) &&
          !findWindowHeaderPartial(shotAfter, 14, 165, 233);
      }
      if (gone) {
        closedHow = "close-button click";
      } else {
        closeNote =
          "close-button click did not close the window within 10s; falling back to appd CLOSE";
        const closeOk = await appdCmd(b, "CLOSE browser", /APPD CLOSE OK browser/);
        if (closeOk) {
          closedHow = "appd CLOSE browser (fallback — close click missed)";
        } else {
          // Round 9 race: the click DID work (the quit line ran)
          // but the app exited between the last poll shot and the
          // fallback, so appd reports `APPD CLOSE FAIL browser
          // not-running` — that is already-closed, not a failed
          // close. Both halves are required: the quit line proves
          // the in-app teardown ran, and the not-running line
          // proves the fallback found nothing left to close. A
          // not-running without a quit line still fails below.
          const quitLine = await waitForLog(
            b.logPath,
            /EXEC sevyn browser quit -> 0/,
            2000,
            closeBefore,
          );
          const notRunning = await waitForLog(
            b.logPath,
            /APPD CLOSE FAIL browser not-running/,
            2000,
            closeBefore,
          );
          if (quitLine && notRunning) {
            closedHow =
              "close-button click (appd CLOSE reported not-running — already closed)";
            closeNote =
              "close-button click closed the app; the appd CLOSE fallback raced the exit (not-running)";
          }
        }
      }
    } else {
      closeNote = "Browser window not found in screendump; trying appd CLOSE";
      const closeOk = await appdCmd(b, "CLOSE browser", /APPD CLOSE OK browser/);
      if (closeOk) closedHow = "appd CLOSE browser (fallback — window not found)";
      else closedHow = "window already gone (appd CLOSE not accepted)";
    }
  }
  check(
    "lifecycle: Browser app closed",
    !!closedHow,
    (closedHow || "could not close the Browser app") +
      (closeNote ? ` — ${closeNote}` : ""),
  );
  // Round 9: closedHow may carry a suffix now (the not-running
  // race above) — the quit-line proof still applies to any
  // close-button path.
  if (closedHow?.startsWith("close-button click")) {
    // The in-app path: the app's close button runs `sevyn browser
    // quit` (via the host exec bridge, which logs the EXEC line)
    // before closing itself. The line must appear after the close
    // started — a missing line means the teardown did not quit
    // Chromium, even if the window is gone.
    const quitLine = await waitForLog(
      b.logPath,
      /EXEC sevyn browser quit -> 0/,
      30000,
      closeBefore,
    );
    check(
      "lifecycle: the in-app close ran `sevyn browser quit` (EXEC 0)",
      !!quitLine,
      quitLine ||
        "(no EXEC sevyn browser quit -> 0 line after the close — the app's teardown did not quit Chromium)",
    );
  } else {
    // The appd-CLOSE fallback runs no `sevyn browser quit` — the
    // quit line is not expected on this path; the running=no poll
    // below is the whole proof (the appd fix kills Chromium).
    check(
      "lifecycle: in-app quit line N/A (appd CLOSE fallback — no `sevyn browser quit` runs on this path)",
      true,
      closedHow || "Browser app never closed",
    );
  }
  {
    // pollBrowserStopped refocuses the Terminal (fresh termPos)
    // before every attempt: the close above may have restacked
    // the windows.
    const stopped = await pollBrowserStopped(60000);
    check(
      "lifecycle: Chromium died with the app (browser status running=no within 60s)",
      !!stopped.hit,
      stopped.hit ||
        (stopped.sawExec
          ? "(browser status still reported running=yes after 60s)"
          : "HARNESS FAILURE: `browser status` produced no EXEC line at all — the command never ran (Terminal focus lost?)"),
    );
  }

  // 9. Shell intact at end + clean poweroff.
  const shotFinal = join(OUT, "m13-shot-final.ppm");
  const imgFinal = await shot(b.qmp, shotFinal);
  const fTop = countColor(imgFinal, 21, 21, 28, 10, {
    x0: 0,
    y0: 0,
    x1: imgFinal.width,
    y1: 48,
  });
  const fDock = countColor(imgFinal, 57, 57, 59, 10, {
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
      gpu: gpuFromLog(b.logPath) ?? "unreported",
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
  writeFileSync(join(OUT, "m13-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "M13 CHECK PASSED" : "M13 CHECK FAILED");
  try {
    if (currentBoot) closeBoot(currentBoot);
  } catch {}
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("M13 check crashed:", e);
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
    writeFileSync(join(OUT, "m13-check.json"), JSON.stringify(result, null, 2));
  } catch {}
  process.exit(1);
});
