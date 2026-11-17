/**
 * SevynOS v2 — audiod client (Linux host side of the native audio stack).
 *
 * The host's `media` adapter (and the `audio` adapter's playback
 * methods) talk to audiod — the native audio daemon from PR 1 — over
 * its Unix socket, one JSON line per request. This client is the only
 * place in the host that speaks the audiod protocol, and it is where
 * the old volume-up bug is made impossible by construction:
 *
 *   1. Every argument is validated HERE, before any I/O. A bad path,
 *      a NaN seek, or a non-numeric volume is a rejected promise
 *      with a stable `code` — never a synchronous throw, never an
 *      unhandled rejection escaping into Genesis.
 *   2. Every transport failure (no daemon, socket error, timeout,
 *      malformed reply) is converted to an `AudiodError` with the
 *      code `audio-unavailable`. Nothing hangs: each request has a
 *      timeout, and a dead socket is closed, never retried in a loop.
 *   3. A daemon `{ok:false}` reply is a rejected promise carrying
 *      the daemon's own stable code (`idle`, `not-found`,
 *      `unsupported-format`, `out-of-range`, ...). The caller gets a
 *      reason it can show, not a crash.
 *   4. Position and duration come from the daemon (frames written
 *      minus `snd_pcm_delay()`). This client keeps NO clock, NO
 *      hardcoded duration, and NO playback state of its own — there
 *      is nothing here that can drift from what is actually playing.
 *
 * The transport is injectable so tests drive a fake audiod without a
 * real daemon or socket. Production uses `SocketAudiodTransport`
 * (default socket `/run/sevyn-audio.sock`, override with
 * `SEVYN_AUDIO_SOCK`).
 */

import net from "node:net";
import { basename } from "node:path";

/** A rejected audio call. `code` is stable — callers switch on it. */
export class AudiodError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AudiodError";
    this.code = code;
  }
}

export interface AudiodTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationSec: number;
  readonly path: string;
  readonly format: string;
}

export interface AudiodStatus {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly currentPositionSec: number;
  readonly durationSec: number;
  readonly volume: number;
  readonly track: AudiodTrack | null;
  readonly available: boolean;
}

export interface AudiodTransport {
  /** One line out, one parsed JSON object back. Rejects with AudiodError. */
  roundtrip(line: string): Promise<Record<string, unknown>>;
}

/**
 * The real transport: one short-lived Unix socket connection per
 * request (like `sevyn music` — no connection lifecycle to leak,
 * no stale-socket recovery to get wrong).
 */
export class SocketAudiodTransport implements AudiodTransport {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  public constructor(
    socketPath: string = process.env["SEVYN_AUDIO_SOCK"] ?? "/run/sevyn-audio.sock",
    timeoutMs = 5000,
  ) {
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
  }

  public roundtrip(line: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.#socketPath);
      let settled = false;
      let buffer = "";
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(
          new AudiodError(
            "audio-unavailable",
            "Timed out waiting for the audio service.",
          ),
        );
      }, this.#timeoutMs);
      socket.once("connect", () => {
        socket.write(`${line}\n`);
      });
      socket.once("error", (error: Error) => {
        fail(
          new AudiodError(
            "audio-unavailable",
            `Cannot reach the audio service: ${error.message}`,
          ),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        socket.destroy();
        try {
          const parsed: unknown = JSON.parse(buffer.slice(0, newline));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            reject(
              new AudiodError("audio-unavailable", "Audio service sent a bad reply."),
            );
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new AudiodError("audio-unavailable", "Audio service sent a bad reply."));
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(
            new AudiodError(
              "audio-unavailable",
              "Audio service closed the connection without answering.",
            ),
          );
        }
      });
    });
  }
}

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg"]);

function trackFromDaemon(
  raw: Record<string, unknown>,
  fallbackDurationSec: number,
): AudiodTrack | null {
  const path = typeof raw["path"] === "string" ? raw["path"] : "";
  if (path.length === 0) return null;
  const format = typeof raw["format"] === "string" ? raw["format"] : extensionOf(path);
  const durationSec =
    typeof raw["durationSec"] === "number" && Number.isFinite(raw["durationSec"])
      ? raw["durationSec"]
      : fallbackDurationSec;
  const base = basename(path).replace(/\.[^.]+$/, "");
  return {
    id: path,
    title: typeof raw["title"] === "string" ? raw["title"] : base,
    artist: typeof raw["artist"] === "string" ? raw["artist"] : "Unknown Artist",
    album: typeof raw["album"] === "string" ? raw["album"] : "Local Library",
    durationSec,
    path,
    format,
  };
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return AUDIO_EXTENSIONS.has(ext) ? ext.slice(1) : "wav";
}

function statusFromDaemon(reply: Record<string, unknown>): AudiodStatus {
  const rawTrack = reply["track"];
  const track =
    typeof rawTrack === "object" && rawTrack !== null && !Array.isArray(rawTrack)
      ? trackFromDaemon(
          rawTrack as Record<string, unknown>,
          typeof reply["durationSec"] === "number" ? reply["durationSec"] : 0,
        )
      : null;
  return {
    playing: reply["playing"] === true,
    paused: reply["paused"] === true,
    currentPositionSec:
      typeof reply["positionSec"] === "number" ? reply["positionSec"] : 0,
    durationSec: typeof reply["durationSec"] === "number" ? reply["durationSec"] : 0,
    volume: typeof reply["volume"] === "number" ? reply["volume"] : 100,
    track,
    available: reply["available"] !== false,
  };
}

