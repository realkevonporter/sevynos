/* SevynOS v2 — audiod decode layer.
 *
 * One decoder interface over every format audiod plays. Output is
 * always interleaved signed 16-bit PCM at the file's native sample
 * rate and channel count; audiod opens ALSA at that rate, so there is
 * no resampler in v1 (HDA accepts 8-192 kHz; a file the hardware
 * rejects fails PLAY with a clean `unsupported-sample-format`).
 *
 * Formats (chosen in v2/audio/README.md — no system -dev headers are
 * needed, so the image build cannot fail on a missing sysroot package):
 *   wav  — own RIFF parser below (PCM 8/16/24/32-bit + IEEE float).
 *   mp3  — minimp3 (third_party/minimp3.h, CC0).
 *   flac — dr_flac (third_party/dr_flac.h, public domain / MIT-0).
 *   ogg  — stb_vorbis (third_party/stb_vorbis.c, public domain / MIT).
 * Anything else (m4a/AAC, opus, ...) is refused with
 * `unsupported-format` — never guessed at, never half-played.
 *
 * Every function fails cleanly: open() returns NULL with a human
 * readable reason in `err`; read() returns <0 only on a decode error
 * (0 is a clean EOF). A corrupt file can never crash the caller —
 * the decoders run on bounded buffers and every allocation is checked.
 */

#ifndef SEVYN_AUDIO_DECODE_H
#define SEVYN_AUDIO_DECODE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct audio_decoder audio_decoder_t;

typedef struct audio_format_info {
  /* "wav" | "mp3" | "flac" | "ogg". */
  char format[8];
  uint32_t sample_rate;
  uint16_t channels;
  /* Total PCM frames, or 0 when the container does not know (VBR mp3
   * without a Xing header). duration_sec is 0 in that case too. */
  uint64_t total_frames;
  double duration_sec;
} audio_format_info_t;

/* Open + probe `path`. Returns NULL on any failure (missing file,
 * unsupported format, corrupt header) with `err` filled in.
 * `err` is always NUL-terminated. */
audio_decoder_t *audio_decoder_open(const char *path, char *err, size_t err_cap);

/* Read up to `frames` PCM frames into `out` (interleaved s16).
 * Returns frames read, 0 on clean EOF, <0 on decode error. */
int audio_decoder_read(audio_decoder_t *d, int16_t *out, size_t frames);

/* Seek to an absolute PCM frame. Returns 0 on success, -1 when the
 * decoder cannot seek there (frame past EOF, unseekable stream). */
int audio_decoder_seek(audio_decoder_t *d, uint64_t frame);

/* Current position in PCM frames (frames already delivered by read,
 * adjusted by the last seek). */
uint64_t audio_decoder_tell(const audio_decoder_t *d);

const audio_format_info_t *audio_decoder_info(const audio_decoder_t *d);

void audio_decoder_close(audio_decoder_t *d);

/* Probe only: open, read the header, close. Returns 0 and fills
 * `info` when the file is a playable format, -1 otherwise (with `err`
 * filled in). Used by SCAN so one bad file never fails the library. */
int audio_decoder_probe(const char *path, audio_format_info_t *info, char *err,
                        size_t err_cap);

/* True when `path` names a file audiod even attempts to decode
 * (extension allow-list: wav/mp3/flac/ogg). The probe is what decides;
 * this only keeps SCAN from opening every file on disk. */
int audio_decoder_is_audio_path(const char *path);

#ifdef __cplusplus
}
#endif

#endif /* SEVYN_AUDIO_DECODE_H */
