// SevynOS v2 — camd host-side check.
//
// Compiles camd from source, starts it against the synthetic source
// (no camera hardware anywhere in CI), and proves the protocol:
// STATUS/LIST answer, preview frames flow and differ frame to
// frame, shutter writes a valid JPEG, DECODE round-trips that JPEG
// back to RGBA, a missing device answers available:false instead of
// faking a capture, and bad verbs fail cleanly. Also compiles the
// `sevyn` CLI and drives the same daemon through `sevyn camera`
// (socket + JSON + exit codes), the way the apps will.
//
// Usage: node v2/camera/camd-check.mjs
// Env: SEVYN_CAMD_CC (default gcc), SEVYN_CAMD_SKIP_CLI=1 to skip
// the sevyn.c compile (it is one big TU; the image build compiles
// it separately, so skipping here only loses the CLI half).
import { spawn, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAMD_C = join(ROOT, "v2", "camera", "camd.c");
const SEVYN_C = join(ROOT, "v2", "update", "sevyn.c");
const CC = process.env.SEVYN_CAMD_CC || "gcc";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")}: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

function jpegDims(buf) {
  // Minimal JPEG scan: SOI, then segments until a SOF0/1/2 gives dims.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xda) return null; // SOS: no SOF before scan data
    const len = (buf[off + 2] << 8) | buf[off + 3];
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: (buf[off + 5] << 8) | buf[off + 6],
        width: (buf[off + 7] << 8) | buf[off + 8],
      };
    }
    off += 2 + len;
  }
  return null;
}