function toAudiodError(error: unknown): AudiodError {
  if (error instanceof AudiodError) return error;
  if (error instanceof Error)
    return new AudiodError("audio-unavailable", `Audio service failed: ${error.message}`);
  return new AudiodError("audio-unavailable", "Audio service failed.");
}

function isPlaySource(value: unknown): value is AudiodPlaySource {
  return typeof value === "object" && value !== null;
}

export interface AudiodPlaySource {
  readonly path: string;
  readonly track?: AudiodTrack | undefined;
}

/**
 * The audiod client. Every method validates its arguments first and
 * returns a rejected promise (never a synchronous throw) on any bad
 * input or daemon failure. Callers `await` + `try/catch` exactly one
 * error type: `AudiodError`.
 */
export class LinuxAudiodClient {
  readonly #transport: AudiodTransport;

  public constructor(transport: AudiodTransport = new SocketAudiodTransport()) {
    this.#transport = transport;
  }

  public async play(source: string | AudiodPlaySource): Promise<AudiodStatus> {
    let path = "";
    let givenTrack: AudiodTrack | undefined;
    if (typeof source === "string") {
      path = source;
    } else if (isPlaySource(source)) {
      if (typeof source.path === "string") path = source.path;
      givenTrack = source.track;
    }
    if (path.length === 0)
      return Promise.reject(
        new AudiodError("bad-argument", "Audio playback requires a file path."),
      );
    if (!path.startsWith("/"))
      return Promise.reject(
        new AudiodError("bad-argument", "Audio playback requires an absolute path."),
      );
    try {
      const reply = await this.#command(`PLAY ${path}`);
      const status = statusFromDaemon(reply);
      // The caller-supplied track (title/artist from the library)
      // wins over the daemon's bare path/format/duration track.
      if (givenTrack !== undefined && status.track !== null) {
        return {
          ...status,
          track: {
            ...status.track,
            id: givenTrack.id,
            title: givenTrack.title,
            artist: givenTrack.artist,
            album: givenTrack.album,
          },
        };
      }
      return status;
    } catch (error) {
      return Promise.reject(toAudiodError(error));
    }
  }

  public async pause(): Promise<AudiodStatus> {
    return this.#statusCommand("PAUSE");
  }

  public async resume(): Promise<AudiodStatus> {
    return this.#statusCommand("RESUME");
  }

  public async stop(): Promise<AudiodStatus> {
    return this.#statusCommand("STOP");
  }

  public async seek(seconds: number): Promise<AudiodStatus> {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
      return Promise.reject(
        new AudiodError(
          "bad-argument",
          "Seek requires a finite number of seconds (0 or more).",
        ),
      );
    return this.#statusCommand(`SEEK ${String(seconds)}`);
  }

  public async setVolume(volume: number): Promise<AudiodStatus> {
    if (typeof volume !== "number" || !Number.isFinite(volume))
      return Promise.reject(
        new AudiodError("bad-argument", "Volume requires a finite number 0..100."),
      );
    // The daemon clamps out-of-range values (amixer-style) and the
    // reply reports the volume actually applied — never an error.
    return this.#statusCommand(`VOLUME ${String(volume)}`);
  }

  public async status(): Promise<AudiodStatus> {
    return this.#statusCommand("STATUS");
  }

  public async scan(directory?: string): Promise<readonly AudiodTrack[]> {
    if (
      directory !== undefined &&
      (typeof directory !== "string" || directory.length === 0)
    )
      return Promise.reject(
        new AudiodError("bad-argument", "Scan requires a directory path."),
      );
    try {
      const reply = await this.#command(
        directory === undefined ? "SCAN" : `SCAN ${directory}`,
      );
      const tracks = reply["tracks"];
      if (!Array.isArray(tracks))
        throw new AudiodError(
          "audio-unavailable",
          "Audio service sent a bad scan reply.",
        );
      const out: AudiodTrack[] = [];
      for (const entry of tracks) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const track = trackFromDaemon(entry as Record<string, unknown>, 0);
        if (track !== null) out.push(track);
      }
      return out;
    } catch (error) {
      return Promise.reject(toAudiodError(error));
    }
  }

  async #statusCommand(line: string): Promise<AudiodStatus> {
    try {
      return statusFromDaemon(await this.#command(line));
    } catch (error) {
      return Promise.reject(toAudiodError(error));
    }
  }

  async #command(line: string): Promise<Record<string, unknown>> {
    let reply: Record<string, unknown>;
    try {
      reply = await this.#transport.roundtrip(line);
    } catch (error) {
      throw toAudiodError(error);
    }
    if (reply["ok"] !== true) {
      const code = typeof reply["code"] === "string" ? reply["code"] : "decode-error";
      const message =
        typeof reply["error"] === "string" ? reply["error"] : "Audio service failed.";
      throw new AudiodError(code, message);
    }
    return reply;
  }
}
