// SevynOS Music — musicd: the music playback daemon.
//
// The Music app is a thin RN UI over the `sevyn music` CLI; this
// daemon owns playback. There is no ALSA/PulseAudio/ffmpeg in the
// image — Chromium 159 is the only media decoder staged — so the
// daemon drives a headless Chromium page (player.html, one <audio>
// element) over CDP, exactly the way commsd's bridge drives Chromium
// for calls (v2/comms/bridge.mjs). The browser's Chromium is NOT
// reused: it belongs to the Browser app and dies with it.
//
//   ChromiumPlayer — headless Chromium + player.html over CDP.
//                    Real decode, real position/duration/volume.
//   NullPlayer     — no Chromium present. A wall-clock timer against
//                    the WAV header's duration: position advances,
//                    pause/seek/volume all work, but media is
//                    explicitly "none" — never presented as sound.
//                    The host-side tests use it; the GF65 proves
//                    real audio.
//
// Protocol: aid-style line protocol over a unix socket (default
// /run/sevyn-music.sock). One line in, one line out:
//   STATUS | PLAY <path...> | PAUSE | RESUME | STOP |
//   SEEK <seconds> | VOLUME <0-100> | SHUTDOWN
// Replies: one bare JSON line, `{ok:true, ...}` or `{ok:false, error}`
// (the CLI prints it verbatim and exits 1 on ok:false).
//
// Guarding (the pre-restart Music bug was a volume-up call killing
// Genesis through an unhandled rejection): EVERY verb runs inside
// handleLine's try/catch and answers {ok:false, error} — the daemon
// never throws out of a verb, never crashes on a bad file, a bad
// seek, or a volume edge. Volume clamps instead of erroring; a seek
// past the end clamps to the duration; a missing file is a clean
// ok:false with the previous state untouched.

import net from "node:net";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
const DATA_DIR = arg("--data", "/data/music");
const SOCK_PATH = arg("--socket", "/run/sevyn-music.sock");
const BRIDGE_MODE = arg("--bridge", "chromium"); // "chromium" | "null"
const CHROME_BIN = arg("--chrome", "");
const PLAYER_PAGE = arg("--bridge-page", "");

const AUDIO_EXTS = new Set([
  ".wav",
  ".mp3",
  ".ogg",
  ".oga",
  ".flac",
  ".m4a",
  ".aac",
  ".opus",
  ".webm",
]);

function log(obj) {
  console.log(`MUSIC ${JSON.stringify(obj)}`);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Chromium player (CDP) — adapted from v2/comms/bridge.mjs
// ---------------------------------------------------------------------------
class ChromiumPlayer {
  constructor({ chromeBin, page }) {
    this.chromeBin = chromeBin || process.env.SEVYN_CHROME || "chromium";
    this.page = page || process.env.SEVYN_PLAYER_PAGE || "";
    this.proc = null;
    this.port = 0;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.started = false;
    this.starting = null;
  }

  async ensureStarted(timeoutMs = 8000) {
    if (this.started) return;
    if (!this.starting) {
      this.starting = this.doStart().then(
        () => {
          this.started = true;
          this.starting = null;
        },
        (e) => {
          this.starting = null;
          throw e;
        },
      );
    }
    // Fail fast: the host kills any `sevyn` exec after 10 s, and a
    // cold Chromium takes ~15-25 s — a verb that arrives mid-warmup
    // fails with "media engine still starting" (the caller retries;
    // the warmup keeps running) instead of hanging to SIGKILL.
    let timer;
    try {
      await Promise.race([
        this.starting,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("media engine still starting")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async doStart() {
    const port = 9333 + Math.floor(Math.random() * 500);
    this.port = port;
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "sevyn-music-"));
    this.profileDir = profileDir;
    try {
      return await this.doStartInner(port, profileDir);
    } catch (e) {
      this.killProc();
      throw e;
    }
  }

  killProc() {
    if (this.proc && !this.proc.killed) {
      try {
        process.kill(-this.proc.pid, "SIGKILL");
      } catch {
        try {
          this.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    this.proc = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
  }

  async doStartInner(port, profileDir) {
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--window-size=640,360",
      "--autoplay-policy=no-user-gesture-required",
      // The player page is file:// and its audio is file:///data/...
      // — file subresources from a file page need this flag.
      "--allow-file-access-from-files",
    ];
    // NOTE: no --mute-audio — this Chromium IS the speaker.
    this.proc = spawn(this.chromeBin, args, { stdio: "ignore", detached: true });
    this.proc.on("error", () => {});
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
        if (version.webSocketDebuggerUrl) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline)
        throw new Error("chromium did not start a DevTools endpoint");
      await new Promise((r) => setTimeout(r, 200));
    }
    const wsUrl = (await httpGetJson(`http://127.0.0.1:${port}/json/version`))
      .webSocketDebuggerUrl;
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    };
    const pageUrl = this.page ? `file://${this.page}` : "about:blank";
    const target = await this.cdp("Target.createTarget", { url: pageUrl });
    this.targetId = target.targetId;
    const attached = await this.cdp("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.cdp("Runtime.enable", {}, this.sessionId);
    await this.cdp("Page.enable", {}, this.sessionId);
    const deadline2 = Date.now() + 120000;
    for (;;) {
      const r = await this.eval(`typeof window.__sevynPlayer`);
      if (r?.result?.value === "object") break;
      if (Date.now() > deadline2)
        throw new Error("player page did not expose __sevynPlayer");
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  cdp(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("player closed (CDP socket gone)"));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 60000);
    });
  }

  async eval(expression) {
    const r = await this.cdp(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (r?.exceptionDetails) {
      throw new Error(
        `player page error: ${JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)}`,
      );
    }
    return r;
  }

  async callFn(fn, arg) {
    const expr = `window.__sevynPlayer.${fn}(${JSON.stringify(arg ?? null)})`;
    const r = await this.eval(expr);
    return r?.result?.value;
  }

  media() {
    return "chromium";
  }

  async load(fileUrl) {
    await this.ensureStarted();
    return this.callFn("load", fileUrl);
  }

  async play() {
    await this.ensureStarted();
    return this.callFn("play");
  }

  async pause() {
    await this.ensureStarted();
    return this.callFn("pause");
  }

  async seek(seconds) {
    await this.ensureStarted();
    return this.callFn("seek", seconds);
  }

  async setVolume(v) {
    await this.ensureStarted();
    return this.callFn("setVolume", v);
  }

  async status() {
    if (!this.started) return null;
    return this.callFn("status");
  }

  async close() {
    this.killProc();
  }
}

// ---------------------------------------------------------------------------
// Null player — no Chromium. Wall-clock timer; media is "none".
// ---------------------------------------------------------------------------
// WAV duration from the RIFF header (fmt + data chunks). Anything
// else: 0 (unknown) — the tests only play WAV.
async function wavDurationSeconds(file) {
  const fh = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, 4096, 0);
    const buf = head.subarray(0, bytesRead);
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return 0;
    let off = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "fmt " && size >= 16) {
        byteRate = buf.readUInt32LE(off + 16);
      } else if (id === "data") {
        dataSize = size;
        break;
      }
      off += 8 + size;
    }
    if (!byteRate || !dataSize) return 0;
    return dataSize / byteRate;
  } finally {
    await fh.close();
  }
}

