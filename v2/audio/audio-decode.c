/* SevynOS v2 — audiod decode layer implementation. See audio-decode.h. */

#define _POSIX_C_SOURCE 200809L

#include "audio-decode.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#define MINIMP3_IMPLEMENTATION
#include "third_party/minimp3.h"
#define MINIMP3_IMPLEMENTATION
#include "third_party/minimp3_ex.h"
#define DR_FLAC_IMPLEMENTATION
#include "third_party/dr_flac.h"
/* stb_vorbis compiles as its own translation unit (its static
 * get_bits collides with minimp3's in this file); here we only need
 * the declarations. */
#define STB_VORBIS_HEADER_ONLY
#include "third_party/stb_vorbis.c"

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

static void set_err(char *err, size_t cap, const char *msg) {
  if (err == NULL || cap == 0)
    return;
  snprintf(err, cap, "%s", msg);
}

static uint16_t rd_u16le(const uint8_t *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t rd_u32le(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

static int has_ext(const char *path, const char *ext) {
  size_t plen = strlen(path);
  size_t elen = strlen(ext);
  if (plen < elen)
    return 0;
  return strcasecmp(path + plen - elen, ext) == 0;
}

int audio_decoder_is_audio_path(const char *path) {
  return has_ext(path, ".wav") || has_ext(path, ".mp3") || has_ext(path, ".flac") ||
         has_ext(path, ".ogg");
}

/* ------------------------------------------------------------------ */
/* WAV — own RIFF parser                                               */
/* ------------------------------------------------------------------ */

typedef struct wav_decoder {
  FILE *f;
  uint64_t data_start; /* file offset of the data chunk payload */
  uint64_t data_bytes;
  uint64_t frames_read; /* PCM frames delivered so far */
  uint16_t format_tag;  /* 1 = PCM, 3 = IEEE float */
  uint16_t bits;        /* 8 | 16 | 24 | 32 */
  uint16_t bytes_per_frame;
} wav_decoder_t;

/* Convert one raw frame (channels * bytes_per_sample) to s16. */
static void wav_frame_to_s16(const wav_decoder_t *w, const uint8_t *in, int16_t *out) {
  for (uint16_t c = 0; c < w->bytes_per_frame / (w->bits / 8); c++) {
    const uint8_t *s = in + c * (w->bits / 8);
    int32_t v = 0;
    switch (w->bits) {
    case 8:
      /* unsigned 8-bit: 128 is silence. */
      v = ((int32_t)s[0] - 128) << 8;
      break;
    case 16:
      v = (int16_t)rd_u16le(s);
      break;
    case 24: {
      int32_t x = (int32_t)(s[0] | (s[1] << 8) | (s[2] << 16));
      if (x & 0x800000)
        x -= 0x1000000;
      v = x >> 8;
      break;
    }
    case 32:
      if (w->format_tag == 3) {
        float fv;
        memcpy(&fv, s, sizeof(fv));
        if (fv > 1.0f)
          fv = 1.0f;
        if (fv < -1.0f)
          fv = -1.0f;
        v = (int32_t)(fv * 32767.0f);
      } else {
        v = (int32_t)rd_u32le(s) >> 16;
      }
      break;
    default:
      v = 0;
      break;
    }
    if (v > 32767)
      v = 32767;
    if (v < -32768)
      v = -32768;
    out[c] = (int16_t)v;
  }
}

static wav_decoder_t *wav_open(FILE *f, audio_format_info_t *info, char *err,
                               size_t err_cap) {
  /* The caller has consumed "RIFF" + size + "WAVE"; walk chunks until
   * fmt + data are both found. Unknown chunks are skipped (odd sizes
   * are word-padded per the RIFF spec). */
  uint8_t hdr[8];
  int have_fmt = 0, have_data = 0;
  uint16_t channels = 0;
  uint32_t sample_rate = 0;
  uint16_t bits = 0, format_tag = 0, block_align = 0;
  uint64_t data_start = 0, data_bytes = 0;

  for (;;) {
    if (fread(hdr, 1, 8, f) != 8) {
      set_err(err, err_cap, "truncated WAV file");
      return NULL;
    }
    uint32_t size = rd_u32le(hdr + 4);
    if (memcmp(hdr, "fmt ", 4) == 0) {
      if (size < 16) {
        set_err(err, err_cap, "WAV fmt chunk too small");
        return NULL;
      }
      uint8_t fmt[40];
      size_t want = size < sizeof(fmt) ? size : sizeof(fmt);
      if (fread(fmt, 1, want, f) != want) {
        set_err(err, err_cap, "truncated WAV fmt chunk");
        return NULL;
      }
      if (size > want && fseek(f, (long)(size - want), SEEK_CUR) != 0) {
        set_err(err, err_cap, "truncated WAV fmt chunk");
        return NULL;
      }
      format_tag = rd_u16le(fmt);
      channels = rd_u16le(fmt + 2);
      sample_rate = rd_u32le(fmt + 4);
      block_align = rd_u16le(fmt + 12);
      bits = rd_u16le(fmt + 14);
      have_fmt = 1;
    } else if (memcmp(hdr, "data", 4) == 0) {
      data_start = (uint64_t)ftell(f);
      data_bytes = size;
      have_data = 1;
      break; /* data is conventionally last; stop scanning here. */
    } else {
      /* Skip unknown chunk (word-aligned). */
      long skip = (long)(size + (size & 1u));
      if (fseek(f, skip, SEEK_CUR) != 0) {
        set_err(err, err_cap, "truncated WAV file");
        return NULL;
      }
    }
    if (have_fmt && have_data)
      break;
  }
  if (!have_fmt) {
    set_err(err, err_cap, "WAV file has no fmt chunk");
    return NULL;
  }
  if (!have_data) {
    set_err(err, err_cap, "WAV file has no data chunk");
    return NULL;
  }
  if (format_tag != 1 && format_tag != 3) {
    set_err(err, err_cap, "unsupported WAV encoding (only PCM and IEEE float)");
    return NULL;
  }
  if (channels == 0 || channels > 2 || sample_rate == 0 || sample_rate > 192000) {
    set_err(err, err_cap, "unsupported WAV channel count or sample rate");
    return NULL;
  }
  if (bits != 8 && bits != 16 && bits != 24 && bits != 32) {
    set_err(err, err_cap, "unsupported WAV bit depth");
    return NULL;
  }
  if (block_align != channels * (bits / 8)) {
    set_err(err, err_cap, "WAV block align does not match format");
    return NULL;
  }
  if (fseek(f, (long)data_start, SEEK_SET) != 0) {
    set_err(err, err_cap, "cannot seek in WAV file");
    return NULL;
  }
  /* A file whose data chunk promises more bytes than are actually
   * on disk IS truncated — refuse it outright instead of reporting
   * a duration for audio that is not there. (A 100-byte head of a
   * 4 MB WAV must fail the probe, not "play" 0.3 ms of it.) */
  struct stat st;
  if (fstat(fileno(f), &st) != 0 || (uint64_t)st.st_size < data_start ||
      data_start + data_bytes > (uint64_t)st.st_size) {
    set_err(err, err_cap, "truncated WAV file (data chunk is incomplete)");
    return NULL;
  }

  wav_decoder_t *w = calloc(1, sizeof(*w));
  if (w == NULL) {
    set_err(err, err_cap, "out of memory");
    return NULL;
  }
  w->f = f;
  w->data_start = data_start;
  w->data_bytes = data_bytes;
  w->format_tag = format_tag;
  w->bits = bits;
  w->bytes_per_frame = block_align;

  snprintf(info->format, sizeof(info->format), "wav");
  info->sample_rate = sample_rate;
  info->channels = channels;
  info->total_frames = data_bytes / block_align;
  info->duration_sec =
      info->total_frames == 0 ? 0.0 : (double)info->total_frames / (double)sample_rate;
  return w;
}

static int wav_read(wav_decoder_t *w, int16_t *out, size_t frames) {
  size_t got_frames = 0;
  uint8_t *raw = malloc(w->bytes_per_frame * frames);
  if (raw == NULL)
    return -1;
  size_t want_bytes = w->bytes_per_frame * frames;
  size_t got_bytes = fread(raw, 1, want_bytes, w->f);
  got_frames = got_bytes / w->bytes_per_frame;
  for (size_t i = 0; i < got_frames; i++)
    wav_frame_to_s16(w, raw + i * w->bytes_per_frame, out + i * (w->bytes_per_frame / (w->bits / 8)));
  free(raw);
  w->frames_read += got_frames;
  if (got_frames < frames && ferror(w->f))
    return -1;
  return (int)got_frames;
}

static int wav_seek(wav_decoder_t *w, uint64_t frame) {
  uint64_t off = w->data_start + frame * w->bytes_per_frame;
  if (off > w->data_start + w->data_bytes)
    return -1;
  if (fseek(w->f, (long)off, SEEK_SET) != 0)
    return -1;
  w->frames_read = frame;
  return 0;
}

/* ------------------------------------------------------------------ */
/* unified decoder                                                     */
/* ------------------------------------------------------------------ */

typedef enum decoder_kind {
  DEC_WAV,
  DEC_MP3,
  DEC_FLAC,
  DEC_OGG,
} decoder_kind_t;

struct audio_decoder {
  decoder_kind_t kind;
  audio_format_info_t info;
  uint64_t frames_read;
  union {
    wav_decoder_t *wav;
    mp3dec_ex_t *mp3;
    drflac *flac;
    stb_vorbis *ogg;
  } u;
  FILE *f; /* owned by wav only; others use their own handle */
};

static int sniff_format(FILE *f, char *format_out) {
  uint8_t magic[12];
  size_t n = fread(magic, 1, sizeof(magic), f);
  rewind(f);
  if (n >= 12 && memcmp(magic, "RIFF", 4) == 0 && memcmp(magic + 8, "WAVE", 4) == 0) {
    strcpy(format_out, "wav");
    return 0;
  }
  if (n >= 4 && memcmp(magic, "fLaC", 4) == 0) {
    strcpy(format_out, "flac");
    return 0;
  }
  if (n >= 4 && memcmp(magic, "OggS", 4) == 0) {
    strcpy(format_out, "ogg");
    return 0;
  }
  if (n >= 3 && memcmp(magic, "ID3", 3) == 0) {
    strcpy(format_out, "mp3");
    return 0;
  }
  /* Bare MPEG frame sync (0xFF 0xFB/0xF3/0xF2) — the common
   * no-ID3-tag case. A false positive here only costs a failed
   * minimp3 open, which reports a clean error. */
  if (n >= 2 && magic[0] == 0xFF && (magic[1] & 0xE0) == 0xE0) {
    strcpy(format_out, "mp3");
    return 0;
  }
  return -1;
}

audio_decoder_t *audio_decoder_open(const char *path, char *err, size_t err_cap) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) {
    set_err(err, err_cap, "audio file not found");
    return NULL;
  }
  char fmt[8] = {0};
  if (sniff_format(f, fmt) != 0) {
    /* Magic sniffing failed: fall back to the extension so a file
     * with an unusual header still gets a real attempt. A wrong
     * guess fails in the format open below with a clean error. */
    if (has_ext(path, ".wav"))
      strcpy(fmt, "wav");
    else if (has_ext(path, ".mp3"))
      strcpy(fmt, "mp3");
    else if (has_ext(path, ".flac"))
      strcpy(fmt, "flac");
    else if (has_ext(path, ".ogg"))
      strcpy(fmt, "ogg");
    else {
      fclose(f);
      set_err(err, err_cap, "unsupported audio format");
      return NULL;
    }
  }

  audio_decoder_t *d = calloc(1, sizeof(*d));
  if (d == NULL) {
    fclose(f);
    set_err(err, err_cap, "out of memory");
    return NULL;
  }

  if (strcmp(fmt, "wav") == 0) {
    /* Consume the RIFF header the parser expects to have read. */
    uint8_t riff[12];
    if (fread(riff, 1, 12, f) != 12) {
      free(d);
      fclose(f);
      set_err(err, err_cap, "truncated WAV file");
      return NULL;
    }
    d->kind = DEC_WAV;
    d->u.wav = wav_open(f, &d->info, err, err_cap);
    if (d->u.wav == NULL) {
      free(d);
      fclose(f);
      return NULL;
    }
    d->f = f;
    return d;
  }

  if (strcmp(fmt, "mp3") == 0) {
    fclose(f);
    d->kind = DEC_MP3;
    d->u.mp3 = calloc(1, sizeof(mp3dec_ex_t));
    if (d->u.mp3 == NULL) {
      free(d);
      set_err(err, err_cap, "out of memory");
      return NULL;
    }
    if (mp3dec_ex_open(d->u.mp3, path, MP3D_SEEK_TO_SAMPLE) != 0) {
      free(d->u.mp3);
      free(d);
      set_err(err, err_cap, "not a decodable MP3 file");
      return NULL;
    }
    mp3dec_ex_t *e = d->u.mp3;
    snprintf(d->info.format, sizeof(d->info.format), "mp3");
    d->info.sample_rate = (uint32_t)e->info.hz;
    d->info.channels = (uint16_t)e->info.channels;
    d->info.total_frames = e->samples / (uint64_t)(e->info.channels > 0 ? e->info.channels : 1);
    d->info.duration_sec = d->info.sample_rate == 0
                               ? 0.0
                               : (double)d->info.total_frames / (double)d->info.sample_rate;
    if (d->info.sample_rate == 0 || d->info.channels == 0 ||
        d->info.channels > 2) {
      mp3dec_ex_close(e);
      free(e);
      free(d);
      set_err(err, err_cap, "unsupported MP3 channel count or sample rate");
      return NULL;
    }
    return d;
  }

  if (strcmp(fmt, "flac") == 0) {
    fclose(f);
    d->kind = DEC_FLAC;
    d->u.flac = drflac_open_file(path, NULL);
    if (d->u.flac == NULL) {
      free(d);
      set_err(err, err_cap, "not a decodable FLAC file");
      return NULL;
    }
    drflac *fl = d->u.flac;
    snprintf(d->info.format, sizeof(d->info.format), "flac");
    d->info.sample_rate = fl->sampleRate;
    d->info.channels = (uint16_t)fl->channels;
    d->info.total_frames = fl->totalPCMFrameCount;
    d->info.duration_sec = d->info.sample_rate == 0
                               ? 0.0
                               : (double)d->info.total_frames / (double)d->info.sample_rate;
    if (d->info.sample_rate == 0 || d->info.channels == 0 ||
        d->info.channels > 2) {
      drflac_close(fl);
      free(d);
      set_err(err, err_cap, "unsupported FLAC channel count or sample rate");
      return NULL;
    }
    return d;
  }

  /* ogg */
  fclose(f);
  d->kind = DEC_OGG;
  int ogg_err = 0;
  d->u.ogg = stb_vorbis_open_filename(path, &ogg_err, NULL);
  if (d->u.ogg == NULL) {
    free(d);
    set_err(err, err_cap, "not a decodable Ogg Vorbis file");
    return NULL;
  }
  stb_vorbis_info ogg_info = stb_vorbis_get_info(d->u.ogg);
  snprintf(d->info.format, sizeof(d->info.format), "ogg");
  d->info.sample_rate = ogg_info.sample_rate;
  d->info.channels = (uint16_t)ogg_info.channels;
  d->info.total_frames = stb_vorbis_stream_length_in_samples(d->u.ogg);
  d->info.duration_sec =
      d->info.sample_rate == 0
          ? 0.0
          : (double)d->info.total_frames / (double)d->info.sample_rate;
  if (d->info.sample_rate == 0 || d->info.channels == 0 || d->info.channels > 2) {
    stb_vorbis_close(d->u.ogg);
    free(d);
    set_err(err, err_cap, "unsupported Ogg Vorbis channel count or sample rate");
    return NULL;
  }
  return d;
}

