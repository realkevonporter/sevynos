// SevynOS Music — host-side musicd test (null player).
//
// Spawns musicd --bridge null and drives it over its control socket:
// idle status, guarded bad calls (missing file, non-audio file,
// relative path, bad seek, bad volume — each must answer {ok:false}
// WITHOUT killing the daemon), then a real 3 s WAV fixture: play,
// position advances, pause holds, seek clamps, volume clamps,
// resume, stop. The null player advances position on a wall clock
// against the WAV header duration; media stays "none" — this proves
// the daemon + protocol, never sound. Real audio is proven on the
// GF65 (Chromium player) and in-guest by the music check.
//
// Run: node test-musicd.mjs
// Exit 0 = full pass. Prints PASS/FAIL per assertion.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = "/tmp/sevyn-music-test";
const SOCK = path.join(TMP, "music.sock");
const DATA = path.join(TMP, "data");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// A 3 s 440 Hz sine, 16-bit mono PCM 44.1 kHz WAV.
async function writeWavFixture(file) {
  const sampleRate = 44100;
  const seconds = 3;
  const n = sampleRate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    data.writeInt16LE(s, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  await fs.writeFile(file, Buffer.concat([header, data]));
}

// One control-socket client: send a line, await one reply line.
class Musicd {
  constructor(sockPath) {
    this.sockPath = sockPath;
    this.buf = "";
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.sockPath);
      this.socket.on("connect", resolve);
      this.socket.on("error", reject);
      this.socket.on("data", (d) => {
        this.buf += d.toString("utf8");
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          const w = this.waiters.shift();
          if (w) w(line);
        }
      });
    });
  }
  send(line) {
    return new Promise((resolve) => {
      this.waiters.push((l) => resolve(JSON.parse(l)));
      this.socket.write(line + "\n");
    });
  }
}

async function waitForSocket(sockPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(sockPath)) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(DATA, { recursive: true });
  const wav = path.join(DATA, "tone.wav");
  await writeWavFixture(wav);
  const txt = path.join(DATA, "notes.txt");
  await fs.writeFile(txt, "not audio\n");

  const daemon = spawn(
    "node",
    [path.join(HERE, "musicd.mjs"), "--socket", SOCK, "--data", DATA, "--bridge", "null"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let daemonErr = "";
  daemon.stderr.on("data", (d) => {
    daemonErr += d.toString("utf8");
  });
  if (!(await waitForSocket(SOCK))) {
    check("musicd listens on its socket", false, daemonErr.slice(-500));
    daemon.kill();
    process.exit(1);
  }
  check("musicd listens on its socket", true);
  const m = new Musicd(SOCK);
  await m.connect();

  let r = await m.send("STATUS");
  check(
    "idle status: state idle, media none",
    r.ok === true && r.state === "idle" && r.media === "none",
    JSON.stringify(r),
  );

  // --- Guarded bad calls: each must answer ok:false AND the daemon
  // must stay alive for the next verb (the old bug: one bad call
  // killed the player). ---
  r = await m.send("PLAY /no/such/file.wav");
  check("play missing file -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send(`PLAY ${txt}`);
  check("play non-audio file -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("PLAY relative/path.wav");
  check("play relative path -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("PLAY");
  check("play with no path -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("SEEK abc");
  check("seek non-number -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("VOLUME abc");
  check("volume non-number -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("PAUSE");
  check("pause with nothing playing -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("RESUME");
  check("resume with nothing to resume -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("BOGUS");
  check("unknown verb -> ok:false", r.ok === false, JSON.stringify(r));
  r = await m.send("STATUS");
  check(
    "daemon alive after bad calls, still idle",
    r.ok === true && r.state === "idle",
    JSON.stringify(r),
  );

  // --- Real playback (null player: position on a wall clock). ---
  r = await m.send(`PLAY ${wav}`);
  check(
    "play wav -> ok, playing, duration ~3s",
    r.ok === true && r.state === "playing" && Math.abs(r.duration - 3) < 0.05,
    JSON.stringify(r),
  );
  await sleep(1200);
  r = await m.send("STATUS");
  check(
    "position advances while playing (~1.2s)",
    r.ok === true && r.state === "playing" && r.position > 0.7 && r.position < 1.8,
    JSON.stringify(r),
  );
  const posBeforePause = r.position;
  r = await m.send("PAUSE");
  check("pause -> paused", r.ok === true && r.state === "paused", JSON.stringify(r));
  await sleep(600);
  r = await m.send("STATUS");
  check(
    "position holds while paused",
    r.ok === true && Math.abs(r.position - posBeforePause) < 0.25,
    JSON.stringify(r),
  );
  r = await m.send("SEEK 2");
  check(
    "seek 2 -> position 2",
    r.ok === true && Math.abs(r.position - 2) < 0.05,
    JSON.stringify(r),
  );
  r = await m.send("SEEK 99");
  check(
    "seek past end clamps to duration",
    r.ok === true && Math.abs(r.position - r.duration) < 0.05,
    JSON.stringify(r),
  );
  r = await m.send("SEEK -5");
  check(
    "seek negative clamps to 0",
    r.ok === true && r.position === 0,
    JSON.stringify(r),
  );
  r = await m.send("VOLUME 150");
  check("volume 150 clamps to 100", r.ok === true && r.volume === 100, JSON.stringify(r));
  r = await m.send("VOLUME -5");
  check("volume -5 clamps to 0", r.ok === true && r.volume === 0, JSON.stringify(r));
  r = await m.send("VOLUME 42");
  check("volume 42 sticks", r.ok === true && r.volume === 42, JSON.stringify(r));
  r = await m.send("RESUME");
  check("resume -> playing", r.ok === true && r.state === "playing", JSON.stringify(r));
  r = await m.send("STOP");
  check(
    "stop -> stopped, position 0",
    r.ok === true && r.state === "stopped" && r.position === 0,
    JSON.stringify(r),
  );
  r = await m.send("STATUS");
  check(
    "status after stop is stopped",
    r.ok === true && r.state === "stopped",
    JSON.stringify(r),
  );

  await m.send("SHUTDOWN");
  await sleep(500);
  daemon.kill();
  await fs.rm(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test-musicd crashed:", e);
  process.exit(1);
});