function pngDims(buf) {
  // PNG magic + IHDR: width/height are big-endian at bytes 16/20.
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || !magic.every((b, i) => buf[i] === b)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

class CamdClient {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.conn = createConnection(sock);
    this.conn.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    this.conn.on("error", () => {});
  }
  drain() {
    let idx;
    while ((idx = this.buf.indexOf(0x0a)) >= 0 && this.waiters.length > 0) {
      const line = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 1);
      const w = this.waiters.shift();
      w(line);
    }
  }
  send(line) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for reply to ${line}`)),
        15_000,
      );
      this.waiters.push((reply) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(reply));
        } catch {
          reject(new Error(`non-JSON reply to ${line}: ${reply}`));
        }
      });
      this.conn.write(`${line}\n`);
    });
  }
  close() {
    this.conn.destroy();
  }
}

const tmp = mkdtempSync(join(tmpdir(), "camd-check-"));
const camdBin = join(tmp, "sevyn-camd");
const dataDir = join(tmp, "data");
mkdirSync(dataDir, { recursive: true });
const sock = join(tmp, "camd.sock");

console.log(`camd-check: workdir ${tmp}`);
await run(CC, [
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-o",
  camdBin,
  CAMD_C,
  "-ljpeg",
  "-lpng",
  "-lz",
]);
check("camd compiles clean (-Wall -Wextra -Werror)", true);

// --- synthetic daemon -------------------------------------------------
const camd = spawn(camdBin, ["--synthetic", "--socket", sock, "--data", dataDir], {
  stdio: ["ignore", "pipe", "pipe"],
});
let camdLog = "";
camd.stdout.on("data", (c) => (camdLog += c.toString()));
camd.stderr.on("data", (c) => (camdLog += c.toString()));
const waitSocket = async (path, tries = 50) => {
  for (let i = 0; i < tries; i++) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
check(
  "synthetic camd starts + creates socket",
  await waitSocket(sock),
  camdLog.slice(-500),
);

const client = new CamdClient(sock);
try {
  const status = await client.send("STATUS");
  check(
    "STATUS: synthetic available",
    status.ok === true && status.available === true && status.source === "synthetic",
    JSON.stringify(status),
  );
  const list = await client.send("LIST");
  check(
    "LIST: synthetic device listed",
    list.ok === true &&
      list.devices?.length === 1 &&
      list.devices[0].device === "synthetic",
    JSON.stringify(list),
  );

  const p1 = await client.send("PREVIEW");
  const p1png = p1.png ? readFileSync(p1.png) : null;
  const p1rgba = p1.rgba ? readFileSync(p1.rgba) : null;
  check(
    "PREVIEW 1: ok + PNG 640x360 + RGBA 640x360x4",
    p1.ok === true &&
      p1.available === true &&
      pngDims(p1png)?.width === 640 &&
      pngDims(p1png)?.height === 360 &&
      p1rgba?.length === 640 * 360 * 4,
    JSON.stringify({ width: p1.width, height: p1.height, png: p1.png, rgba: p1.rgba }),
  );
  const p2 = await client.send("PREVIEW");
  const p2png = p2.png ? readFileSync(p2.png) : null;
  check(
    "PREVIEW 2: new path (painter cache-bust) + frame differs",
    p2.ok === true && p2.png !== p1.png && p2png !== null && !p2png.equals(p1png),
    `p1=${p1.png} p2=${p2.png}`,
  );
  check(
    "PREVIEW 1 files pruned after PREVIEW 2",
    !existsSync(p1.png) && !existsSync(p1.rgba),
  );

  const shot = join(dataDir, "shot.jpg");
  const cap = await client.send(`CAPTURE ${shot}`);
  const jpg = existsSync(shot) ? readFileSync(shot) : null;
  const dims = jpg ? jpegDims(jpg) : null;
  check(
    "CAPTURE: valid JPEG 1280x720 on disk",
    cap.ok === true &&
      cap.path === shot &&
      jpg !== null &&
      jpg.length > 1024 &&
      jpg[jpg.length - 2] === 0xff &&
      jpg[jpg.length - 1] === 0xd9 &&
      dims?.width === 1280 &&
      dims?.height === 720,
    JSON.stringify({ ...cap, bytesOnDisk: jpg?.length, dims }),
  );

  const rgbaOut = join(dataDir, "decoded.rgba");
  const dec = await client.send(`DECODE ${shot} ${rgbaOut}`);
  const decPng = dec.png ? readFileSync(dec.png) : null;
  check(
    "DECODE: JPEG -> RGBA + PNG sidecar",
    dec.ok === true &&
      dec.available === true &&
      dec.width === 1280 &&
      dec.height === 720 &&
      existsSync(rgbaOut) &&
      readFileSync(rgbaOut).length === 1280 * 720 * 4 &&
      pngDims(decPng)?.width === 1280,
    JSON.stringify(dec),
  );

  writeFileSync(join(dataDir, "junk.bin"), Buffer.from("not a jpeg at all"));
  const badDec = await client.send(
    `DECODE ${join(dataDir, "junk.bin")} ${join(dataDir, "junk.rgba")}`,
  );
  check(
    "DECODE of non-JPEG: available:false, daemon alive",
    badDec.ok === true && badDec.available === false,
    JSON.stringify(badDec),
  );
  const badVerb = await client.send("BOGUS");
  check(
    "unknown verb: ok:false, daemon alive",
    badVerb.ok === false && typeof badVerb.error === "string",
  );
  const badCap = await client.send("CAPTURE relative/path.jpg");
  check("relative CAPTURE path rejected", badCap.ok === false, JSON.stringify(badCap));
  const alive = await client.send("STATUS");
  check("daemon alive after bad input", alive.ok === true && alive.available === true);
} finally {
  client.close();
}

// --- CLI through `sevyn camera` ----------------------------------------
if (process.env.SEVYN_CAMD_SKIP_CLI !== "1") {
  const sevynBin = join(tmp, "sevyn");
  await run(CC, [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    sevynBin,
    SEVYN_C,
    "-lcrypto",
  ]);
  check("sevyn CLI compiles clean (-Wall -Wextra -Werror)", true);
  const cli = (args) =>
    run(sevynBin, ["camera", "--socket", sock, ...args]).then(
      (r) => ({ code: 0, out: r.stdout }),
      (e) => ({ code: 1, out: e.message }),
    );
  // NOTE: the daemon above is still running; re-open a fresh client
  // connection through the CLI instead.
  const st = await cli(["status"]);
  let parsed = null;
  try {
    parsed = JSON.parse(st.out.trim());
  } catch {}
  check(
    "`sevyn camera status` exits 0 with synthetic JSON",
    st.code === 0 && parsed?.available === true && parsed?.source === "synthetic",
    st.out.trim().slice(0, 200),
  );
  const pv = await cli(["preview"]);
  let pvParsed = null;
  try {
    pvParsed = JSON.parse(pv.out.trim());
  } catch {}
  check(
    "`sevyn camera preview` exits 0 with a PNG path",
    pv.code === 0 &&
      pvParsed?.ok === true &&
      typeof pvParsed?.png === "string" &&
      existsSync(pvParsed.png),
    pv.out.trim().slice(0, 200),
  );
  const shot2 = join(dataDir, "cli-shot.jpg");
  const cp = await cli(["capture", shot2]);
  let cpParsed = null;
  try {
    cpParsed = JSON.parse(cp.out.trim());
  } catch {}
  check(
    "`sevyn camera capture` exits 0 with a real JPEG",
    cp.code === 0 &&
      cpParsed?.ok === true &&
      existsSync(shot2) &&
      jpegDims(readFileSync(shot2))?.width === 1280,
    cp.out.trim().slice(0, 200),
  );
  const bad = await cli(["nonsense"]);
  check("`sevyn camera nonsense` exits 1 (usage)", bad.code === 1);
}

// --- no-device daemon ---------------------------------------------------
const sock2 = join(tmp, "camd-nodev.sock");
const dataDir2 = join(tmp, "data2");
mkdirSync(dataDir2, { recursive: true });
const camd2 = spawn(camdBin, ["--socket", sock2, "--data", dataDir2], {
  stdio: ["ignore", "pipe", "pipe"],
});
check("no-device camd starts", await waitSocket(sock2));
const client2 = new CamdClient(sock2);
try {
  const st2 = await client2.send("STATUS");
  check(
    "no-device STATUS: available:false, source none",
    st2.ok === true && st2.available === false && st2.source === "none",
    JSON.stringify(st2),
  );
  const pv2 = await client2.send("PREVIEW");
  check(
    "no-device PREVIEW: available:false, not an error",
    pv2.ok === true && pv2.available === false,
    JSON.stringify(pv2),
  );
  const cp2 = await client2.send("CAPTURE");
  check(
    "no-device CAPTURE: ok:false (never fakes a photo)",
    cp2.ok === false,
    JSON.stringify(cp2),
  );
  const l2 = await client2.send("LIST");
  check(
    "no-device LIST: empty",
    l2.ok === true && l2.devices?.length === 0,
    JSON.stringify(l2),
  );
} finally {
  client2.close();
}

// --- shutdown -----------------------------------------------------------
const client3 = new CamdClient(sock);
try {
  const sd = await client3.send("SHUTDOWN");
  check("SHUTDOWN replies ok", sd.ok === true);
} finally {
  client3.close();
}
const exited = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 5_000);
  camd.once("exit", (code) => {
    clearTimeout(t);
    resolve(code === 0);
  });
});
check("synthetic camd exits 0 on SHUTDOWN", exited);
const exited2 = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 5_000);
  camd2.once("exit", (code) => {
    clearTimeout(t);
    resolve(code === 0);
  });
  camd2.kill("SIGTERM");
});
check("no-device camd exits 0 on SIGTERM", exited2);

if (failures > 0) {
  console.log(`camd-check: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("camd-check: all green");
