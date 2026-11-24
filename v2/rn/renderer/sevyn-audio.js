"use strict";
// SevynOS v2 — RN audio module, JS adapter (port of the old-tree
// media/audio adapters, PR #129).
//
// The host exposes audiod — the native audio daemon (v2/audio) — as
// eight async functions on the Sevyn global (see v2/rn/README.md):
// audioPlay / audioPause / audioResume / audioStop / audioSeek /
// audioVolume / audioStatus / audioScan. Each returns a Promise that
// resolves to ONE JSON line: the daemon's own reply, or a synthesized
// {ok:false, code, error} line when the host's client rejected the
// call before any I/O (bad argument) or the transport failed. This
// module is the only place in JS that speaks that reply shape:
//
//   1. Every argument is validated HERE, before any host call. A bad
//      path, a NaN seek, or a non-numeric volume is a rejected
//      promise with a stable `code` — never a synchronous throw, never
//      an unhandled rejection escaping into the renderer.
//   2. Every host/transport failure is an `AudiodError` with the code
//      `audio-unavailable`. Nothing hangs: the host's client times
//      out, and a dead daemon is a rejection, not a freeze.
//   3. A daemon {ok:false} reply is a rejected promise carrying the
//      daemon's own stable code (idle, not-found, unsupported-format,
//      out-of-range, ...). The caller gets a reason it can show, not
//      a crash.
//   4. Position and duration come from the daemon (frames written
//      minus snd_pcm_delay()). This module keeps NO clock, NO
//      hardcoded duration, and NO playback state of its own — there
//      is nothing here that can drift from what is actually playing.
//
// One implementation, two names — never two implementations: the
// `media` adapter is the MediaService surface and `audio` carries the
// same playback surface for callers that think in output-device
// terms. Both names below are the SAME frozen object, backed by the
// one audiod client in the host.

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg"]);

/** A rejected audio call. `code` is stable — callers switch on it. */
class AudiodError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AudiodError";
    this.code = code;
  }
}

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return AUDIO_EXTENSIONS.has(ext) ? ext.slice(1) : "wav";
}

function trackFromDaemon(raw, fallbackDurationSec) {
  const path = typeof raw.path === "string" ? raw.path : "";
  if (path.length === 0) return null;
  const format = typeof raw.format === "string" ? raw.format : extensionOf(path);
  const durationSec =
    typeof raw.durationSec === "number" && Number.isFinite(raw.durationSec)
      ? raw.durationSec
      : fallbackDurationSec;
  const base = path
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "");
  return {
    id: path,
    title: typeof raw.title === "string" ? raw.title : base,
    artist: typeof raw.artist === "string" ? raw.artist : "Unknown Artist",
    album: typeof raw.album === "string" ? raw.album : "Local Library",
    durationSec,
    path,
    format,
  };
}

function statusFromDaemon(reply) {
  const rawTrack = reply.track;
  const track =
    rawTrack !== null && typeof rawTrack === "object" && !Array.isArray(rawTrack)
      ? trackFromDaemon(
          rawTrack,
          typeof reply.durationSec === "number" ? reply.durationSec : 0,
        )
      : null;
  return {
    playing: reply.playing === true,
    paused: reply.paused === true,
    currentPositionSec: typeof reply.positionSec === "number" ? reply.positionSec : 0,
    durationSec: typeof reply.durationSec === "number" ? reply.durationSec : 0,
    volume: typeof reply.volume === "number" ? reply.volume : 100,
    track,
    available: reply.available !== false,
  };
}