class NullPlayer {
  constructor() {
    this.offset = 0; // seconds at the last pause/seek/load
    this.duration = 0;
    this.playing = false;
    this.startedAt = 0; // ms epoch when the current run started
    this.loaded = false;
  }

  media() {
    return "none";
  }

  position() {
    if (!this.playing) return this.offset;
    const p = this.offset + (Date.now() - this.startedAt) / 1000;
    return this.duration > 0 ? Math.min(p, this.duration) : p;
  }

  async load(filePath) {
    const fsPath = filePath.startsWith("file://")
      ? filePath.slice("file://".length)
      : filePath;
    this.duration = await wavDurationSeconds(fsPath);
    this.offset = 0;
    this.playing = false;
    this.loaded = true;
    return { duration: this.duration };
  }

  async play() {
    if (!this.loaded) throw new Error("nothing loaded");
    if (!this.playing) {
      this.playing = true;
      this.startedAt = Date.now();
    }
    return { ok: true };
  }

  async pause() {
    this.offset = this.position();
    this.playing = false;
    return { ok: true };
  }

  async seek(seconds) {
    this.offset = seconds;
    if (this.playing) this.startedAt = Date.now();
    return { ok: true };
  }

  async setVolume() {
    return { ok: true };
  }

  async status() {
    return {
      currentTime: this.position(),
      duration: this.duration,
      paused: !this.playing,
      ended: this.duration > 0 && this.position() >= this.duration,
      volume: 0,
      src: "",
      error: "",
    };
  }

  async close() {}
}

// ---------------------------------------------------------------------------
// Daemon state + verbs
// ---------------------------------------------------------------------------
let player = null;
function getPlayer() {
  if (!player) {
    player =
      BRIDGE_MODE === "chromium"
        ? new ChromiumPlayer({ chromeBin: CHROME_BIN, page: PLAYER_PAGE })
        : new NullPlayer();
  }
  return player;
}

// state: idle | playing | paused | stopped | ended
const state = {
  state: "idle",
  path: "",
  position: 0,
  duration: 0,
  volume: 80,
  error: "",
};

function clampVolume(v) {
  if (!Number.isFinite(v)) return state.volume;
  return Math.max(0, Math.min(100, Math.round(v)));
}

async function refreshFromPlayer() {
  try {
    const s = await getPlayer().status();
    if (!s) return;
    state.position = Number.isFinite(s.currentTime) ? s.currentTime : state.position;
    state.duration = Number.isFinite(s.duration) ? s.duration : state.duration;
    if (s.ended && (state.state === "playing" || state.state === "paused")) {
      state.state = "ended";
    } else if (state.state === "playing" && s.paused && !s.ended) {
      state.state = "paused";
    }
    if (s.error) state.error = s.error;
  } catch {
    /* a status read never fails a verb */
  }
}