int audio_decoder_read(audio_decoder_t *d, int16_t *out, size_t frames) {
  int got = 0;
  switch (d->kind) {
  case DEC_WAV:
    got = wav_read(d->u.wav, out, frames);
    break;
  case DEC_MP3: {
    size_t n = mp3dec_ex_read(d->u.mp3, out, frames * d->info.channels);
    got = (int)(n / d->info.channels);
    break;
  }
  case DEC_FLAC: {
    uint64_t n = drflac_read_pcm_frames_s16(d->u.flac, frames, out);
    got = (int)n;
    break;
  }
  case DEC_OGG: {
    int n = stb_vorbis_get_samples_short_interleaved(d->u.ogg, d->info.channels, out,
                                                     (int)frames);
    got = n;
    break;
  }
  }
  if (got > 0)
    d->frames_read += (uint64_t)got;
  return got;
}

int audio_decoder_seek(audio_decoder_t *d, uint64_t frame) {
  int rc = -1;
  switch (d->kind) {
  case DEC_WAV:
    rc = wav_seek(d->u.wav, frame);
    break;
  case DEC_MP3:
    rc = mp3dec_ex_seek(d->u.mp3, frame * d->info.channels) == 0 ? 0 : -1;
    break;
  case DEC_FLAC:
    rc = drflac_seek_to_pcm_frame(d->u.flac, frame) == DRFLAC_TRUE ? 0 : -1;
    break;
  case DEC_OGG:
    rc = stb_vorbis_seek_frame(d->u.ogg, (unsigned int)frame) ? 0 : -1;
    break;
  }
  if (rc == 0)
    d->frames_read = frame;
  return rc;
}

uint64_t audio_decoder_tell(const audio_decoder_t *d) {
  return d->frames_read;
}

const audio_format_info_t *audio_decoder_info(const audio_decoder_t *d) {
  return &d->info;
}

void audio_decoder_close(audio_decoder_t *d) {
  if (d == NULL)
    return;
  switch (d->kind) {
  case DEC_WAV:
    if (d->f != NULL)
      fclose(d->f);
    free(d->u.wav);
    break;
  case DEC_MP3:
    mp3dec_ex_close(d->u.mp3);
    free(d->u.mp3);
    break;
  case DEC_FLAC:
    drflac_close(d->u.flac);
    break;
  case DEC_OGG:
    stb_vorbis_close(d->u.ogg);
    break;
  }
  free(d);
}

int audio_decoder_probe(const char *path, audio_format_info_t *info, char *err,
                        size_t err_cap) {
  audio_decoder_t *d = audio_decoder_open(path, err, err_cap);
  if (d == NULL)
    return -1;
  *info = d->info;
  audio_decoder_close(d);
  return 0;
}