// Parse one host reply line. A malformed line or a non-object is a
// broken daemon (audio-unavailable); {ok:false} carries the daemon's
// own code.
function parseReply(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AudiodError("audio-unavailable", "Audio service sent a bad reply.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new AudiodError("audio-unavailable", "Audio service sent a bad reply.");
  if (parsed.ok !== true) {
    const code = typeof parsed.code === "string" ? parsed.code : "decode-error";
    const message =
      typeof parsed.error === "string" ? parsed.error : "Audio service failed.";
    throw new AudiodError(code, message);
  }
  return parsed;
}

// Call one Sevyn.audio* host function. A missing function (an old
// host bundle) is audio-unavailable, never a TypeError escaping to
// the caller. The host always resolves with a JSON line; it never
// rejects, so a rejection here is a host bug, mapped the same way.
function callHost(fnName, ...args) {
  const host = globalThis.Sevyn;
  const fn =
    host !== null && host !== undefined && typeof host[fnName] === "function"
      ? host[fnName]
      : null;
  if (fn === null)
    return Promise.reject(
      new AudiodError("audio-unavailable", "Audio service is unavailable on this host."),
    );
  let result;
  try {
    result = fn(...args);
  } catch (err) {
    return Promise.reject(
      new AudiodError(
        "audio-unavailable",
        "Audio service failed: " + (err && err.message ? err.message : String(err)),
      ),
    );
  }
  return Promise.resolve(result);
}

function statusCall(fnName, ...args) {
  return callHost(fnName, ...args).then((json) => statusFromDaemon(parseReply(json)));
}

function play(source) {
  let path = "";
  let givenTrack;
  if (typeof source === "string") {
    path = source;
  } else if (source !== null && typeof source === "object") {
    if (typeof source.path === "string") path = source.path;
    givenTrack = source.track;
  }
  if (path.length === 0)
    return Promise.reject(
      new AudiodError("bad-argument", "Audio playback requires a file path."),
    );
  if (path[0] !== "/")
    return Promise.reject(
      new AudiodError("bad-argument", "Audio playback requires an absolute path."),
    );
  return callHost("audioPlay", path).then((json) => {
    const status = statusFromDaemon(parseReply(json));
    // The caller-supplied track (title/artist from the library)
    // wins over the daemon's bare path/format/duration track.
    if (
      givenTrack !== undefined &&
      givenTrack !== null &&
      typeof givenTrack === "object" &&
      status.track !== null
    ) {
      const override = {};
      if (typeof givenTrack.id === "string") override.id = givenTrack.id;
      if (typeof givenTrack.title === "string") override.title = givenTrack.title;
      if (typeof givenTrack.artist === "string") override.artist = givenTrack.artist;
      if (typeof givenTrack.album === "string") override.album = givenTrack.album;
      return { ...status, track: { ...status.track, ...override } };
    }
    return status;
  });
}

function pause() {
  return statusCall("audioPause");
}

function resume() {
  return statusCall("audioResume");
}

function stop() {
  return statusCall("audioStop");
}

function seek(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
    return Promise.reject(
      new AudiodError(
        "bad-argument",
        "Seek requires a finite number of seconds (0 or more).",
      ),
    );
  return statusCall("audioSeek", seconds);
}

function setVolume(volume) {
  if (typeof volume !== "number" || !Number.isFinite(volume))
    return Promise.reject(
      new AudiodError("bad-argument", "Volume requires a finite number 0..100."),
    );
  // The daemon clamps out-of-range values (amixer-style) and the
  // reply reports the volume actually applied — never an error.
  return statusCall("audioVolume", volume);
}

function status() {
  return statusCall("audioStatus");
}

function scan(directory) {
  if (directory === undefined)
    return callHost("audioScan").then((json) => scanFromReply(json));
  if (typeof directory !== "string" || directory.length === 0)
    return Promise.reject(
      new AudiodError("bad-argument", "Scan requires a directory path."),
    );
  return callHost("audioScan", directory).then((json) => scanFromReply(json));
}

function scanFromReply(json) {
  const reply = parseReply(json);
  const tracks = reply.tracks;
  if (!Array.isArray(tracks))
    throw new AudiodError("audio-unavailable", "Audio service sent a bad scan reply.");
  const out = [];
  for (const entry of tracks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const track = trackFromDaemon(entry, 0);
    if (track !== null) out.push(track);
  }
  return out;
}

// Output devices: audiod owns a single ALSA device, so the list is
// one static default output and selection is a no-op (matches the
// old host service). No daemon roundtrip for either call.
function getOutputs() {
  return Promise.resolve([
    {
      id: "default",
      name: "System Audio Output",
      isDefault: true,
      type: "speaker",
    },
  ]);
}

function setOutput(_deviceId) {
  return Promise.resolve(null);
}

const SevynAudio = Object.freeze({
  play,
  pause,
  resume,
  stop,
  seek,
  setVolume,
  status,
  scan,
  getOutputs,
  setOutput,
});

// The media adapter is the same implementation under its other name:
// one client behind both names — never two implementations.
const SevynMedia = SevynAudio;

module.exports = { AudiodError, SevynAudio, SevynMedia };
