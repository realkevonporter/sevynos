// SevynOS v2 — audiod host harness (CI proof without audio hardware).
//
// Spawns sevyn-audiod against the ALSA null PCM device (no sound card
// needed — playback is paced to real time, so position advances at 1x)
// and drives it over its Unix socket:
//   status/plays all 7 test WAVs + mp3/flac/ogg fixtures, pause/resume
//   freeze + resume position, seek (valid + out-of-range + garbage),
//   volume (valid + clamped edges + garbage), bad calls while idle,
//   SCAN with real probed durations, and a clean SHUTDOWN.
// What it CAN prove: the daemon answers, decodes all four formats,
// position is real (advances, freezes on pause, moves on seek),
// every bad call returns a clean {ok:false, code} and the daemon
// stays up. What it CANNOT prove: audible output on real hardware —
// only the GF65 (HDA device "default") proves sound comes out.
//
// Usage:
//   SEVYN_AUDIOD_BIN=/path/to/sevyn-audiod node test-audiod.mjs
//   (default binary: v2/build/sevyn-audiod — CI sets SEVYN_AUDIOD_BIN
//   to the binary it just compiled)
//   SEVYN_AUDIO_TEST_MEDIA=/path/to/audio (default
//   ~/workspace/sevynos-test-media/audio — falls back to the
//   fixtures dir for every check when the 7 WAVs are absent)
// Exit 0 = full pass. Prints PASS/FAIL per assertion.

import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.SEVYN_AUDIOD_BIN || path.join(HERE, "..", "build", "sevyn-audiod");
const SOCK = process.env.SEVYN_AUDIOD_SOCK || "/tmp/sevyn-audiod-test.sock";
const MEDIA =
  process.env.SEVYN_AUDIO_TEST_MEDIA ||
  path.join(
    process.env.HOME || "/home/hatch",
    "workspace",
    "sevynos-test-media",
    "audio",
  );
