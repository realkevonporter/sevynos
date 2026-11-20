# SevynOS native audio — audiod

The real audio service. A C daemon (`audiod.c`) that decodes local
audio files in-process and plays PCM straight to the HDA device
through ALSA. No sound server, no Chromium, no media-player
subprocess: the Music app and the host media adapter talk to it over
a Unix socket, and `sevyn music` speaks the same protocol from the
Terminal.

## Why this stack

| Decision        | Choice                                           | Why                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Output          | ALSA-direct (`libasound`)                        | The image stages the HDA kernel modules but **no audio userspace** — no PipeWire, no PulseAudio. A sound server would be a whole new subsystem (daemon + config + policy) for a single-user OS whose only writer is audiod. ALSA-direct owns the device exclusively, is the leanest path to sound, and the volume/mixer surface is in-process PCM scaling (no `amixer` dependency, no process restart on volume change). |
| Daemon language | C                                                | It owns a real-time-ish write loop, ALSA hw params, and decoder state. A Node daemon would still need a native helper for ALSA (Hermes/Node have no ALSA binding) and would add a ~30 MB runtime to a 236 KB job. C also matches the other system daemons (`statusd`, `appd`, `sevyn-aid` are all C; only `commsd` is Node, because the Matrix SDK needs it).                                                            |
| Decode          | Vendored single-header decoders + own WAV parser | The runner has **no `-dev` headers** for mpg123/FLAC/Vorbis/Opus, and staging their runtime closures would couple the image to whatever the sysroot happens to ship. Vendored decoders are deterministic, ~100 KB total, and need nothing from the sysroot beyond `libasound.so.2`. See `third_party/README.md` for provenance.                                                                                          |
| Position        | Frames written − `snd_pcm_delay()`               | Real, not wall-clock. Pause freezes it, seek moves it, end-of-track reports `playing:false` at exactly `duration`. The old Music rebuild faked position from a clock; that failure mode is gone by construction.                                                                                                                                                                                                         |
| Pacing          | Real-time wait per chunk                         | The ALSA null device (CI) accepts writes instantly, so without pacing a track would "play" in milliseconds. The playback thread waits until the written frames' play time has elapsed; on real hardware the ALSA write blocks anyway and the wait is ~0.                                                                                                                                                                 |

## Formats

| Format                               | Decoder                            | Duration                                           |
| ------------------------------------ | ---------------------------------- | -------------------------------------------------- |
| WAV (PCM 8/16/24/32-bit, IEEE float) | own RIFF parser (`audio-decode.c`) | exact, from data chunk                             |
| MP3                                  | minimp3 (`minimp3_ex.h`)           | exact when a Xing/LAME header exists, else scanned |
| FLAC                                 | dr_flac                            | exact, from STREAMINFO                             |
| Ogg Vorbis                           | stb_vorbis                         | exact, from stream length                          |

Anything else — m4a/AAC, Opus, WMA — is refused with a clean
`unsupported-format`. That is deliberate, not a TODO left vague:
decoding AAC needs libavcodec (~19 MB + deps against the 2 GiB
image cap) and deserves its own size justification; Opus needs
libopusfile headers the runner lacks. Both are follow-ups, listed
below.

A truncated file is refused, not half-played: the WAV parser
rejects a data chunk that promises more bytes than are on disk
(the 100-byte head of a 4 MB WAV fails the probe), and every
decoder failure is a clean error, never a crash.

## Protocol

Aid-style line protocol, mirroring `commsd`: one line in, one bare
JSON line out, `{ok:true, ...}` or `{ok:false, error, code}`.
Socket: `/run/sevyn-audio.sock` (override with `--socket`).
Device: ALSA device, default `default` (`--device null` is the null
PCM — no hardware, what CI proves against).

```
STATUS            -> {ok, available, playing, paused, positionSec,
                      durationSec, volume, track|null, error}
PLAY <abs path>   -> status (stops whatever is playing first)
PAUSE | RESUME    -> status (idle when nothing is playing)
STOP              -> status (always ok, even when idle)
SEEK <seconds>    -> status (out-of-range past the end / below 0)
VOLUME <0..100>   -> status (clamped, amixer-style; NaN rejected)
SCAN [dir]        -> {ok, tracks:[{id, title, artist, album,
                      durationSec, path, format}]} (default /data;
                      undecodable files skipped, never fail the scan)
SHUTDOWN          -> {ok}, then a clean exit (tests)
```

