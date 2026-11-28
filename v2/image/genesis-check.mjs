#!/usr/bin/env node
// Genesis check: boot the standalone SevynOS image in QEMU and prove
// the Stage 3 acceptance set — the Genesis compositor as the only
// compositor, no Weston, no X, no parent.
//
//   Fork: this check is forked from v2/image/m1-check.mjs and
//   v2/image/m13-check.mjs (same harness shape: QEMU guest boot,
//   QMP input + screendump pixel proofs, control serials, step
//   pass/fail lines, genesis-check.json). The compositor markers it
//   asserts are the ones the standalone run #8 proved
//   (compositor/tests/standalone-check.sh, 2026-11-20); the
//   Terminal/appd/EXEC driving is m13's.
//
//   1. Standalone boot: SEVYN READY backend=drm renderer=gles, one
//      output in native mode, socket up <= 2 s, first frame <= 3 s.
//   2. Shell + one real RN app (Terminal) inside Genesis: the shell
//      mounts (SEVYNOS_M2_READY), the desktop paints (top bar +
//      dock), frames flow (GENESIS fps sample + the desktop repaints
//      for the Terminal launch). An idle desktop is pixel-identical
//      5 s apart — the shell clock resyncs hourly via setTimeout,
//      there is no per-second tick — so two idle screendumps cannot
//      prove liveness; the launch repaint is the proof.
//   3. Memory: steady-state RSS of sevyn-compositor with Shell +
//      Terminal up and idle, <= 200 MB (from the GENESIS RSS console
//      line — see the builder contract below).
//   4. Pointer/keyboard routing: the pointer focus token follows
//      the pointer between the Shell and the Terminal window
//      (two distinct surfaces: the shell layer reports
//      `layer=sevyn-shell`, the Terminal its registry id). The
//      Shell point is the AI button (a Pressable, so inside the
//      shell surface's input region); the bare top bar is the
//      opposite case — the host deliberately leaves it out of
//      the region (#179), so a point on the bar's empty stretch
//      hits no surface at all and is asserted as fall-through
//      (no POINTER FOCUS, click reaches (none)). Clicks and keys
//      land on the surface under the pointer (SEVYN POINTER
//      BUTTON / SEVYN KEY with the matching focus); a key over
//      the shell reports focus=(none) (the KEY marker only
//      prints the numeric registry id, which is None for layer
//      focus). Typing `net status` in the Terminal produces its
//      EXEC line (the prompt already supplies the `sevyn`
//      prefix — typing it doubles it and the command fails).
//   5. Focus + close: clicking the Terminal moves keyboard focus to
//      it (SEVYN FOCUS KEYBOARD); keyboard focus is moved to the
//      Shell first, so the click is a real change and the marker
//      must fire — it only fires on change. appd CLOSE ends its
//      session (SEVYN SESSION STOPPED reason=disconnected — appd
//      only SIGTERMs the app, so Genesis drops the record on
//      client disconnect, never reason=closed), its window leaves
//      the screen, and the Shell survives.
//   6. Move/resize follow: dragging the Terminal title bar moves
//      its window (measured header rect before/after, dragged back
//      after); dragging its right edge resizes it (header width +
//      a new SEVYN SURFACE COMMITTED size, restored after). The
//      window rect is measured with a tight (±2) colour tolerance:
//      the shell wallpaper colour #111320 sits inside the old ±10
//      tolerance of the header colour #111827 and inflates the rect
//      to 985 wide.
//   7. Recovery console: a second boot with sevyn.recovery=1 prints
//      the recovery marker, never prints SEVYN READY (the
//      compositor is skipped entirely), and the sevyn CLI answers
//      (`sevyn net status` prints an interface line) on the serial
//      console.
//   8. Pixman fallback: a third boot with sevyn.pixman=1 attempts
//      the --no-gles path. On the virtual DRM devices available in
//      CI this is NOT PROVEN (Mesa GBM reports every buffer
//      Invalid on vkms/virtio-gpu — standalone run #8 evidence),
//      and the check says so as an explicit WARN, recorded in
//      genesis-check.json as pixman=NOT_PROVEN, never a silent pass
//      and never hidden. Real-GPU proof is owed (GF65).
//   9. Clean exit: POWEROFF powers the guest off, QEMU exits, no
//      SEVYN CRASH anywhere, no orphaned QEMU process.
//
// The m12 regression does NOT run as a separate script on this
// image: m12-check.mjs asserts the Weston stack (GENESIS weston
// renderer=gl, host EGL init, GPU present path), which this image
// has no longer — Weston is intentionally absent. The m12
// behaviours that survive the switch (shell mounts, desktop
// paints, frames flow, a real app launches) are re-proven here in
// steps 2–3, which is the m12 regression in substance for this
// image.
//
// What this check cannot prove in CI (all GF65 / real hardware):
// Pixman presenting a frame (see step 8); the real Shell/RN apps
// on real hardware (QEMU proves function, not the GF65's
// behaviour); the 60 fps bar (QEMU cannot prove frame rate — the
// fps number is a liveness signal only, never asserted); dmabuf
// (no dmabuf path exists on virtio-gpu dumb buffers); input
// latency; VT-switch re-activation (no VT switch is exercised).
//
// Builder contract — the console lines this check depends on the
// image's init (v2/image/build-genesis-image.sh) to produce. If a
// line is missing the step fails (or warns, where marked) naming
// the line, so a builder gap is visible, never silently waived:
//   * The compositor's stdout goes to the serial console
//     (/dev/console), so every SEVYN marker is in the boot log.
//     Its stderr goes to /tmp/genesis-stderr.log in the guest and
//     its diag lines to /tmp/genesis.log — NEITHER reaches the
//     console, so the check cannot read a diag line from the boot
//     log (see the Pixman step: the console alone cannot
//     distinguish a new first-frame failure from the known
//     environmental one; /tmp/genesis.log is preserved to
//     /data/logs/ only when the compositor exits or recovery runs).
//   * SEVYN READY ... backend=drm renderer=gles|pixman
//     output=<WxH>@<refresh> socket_up_ms=<N> — the compositor's
//     own marker; socket_up_ms / first_frame_ms are the budgets.
//   * SEVYNOS_M2_READY — the shell host's mount line (as m13).
//   * GENESIS fps ... — the host presenter's fps sample (as m13);
//     asserted to exist, its value never asserted.
//   * GENESIS RSS <kib> — printed by init at least every 60 s
//     while the compositor runs (the compositor process's RSS in
//     KiB). The check uses the first sample after the Terminal is
//     up and idle. NEW in this image: no sevyn verb reports a
//     process's RSS, and statusd has no such verb either, so init
//     must print it. VERIFIED GAP (2026-11-26): the builder as
//     written prints no RSS line anywhere, so the memory step
//     FAILS naming the missing line until the builder adds it.
//   * SEVYN RECOVERY ... — printed by init when it enters the
//     recovery console (sevyn.recovery=1), before the shell prompt.
//     VERIFIED: the builder prints "SEVYN RECOVERY READY (sevyn
//     CLI available; ...)".
//   * sevyn.pixman=1 on the kernel cmdline makes init pass
//     --no-gles to sevyn-compositor. If the flag is not honored
//     the Pixman step records NOT_PROVEN with that reason.
//     VERIFIED GAP (2026-11-26): the builder as written has no
//     sevyn.pixman=1 handling, so the Pixman step is expected to
//     record NOT_PROVEN ("flag not honored") until the builder
//     adds the flag.
//   * The data disk is built by make-data-disk.py (slot A = the
//     built image), as m13-check does; the check boots
//     $OUT/vmlinuz + $OUT/initramfs.cpio.gz directly with the data
//     disk attached, as m1-check does.
//
// Usage: node v2/image/genesis-check.mjs
// Env: SEVYN_V2_BUILD_DIR (default v2/image/build),
//      SEVYN_V2_GENESIS_TIMEOUT (seconds, default 3600),
//      SEVYN_V2_QEMU (default qemu-system-x86_64),
//      SEVYN_V2_ACCEL (default tcg; kvm on a box with /dev/kvm).
import { spawn, execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SEVYN_V2_BUILD_DIR || join(ROOT, "image", "build");
const DISK = join(OUT, "genesis-data.img");
const TIMEOUT_S = Number(process.env.SEVYN_V2_GENESIS_TIMEOUT || 3600);
const QEMU = process.env.SEVYN_V2_QEMU || "qemu-system-x86_64";
// QEMU accelerator: "tcg" in the sandbox (no /dev/kvm), "kvm" on a
// box with real KVM.
const ACCEL = process.env.SEVYN_V2_ACCEL || "tcg";

// Performance budgets (COMPOSITOR_PLAN.md, "Performance budget";
// ACCEPTANCE.md). A missed budget FAILS the check — a stage that
// misses a budget does not ship until the budget is met or Kevon
// explicitly re-scopes it.
const SOCKET_UP_BUDGET_MS = 2000;
const FIRST_FRAME_BUDGET_MS = 3000;
const RSS_BUDGET_MB = 200;

// Shell / Terminal colours (as m13-check; the same shell + apps).
const TOP_BAR_RGB = [21, 21, 28];
const DOCK_RGB = [52, 54, 59];
const TERM_HEADER_RGB = [17, 24, 39];
const TERM_INPUT_RGB = [31, 41, 55];
// Colour-match tolerance for the Terminal window. The shell
// wallpaper colour #111320 (17,19,32) sits inside the old ±10 of
// the header colour #111827 (17,24,39) — |19-24|=5, |32-39|=7 —
// and inflates the measured rect to 985 wide and 511 tall (the
// wallpaper band keeps rows matching down to y=559). ±2 excludes
// it (|5|>2, |7|>2) while the window itself is exactly #111827.
const TERM_MATCH_TOL = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1) + "s";

