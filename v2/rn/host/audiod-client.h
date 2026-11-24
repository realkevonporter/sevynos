// SevynOS v2 — audiod client for the RN host (port of the old-tree
// LinuxAudiodClient, hosts/linux/src/linux-audiod-client.ts, PR #129).
//
// The host's media/audio adapters talk to audiod — the native audio
// daemon (v2/audio) — over its Unix socket, one JSON line per request.
// This client is the only place in the host that speaks the audiod
// protocol, and it is where the old volume-up bug is made impossible
// by construction:
//
//   1. Every argument is validated HERE, before any I/O. A bad path,
//      a NaN seek, or a non-numeric volume is a synthesized
//      {ok:false, code:"bad-argument"} reply — never a throw, never
//      an unhandled failure escaping into the host.
//   2. Every transport failure (no daemon, socket error, timeout,
//      malformed reply) becomes {ok:false, code:"audio-unavailable"}.
//      Nothing hangs: each request has a timeout, and a dead socket
//      is closed, never retried in a loop.
//   3. A daemon {ok:false} reply passes through untouched, so the
//      caller gets the daemon's own stable code (idle, not-found,
//      unsupported-format, out-of-range, ...) — a reason it can show,
//      not a crash.
//   4. Position and duration come from the daemon (frames written
//      minus snd_pcm_delay()). This client keeps NO clock, NO
//      hardcoded duration, and NO playback state of its own — there
//      is nothing here that can drift from what is actually playing.
//
// Contract with JS: every method returns a JSON object line — the
// daemon's own reply on success, or a synthesized {ok:false, ...}
// line on validation/transport failure. The host resolves the
// Promise with that line; the JS adapter
// (v2/rn/renderer/sevyn-audio.js) parses it and rejects with an
// AudiodError carrying the stable code. Nothing here throws, and
// nothing here parses JSON beyond a one-character sanity check —
// parsing lives in JS, where JSON is native.
//
// The transport is one short-lived Unix socket connection per request
// (like `sevyn music` — no connection lifecycle to leak, no
// stale-socket recovery to get wrong). Socket: /run/sevyn-audio.sock
// (override with SEVYN_AUDIO_SOCK).
#pragma once

#include <optional>
#include <string>

namespace sevyn {

class AudiodClient {
 public:
  static constexpr const char* kDefaultSocketPath = "/run/sevyn-audio.sock";
  static constexpr int kDefaultTimeoutMs = 5000;

  // Socket path from SEVYN_AUDIO_SOCK when set, else the default.
  static std::string defaultSocketPath();

  // Build a synthesized {ok:false,code,error} JSON line (message is
  // JSON-escaped). Used for validation/transport failures.
  static std::string errorJson(const std::string& code,
                               const std::string& message);

  explicit AudiodClient(std::string socketPath = defaultSocketPath(),
                        int timeoutMs = kDefaultTimeoutMs);

  // Validated verbs. Each returns the daemon's reply line, or a
  // synthesized error line. Never throws.
  std::string play(const std::string& path) const;
  std::string pause() const;
  std::string resume() const;
  std::string stop() const;
  std::string seek(double seconds) const;
  std::string setVolume(double volume) const;
  std::string status() const;
  // std::nullopt = the daemon's default directory; an explicit empty
  // string is a bad-argument error (mirrors the old client).
  std::string scan(const std::optional<std::string>& directory) const;

 private:
  // One line out, one reply line back (or a synthesized error line).
  std::string roundtrip(const std::string& line) const;

  std::string socketPath_;
  int timeoutMs_;
};

} // namespace sevyn