const FIXTURES = path.join(HERE, "test", "fixtures");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}
function approx(name, got, want, tol) {
  check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want} ± ${tol}`);
}

let client = null;
let buf = "";
let waiters = [];
function onData(chunk) {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const w = waiters.shift();
    if (w) w(JSON.parse(line));
  }
}
function cmd(line) {
  return new Promise((resolve) => {
    waiters.push(resolve);
    client.write(line + "\n");
  });
}

const trackDurations = {
  "01-sunrise-acoustic.wav": 21.5,
  "02-midnight-jazz.wav": 25.5,
  "03-ocean-breeze.wav": 24.833,
  "04-city-lights.wav": 27.75,
  "05-forest-dawn.wav": 22.833,
  "06-desert-drive.wav": 22.929,
  "07-starlight-lullaby.wav": 29.5,
};

async function main() {
  const bin = await fs.stat(BIN).catch(() => null);
  if (!bin) {
    console.log(`SKIP audiod harness: binary not found at ${BIN} (build it first)`);
    process.exit(0);
  }
  await fs.rm(SOCK, { force: true });

  const proc = spawn(BIN, ["--socket", SOCK, "--device", "null"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c) => {
    stderr += c;
  });
  const exited = new Promise((r) => proc.once("close", (code) => r(code)));

  // Wait for the socket to appear.
  let connected = false;
  for (let i = 0; i < 50 && !connected; i++) {
    await sleep(100);
    try {
      await fs.stat(SOCK);
      connected = true;
    } catch {
      /* not yet */
    }
  }
  check("audiod: socket appears", connected);
  if (!connected) {
    console.log(stderr);
    process.kill(proc.pid, "SIGKILL");
    process.exit(1);
  }
  client = net.connect(SOCK);
  client.on("data", onData);
  await new Promise((r) => client.once("connect", r));

  // --- idle state + bad calls before anything plays -------------------
  let s = await cmd("STATUS");
  check("status: idle, available on null device", s.ok && !s.playing && s.available);
  check("status: volume starts at 100", s.volume === 100);

  const idlePause = await cmd("PAUSE");
  check("pause while idle: clean idle error", !idlePause.ok && idlePause.code === "idle");
  const idleResume = await cmd("RESUME");
  check(
    "resume while idle: clean idle error",
    !idleResume.ok && idleResume.code === "idle",
  );
  const idleSeek = await cmd("SEEK 5");
  check("seek while idle: clean idle error", !idleSeek.ok && idleSeek.code === "idle");
  const idleStop = await cmd("STOP");
  check("stop while idle: ok, stays idle", idleStop.ok && !idleStop.playing);
  const unknown = await cmd("FROBNICATE");
  check(
    "unknown command: clean bad-argument",
    !unknown.ok && unknown.code === "bad-argument",
  );
  const noArg = await cmd("PLAY");
  check(
    "PLAY with no path: clean bad-argument",
    !noArg.ok && noArg.code === "bad-argument",
  );
  const relative = await cmd("PLAY relative/path.wav");
  check(
    "PLAY with relative path: clean bad-argument",
    !relative.ok && relative.code === "bad-argument",
  );
  const missing = await cmd("PLAY /data/does-not-exist.wav");
  check(
    "PLAY missing file: clean not-found",
    !missing.ok && missing.code === "not-found",
  );
  const notAudio = await cmd(`PLAY ${path.join(FIXTURES, "not-audio.wav")}`);
  check(
    "PLAY non-audio file: clean error, daemon alive",
    !notAudio.ok && typeof notAudio.code === "string",
  );
  s = await cmd("STATUS");
  check("daemon alive after bad PLAYs", s.ok && !s.playing);

  // --- the 7 test WAVs -------------------------------------------------
  const mediaFiles = await fs.readdir(MEDIA).catch(() => []);
  const wavs = mediaFiles.filter((f) => f.endsWith(".wav")).sort();
  if (wavs.length === 0) {
    console.log("NOTE: 7 test WAVs absent — checking fixtures only");
  }
  check("test media: 7 WAVs present", wavs.length === 7, `found ${wavs.length}`);
  for (const name of wavs) {
    const p = path.join(MEDIA, name);
    const r = await cmd(`PLAY ${p}`);
    check(
      `play ${name}: ok, format wav`,
      r.ok && r.track?.format === "wav",
      JSON.stringify(r).slice(0, 120),
    );
    if (r.ok) {
      approx(
        `play ${name}: real duration`,
        r.durationSec,
        trackDurations[name] ?? 0,
        0.15,
      );
      await sleep(1500);
      s = await cmd("STATUS");
      check(
        `play ${name}: position advances in real time`,
        s.positionSec > 0.5 && s.positionSec < 3,
        `pos ${s.positionSec}`,
      );
      check(`play ${name}: still playing`, s.playing && !s.paused);
      await cmd("STOP");
    }
  }

  // --- pause / resume / seek / volume on one track --------------------
  const track1 = path.join(MEDIA, "01-sunrise-acoustic.wav");
  const first = wavs.length > 0 ? track1 : path.join(FIXTURES, "clip.wav");
  let r = await cmd(`PLAY ${first}`);
  check("play track 1: ok", r.ok);
  await sleep(1200);
  const paused = await cmd("PAUSE");
  check("pause: reports paused", paused.ok && paused.paused);
  const posA = paused.positionSec;
  await sleep(700);
  s = await cmd("STATUS");
  check(
    "pause: position frozen",
    Math.abs(s.positionSec - posA) < 0.05,
    `was ${posA}, now ${s.positionSec}`,
  );
  const resumed = await cmd("RESUME");
  check("resume: reports playing", resumed.ok && resumed.playing && !resumed.paused);
  await sleep(900);
  s = await cmd("STATUS");
  check(
    "resume: position advances again",
    s.positionSec > posA + 0.4,
    `was ${posA}, now ${s.positionSec}`,
  );

  const seeked = await cmd("SEEK 10");
  check("seek 10s: ok", seeked.ok);
  approx("seek 10s: position moves to 10", seeked.positionSec, 10, 0.4);
  await sleep(700);
  s = await cmd("STATUS");
  check(
    "seek: playback continues from 10",
    s.positionSec > 10 && s.positionSec < 12,
    `pos ${s.positionSec}`,
  );

  const seekNeg = await cmd("SEEK -1");
  check("seek -1: clean out-of-range", !seekNeg.ok && seekNeg.code === "out-of-range");
  const seekFar = await cmd("SEEK 9999");
  check(
    "seek past end: clean out-of-range",
    !seekFar.ok && seekFar.code === "out-of-range",
  );
  const seekGarbage = await cmd("SEEK abc");
  check(
    "seek garbage: clean bad-argument",
    !seekGarbage.ok && seekGarbage.code === "bad-argument",
  );
  const seekNaN = await cmd("SEEK NaN");
  check(
    "seek NaN: clean bad-argument (never UB)",
    !seekNaN.ok && seekNaN.code === "bad-argument",
  );
  s = await cmd("STATUS");
  check("daemon alive after bad seeks, still playing", s.ok && s.playing);

  const vol50 = await cmd("VOLUME 50");
  check("volume 50: applied", vol50.ok && vol50.volume === 50);
  const volHigh = await cmd("VOLUME 150");
  check("volume 150: clamped to 100, no crash", volHigh.ok && volHigh.volume === 100);
  const volLow = await cmd("VOLUME -5");
  check("volume -5: clamped to 0, no crash", volLow.ok && volLow.volume === 0);
  const volGarbage = await cmd("VOLUME loud");
  check(
    "volume garbage: clean bad-argument",
    !volGarbage.ok && volGarbage.code === "bad-argument",
  );
  const volNaN = await cmd("VOLUME NaN");
  check(
    "volume NaN: clean bad-argument (never UB)",
    !volNaN.ok && volNaN.code === "bad-argument",
  );
  await cmd("VOLUME 100");
  s = await cmd("STATUS");
  check("daemon alive after bad volumes, still playing", s.ok && s.playing);

  // Switching tracks mid-play replaces the old one.
  const second =
    wavs.length > 1
      ? path.join(MEDIA, "02-midnight-jazz.wav")
      : path.join(FIXTURES, "clip.flac");
  r = await cmd(`PLAY ${second}`);
  check("play while playing: switches track", r.ok && r.track?.path === second);
  await cmd("STOP");
  s = await cmd("STATUS");
  check("stop: back to idle", s.ok && !s.playing && s.track === null);

  // --- mp3 / flac / ogg fixtures --------------------------------------
  for (const [file, fmt] of [
    ["clip.mp3", "mp3"],
    ["clip.flac", "flac"],
    ["clip.ogg", "ogg"],
  ]) {
    r = await cmd(`PLAY ${path.join(FIXTURES, file)}`);
    check(
      `play ${file}: ok, format ${fmt}`,
      r.ok && r.track?.format === fmt,
      JSON.stringify(r).slice(0, 120),
    );
    if (r.ok) {
      approx(`play ${file}: real duration ~2s`, r.durationSec, 2, 0.35);
      // A 2s clip ends on its own: position must reach duration and
      // playing must go false — end-of-track, not a hang.
      await sleep(2600);
      s = await cmd("STATUS");
      check(
        `play ${file}: ends cleanly at duration`,
        !s.playing && Math.abs(s.positionSec - s.durationSec) < 0.15,
        `pos ${s.positionSec} dur ${s.durationSec}`,
      );
    }
  }

  // --- SCAN -------------------------------------------------------------
  const scanDir = FIXTURES;
  const scan = await cmd(`SCAN ${scanDir}`);
  const names = (scan.tracks || []).map((t) => path.basename(t.path)).sort();
  check(
    "scan: finds the decodable fixtures",
    scan.ok &&
      names.includes("clip.mp3") &&
      names.includes("clip.flac") &&
      names.includes("clip.ogg") &&
      names.includes("clip.wav"),
    names.join(","),
  );
  check(
    "scan: skips undecodable files, never fails",
    scan.ok && !names.includes("not-audio.wav") && !names.includes("truncated.wav"),
    names.join(","),
  );
  const clipTrack = (scan.tracks || []).find((t) => t.path.endsWith("clip.wav"));
  check(
    "scan: real probed duration (not hardcoded)",
    clipTrack && Math.abs(clipTrack.durationSec - 2) < 0.15,
    `dur ${clipTrack?.durationSec}`,
  );
  const scanMissing = await cmd("SCAN /data/does-not-exist-dir");
  check(
    "scan missing dir: clean not-found",
    !scanMissing.ok && scanMissing.code === "not-found",
  );
  if (wavs.length === 7) {
    const full = await cmd(`SCAN ${MEDIA}`);
    check(
      "scan test media: all 7 WAVs, real durations",
      full.ok && full.tracks.length === 7 && full.tracks.every((t) => t.durationSec > 20),
      `found ${full.tracks?.length}`,
    );
  }

  // --- shutdown ----------------------------------------------------------
  const bye = await cmd("SHUTDOWN");
  check("shutdown: ok", bye.ok);
  client.end();
  const code = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
  check("audiod exits cleanly after SHUTDOWN", code === 0, `exit ${code}`);
  if (code !== 0) proc.kill("SIGKILL");

  console.log(
    failures === 0 ? "AUDIOD HARNESS: ALL PASS" : `AUDIOD HARNESS: ${failures} FAILURES`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS CRASH", e);
  process.exit(1);
});