const checks = [];
const warnings = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} [${elapsed()}] ${name}${detail ? " — " + detail : ""}`,
  );
  return ok;
}
// A WARN step is recorded, printed, and carried in the JSON, but
// does not fail the run. Used ONLY for the Pixman fallback, which
// the virtual DRM devices in CI cannot prove (see step 8): warning
// explicitly is the plan's "a stage that cannot meet an item says
// so" rule. Anything else that cannot meet its item FAILS.
function warn(name, detail = "") {
  checks.push({ name, ok: true, warn: true, detail });
  warnings.push({ name, detail });
  console.log(`WARN [${elapsed()}] ${name}${detail ? " — " + detail : ""}`);
  return true;
}

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
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
  // Only complete lines are returned. The log is a live-growing file
  // fed by the guest's serial console (console=ttyS0, -serial stdio):
  // a long marker takes milliseconds to arrive over the emulated
  // UART, and the 200 ms poll in waitForLog can catch one mid-flight.
  // That is what killed the genesis-check READY step — waitForLog
  // matched "SEVYN READY ... output=1280x800@75" before the rest of
  // the marker arrived, the parse regex failed, and the boot was
  // closed, so the artifact log ends mid-line with no trailing "\n".
  // Drop the last element unconditionally: it is "" when the file
  // ends in "\n" (the m1-check lesson: without this, waitForLog(...,
  // before) skips the first line appended after `before` was
  // captured), and it is the partial line still being written when
  // the file does not end in "\n" — it appears as a complete line on
  // the next poll. A marker assertion must only ever see whole lines.
  const lines = readLog(path).split("\n");
  if (lines.length > 0) lines.pop();
  return lines;
}

function logHas(path, pattern) {
  return pattern.test(readLog(path));
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

// First SEVYN marker line matching `pattern` at or after line
// `sinceLines`, or null. Unlike waitForLog this scans the log as it
// already stands (for markers that must already be present).
function findLog(path, pattern, sinceLines = 0) {
  const lines = logLines(path);
  for (let i = sinceLines; i < lines.length; i++) {
    if (pattern.test(lines[i])) return lines[i];
  }
  return null;
}

// --- PPM parsing + pixel counting (as m1/m13-check) ---
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

function pixelMatches(img, x, y, r, g, b, tol = 10) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
  const i = (y * img.width + x) * 3;
  return (
    Math.abs(img.pixels[i] - r) <= tol &&
    Math.abs(img.pixels[i + 1] - g) <= tol &&
    Math.abs(img.pixels[i + 2] - b) <= tol
  );
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

// Find an app window's header bar (a solid 40px band of the given
// colour, 800px wide) and return its bounds. Copied from
// m13-check.mjs (findWindowHeader, round 7): left/right come ONLY
// from rows in the header band itself, with a longest-run median
// fallback when a wallpaper band pollutes the min/max.
//
// The scan starts at y=0, not y=48: with the tight Terminal
// tolerance (±2) the top bar (21,21,28) no longer matches the
// header colour, so the old skip is unnecessary — and the window's
// true top IS 0 (the compositor places the first window at (0,0)).
// `tol` defaults to the m13 ±10; Terminal call sites pass
// TERM_MATCH_TOL.
function findWindowHeader(img, r, g, b, tol = 10) {
  const { width: W, pixels } = img;
  let top = -1;
  let bottom = -1;
  const rows = [];
  for (let y = 0; y < 672; y++) {
    let n = 0;
    let rowLeft = W;
    let rowRight = -1;
    let bestRunLeft = W;
    let bestRunRight = -1;
    let bestRunLen = 0;
    let runStart = -1;
    for (let x = 0; x <= W; x++) {
      let m = false;
      if (x < W) {
        const i = (y * W + x) * 3;
        m =
          Math.abs(pixels[i] - r) <= tol &&
          Math.abs(pixels[i + 1] - g) <= tol &&
          Math.abs(pixels[i + 2] - b) <= tol;
      }
      if (m) {
        n++;
        if (x < rowLeft) rowLeft = x;
        if (x > rowRight) rowRight = x;
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        const runLen = x - runStart;
        if (runLen > bestRunLen) {
          bestRunLen = runLen;
          bestRunLeft = runStart;
          bestRunRight = x - 1;
        }
        runStart = -1;
      }
    }
    if (n > 700) {
      if (top < 0) top = y;
      bottom = y;
    }
    rows.push({
      n,
      left: rowLeft,
      right: rowRight,
      runLeft: bestRunLeft,
      runRight: bestRunRight,
    });
  }
  if (top < 0) return null;
  let left = W;
  let right = -1;
  for (let y = top; y <= Math.min(bottom, top + 43); y++) {
    const row = rows[y];
    if (row.n > 700) {
      if (row.left < left) left = row.left;
      if (row.right > right) right = row.right;
    }
  }
  if (right - left > 1000) {
    const bandLefts = [];
    const bandRights = [];
    for (let y = top; y <= Math.min(bottom, top + 43); y++) {
      const row = rows[y];
      if (row.n > 700) {
        bandLefts.push(row.runLeft);
        bandRights.push(row.runRight);
      }
    }
    if (bandLefts.length > 0) {
      const median = (xs) => {
        const s = [...xs].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
      };
      left = median(bandLefts);
      right = median(bandRights);
    }
  }
  return { top, bottom, left, right };
}

// Partial header band (m13-check, round 7): a window dragged partly
// off-screen keeps a header band, but its rows hold fewer than the
// 700px findWindowHeader requires. Used ONLY for a drag's
// after-frame, never to gate a focus click. The floor is 400, not
// 100: the desktop itself carries a (15,23,38) diagonal that yields
// up to 276 matching px/row, so a 100px sliver is not a window
// remnant — a real partially-visible window still shows 400+ px/row.
function findWindowHeaderPartial(img, r, g, b, tol = 10) {
  const { width: W, pixels } = img;
  let best = null;
  let cur = null;
  const close = () => {
    if (cur && (!best || cur.bottom - cur.top > best.bottom - best.top)) best = cur;
    cur = null;
  };
  for (let y = 0; y < 672; y++) {
    let n = 0;
    let rowLeft = W;
    let rowRight = -1;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (
        Math.abs(pixels[i] - r) <= tol &&
        Math.abs(pixels[i + 1] - g) <= tol &&
        Math.abs(pixels[i + 2] - b) <= tol
      ) {
        n++;
        if (x < rowLeft) rowLeft = x;
        if (x > rowRight) rowRight = x;
      }
    }
    if (n > 400) {
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

// A drag's start point, VERIFIED to be a header pixel (m13-check,
// round 7). Prefer the usual start (left+200, top+20); fall back to
// the centre of the longest run of header-colour pixels in the
// header band; refuse (null) when no run reaches 20px, so the
// caller never drags blind.
function dragStartPoint(frame, rect, r, g, b, tol = 10) {
  const sx = rect.left + 200;
  const sy = rect.top + 20;
  if (pixelMatches(frame, sx, sy, r, g, b, tol)) return { x: sx, y: sy };
  let best = null;
  for (let y = rect.top; y <= rect.bottom; y++) {
    let s = -1;
    for (let x = 0; x <= frame.width; x++) {
      const m = x < frame.width && pixelMatches(frame, x, y, r, g, b, tol);
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

// The Terminal window's measured rect: the tight-tolerance finder,
// falling back to the partial-band finder for a window dragged
// partly off-screen. Every Terminal measurement in this check goes
// through here — never the bare ±10 finder (see TERM_MATCH_TOL).
function findTermHeader(frame) {
  return (
    findWindowHeader(frame, ...TERM_HEADER_RGB, TERM_MATCH_TOL) ??
    findWindowHeaderPartial(frame, ...TERM_HEADER_RGB, TERM_MATCH_TOL)
  );
}

// Do two window rects show the same window returned to the same
// place (m13-check, round 8/10)? Left/top always compare; bottom /
// right compare ONLY when the two rects have (near-)identical
// dimensions (a partial rect's bottom/right is a coverage or
// screen boundary, not the window's edge).
function rectsMatchReturn(a, b, tol) {
  if (!a || !b) return false;
  if (Math.abs(a.top - b.top) > tol || Math.abs(a.left - b.left) > tol) return false;
  const SAME_DIM_PX = 10;
  if (
    Math.abs(a.bottom - a.top - (b.bottom - b.top)) <= SAME_DIM_PX &&
    Math.abs(a.bottom - b.bottom) > tol
  )
    return false;
  if (
    Math.abs(a.right - a.left - (b.right - b.left)) <= SAME_DIM_PX &&
    Math.abs(a.right - b.right) > tol
  )
    return false;
  return true;
}

// --- QMP client (as m1/m13-check) ---
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

// --- data disk (debugfs, read-only from the harness; as m13-check) ---
async function readState() {
  const out = await execAsync("debugfs", ["-R", "cat /slot-state.json", DISK]);
  return JSON.parse(out);
}

// --- one QEMU boot ---
// `opts`: { qmp, ctl, appd, stdin } — which channels this boot
// needs. The recovery boot needs only the serial console + stdin
// (no services run there); the standalone boot needs all of them.
async function boot(tag, appendExtra, opts = {}) {
  const { qmp = true, ctl = true, appd = true, stdin = false } = opts;
  const logPath = join(OUT, `genesis-boot-${tag}.log`);
  writeFileSync(logPath, "");
  const logStream = createWriteStream(logPath, { flags: "w" });
  const ctlSock = join(OUT, `genesis-${tag}-ctl.sock`);
  const appdSock = join(OUT, `genesis-${tag}-appd.sock`);
  const qmpSock = join(OUT, `genesis-${tag}-qmp.sock`);
  const args = [
    "-machine",
    `q35,accel=${ACCEL}`,
    "-m",
    "4096",
    "-smp",
    "2",
    "-kernel",
    join(OUT, "vmlinuz"),
    "-initrd",
    join(OUT, "initramfs.cpio.gz"),
    "-append",
    `console=ttyS0 sevyn.slot=A${appendExtra ? " " + appendExtra : ""}`,
    "-display",
    "none",
    "-vga",
    "none",
    "-monitor",
    "none",
    "-serial",
    "stdio",
  ];
  if (ctl) {
    args.push(
      "-chardev",
      `socket,id=ctl,path=${ctlSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=ctl",
    );
  }
  if (appd) {
    args.push(
      "-chardev",
      `socket,id=appd,path=${appdSock},server=on,wait=off`,
      "-device",
      "isa-serial,chardev=appd",
    );
  }
  if (qmp) {
    args.push(
      "-chardev",
      `socket,id=qmp,path=${qmpSock},server=on,wait=off`,
      "-mon",
      "chardev=qmp,mode=control",
    );
  }
  args.push(
    "-drive",
    `file=${DISK},format=raw,if=virtio,cache=writethrough`,
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
  const qemu = spawn(QEMU, args, {
    stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  qemu.stdout.pipe(logStream);
  qemu.stderr.pipe(logStream);
  const b = {
    tag,
    qemu,
    logPath,
    ctlSock,
    appdSock,
    qmpSock,
    exited: false,
    ctl: null,
    appd: null,
    qmp: null,
  };
  qemu.on("exit", () => {
    b.exited = true;
  });
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

async function connectSocket(path, timeoutMs = 30000) {
  if (!(await waitForSocketFile(path, timeoutMs))) {
    throw new Error(`control socket never appeared: ${path}`);
  }
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
}

async function connectSockets(b, { qmp = true, ctl = true, appd = true } = {}) {
  if (qmp) {
    if (!(await waitForSocketFile(b.qmpSock))) {
      throw new Error(`QMP socket never appeared: ${b.qmpSock}`);
    }
    let q = null;
    const deadline = Date.now() + 30000;
    for (;;) {
      q = new QMP(b.qmpSock);
      try {
        await q.ready();
        break;
      } catch (e) {
        try {
          q.close();
        } catch {}
        if (Date.now() >= deadline) throw e;
        await sleep(200);
      }
    }
    await q.capabilities();
    b.qmp = q;
  }
  if (ctl) b.ctl = await connectSocket(b.ctlSock);
  if (appd) b.appd = await connectSocket(b.appdSock);
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
  for (const s of [b.ctl, b.appd]) {
    try {
      s?.destroy();
    } catch {}
  }
  try {
    b.qemu.kill("SIGKILL");
  } catch {}
}

// Drive appd over its control serial; replies arrive as APPD log
// lines on the console (the boot log). As m13-check.
async function appdCmd(b, cmd, pattern, timeoutMs = 15000) {
  const before = logLines(b.logPath).length;
  b.appd.write(cmd + "\n");
  return waitForLog(b.logPath, pattern, timeoutMs, before);
}

// Power the guest off over the statusd control serial (POWEROFF on
// ttyS1, as m13-check). Returns true when QEMU exited.
async function poweroff(b, timeoutMs = 30000) {
  try {
    b.ctl.write("POWEROFF\n");
  } catch {
    return false;
  }
  return waitExit(b, timeoutMs);
}

// Poll screendumps until the top bar + dock appear (the shell's first
// present can lag the mount by seconds under TCG; the m2-check
// render-timing flake). 120 s, as m12-check. The dock band is the
// bottom 96 rows of the actual frame, not a hardcoded y — the output
// size comes from the SEVYN READY marker. Returns the settled frame
// or null.
async function screenSettled(b, timeoutMs = 120000) {
  const shotPath = join(OUT, `genesis-shot-${b.tag}.ppm`);
  const settleStart = Date.now();
  while (Date.now() - settleStart < timeoutMs) {
    try {
      const img = await shot(b.qmp, shotPath);
      const topBar = countColor(img, ...TOP_BAR_RGB, 10, {
        x0: 0,
        y0: 0,
        x1: img.width,
        y1: 48,
      });
      const dockBg = countColor(img, ...DOCK_RGB, 10, {
        x0: 0,
        y0: Math.max(0, img.height - 96),
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

// Pixels differing by more than a noise threshold between two
// frames. The shell's clock does NOT tick every second (Shell.tsx
// resyncs hourly via setTimeout; no setInterval), so an idle
// desktop is pixel-identical 5 s apart — two idle screendumps
// cannot prove liveness. The live-desktop proof is the repaint a
// window launch causes (see §1b/§1c), not two idle frames.
function countDiff(imgA, imgB) {
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) return -1;
  let diff = 0;
  for (let i = 0; i < imgA.pixels.length; i += 3) {
    const d =
      Math.abs(imgA.pixels[i] - imgB.pixels[i]) +
      Math.abs(imgA.pixels[i + 1] - imgB.pixels[i + 1]) +
      Math.abs(imgA.pixels[i + 2] - imgB.pixels[i + 2]);
    if (d > 30) diff++;
  }
  return diff;
}

// --- main ---
let currentBoot = null;

function finish(ok, extra = {}) {
  if (currentBoot) closeBoot(currentBoot);
  const result = {
    pass: ok,
    duration_s: Number(((Date.now() - started) / 1000).toFixed(1)),
    checks,
    warnings,
    ...extra,
  };
  writeFileSync(join(OUT, "genesis-check.json"), JSON.stringify(result, null, 2));
  console.log(ok ? "GENESIS CHECK PASSED" : "GENESIS CHECK FAILED");
  process.exit(ok ? 0 : 1);
}

async function main() {
  for (const f of ["vmlinuz", "initramfs.cpio.gz", "os-version"]) {
    if (!existsSync(join(OUT, f))) {
      console.error(
        `error: missing ${join(OUT, f)} — run v2/image/build-genesis-image.sh first`,
      );
      process.exit(1);
    }
  }
  const version = readFileSync(join(OUT, "os-version"), "utf8").trim();
  const measurements = { pixman: "NOT_PROVEN" };

  // 0. Setup: data disk (slot A = the built image).
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
    state0.active === "A" && state0.good === "A" && state0.attempts === 0,
    JSON.stringify(state0),
  );

  // 1. Standalone boot.
  const b = await boot("1", "");
  currentBoot = b;
  await connectSockets(b);
  check("boot: QMP + control serials connected", true);

  // 1a. Compositor READY: standalone, one output, budgets.
  const readyLine = await waitForLog(b.logPath, /SEVYN READY/, 300000);
  if (!check("boot: compositor READY (SEVYN READY)", !!readyLine)) {
    console.error(readLog(b.logPath).slice(-3000));
    closeBoot(b);
    finish(false, { measurements });
    return;
  }
  const readyM = readyLine.match(
    /SEVYN READY socket=(\S+) bridge=(\S+) output=(\d+)x(\d+)@(\d+) backend=drm scale=(\S+) renderer=(gles|pixman) socket_up_ms=(\d+)/,
  );
  if (!readyM) {
    check("boot: READY marker parses", false, readyLine);
    closeBoot(b);
    finish(false, { measurements });
    return;
  }
  const [, , , outW, outH, , , renderer, socketUpMs] = readyM;
  const W = Number(outW);
  const H = Number(outH);
  const socketUp = Number(socketUpMs);
  measurements.output = `${W}x${H}`;
  measurements.socket_up_ms = socketUp;
  measurements.renderer = renderer;
  check("boot: standalone backend=drm (no parent compositor)", true, readyLine);
  check(
    "boot: renderer=gles on the standalone boot",
    renderer === "gles",
    `renderer=${renderer}`,
  );
  check(
    "boot: socket up within budget",
    socketUp <= SOCKET_UP_BUDGET_MS,
    `socket_up_ms=${socketUp} (budget ${SOCKET_UP_BUDGET_MS})`,
  );

  const firstLine = await waitForLog(b.logPath, /SEVYN FIRST FRAME PRESENTED/, 60000);
  let firstFrameMs = null;
  if (firstLine) {
    const fm = firstLine.match(/first_frame_ms=(\d+)/);
    firstFrameMs = fm ? Number(fm[1]) : null;
  }
  measurements.first_frame_ms = firstFrameMs;
  check(
    "boot: first frame within budget",
    firstFrameMs !== null && firstFrameMs <= FIRST_FRAME_BUDGET_MS,
    firstFrameMs === null
      ? "no first-frame marker"
      : `first_frame_ms=${firstFrameMs} (budget ${FIRST_FRAME_BUDGET_MS})`,
  );

  // 1b. Shell mounts + desktop paints + frames flow.
  const ready2 = await waitForLog(b.logPath, /SEVYNOS_M2_READY/, 300000);
  check("genesis: shell mounts (SEVYNOS_M2_READY)", !!ready2);
  if (!ready2) {
    console.error(readLog(b.logPath).slice(-3000));
    closeBoot(b);
    finish(false, { measurements });
    return;
  }
  const settled = await screenSettled(b);
  check(
    "genesis: desktop paints (top bar + dock in screendump)",
    !!settled,
    settled ? `${settled.width}x${settled.height}` : "no settled frame",
  );
  if (settled) {
    check(
      "genesis: one output in native mode (screendump matches READY output)",
      settled.width === W && settled.height === H,
      `screendump ${settled.width}x${settled.height} vs READY ${W}x${H}`,
    );
  }
  const fpsLine = await waitForLog(b.logPath, /GENESIS fps/, 90000);
  check(
    "frames: GENESIS fps sample logged (frames flowing)",
    !!fpsLine,
    fpsLine ? fpsLine.trim().slice(0, 200) : "no fps line in 90 s",
  );
  // Liveness, part 1: capture the desktop before the Terminal
  // launches. The diff against the post-launch frame lands in §1c —
  // an idle desktop is pixel-identical (the clock resyncs hourly),
  // so the launch repaint is the proof, not two idle frames.
  const flowBefore = await shot(b.qmp, join(OUT, "genesis-shot-flow-a.ppm"));
  // 1c. appd answers, then launch the Terminal (the one real RN app).
  const pong = await appdCmd(b, "PING", /APPD PONG/);
  check("boot: appd answers PING (M3 stack intact)", !!pong);
  const launchLines = logLines(b.logPath).length;
  const launched = await appdCmd(b, "LAUNCH terminal", /APPD LAUNCH OK terminal/);
  check("app: LAUNCH terminal accepted", !!launched, launched || "");
  let termSurface = null;
  let termSession = null;
  let termW = null;
  let termH = null;
  if (launched) {
    const createdLine = await waitForLog(
      b.logPath,
      /SEVYN SURFACE CREATED id=(\d+) session=(\S+) pid=(\d+)/,
      60000,
      launchLines,
    );
    if (createdLine) {
      const cm = createdLine.match(/id=(\d+) session=(\S+)/);
      termSurface = Number(cm[1]);
      termSession = cm[2];
    }
    check(
      "app: Terminal surface created in Genesis",
      termSurface !== null,
      createdLine || "no SURFACE CREATED after LAUNCH",
    );
    if (termSurface !== null) {
      const metaLine = await waitForLog(
        b.logPath,
        new RegExp(`SEVYN SURFACE METADATA id=${termSurface} app_id=(\\S+) title=(.*)`),
        30000,
        launchLines,
      );
      check(
        "app: Terminal surface metadata logged",
        !!metaLine,
        metaLine ? metaLine.trim().slice(0, 160) : "no METADATA",
      );
      const commitLine = await waitForLog(
        b.logPath,
        new RegExp(`SEVYN SURFACE COMMITTED id=${termSurface} size=(\\d+)x(\\d+)`),
        30000,
        launchLines,
      );
      if (commitLine) {
        const sm = commitLine.match(/size=(\d+)x(\d+)/);
        termW = Number(sm[1]);
        termH = Number(sm[2]);
      }
      check(
        "app: Terminal surface committed",
        termW !== null && termH !== null,
        commitLine ? `size=${termW}x${termH}` : "no COMMITTED",
      );
    }
  }
  // The window rect comes from the compositor, not the pixel
  // finder: the Terminal is the first (only) toplevel, so the
  // compositor's cascade places it at (0,0) (server.rs
  // place_window: 48px steps from (0,0)) and its size is the
  // COMMITTED size. The finder only proves the window is actually
  // painted there — it must not define the rect (the shell
  // wallpaper colour sits inside the old ±10 tolerance and inflates
  // it to 985 wide; see TERM_MATCH_TOL).
  const termRect =
    termW !== null && termH !== null
      ? { left: 0, top: 0, right: termW, bottom: termH }
      : null;
  let termOnScreen = false;
  const termDeadline = Date.now() + 30000;
  while (!termOnScreen && Date.now() < termDeadline) {
    try {
      const frame = await shot(b.qmp, join(OUT, "genesis-shot-terminal.ppm"));
      termOnScreen =
        termRect !== null &&
        countColor(frame, ...TERM_HEADER_RGB, TERM_MATCH_TOL, {
          x0: termRect.left,
          y0: termRect.top,
          x1: termRect.right,
          y1: termRect.bottom,
        }) >
          (termW * termH) / 2;
    } catch {
      // No readable frame yet; keep polling.
    }
    if (!termOnScreen) await sleep(1000);
  }
  check("app: Terminal window on screen (header found)", termOnScreen);
  if (!termOnScreen || termSurface === null) {
    console.error(readLog(b.logPath).slice(-3000));
    closeBoot(b);
    finish(false, { measurements });
    return;
  }

  // Liveness, part 2: the desktop repaints for the Terminal launch.
  // (Part 1 captured the pre-launch frame in §1b; an idle desktop
  // is pixel-identical, so the launch repaint is the proof.)
  const flowAfter = await shot(b.qmp, join(OUT, "genesis-shot-flow-b.ppm"));
  const flowDiff = countDiff(flowBefore, flowAfter);
  check(
    "frames: desktop repaints for the Terminal launch (live desktop)",
    flowDiff > 50,
    flowDiff === -1 ? "frame size changed" : `differing pixels=${flowDiff}`,
  );

  // Input helpers (QMP input-send-event, as m3/m13-check).
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
  // Two clicks with no pointer move between them: the host's
  // double-click window is 500ms, and two click()s span ~240ms.
  const doubleClick = async (x, y) => {
    await moveTo(x, y, W, H);
    await click();
    await click();
  };
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
      {
        type: "key",
        data: { down: true, key: { type: "qcode", data: qcode } },
      },
    ]);
  };
  const keyUp = async (qcode) => {
    await b.qmp.input([
      {
        type: "key",
        data: { down: false, key: { type: "qcode", data: qcode } },
      },
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
  const QCODE_FOR = {
    " ": "spc",
    "/": "slash",
    ".": "dot",
    "-": "minus",
  };
  for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") QCODE_FOR[c] = c;
  const typeText = async (s) => {
    for (const ch of s) {
      const qc = QCODE_FOR[ch];
      if (!qc) throw new Error(`genesis-check: no QKeyCode for ${JSON.stringify(ch)}`);
      await keyTap(qc);
      await sleep(60);
    }
  };

  // 1d. Memory: steady-state RSS with Shell + Terminal up and idle.
  // The check uses the first GENESIS RSS line printed AFTER the
  // Terminal has been idle 2 s (the line is periodic, <= 60 s, so a
  // 90 s wait covers it). The number is recorded, never invented.
  await sleep(2000);
  const rssSince = logLines(b.logPath).length;
  const rssLine = await waitForLog(b.logPath, /GENESIS RSS (\d+)/, 90000, rssSince);
  let rssMb = null;
  if (rssLine) {
    const rm = rssLine.match(/GENESIS RSS (\d+)/);
    rssMb = Number((Number(rm[1]) / 1024).toFixed(1));
  }
  measurements.rss_mb = rssMb;
  check(
    "memory: compositor RSS within budget (Shell + Terminal, idle)",
    rssMb !== null && rssMb <= RSS_BUDGET_MB,
    rssMb === null
      ? "no GENESIS RSS line — the builder contract line is missing (see the header)"
      : `rss=${rssMb} MB (budget ${RSS_BUDGET_MB})`,
  );

  // 1e. Pointer/keyboard routing: the focus token follows the
  // pointer between the Shell and the Terminal window, and clicks
  // + keys land on the surface under the pointer.
  //
  // The Shell point is the AI button, bottom-right (AiButton.tsx:
  // 56px disc, right:16, bottom:16 — centre W-44, H-44). It is a
  // Pressable, so it is inside the shell surface's input region —
  // the host builds that region from Pressables + TextInputs only
  // (#179: the bare top bar is deliberately NOT in it, so a point
  // on the bar's empty stretch hits no surface at all). The old
  // shell point (termRect.right + 100, y=12) was exactly that
  // bare chrome, so the "Shell top bar is a focusable surface"
  // premise was false and the focus/click/key assertions on it
  // could never pass. The top-bar point is kept here as a
  // fall-through assertion instead: no surface, by design. A
  // desktop icon would be the other interactive Shell point, but
  // /data/Desktop is not seeded in this image, so no icon exists
  // to point at; the dock tiles all launch apps, and the tray
  // Power button opens the power menu (whose fullscreen backdrop
  // would swallow the next click) — the AI button is the only
  // Shell Pressable whose click is harmless here. Its click opens
  // the AI sidebar; the sidebar is closed again before the
  // Terminal assertions, so the desktop is restored for the EXEC
  // / move / resize steps. Focus ids are tokens, not numbers: a
  // toplevel reports its registry id ("1"), the shell layer
  // reports "layer=sevyn-shell". A key over the shell reports
  // focus=(none) — the KEY marker only prints the numeric
  // registry id, which is None for layer focus (input.rs
  // keyboard_key) — so the shell key expectation is "(none)",
  // not the layer token.
  const shellPt = { x: W - 44, y: H - 44 };
  const topBarPt =
    termRect.right + 100 < W - 20
      ? { x: termRect.right + 100, y: 12 }
      : { x: Math.floor(W / 2), y: termRect.bottom + 100 };
  const termPt = {
    x: termRect.left + 200,
    y: termRect.top + Math.min(100, Math.max(50, termH - 50)),
  };
  // Guard: the AI button really is the violet disc at shellPt.
  // The disc is #5B5BD6; the pixel 22px above the centre is
  // inside the disc (radius 28) and clear of the white "AI"
  // monogram. If the dock ever grows over the button, this fails
  // loudly here instead of producing a confusing focus failure.
  const AI_BUTTON_RGB = [91, 91, 214];
  {
    const guardFrame = await shot(b.qmp, join(OUT, "genesis-shot-shell-point.ppm"));
    check(
      "input: AI button visible at the Shell point (violet disc)",
      pixelMatches(guardFrame, shellPt.x, shellPt.y - 22, ...AI_BUTTON_RGB),
      `no violet pixel at (${shellPt.x}, ${shellPt.y - 22}) — the dock may cover the button`,
    );
  }
  const focusAfterMove = async (pt) => {
    const before = logLines(b.logPath).length;
    await moveTo(pt.x, pt.y, W, H);
    await sleep(500);
    let line = await waitForLog(
      b.logPath,
      /SEVYN POINTER FOCUS surface=(\S+)/,
      10000,
      before,
    );
    if (!line) {
      // No new marker: the pointer was already on this surface, so
      // the focus did not change — pointer_motion only logs on
      // change. The last marker in the log is the focus still in
      // effect.
      const lines = logLines(b.logPath);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (/SEVYN POINTER FOCUS surface=(\S+)/.test(lines[i])) {
          line = lines[i];
          break;
        }
      }
    }
    return line ? line.match(/surface=(\S+)/)[1] : null;
  };
  // Fresh-marker variant, no fallback to the last marker: the
  // fall-through point must produce NO new marker at all, and the
  // fallback would hand back the previous surface's marker.
  const freshFocusAfterMove = async (pt) => {
    const before = logLines(b.logPath).length;
    await moveTo(pt.x, pt.y, W, H);
    await sleep(500);
    const line = await waitForLog(
      b.logPath,
      /SEVYN POINTER FOCUS surface=(\S+)/,
      10000,
      before,
    );
    return line ? line.match(/surface=(\S+)/)[1] : null;
  };
  // Fall-through first, while pointer focus has never been set:
  // the bare top bar hits no surface (the #179 design), so no
  // POINTER FOCUS marker may fire and the click reports (none).
  const topBarFocus = await freshFocusAfterMove(topBarPt);
  check(
    "input: pointer over the bare top bar focuses no surface (fall-through)",
    topBarFocus === null,
    topBarFocus === null ? "" : `surface=${topBarFocus}`,
  );
  const clickReaches = async (pt) => {
    const before = logLines(b.logPath).length;
    await moveTo(pt.x, pt.y, W, H);
    await sleep(300);
    await click();
    const line = await waitForLog(
      b.logPath,
      /SEVYN POINTER BUTTON button=272 state=pressed surface=(\S+)/,
      10000,
      before,
    );
    return line ? line.match(/surface=(\S+)/)[1] : null;
  };
  const topBarClick = await clickReaches(topBarPt);
  check(
    "input: click on the bare top bar reaches no surface (fall-through)",
    topBarClick === "(none)",
    `button surface=${topBarClick}, expected (none)`,
  );
  const shellFocus = await focusAfterMove(shellPt);
  check(
    "input: pointer over the AI button focuses the Shell layer",
    shellFocus === "layer=sevyn-shell",
    shellFocus === null ? "no POINTER FOCUS" : `surface=${shellFocus}`,
  );
  // Capture the line count before this click: its press is the
  // real keyboard-focus change (Terminal -> Shell layer), and
  // the move-away assertion below reads the marker it fired.
  const shellBefore = logLines(b.logPath).length;
  const shellClick = await clickReaches(shellPt);
  check(
    "input: click on the AI button reaches the Shell surface",
    shellClick === shellFocus,
    `button surface=${shellClick}, expected ${shellFocus}`,
  );
  // Move-away marker: the AI-button press moved keyboard focus
  // to the Shell layer, so Genesis logged FOCUS KEYBOARD
  // surface=layer=sevyn-shell during the press. Asserting it
  // here keeps a future failure diagnostic: if this fails, the
  // move-away never happened; if only the Terminal focus
  // assertion below fails, the wait window missed the marker.
  const shellKeyFocusLine = findLog(
    b.logPath,
    /SEVYN FOCUS KEYBOARD surface=layer=sevyn-shell/,
    shellBefore,
  );
  check(
    "focus: clicking the AI button moves keyboard focus to the Shell layer",
    !!shellKeyFocusLine,
    shellKeyFocusLine ? "" : "no FOCUS KEYBOARD surface=layer=sevyn-shell",
  );
  const keyReaches = async (pt, qcode) => {
    const before = logLines(b.logPath).length;
    await moveTo(pt.x, pt.y, W, H);
    await sleep(300);
    await click();
    await sleep(300);
    await key(qcode);
    const line = await waitForLog(
      b.logPath,
      /SEVYN KEY .* state=pressed focus=(\S+)/,
      10000,
      before,
    );
    return line ? line.match(/focus=(\S+)/)[1] : null;
  };
  // The AI-button click opened the sidebar, and the pointer is
  // still over it — but the button hid, so the point is now over
  // the sidebar's input row. Do not move or click again: keyboard
  // focus is already the layer (the button press moved it), so
  // type in place and read where the key lands.
  const keyAtFocus = async (qcode) => {
    const before = logLines(b.logPath).length;
    await key(qcode);
    const line = await waitForLog(
      b.logPath,
      /SEVYN KEY .* state=pressed focus=(\S+)/,
      10000,
      before,
    );
    return line ? line.match(/focus=(\S+)/)[1] : null;
  };
  const shellKey = await keyAtFocus("a");
  check(
    "input: key 'a' over the Shell reaches the Shell (not the Terminal)",
    shellKey === "(none)",
    `key focus=${shellKey}, expected (none) — layer focus has no registry id`,
  );
  // Close the sidebar to restore the desktop: its Close button is
  // the right-most item in the 48px header (right padding 12),
  // vertically centred — x W-28, y 72. The click is a press on
  // the shell surface, so keyboard focus stays on the layer.
  // Verify by the AI button's violet coming back at shellPt.
  {
    const closePt = { x: W - 28, y: 72 };
    await moveTo(closePt.x, closePt.y, W, H);
    await sleep(300);
    await click();
    await sleep(500);
    const closedFrame = await shot(b.qmp, join(OUT, "genesis-shot-shell-closed.ppm"));
    check(
      "input: AI sidebar closes again (AI button back)",
      pixelMatches(closedFrame, shellPt.x, shellPt.y - 22, ...AI_BUTTON_RGB),
      "no violet pixel after closing — the sidebar may still be open",
    );
  }
  const termFocus = await focusAfterMove(termPt);
  check(
    "input: pointer over the Terminal focuses a different surface",
    termFocus !== null && termFocus !== shellFocus,
    `shell surface=${shellFocus}, terminal surface=${termFocus}`,
  );
  // Capture the line count before this click: its press is the
  // real keyboard-focus change (Shell layer -> Terminal), and
  // the focus assertion below reads the marker it fired.
  const termBefore = logLines(b.logPath).length;
  const termClick = await clickReaches(termPt);
  check(
    "input: click in the Terminal reaches the Terminal surface",
    termClick === termFocus,
    `button surface=${termClick}, expected ${termFocus}`,
  );
  // Focus: clicking the Terminal moves keyboard focus to it.
  // The press inside clickReaches(termPt) above IS the change:
  // keyboard focus was on the Shell layer (the sidebar-close
  // press kept it there), so the press moved it to the Terminal
  // and Genesis logged FOCUS KEYBOARD surface=<termFocus> then.
  // A second click here would be a non-change — set_keyboard_focus
  // early-returns unchanged and no marker can fire — so assert
  // the marker the clickReaches press already fired, since the
  // line count captured before it (termBefore).
  const focusLine = findLog(
    b.logPath,
    new RegExp(`SEVYN FOCUS KEYBOARD surface=${termFocus}`),
    termBefore,
  );
  check(
    "focus: clicking the Terminal moves keyboard focus to it",
    !!focusLine,
    focusLine ? "" : `no FOCUS KEYBOARD surface=${termFocus}`,
  );
  const termKey = await keyReaches(termPt, "b");
  check(
    "input: key 'b' in the Terminal reaches the Terminal surface",
    termKey === termFocus,
    `key focus=${termKey}, expected ${termFocus}`,
  );

  // The Terminal really got the keys: type a sevyn command into its
  // input and wait for the host's EXEC line. The input row sits
  // ~17 px above the window's bottom edge (m13: top+482 in a
  // 499 px window); the row is verified by its background colour
  // before clicking, and the EXEC wait is the verdict — a failed
  // refocus never silently passes, it just fails the EXEC wait.
  const inputPoint = (frame, header) => {
    const y = header.top + termH - 17;
    const x = header.left + 200;
    if (x < header.left || x > header.right || y < header.top || y > header.top + termH)
      return null;
    let n = 0;
    let tot = 0;
    for (let yy = Math.max(0, y - 5); yy <= Math.min(H - 1, y + 5); yy++) {
      for (let xx = Math.max(0, x - 20); xx <= Math.min(W - 1, x + 20); xx++) {
        tot++;
        if (pixelMatches(frame, xx, yy, ...TERM_INPUT_RGB)) n++;
      }
    }
    return tot > 0 && n / tot >= 0.5 ? { x, y } : null;
  };
  {
    const before = logLines(b.logPath).length;
    const frame = await shot(b.qmp, join(OUT, "genesis-shot-termcmd-input.ppm"));
    const freshHeader = findTermHeader(frame);
    const pt = freshHeader ? inputPoint(frame, freshHeader) : null;
    if (pt) {
      await moveTo(pt.x, pt.y, W, H);
      await sleep(300);
      await click();
      await sleep(300);
    }
    // Clear the input first (m13 round 3: an empty submit flushes
    // text typed while focus was lost, so the next command cannot
    // concatenate onto a stale fragment).
    await key("ret");
    await sleep(2000);
    // Type WITHOUT the `sevyn` prefix: the Terminal prompt already
    // supplies it, so typing it doubles it (`sevyn sevyn net
    // status`, exit 1) and the EXEC 0 wait can never match.
    await typeText("net status");
    await key("ret");
    const exec = await waitForLog(
      b.logPath,
      /EXEC sevyn net status -> 0/,
      120000,
      before,
    );
    check(
      "app: `sevyn net status` typed in the Terminal runs (EXEC 0)",
      !!exec,
      exec ? "" : "no EXEC line — the Terminal input never got focus",
    );
  }

  // 1f. Move follows: drag the Terminal title bar, then drag it back.
  const dragTerminal = async (dx, dy, tag) => {
    const frame = await shot(b.qmp, join(OUT, `genesis-shot-drag-${tag}-before.ppm`));
    const before = findTermHeader(frame);
    if (!before) return null;
    const start = dragStartPoint(frame, before, ...TERM_HEADER_RGB, TERM_MATCH_TOL);
    if (!start) return null;
    await dragPointer(start.x, start.y, start.x + dx, start.y + dy, W, H);
    const afterFrame = await shot(b.qmp, join(OUT, `genesis-shot-drag-${tag}-after.ppm`));
    const after = findTermHeader(afterFrame);
    if (!after) return { before, after: null };
    const moved =
      Math.abs(after.top - before.top) > 10 || Math.abs(after.left - before.left) > 10;
    return moved ? { before, after } : null;
  };
  const aside = await dragTerminal(150, 80, "aside");
  check(
    "move: dragging the Terminal title bar moves its window",
    !!aside?.after,
    aside?.after
      ? `(${aside.before.left},${aside.before.top}) -> (${aside.after.left},${aside.after.top})`
      : "drag produced no measurable move",
  );
  if (aside?.after) {
    let backOk = false;
    let backDetail = "";
    for (let attempt = 0; attempt < 2 && !backOk; attempt++) {
      const backFrame = await shot(
        b.qmp,
        join(OUT, `genesis-shot-drag-back-${attempt}-before.ppm`),
      );
      const cur = findTermHeader(backFrame);
      if (!cur) break;
      const dx = aside.before.left - cur.left;
      const dy = aside.before.top - cur.top;
      if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10) {
        backOk = true;
        backDetail = "already back";
        break;
      }
      const start = dragStartPoint(backFrame, cur, ...TERM_HEADER_RGB, TERM_MATCH_TOL);
      if (!start) break;
      await dragPointer(start.x, start.y, start.x + dx, start.y + dy, W, H);
      const afterFrame = await shot(
        b.qmp,
        join(OUT, `genesis-shot-drag-back-${attempt}-after.ppm`),
      );
      const after = findTermHeader(afterFrame);
      backOk = rectsMatchReturn(after, aside.before, 10);
      backDetail = after
        ? `returned to (${after.left},${after.top}), wanted (${aside.before.left},${aside.before.top})`
        : "no header after drag-back";
    }
    check("move: dragging the Terminal back returns it", backOk, backDetail);
  }

  // 1g. Resize follows: drag the Terminal's right edge outward, then back.
  const resizeTerminal = async (dx, tag) => {
    const frame = await shot(b.qmp, join(OUT, `genesis-shot-resize-${tag}-before.ppm`));
    const rect = findTermHeader(frame);
    if (!rect) return null;
    // The window rect is the measured header rect plus the
    // compositor's own COMMITTED size: the right edge midpoint is a
    // resize-strip point by geometry (the body colour is not a
    // known constant, so no pixel check is possible here — the
    // drag's measured result is the verdict).
    const start = { x: rect.right - 2, y: rect.top + Math.floor(termH / 2) };
    const beforeLines = logLines(b.logPath).length;
    await dragPointer(start.x, start.y, start.x + dx, start.y, W, H);
    const afterFrame = await shot(
      b.qmp,
      join(OUT, `genesis-shot-resize-${tag}-after.ppm`),
    );
    const after = findTermHeader(afterFrame);
    // The compositor logs the new size on commit.
    const commitLine = await waitForLog(
      b.logPath,
      new RegExp(`SEVYN SURFACE COMMITTED id=${termSurface} size=(\\d+)x(\\d+)`),
      15000,
      beforeLines,
    );
    const newW = commitLine ? Number(commitLine.match(/size=(\d+)x/)[1]) : null;
    return { before: rect, after, newW };
  };
  const resized = await resizeTerminal(120, "out");
  const resizeOk =
    !!resized?.after &&
    resized.after.right -
      resized.after.left -
      (resized.before.right - resized.before.left) >=
      50 &&
    resized.newW !== null &&
    resized.newW > termW;
  check(
    "resize: dragging the Terminal's right edge widens its window",
    resizeOk,
    resized?.after
      ? `width ${resized.before.right - resized.before.left} -> ${resized.after.right - resized.after.left}, committed width ${resized.newW} (was ${termW})`
      : "resize drag produced no measurable change",
  );
  if (resizeOk) {
    const restored = await resizeTerminal(-120, "back");
    const backOk =
      !!restored?.after &&
      Math.abs(
        restored.after.right - restored.after.left - (termW === null ? 0 : termW),
      ) <= 15;
    if (backOk) {
      check("resize: dragging the edge back restores the width", true);
    } else {
      warn(
        "resize: edge drag-back did not restore the width",
        restored?.after
          ? `width now ${restored.after.right - restored.after.left}, wanted ~${termW}`
          : "no header after drag-back",
      );
    }
  }

  // 1h. Maximize + rounded corners (polish surface (b)): a
  // title-bar double-click toggles maximize. Under Genesis the
  // shell's 48px exclusive zone makes the work area start below
  // the top bar, so a maximized window's header sits at y=48
  // (40px bar). The verdict is the band's TOP edge + width: top
  // 48 + full width is maximized below the bar, top 0 is
  // fullscreen, and a windowed header is only ~800 wide. The
  // band's BOTTOM edge is NOT asserted: the Terminal's body
  // shares the header's colour, so bottom is the window body's
  // extent (~498 windowed), never the header's bottom edge —
  // asserting bottom 88 failed on the first run even though the
  // host had requested maximize. Restore is the same double-click.
  // The corner verdict then proves the compositor rounds the
  // corners (radius 10): the corner pixel is the wallpaper, a
  // pixel 12px in is the header colour. The wallpaper is dark in
  // places, so the verdict is only meaningful where the wallpaper
  // next to the window differs from the header colour; if it does
  // not, the window is dragged to a different patch and retried
  // once, and if it still does not differ the corner is warned,
  // not failed — unprovable, not square.
  {
    const frame0 = await shot(b.qmp, join(OUT, "genesis-shot-max-before.ppm"));
    const before = findTermHeader(frame0);
    let maxed = null;
    if (before) {
      await doubleClick(
        before.left + Math.floor((before.right - before.left) / 2),
        before.top + 20,
      );
      const deadline = Date.now() + 15000;
      while (!maxed && Date.now() < deadline) {
        try {
          const frame = await shot(b.qmp, join(OUT, "genesis-shot-max.ppm"));
          const band = findTermHeader(frame);
          if (
            band &&
            band.right - band.left >= W - 80 &&
            band.top >= 47 &&
            band.top <= 49
          ) {
            maxed = band;
          }
        } catch {}
        if (!maxed) await sleep(1000);
      }
    }
    check(
      "polish: maximize fills below the top bar (header top 48, full width)",
      !!maxed,
      maxed ? JSON.stringify(maxed) : "no maximized header found",
    );
    if (maxed) {
      let restored = null;
      let restoredFrame = null;
      // The restore double-click's second press can be lost below
      // Genesis (QMP -> virtio-input -> libinput): on the d47850fa
      // run the second press never arrived (no POINTER BUTTON line
      // in the boot log) and the unmaximize never fired, even
      // though the identical maximize double-click worked in the
      // same run. The Genesis-side restore path
      // (manager_set_maximized(false) -> sizeless configure ->
      // host restores the saved size) and the host-side saved size
      // are both correct on inspection — the unmaximize simply
      // never fired, so the saved size was never consulted. Retry
      // the double-click (up to 3 attempts, re-reading the live
      // header each time) before failing; a late restore from a
      // previous attempt is taken, not re-clicked (a click on a
      // windowed header would re-maximize).
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        let cur = maxed;
        let curFrame = null;
        if (attempt > 0) {
          try {
            curFrame = await shot(b.qmp, join(OUT, "genesis-shot-max-restored.ppm"));
            const bd = findTermHeader(curFrame);
            if (bd) cur = bd;
          } catch {}
          if (cur.right - cur.left < 1000 && cur.right - cur.left > 400) {
            restored = cur;
            restoredFrame = curFrame;
            break;
          }
        }
        await doubleClick(
          cur.left + Math.floor((cur.right - cur.left) / 2),
          cur.top + 20,
        );
        const deadline = Date.now() + 5000;
        while (!restored && Date.now() < deadline) {
          try {
            const frame = await shot(b.qmp, join(OUT, "genesis-shot-max-restored.ppm"));
            const band = findTermHeader(frame);
            if (band && band.right - band.left < 1000 && band.right - band.left > 400) {
              restored = band;
              restoredFrame = frame;
            }
          } catch {}
          if (!restored) await sleep(1000);
        }
      }
      check(
        "polish: restore returns to a windowed size",
        !!restored,
        restored ? JSON.stringify(restored) : "no windowed header after restore",
      );
      if (restored && restoredFrame) {
        let band = restored;
        let frame = restoredFrame;
        let cornerPass = false;
        let cornerDetail = "";
        let cornerDone = false;
        for (let attempt = 0; attempt < 2 && !cornerDone; attempt++) {
          const wx = band.left >= 5 ? band.left - 5 : band.right + 5;
          const wallDiffers = !pixelMatches(
            frame,
            wx,
            band.top,
            ...TERM_HEADER_RGB,
            TERM_MATCH_TOL,
          );
          if (wallDiffers) {
            const cornerIsWall = !pixelMatches(
              frame,
              band.left,
              band.top,
              ...TERM_HEADER_RGB,
              TERM_MATCH_TOL,
            );
            const innerIsHeader = pixelMatches(
              frame,
              band.left + 12,
              band.top + 12,
              ...TERM_HEADER_RGB,
              TERM_MATCH_TOL,
            );
            cornerPass = cornerIsWall && innerIsHeader;
            cornerDetail = `corner=${cornerIsWall ? "wallpaper" : "header"} inner=${innerIsHeader ? "header" : "other"} box=${JSON.stringify(band)}`;
            cornerDone = true;
          } else if (attempt === 0) {
            const start = dragStartPoint(frame, band, ...TERM_HEADER_RGB, TERM_MATCH_TOL);
            if (!start) break;
            await dragPointer(start.x, start.y, start.x + 300, start.y + 300, W, H);
            try {
              const frame2 = await shot(
                b.qmp,
                join(OUT, "genesis-shot-corner-retry.ppm"),
              );
              const band2 = findTermHeader(frame2);
              if (!band2) break;
              band = band2;
              frame = frame2;
            } catch {
              break;
            }
          }
        }
        if (cornerDone) {
          check(
            "polish: corners are rounded (corner pixel is not the header colour)",
            cornerPass,
            cornerDetail,
          );
        } else {
          warn(
            "polish: corners unprovable — wallpaper matches the header colour at both positions",
            "",
          );
        }
      }
    }
  }

  // 1i. Close: appd CLOSE ends the session, the window leaves the
  // screen, the Shell survives.
  const closeOk = await appdCmd(b, "CLOSE terminal", /APPD CLOSE OK terminal/);
  check("close: appd CLOSE terminal accepted", !!closeOk, closeOk || "");
  const stoppedLine = await waitForLog(
    b.logPath,
    new RegExp(
      `SEVYN SESSION STOPPED session=${termSession} surface=${termSurface} reason=disconnected`,
    ),
    30000,
  );
  check(
    "close: Terminal session recorded stopped (reason=disconnected)",
    !!stoppedLine,
    stoppedLine ? "" : "no SESSION STOPPED for the Terminal",
  );
  let headerGone = false;
  const closeDeadline = Date.now() + 10000;
  while (!headerGone && Date.now() < closeDeadline) {
    try {
      const frame = await shot(b.qmp, join(OUT, "genesis-shot-closed.ppm"));
      // The window leaves the screen: the pixels at its known rect
      // stop being the window colour. (The pixel finder cannot
      // prove this — the desktop itself carries a (15,23,38)
      // diagonal that the partial-band finder mistakes for a window
      // remnant — so the verdict is the count in the log-anchored
      // rect, not the finder. Replay-verified: 346,459 px with the
      // window up, 15,656 px with it gone.)
      headerGone =
        countColor(frame, ...TERM_HEADER_RGB, TERM_MATCH_TOL, {
          x0: termRect.left,
          y0: termRect.top,
          x1: termRect.right,
          y1: termRect.bottom,
        }) <
        (termW * termH) / 2;
    } catch {
      // No readable frame yet; keep polling.
    }
    if (!headerGone) await sleep(1000);
  }
  check("close: Terminal window leaves the screen", headerGone);
  let shellAlive = false;
  try {
    const frame = await shot(b.qmp, join(OUT, "genesis-shot-shell-alive.ppm"));
    shellAlive =
      countColor(frame, ...TOP_BAR_RGB, 10, { x0: 0, y0: 0, x1: W, y1: 48 }) > 10000;
  } catch {}
  check("close: Shell still paints after the Terminal closes", shellAlive);

  // 1j. Clean poweroff, no crash, no orphans.
  const exited1 = await poweroff(b);
  check("shutdown: guest powers off on request", exited1);
  check(
    "shutdown: no SEVYN CRASH in the standalone boot",
    !logHas(b.logPath, /SEVYN CRASH/),
  );
  check("shutdown: QEMU process gone (no orphans)", b.exited);
  currentBoot = null;

  // 2. Recovery console boot (sevyn.recovery=1): the recovery
  // marker appears, the compositor never starts, and the sevyn CLI
  // answers on the serial console. This boot has no QMP / control
  // serials — no services run in recovery — only the serial console
  // plus stdin (QEMU -serial stdio).
  const rec = await boot("rec", "sevyn.recovery=1", {
    qmp: false,
    ctl: false,
    appd: false,
    stdin: true,
  });
  currentBoot = rec;
  const recLine = await waitForLog(rec.logPath, /SEVYN RECOVERY/, 180000);
  check(
    "recovery: recovery console boots (SEVYN RECOVERY)",
    !!recLine,
    recLine ? recLine.trim().slice(0, 160) : "no recovery marker in 180 s",
  );
  check(
    "recovery: compositor skipped (no SEVYN READY)",
    !logHas(rec.logPath, /SEVYN READY/),
  );
  if (recLine) {
    await sleep(1000);
    const typeConsole = async (text) => {
      try {
        rec.qemu.stdin.write(text);
      } catch {}
    };
    await typeConsole("echo GENESIS-RECOVERY-OK\n");
    const echo = await waitForLog(rec.logPath, /GENESIS-RECOVERY-OK/, 30000);
    check("recovery: console shell answers (echo)", !!echo);
    await typeConsole("sevyn net status\n");
    const netLine = await waitForLog(rec.logPath, /interface:/, 60000);
    check(
      "recovery: sevyn CLI answers (`sevyn net status` prints an interface line)",
      !!netLine,
      netLine ? netLine.trim().slice(0, 160) : "no interface: line",
    );
    await typeConsole("poweroff\n");
    const exitedRec = await waitExit(rec, 30000);
    if (exitedRec) {
      check("recovery: guest powers off from the console", true);
    } else {
      warn(
        "recovery: guest did not power off from the console (forced kill)",
        "the console itself proved usable (echo + sevyn CLI); poweroff is hygiene here",
      );
      closeBoot(rec);
    }
    check(
      "recovery: no SEVYN CRASH in the recovery boot",
      !logHas(rec.logPath, /SEVYN CRASH/),
    );
  } else {
    console.error(readLog(rec.logPath).slice(-3000));
    closeBoot(rec);
  }
  currentBoot = null;

  // 3. Pixman fallback boot (sevyn.pixman=1 -> --no-gles).
  // On the virtual DRM devices available in CI this cannot present
  // a frame (standalone run #8: Mesa GBM reports every buffer
  // Invalid on vkms and virtio-gpu, while Smithay's Pixman renderer
  // refuses to bind anything but LINEAR). The check attempts the
  // boot and records the outcome honestly: proven when a frame
  // presents, NOT_PROVEN (explicit WARN, never a silent pass) when
  // it cannot for the known environmental reason or when the image
  // offers no pixman boot path at all. A crash, or a first-frame
  // failure for a NEW reason, FAILS — a new compositor bug must not
  // hide behind the known limitation.
  const pix = await boot("pix", "sevyn.pixman=1", {
    qmp: false,
    ctl: true,
    appd: false,
  });
  currentBoot = pix;
  try {
    pix.ctl = await connectSocket(pix.ctlSock);
  } catch {
    pix.ctl = null;
  }
  const pixReady = await waitForLog(pix.logPath, /SEVYN READY/, 120000);
  if (pixReady) {
    const pm = pixReady.match(/renderer=(gles|pixman)/);
    if (pm && pm[1] === "pixman") {
      const pixFirst = await waitForLog(
        pix.logPath,
        /SEVYN FIRST FRAME PRESENTED/,
        60000,
      );
      if (pixFirst) {
        measurements.pixman = "proven";
        check(
          "pixman: fallback presents a frame (renderer=pixman)",
          true,
          pixFirst.trim().slice(0, 160),
        );
      } else if (logHas(pix.logPath, /SEVYN CRASH/)) {
        check("pixman: no crash in the pixman boot", false, "SEVYN CRASH in the log");
      } else if (
        logHas(pix.logPath, /first frame failed: Unsupported modifier: Invalid/)
      ) {
        measurements.pixman = "NOT_PROVEN";
        warn(
          "pixman: NOT PROVEN — first frame failed (Unsupported modifier: Invalid)",
          "vkms advertises LINEAR but Mesa GBM reports every buffer Invalid on this box's virtual DRM devices (standalone run #8 evidence); the compositor negotiates LINEAR when the plane offers it and READY renderer=pixman was reached. Real-GPU proof is owed (GF65).",
        );
      } else {
        // No first frame, no crash, and the diag line is not on the
        // console (the compositor's stderr/diags stay in the guest's
        // /tmp/genesis.log, preserved only on compositor exit — this
        // compositor is still running). The console alone cannot
        // distinguish a new first-frame failure from the known
        // environmental one, so this is recorded as NOT_PROVEN with
        // that limitation stated, not as a proven-environmental
        // failure and not as a product failure. The GF65 still owes
        // the real proof.
        measurements.pixman = "NOT_PROVEN";
        warn(
          "pixman: NOT PROVEN — no first frame in 60 s (renderer=pixman READY reached)",
          "no crash; the first-frame diag lives in the guest's /tmp/genesis.log, not the serial log, so the console cannot confirm the known environmental cause (Mesa GBM reports every buffer Invalid on this box's virtual DRM devices — standalone run #8). Real-GPU proof is owed (GF65).",
        );
      }
    } else {
      measurements.pixman = "NOT_PROVEN";
      warn(
        "pixman: NOT PROVEN — sevyn.pixman=1 not honored (READY renderer=gles)",
        "the image offers no --no-gles boot path; the fallback cannot be attempted in CI. Real-GPU proof is owed (GF65).",
      );
    }
  } else {
    measurements.pixman = "NOT_PROVEN";
    warn(
      "pixman: NOT PROVEN — no SEVYN READY in the pixman boot",
      "see genesis-boot-pix.log; the compositor never reached READY with sevyn.pixman=1",
    );
  }
  if (pix.ctl) {
    const exitedPix = await poweroff(pix);
    if (!exitedPix) {
      warn(
        "pixman: guest did not power off (forced kill)",
        "the pixman boot's shutdown is warn-grade, like the pixman proof itself",
      );
      closeBoot(pix);
    } else {
      check("pixman: guest powers off on request", true);
    }
  } else {
    warn(
      "pixman: no statusd control serial in the pixman boot (forced kill)",
      "could not power off cleanly; QEMU killed from the host",
    );
    closeBoot(pix);
  }
  currentBoot = null;

  const pass = checks.every((c) => c.ok);
  console.log(
    `GENESIS MEASUREMENTS output=${measurements.output} socket_up_ms=${measurements.socket_up_ms} first_frame_ms=${measurements.first_frame_ms} rss_mb=${measurements.rss_mb} pixman=${measurements.pixman}`,
  );
  finish(pass, {
    measurements,
    screen: settled ? { width: settled.width, height: settled.height } : null,
    terminal:
      termSurface === null
        ? null
        : {
            surface: termSurface,
            session: termSession,
            size: `${termW}x${termH}`,
          },
  });
}

main().catch((e) => {
  console.error("Genesis check crashed:", e);
  if (currentBoot) closeBoot(currentBoot);
  process.exit(1);
});