Stable error codes: `idle | not-found | unsupported-format |
decode-error | out-of-range | bad-argument | no-audio-device |
unsupported-sample-format`. A bad call is always a clean
`{ok:false}` reply — the daemon never drops a connection and never
dies on input. That is the guard the old volume-up bug needed: the
host only ever sees JSON.

## Files

- `audiod.c` — daemon: socket server, playback thread, ALSA, volume
  scaling, real-time pacing, SCAN.
- `audio-decode.{h,c}` — one decoder interface over WAV/MP3/FLAC/OGG.
- `third_party/` — vendored decoders (see its README for sources +
  hashes). `stb_vorbis.c` compiles as its own translation unit: its
  static `get_bits` collides with minimp3's in one file.
- `test-audiod.mjs` — host harness (see below).
- `test/fixtures/` — 2 s mp3/flac/ogg/wav clips (generated from the
  01 test WAV with ffmpeg) + `not-audio.*` / `truncated.wav` negatives.

## Build + stage

Image build (`v2/image/build-m13-image.sh`, audiod section):

```
gcc -O2 -Wall -Wextra -o "$BUILD_TMP/sevyn-audiod" \
  "$ROOT/audio/audiod.c" "$ROOT/audio/audio-decode.c" \
  "$ROOT/audio/third_party/stb_vorbis.c" -lasound -lm -lpthread
python3 copy-closure.py "$SYSROOT" "$STAGE" \
  "$BUILD_TMP/sevyn-audiod:/usr/local/bin/sevyn-audiod"
```

Needs `libasound2-dev` on the build host (added to the
`v2-m13.yml` / `public-build.yml` apt lists; the build fails loudly
— a gcc error — if the header is missing). Image cost: the 236 KB
binary + the `libasound.so.2` closure (~1 MB). No ffmpeg, no
decoder libraries, no sound server.

`init` starts it after commsd, logging to `/data/logs/audiod.log`:

```
/usr/local/bin/sevyn-audiod >/data/logs/audiod.log 2>&1 &
```

## Tests

`node test-audiod.mjs` — 78 assertions, exit 0 on pass. Spawns
audiod with `--device null` and drives the socket: idle-state guards,
bad calls (missing file, non-audio file, garbage/NaN seek + volume,
idle pause/resume/seek), all 7 test WAVs (real durations + real-time
position advance), pause-freeze / resume / seek / volume edges,
track switching, mp3/flac/ogg clips to clean end-of-track, SCAN
(real durations, bad files skipped), clean SHUTDOWN + exit 0.
Runs in CI as the `audiod` job in `.github/workflows/quality.yml`.

What the harness **cannot** prove: audible output on real hardware
— only the GF65 (device `default`) proves sound comes out. It also
cannot prove the HDA device accepts 44.1 kHz on the GF65's codec;
the daemon reports that as `unsupported-sample-format` if it ever
happens.

## GF65 test

1. Boot the nightly, Terminal: `sevyn music status` →
   `available:true`.
2. Copy the 7 test WAVs to `/data` (USB or `sevyn files`).
3. `sevyn music scan /data` → 7 tracks with the real durations
   (21.5 / 25.5 / 24.8 / 27.75 / 22.8 / 22.9 / 29.5 s).
4. `sevyn music play /data/01-sunrise-acoustic.wav` → sound from the
   speakers/headphones; `status` twice, 2 s apart → position
   advances ~2 s.
5. `sevyn music pause` → sound stops, position frozen;
   `resume` → sound + position resume; `seek 10` → position 10;
   `volume 50` → quieter; `volume 150` → still 100, no crash;
   `stop` → silence.
6. `sevyn music play /data/not-audio.wav` → clean
   `{ok:false}` + exit 1, daemon still answers `status`.
7. Check `/data/logs/audiod.log` for `play …` / `ended …` lines.

## Deliberately left out (follow-ups)

- m4a/AAC + Opus decode (needs libavcodec / libopusfile + a size
  justification against the 2 GiB cap).
- Metadata tags (ID3/Vorbis comments) — titles come from file
  names today (`Artist - Title` split); real tags need a tag
  reader in the decode layer.
- Resampling — a file whose rate the hardware rejects fails with
  `unsupported-sample-format`; HDA accepts 8–192 kHz so this should
  not trigger on real files, but a resampler is the fix if it does.
- Playlists, shuffle, repeat, artwork, search — Music-app work
  (PR 3 follow-ups), not daemon work.
- Multi-client arbitration (two apps playing at once) — last PLAY
  wins today; a focus policy is follow-up work.