function snapshot() {
  return {
    ok: true,
    state: state.state,
    path: state.path,
    position: Math.round(state.position * 100) / 100,
    duration: Number.isFinite(state.duration)
      ? Math.round(state.duration * 100) / 100
      : 0,
    volume: state.volume,
    media: getPlayer().media(),
    error: state.error,
  };
}

async function handleLine(line) {
  try {
    const sp = line.indexOf(" ");
    const verb = sp < 0 ? line.trim() : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    switch (verb) {
      case "STATUS": {
        await refreshFromPlayer();
        return snapshot();
      }
      case "PLAY": {
        if (!rest) throw new Error("usage: PLAY <path>");
        if (!path.isAbsolute(rest)) throw new Error("path must be absolute");
        const ext = path.extname(rest).toLowerCase();
        if (!AUDIO_EXTS.has(ext))
          throw new Error(`unsupported audio type ${ext || "(none)"}`);
        let st;
        try {
          st = await fs.stat(rest);
        } catch {
          throw new Error(`no such file: ${rest}`);
        }
        if (!st.isFile()) throw new Error(`not a file: ${rest}`);
        const p = getPlayer();
        const loaded = await p.load(`file://${rest}`);
        state.path = rest;
        state.error = "";
        if (loaded && Number.isFinite(loaded.duration)) state.duration = loaded.duration;
        await p.setVolume(state.volume / 100);
        await p.play();
        state.state = "playing";
        state.position = 0;
        log({ kind: "play", path: rest, duration: state.duration });
        return snapshot();
      }
      case "PAUSE": {
        if (state.state === "idle" || state.state === "stopped")
          throw new Error("nothing playing");
        if (state.state === "playing") {
          await getPlayer().pause();
          await refreshFromPlayer();
          state.state = "paused";
        }
        return snapshot();
      }
      case "RESUME": {
        if (state.state !== "paused" && state.state !== "ended")
          throw new Error("nothing to resume");
        if (state.state === "ended") {
          await getPlayer().seek(0);
          state.position = 0;
        }
        await getPlayer().play();
        state.state = "playing";
        return snapshot();
      }
      case "STOP": {
        if (state.state !== "idle") {
          await getPlayer().pause();
          await getPlayer().seek(0);
          state.state = "stopped";
          state.position = 0;
        }
        return snapshot();
      }
      case "SEEK": {
        const sec = Number(rest);
        if (!Number.isFinite(sec)) throw new Error("usage: SEEK <seconds>");
        if (state.state === "idle" || state.state === "stopped")
          throw new Error("nothing playing");
        const max =
          Number.isFinite(state.duration) && state.duration > 0
            ? state.duration
            : Infinity;
        const clamped = Math.max(0, Math.min(sec, max));
        await getPlayer().seek(clamped);
        state.position = clamped;
        return snapshot();
      }
      case "VOLUME": {
        const v = Number(rest);
        if (!Number.isFinite(v)) throw new Error("usage: VOLUME <0-100>");
        state.volume = clampVolume(v);
        if (state.state !== "idle") {
          try {
            await getPlayer().setVolume(state.volume / 100);
          } catch {
            /* volume set is best-effort once playing; the stored
             * value is what STATUS reports and PLAY applies */
          }
        }
        return snapshot();
      }
      case "SHUTDOWN": {
        setTimeout(() => {
          void (async () => {
            try {
              await getPlayer().close();
            } catch {
              /* no player */
            }
            process.exit(0);
          })();
        }, 50);
        return { ok: true, shuttingDown: true };
      }
      default:
        throw new Error(`unknown verb ${verb || "(empty)"}`);
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.unlink(SOCK_PATH);
  } catch {
    /* no stale socket */
  }
  const server = net.createServer((socket) => {
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      const reply = await handleLine(line);
      socket.write(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => {});
  });
  server.listen(SOCK_PATH, async () => {
    log({ kind: "listening", socket: SOCK_PATH, bridge: BRIDGE_MODE, data: DATA_DIR });
    // Eager player pre-warm (chromium mode only): same 10 s host
    // exec kill as commsd — the engine must already be up before
    // the first PLAY, or the verb dies at 10 s. Best effort: a
    // failed warmup is logged, the next verb retries lazily.
    if (BRIDGE_MODE === "chromium") {
      void getPlayer()
        .ensureStarted(300000)
        .then(() => log({ kind: "player-warm" }))
        .catch((e) =>
          log({ kind: "player-warm-failed", error: String(e?.message || e) }),
        );
    }
  });
  const shutdown = async () => {
    try {
      await getPlayer().close();
    } catch {
      /* no player */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(`MUSIC fatal: ${e?.stack || e}`);
  process.exit(1);
});
