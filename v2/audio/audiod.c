/* SevynOS v2 — audiod: the native audio service.
 *
 * A C daemon that decodes local audio files and plays PCM straight
 * to the HDA device through ALSA — no sound server, no Chromium, no
 * media-player subprocess. The host's media adapter (PR 2) and the
 * Music app (PR 3) talk to it over a Unix socket; `sevyn music`
 * (v2/update/sevyn.c) speaks the same protocol from the Terminal.
 *
 * Protocol (aid-style line protocol, mirroring commsd): one line in,
 * one bare JSON line out, `{ok:true, ...}` or `{ok:false, error,
 * code}`. Commands:
 *   STATUS            current state (always answers, even idle)
 *   PLAY <path>       decode + play a file (stops whatever is playing)
 *   PAUSE | RESUME    pause / resume the current track
 *   STOP              stop playback (always ok, even when idle)
 *   SEEK <seconds>    seek inside the current track
 *   VOLUME <0..100>   set playback volume (clamped, amixer-style)
 *   SCAN [dir]        list playable files in dir (default /data)
 *                       with REAL probed durations
 *   SHUTDOWN          clean exit (tests)
 *
 * Error codes are stable strings the RN layer switches on:
 *   idle | not-found | unsupported-format | decode-error |
 *   out-of-range | bad-argument | no-audio-device |
 *   unsupported-sample-format
 * A bad call is always a clean {ok:false} reply — never a crash, never
 * a dropped connection. That is the whole point: the old Music rebuild
 * died because a volume-up rejection escaped into Genesis; here the
 * daemon owns every failure mode and the host only ever sees JSON.
 *
 * Position is REAL, not wall-clock: the playback thread counts PCM
 * frames handed to ALSA minus snd_pcm_delay() (frames still in the
 * hardware buffer). Pause freezes it; seek moves it; end-of-track
 * reports playing:false at position == duration.
 *
 * Playback is paced to real time: after each ALSA write the thread
 * waits until the written frames' play time has elapsed, so the null
 * PCM device (CI, no hardware) advances position at 1x instead of
 * racing to EOF. On real hardware the ALSA write blocks anyway and
 * the wait is ~0. Pause/stop/seek wake the wait at once via the
 * state condition variable.
 *
 * Usage: sevyn-audiod [--socket <path>] [--device <alsa device>]
 *   --socket: default /run/sevyn-audio.sock
 *   --device: ALSA device, default "default"; "null" is the null PCM
 *             (no hardware — what CI proves against).
 * Logs go to stderr (init redirects to /data/logs/audiod.log).
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <alsa/asoundlib.h>
#include <dirent.h>
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "audio-decode.h"

#define DEFAULT_SOCK "/run/sevyn-audio.sock"
#define DEFAULT_DEVICE "default"
#define DEFAULT_SCAN_DIR "/data"
#define MAX_LINE 8192
#define CHUNK_FRAMES 4096
#define MAX_SCAN_TRACKS 512

static const char *g_sock_path = DEFAULT_SOCK;
static const char *g_device = DEFAULT_DEVICE;
static volatile sig_atomic_t g_shutting_down = 0;
static int g_listen_fd = -1;

/* ------------------------------------------------------------------ */
/* logging                                                             */
/* ------------------------------------------------------------------ */

static void log_line(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "AUDIOD ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  fflush(stderr);
  va_end(ap);
}

/* ------------------------------------------------------------------ */
/* playback state (guarded by g_mu; g_cond wakes the playback thread)  */
/* ------------------------------------------------------------------ */

typedef struct playback_state {
  pthread_mutex_t mu;
  pthread_cond_t cond;
  /* What is loaded. */
  char *path;                 /* owned, NULL when idle */
  audio_format_info_t info;   /* valid when path != NULL */
  audio_decoder_t *dec;       /* owned by the playback thread while running */
  snd_pcm_t *pcm;             /* owned by the playback thread while running */
  /* Transport. */
  bool playing;               /* a track is loaded and not finished */
  bool paused;
  bool stop_requested;        /* playback thread should exit */
  bool thread_running;
  pthread_t thread;
  uint64_t generation;        /* bumped on every PLAY/STOP */
  /* Position bookkeeping (frames). */
  uint64_t frames_written;    /* frames handed to ALSA for this track */
  uint64_t frames_played;     /* frames_written - delay, as last computed */
  uint64_t pause_frame;       /* position frozen at pause */
  bool ended;                 /* decoder hit EOF */
  char error[256];            /* last playback error, "" when none */
  int volume;                 /* 0..100 */
  bool device_available;      /* startup probe result */
} playback_state_t;

static playback_state_t g_st;

/* Must hold g_st.mu. */
static double state_position_sec_locked(void) {
  if (g_st.path == NULL || g_st.info.sample_rate == 0)
    return 0.0;
  uint64_t frames;
  if (g_st.paused)
    frames = g_st.pause_frame;
  else if (g_st.ended)
    frames = g_st.info.total_frames;
  else
    frames = g_st.frames_played;
  if (frames > g_st.info.total_frames && g_st.info.total_frames != 0)
    frames = g_st.info.total_frames;
  return (double)frames / (double)g_st.info.sample_rate;
}

static double state_duration_sec_locked(void) {
  if (g_st.path == NULL)
    return 0.0;
  return g_st.info.duration_sec;
}

/* ------------------------------------------------------------------ */
/* ALSA                                                                */
/* ------------------------------------------------------------------ */

static int alsa_open(snd_pcm_t **out, const audio_format_info_t *info, char *err,
                     size_t err_cap) {
  snd_pcm_t *pcm = NULL;
  int rc = snd_pcm_open(&pcm, g_device, SND_PCM_STREAM_PLAYBACK, 0);
  if (rc < 0) {
    snprintf(err, err_cap, "cannot open audio device %s: %s", g_device,
             snd_strerror(rc));
    return -1;
  }
  snd_pcm_hw_params_t *params = NULL;
  snd_pcm_hw_params_alloca(&params);
  snd_pcm_hw_params_any(pcm, params);
  snd_pcm_hw_params_set_access(pcm, params, SND_PCM_ACCESS_RW_INTERLEAVED);
  snd_pcm_hw_params_set_format(pcm, params, SND_PCM_FORMAT_S16_LE);
  snd_pcm_hw_params_set_channels(pcm, params, info->channels);
  unsigned int rate = info->sample_rate;
  rc = snd_pcm_hw_params_set_rate_near(pcm, params, &rate, 0);
  if (rc < 0 || rate != info->sample_rate) {
    snprintf(err, err_cap, "audio device refuses sample rate %u",
             info->sample_rate);
    snd_pcm_close(pcm);
    return -2; /* unsupported-sample-format */
  }
  rc = snd_pcm_hw_params(pcm, params);
  if (rc < 0) {
    snprintf(err, err_cap, "cannot configure audio device: %s", snd_strerror(rc));
    snd_pcm_close(pcm);
    return -2;
  }
  *out = pcm;
  return 0;
}

/* ------------------------------------------------------------------ */
/* playback thread                                                     */
/* ------------------------------------------------------------------ */

static void apply_volume(int16_t *buf, size_t samples, int volume) {
  if (volume >= 100)
    return;
  if (volume <= 0) {
    memset(buf, 0, samples * sizeof(int16_t));
    return;
  }
  for (size_t i = 0; i < samples; i++) {
    int32_t v = (int32_t)buf[i] * volume / 100;
    buf[i] = (int16_t)v;
  }
}

/* Re-base a pacing origin so that `frames` already played do not
 * count as time still to wait: origin = now - frames/rate. Used at
 * thread start (seek restarts mid-track) and while paused. */
static void rebase_origin(struct timespec *origin, uint64_t frames, uint32_t rate) {
  if (rate == 0 || frames == 0)
    return;
  double offset = (double)frames / (double)rate;
  time_t whole = (time_t)offset;
  long frac_nsec = (long)((offset - (double)whole) * 1e9);
  origin->tv_sec -= whole;
  origin->tv_nsec -= frac_nsec;
  if (origin->tv_nsec < 0) {
    origin->tv_sec -= 1;
    origin->tv_nsec += 1000000000L;
  }
}

/* Real-time pacing: sleep until the frames written so far have had
 * time to play. Returns false when the thread should exit. */
static bool pace_wait_locked(uint64_t frames_written, uint32_t rate,
                             struct timespec *started_at) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  double elapsed =
      (double)(now.tv_sec - started_at->tv_sec) +
      (double)(now.tv_nsec - started_at->tv_nsec) / 1e9;
  double due = rate == 0 ? 0.0 : (double)frames_written / (double)rate;
  double wait_sec = due - elapsed;
  if (wait_sec <= 0.0)
    return true;
  struct timespec until = now;
  until.tv_sec += (time_t)wait_sec;
  until.tv_nsec += (long)((wait_sec - (time_t)wait_sec) * 1e9);
  if (until.tv_nsec >= 1000000000L) {
    until.tv_sec += 1;
    until.tv_nsec -= 1000000000L;
  }
  /* Timed wait so pause/stop/seek wake us immediately. */
  int rc = pthread_cond_timedwait(&g_st.cond, &g_st.mu, &until);
  (void)rc;
  return !g_st.stop_requested;
}

static void *playback_thread(void *arg) {
  (void)arg;
  uint64_t generation;
  audio_decoder_t *dec;
  snd_pcm_t *pcm;
  audio_format_info_t info;
  char path_copy[1024];

  pthread_mutex_lock(&g_st.mu);
  generation = g_st.generation;
  dec = g_st.dec;
  pcm = g_st.pcm;
  info = g_st.info;
  uint64_t frames_at_start = g_st.frames_written;
  snprintf(path_copy, sizeof(path_copy), "%s", g_st.path ? g_st.path : "");
  pthread_mutex_unlock(&g_st.mu);

  int16_t *buf = malloc(CHUNK_FRAMES * info.channels * sizeof(int16_t));
  if (buf == NULL) {
    pthread_mutex_lock(&g_st.mu);
    snprintf(g_st.error, sizeof(g_st.error), "out of memory");
    g_st.playing = false;
    g_st.thread_running = false;
    pthread_mutex_unlock(&g_st.mu);
    return NULL;
  }

  struct timespec started_at;
  clock_gettime(CLOCK_MONOTONIC, &started_at);
  /* The track may already be part-played (seek restart, or resume):
   * the origin must account for frames already written, or pacing
   * would sleep for the whole played duration before the next chunk. */
  rebase_origin(&started_at, frames_at_start, info.sample_rate);

  for (;;) {
    pthread_mutex_lock(&g_st.mu);
    if (g_st.stop_requested || generation != g_st.generation) {
      pthread_mutex_unlock(&g_st.mu);
      break;
    }
    while (g_st.paused && !g_st.stop_requested && generation == g_st.generation) {
      /* Freeze the position clock while paused: re-base the origin
       * so pacing does not "catch up" on resume. */
      clock_gettime(CLOCK_MONOTONIC, &started_at);
      rebase_origin(&started_at, g_st.frames_written, info.sample_rate);
      pthread_cond_wait(&g_st.cond, &g_st.mu);
    }
    if (g_st.stop_requested || generation != g_st.generation) {
      pthread_mutex_unlock(&g_st.mu);
      break;
    }
    int volume = g_st.volume;
    pthread_mutex_unlock(&g_st.mu);

    int got = audio_decoder_read(dec, buf, CHUNK_FRAMES);
    if (got < 0) {
      pthread_mutex_lock(&g_st.mu);
      snprintf(g_st.error, sizeof(g_st.error), "decode error in %.200s", path_copy);
      log_line("decode error in %s", path_copy);
      g_st.playing = false;
      g_st.ended = true;
      g_st.thread_running = false;
      pthread_mutex_unlock(&g_st.mu);
      break;
    }
    if (got == 0) {
      /* Clean EOF: drain the hardware buffer, then report ended at
       * exactly duration. */
      snd_pcm_drain(pcm);
      pthread_mutex_lock(&g_st.mu);
      g_st.frames_played = info.total_frames;
      g_st.ended = true;
      g_st.playing = false;
      g_st.thread_running = false;
      pthread_mutex_unlock(&g_st.mu);
      log_line("ended %s", path_copy);
      break;
    }

    apply_volume(buf, (size_t)got * info.channels, volume);
    int16_t *p = buf;
    int remaining = got;
    bool write_failed = false;
    while (remaining > 0) {
      snd_pcm_sframes_t w = snd_pcm_writei(pcm, p, (snd_pcm_uframes_t)remaining);
      if (w == -EPIPE) {
        snd_pcm_prepare(pcm);
        continue;
      }
      if (w == -ESTRPIPE) {
        if (snd_pcm_resume(pcm) < 0)
          snd_pcm_prepare(pcm);
        continue;
      }
      if (w < 0) {
        pthread_mutex_lock(&g_st.mu);
        snprintf(g_st.error, sizeof(g_st.error), "audio device write failed: %s",
                 snd_strerror((int)w));
        log_line("ALSA write failed: %s", snd_strerror((int)w));
        g_st.playing = false;
        g_st.ended = true;
        g_st.thread_running = false;
        pthread_mutex_unlock(&g_st.mu);
        write_failed = true;
        break;
      }
      p += w * info.channels;
      remaining -= (int)w;
      pthread_mutex_lock(&g_st.mu);
      g_st.frames_written += (uint64_t)w;
      /* Position = written minus what is still buffered in hardware. */
      snd_pcm_sframes_t delay = 0;
      if (snd_pcm_delay(pcm, &delay) == 0 && delay > 0)
        g_st.frames_played = g_st.frames_written - (uint64_t)delay;
      else
        g_st.frames_played = g_st.frames_written;
      bool stop = g_st.stop_requested || generation != g_st.generation;
      pthread_mutex_unlock(&g_st.mu);
      if (stop)
        break;
    }
    if (write_failed)
      break;

    pthread_mutex_lock(&g_st.mu);
    if (g_st.stop_requested || generation != g_st.generation) {
      pthread_mutex_unlock(&g_st.mu);
      break;
    }
    uint64_t written = g_st.frames_written;
    bool keep_going = pace_wait_locked(written, info.sample_rate, &started_at);
    pthread_mutex_unlock(&g_st.mu);
    if (!keep_going)
      break;
  }

  free(buf);
  pthread_mutex_lock(&g_st.mu);
  /* The thread owns dec/pcm; the command side must not free them
   * while the thread runs — stop_playback_locked() joins first. */
  if (generation == g_st.generation) {
    g_st.thread_running = false;
  }
  pthread_mutex_unlock(&g_st.mu);
  return NULL;
}

/* Must hold g_st.mu. Stops the playback thread (if any), closes the
 * decoder + ALSA handle, and clears the loaded track. */
static void stop_playback_locked(void) {
  if (g_st.thread_running) {
    g_st.stop_requested = true;
    pthread_cond_broadcast(&g_st.cond);
    pthread_t th = g_st.thread;
    /* Drop the mutex while joining: the thread needs it to exit. */
    pthread_mutex_unlock(&g_st.mu);
    pthread_join(th, NULL);
    pthread_mutex_lock(&g_st.mu);
    g_st.thread_running = false;
    g_st.stop_requested = false;
  }
  if (g_st.pcm != NULL) {
    snd_pcm_drop(g_st.pcm);
    snd_pcm_close(g_st.pcm);
    g_st.pcm = NULL;
  }
  if (g_st.dec != NULL) {
    audio_decoder_close(g_st.dec);
    g_st.dec = NULL;
  }
  free(g_st.path);
  g_st.path = NULL;
  g_st.playing = false;
  g_st.paused = false;
  g_st.ended = false;
  g_st.frames_written = 0;
  g_st.frames_played = 0;
  g_st.pause_frame = 0;
  g_st.error[0] = '\0';
  g_st.generation++;
}

/* ------------------------------------------------------------------ */
/* command handlers — each writes exactly one JSON line to `out`       */
/* ------------------------------------------------------------------ */

static void json_escape_into(char *dst, size_t cap, const char *src) {
  size_t o = 0;
  for (size_t i = 0; src[i] != '\0' && o + 2 < cap; i++) {
    char c = src[i];
    if (c == '"' || c == '\\') {
      dst[o++] = '\\';
      dst[o++] = c;
    } else if (c == '\n') {
      dst[o++] = '\\';
      dst[o++] = 'n';
    } else if ((unsigned char)c < 0x20) {
      if (o + 6 < cap) {
        o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", c);
      }
    } else {
      dst[o++] = c;
    }
  }
  dst[o] = '\0';
}

/* Must hold g_st.mu. */
static void status_json_locked(char *out, size_t cap) {
  char path_esc[1024];
  if (g_st.path != NULL)
    json_escape_into(path_esc, sizeof(path_esc), g_st.path);
  else
    path_esc[0] = '\0';
  char err_esc[256];
  json_escape_into(err_esc, sizeof(err_esc), g_st.error);
  if (g_st.path != NULL) {
    snprintf(out, cap,
             "{\"ok\":true,\"available\":%s,\"playing\":%s,\"paused\":%s,"
             "\"positionSec\":%.3f,\"durationSec\":%.3f,\"volume\":%d,"
             "\"track\":{\"path\":\"%s\",\"format\":\"%s\",\"durationSec\":%.3f},"
             "\"error\":\"%s\"}\n",
             g_st.device_available ? "true" : "false",
             g_st.playing ? "true" : "false", g_st.paused ? "true" : "false",
             state_position_sec_locked(), state_duration_sec_locked(), g_st.volume,
             path_esc, g_st.info.format, g_st.info.duration_sec, err_esc);
  } else {
    snprintf(out, cap,
             "{\"ok\":true,\"available\":%s,\"playing\":false,\"paused\":false,"
             "\"positionSec\":0,\"durationSec\":0,\"volume\":%d,"
             "\"track\":null,\"error\":\"%s\"}\n",
             g_st.device_available ? "true" : "false", g_st.volume, err_esc);
  }
}

static void fail_json(char *out, size_t cap, const char *code, const char *msg) {
  char msg_esc[512];
  json_escape_into(msg_esc, sizeof(msg_esc), msg);
  snprintf(out, cap, "{\"ok\":false,\"error\":\"%s\",\"code\":\"%s\"}\n", msg_esc, code);
}

static void cmd_status(char *out, size_t cap) {
  pthread_mutex_lock(&g_st.mu);
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_play(const char *path, char *out, size_t cap) {
  if (path == NULL || path[0] == '\0') {
    fail_json(out, cap, "bad-argument", "PLAY requires a file path");
    return;
  }
  if (path[0] != '/') {
    fail_json(out, cap, "bad-argument", "PLAY requires an absolute path");
    return;
  }
  char err[256];
  audio_decoder_t *dec = audio_decoder_open(path, err, sizeof(err));
  if (dec == NULL) {
    const char *code = "decode-error";
    if (strstr(err, "not found") != NULL)
      code = "not-found";
    else if (strstr(err, "unsupported") != NULL)
      code = "unsupported-format";
    fail_json(out, cap, code, err);
    return;
  }
  const audio_format_info_t *info = audio_decoder_info(dec);

  pthread_mutex_lock(&g_st.mu);
  if (!g_st.device_available) {
    pthread_mutex_unlock(&g_st.mu);
    audio_decoder_close(dec);
    fail_json(out, cap, "no-audio-device",
              "no audio output device is available on this machine");
    return;
  }
  stop_playback_locked();
  char aerr[256];
  snd_pcm_t *pcm = NULL;
  int arc = alsa_open(&pcm, info, aerr, sizeof(aerr));
  if (arc != 0) {
    pthread_mutex_unlock(&g_st.mu);
    audio_decoder_close(dec);
    fail_json(out, cap, arc == -2 ? "unsupported-sample-format" : "no-audio-device",
              aerr);
    return;
  }
  g_st.path = strdup(path);
  g_st.info = *info;
  g_st.dec = dec;
  g_st.pcm = pcm;
  g_st.playing = true;
  g_st.paused = false;
  g_st.ended = false;
  g_st.frames_written = 0;
  g_st.frames_played = 0;
  g_st.pause_frame = 0;
  g_st.error[0] = '\0';
  g_st.stop_requested = false;
  g_st.thread_running = true;
  if (pthread_create(&g_st.thread, NULL, playback_thread, NULL) != 0) {
    snd_pcm_close(pcm);
    audio_decoder_close(dec);
    free(g_st.path);
    g_st.path = NULL;
    g_st.dec = NULL;
    g_st.pcm = NULL;
    g_st.playing = false;
    g_st.thread_running = false;
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "decode-error", "cannot start playback thread");
    return;
  }
  log_line("play %s (%s, %u Hz, %u ch, %.1fs)", path, info->format,
           info->sample_rate, info->channels, info->duration_sec);
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_pause(char *out, size_t cap) {
  pthread_mutex_lock(&g_st.mu);
  if (g_st.path == NULL || !g_st.playing) {
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "idle", "nothing is playing");
    return;
  }
  if (!g_st.paused) {
    g_st.pause_frame = g_st.frames_played;
    g_st.paused = true;
    pthread_cond_broadcast(&g_st.cond);
  }
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_resume(char *out, size_t cap) {
  pthread_mutex_lock(&g_st.mu);
  if (g_st.path == NULL || !g_st.playing) {
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "idle", "nothing is playing");
    return;
  }
  if (g_st.paused) {
    g_st.paused = false;
    /* Re-base the pacing origin is handled by the playback thread
     * (it re-derives started_at from frames_written on wake). */
    pthread_cond_broadcast(&g_st.cond);
  }
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_stop(char *out, size_t cap) {
  pthread_mutex_lock(&g_st.mu);
  stop_playback_locked();
  log_line("stop");
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_seek(const char *arg, char *out, size_t cap) {
  char *end = NULL;
  double seconds = strtod(arg ? arg : "", &end);
  if (arg == NULL || end == arg || *end != '\0' || !isfinite(seconds)) {
    fail_json(out, cap, "bad-argument", "SEEK requires a number of seconds");
    return;
  }
  pthread_mutex_lock(&g_st.mu);
  if (g_st.path == NULL || !g_st.playing) {
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "idle", "nothing is playing");
    return;
  }
  if (seconds < 0.0 || seconds > g_st.info.duration_sec) {
    char msg[128];
    snprintf(msg, sizeof(msg), "seek %.3f is outside 0..%.3f", seconds,
             g_st.info.duration_sec);
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "out-of-range", msg);
    return;
  }
  uint64_t frame = (uint64_t)(seconds * (double)g_st.info.sample_rate);
  if (frame > g_st.info.total_frames)
    frame = g_st.info.total_frames;
  /* Seek = stop the thread FIRST (it owns decoder reads), then seek
   * the decoder, then reopen ALSA at the new frame. Reopening the
   * device guarantees a half-fed hardware buffer can never play
   * stale audio after the seek. */
  audio_decoder_t *dec = g_st.dec;
  snd_pcm_t *pcm = g_st.pcm;
  char *path = g_st.path;
  audio_format_info_t info = g_st.info;
  int volume = g_st.volume;
  bool was_paused = g_st.paused;
  g_st.generation++;
  if (g_st.thread_running) {
    g_st.stop_requested = true;
    pthread_cond_broadcast(&g_st.cond);
    pthread_t th = g_st.thread;
    pthread_mutex_unlock(&g_st.mu);
    pthread_join(th, NULL);
    pthread_mutex_lock(&g_st.mu);
    g_st.thread_running = false;
    g_st.stop_requested = false;
  }
  if (audio_decoder_seek(dec, frame) != 0) {
    /* The decoder never moved: restart playback where it was instead
     * of leaving a dead thread behind a "playing" status. The old
     * ALSA handle is still open and valid, so only the thread restarts. */
    g_st.thread_running = true;
    g_st.stop_requested = false;
    if (pthread_create(&g_st.thread, NULL, playback_thread, NULL) != 0) {
      g_st.thread_running = false;
      g_st.playing = false;
      pthread_mutex_unlock(&g_st.mu);
      fail_json(out, cap, "decode-error", "cannot restart playback thread");
      return;
    }
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "decode-error", "decoder cannot seek to that position");
    return;
  }
  if (pcm != NULL) {
    snd_pcm_drop(pcm);
    snd_pcm_close(pcm);
  }
  char aerr[256];
  snd_pcm_t *new_pcm = NULL;
  int arc = alsa_open(&new_pcm, &info, aerr, sizeof(aerr));
  if (arc != 0) {
    /* Decoder is seeked; keep the track loaded but stopped so a
     * later PLAY is clean. */
    g_st.pcm = NULL;
    g_st.playing = false;
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, arc == -2 ? "unsupported-sample-format" : "no-audio-device",
              aerr);
    return;
  }
  g_st.pcm = new_pcm;
  g_st.frames_written = frame;
  g_st.frames_played = frame;
  g_st.pause_frame = frame;
  g_st.ended = false;
  g_st.playing = true;
  g_st.paused = was_paused;
  g_st.thread_running = true;
  g_st.stop_requested = false;
  if (pthread_create(&g_st.thread, NULL, playback_thread, NULL) != 0) {
    g_st.playing = false;
    g_st.thread_running = false;
    pthread_mutex_unlock(&g_st.mu);
    fail_json(out, cap, "decode-error", "cannot restart playback thread");
    return;
  }
  (void)path;
  (void)volume;
  log_line("seek %.3fs", seconds);
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static void cmd_volume(const char *arg, char *out, size_t cap) {
  char *end = NULL;
  double v = strtod(arg ? arg : "", &end);
  if (arg == NULL || end == arg || *end != '\0' || !isfinite(v)) {
    fail_json(out, cap, "bad-argument", "VOLUME requires a number 0..100");
    return;
  }
  /* Clamp, amixer-style: out-of-range volume is a user slip, not an
   * error — but it never crashes anything and the reply reports the
   * value actually applied. */
  int clamped = (int)v;
  if (clamped < 0)
    clamped = 0;
  if (clamped > 100)
    clamped = 100;
  pthread_mutex_lock(&g_st.mu);
  g_st.volume = clamped;
  status_json_locked(out, cap);
  pthread_mutex_unlock(&g_st.mu);
}

static int cmp_track(const void *a, const void *b) {
  const char *sa = (const char *)a;
  const char *sb = (const char *)b;
  return strcmp(sa, sb);
}

static void cmd_scan(const char *dir_arg, char *out, size_t cap) {
  const char *dir = (dir_arg != NULL && dir_arg[0] != '\0') ? dir_arg : DEFAULT_SCAN_DIR;
  DIR *d = opendir(dir);
  if (d == NULL) {
    char msg[256];
    snprintf(msg, sizeof(msg), "cannot list %s: %s", dir, strerror(errno));
    fail_json(out, cap, "not-found", msg);
    return;
  }
  /* Collect names first (bounded), sort, then probe — so the reply
   * order is stable and one bad file cannot reorder the library. */
  char (*names)[512] = calloc(MAX_SCAN_TRACKS, sizeof(*names));
  if (names == NULL) {
    closedir(d);
    fail_json(out, cap, "decode-error", "out of memory");
    return;
  }
  size_t count = 0;
  struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (ent->d_name[0] == '.')
      continue;
    if (!audio_decoder_is_audio_path(ent->d_name))
      continue;
    if (count >= MAX_SCAN_TRACKS)
      break;
    snprintf(names[count], sizeof(names[count]), "%s", ent->d_name);
    count++;
  }
  closedir(d);
  qsort(names, count, sizeof(*names), cmp_track);

  size_t used = 0;
  used += (size_t)snprintf(out + used, cap - used, "{\"ok\":true,\"tracks\":[");
  bool first = true;
  for (size_t i = 0; i < count; i++) {
    char full[1024];
    snprintf(full, sizeof(full), "%s/%s", dir, names[i]);
    struct stat st;
    if (stat(full, &st) != 0 || !S_ISREG(st.st_mode))
      continue;
    audio_format_info_t info;
    char err[128];
    if (audio_decoder_probe(full, &info, err, sizeof(err)) != 0)
      continue; /* undecodable file: skipped, never fails the scan */
    /* Title from the file name; "Artist - Title" splits like the
     * host's media scan does. Metadata tags are a follow-up. */
    char base[512];
    snprintf(base, sizeof(base), "%s", names[i]);
    char *dot = strrchr(base, '.');
    if (dot != NULL)
      *dot = '\0';
    char title[512], artist[512];
    snprintf(artist, sizeof(artist), "Unknown Artist");
    snprintf(title, sizeof(title), "%s", base);
    char *sep = strstr(base, " - ");
    if (sep != NULL) {
      *sep = '\0';
      if (base[0] != '\0')
        snprintf(artist, sizeof(artist), "%s", base);
      if (sep[3] != '\0')
        snprintf(title, sizeof(title), "%s", sep + 3);
    }
    char path_esc[1024], title_esc[512], artist_esc[512];
    json_escape_into(path_esc, sizeof(path_esc), full);
    json_escape_into(title_esc, sizeof(title_esc), title);
    json_escape_into(artist_esc, sizeof(artist_esc), artist);
    if (!first)
      used += (size_t)snprintf(out + used, cap - used, ",");
    first = false;
    used += (size_t)snprintf(
        out + used, cap - used,
        "{\"id\":\"%s\",\"title\":\"%s\",\"artist\":\"%s\",\"album\":\"Local Library\","
        "\"durationSec\":%.3f,\"path\":\"%s\",\"format\":\"%s\"}",
        path_esc, title_esc, artist_esc, info.duration_sec, path_esc, info.format);
    if (used >= cap - 256)
      break; /* reply buffer guard: truncate the list, never overflow */
  }
  free(names);
  snprintf(out + used, cap - used, "]}\n");
}

/* Returns 1 when the daemon should exit after replying. */
static int dispatch_line(const char *line, char *out, size_t cap) {
  /* Split command + argument on the first space. */
  char cmd[32];
  const char *arg = NULL;
  const char *sp = strchr(line, ' ');
  if (sp != NULL) {
    size_t n = (size_t)(sp - line);
    if (n >= sizeof(cmd))
      n = sizeof(cmd) - 1;
    memcpy(cmd, line, n);
    cmd[n] = '\0';
    arg = sp + 1;
    while (*arg == ' ')
      arg++;
    if (*arg == '\0')
      arg = NULL;
  } else {
    snprintf(cmd, sizeof(cmd), "%s", line);
  }

  if (strcmp(cmd, "STATUS") == 0)
    cmd_status(out, cap);
  else if (strcmp(cmd, "PLAY") == 0)
    cmd_play(arg, out, cap);
  else if (strcmp(cmd, "PAUSE") == 0)
    cmd_pause(out, cap);
  else if (strcmp(cmd, "RESUME") == 0)
    cmd_resume(out, cap);
  else if (strcmp(cmd, "STOP") == 0)
    cmd_stop(out, cap);
  else if (strcmp(cmd, "SEEK") == 0)
    cmd_seek(arg, out, cap);
  else if (strcmp(cmd, "VOLUME") == 0)
    cmd_volume(arg, out, cap);
  else if (strcmp(cmd, "SCAN") == 0)
    cmd_scan(arg, out, cap);
  else if (strcmp(cmd, "SHUTDOWN") == 0) {
    snprintf(out, cap, "{\"ok\":true}\n");
    return 1;
  } else
    fail_json(out, cap, "bad-argument", "unknown command");
  return 0;
}

/* ------------------------------------------------------------------ */
/* socket server                                                       */
/* ------------------------------------------------------------------ */

static void *client_thread(void *arg) {
  int fd = *(int *)arg;
  free(arg);
  pthread_detach(pthread_self());
  FILE *in = fdopen(fd, "r");
  if (in == NULL) {
    close(fd);
    return NULL;
  }
  char *line = NULL;
  size_t line_cap = 0;
  ssize_t n;
  /* One reply per line. The reply buffer is 64 KiB (SCAN of a large
   * library truncates its list rather than growing unboundedly). */
  static _Thread_local char reply[65536];
  while ((n = getline(&line, &line_cap, in)) >= 0) {
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r'))
      line[--n] = '\0';
    if (n == 0)
      continue;
    if (n >= MAX_LINE) {
      const char *err = "{\"ok\":false,\"error\":\"command too long\","
                        "\"code\":\"bad-argument\"}\n";
      (void)!write(fd, err, strlen(err));
      continue;
    }
    int should_exit = dispatch_line(line, reply, sizeof(reply));
    (void)!write(fd, reply, strlen(reply));
    if (should_exit) {
      g_shutting_down = 1;
      if (g_listen_fd >= 0) {
        shutdown(g_listen_fd, SHUT_RDWR);
        close(g_listen_fd);
        g_listen_fd = -1;
      }
      break;
    }
    if (g_shutting_down)
      break;
  }
  free(line);
  fclose(in); /* closes fd */
  return NULL;
}

static void handle_signal(int sig) {
  (void)sig;
  g_shutting_down = 1;
  if (g_listen_fd >= 0) {
    shutdown(g_listen_fd, SHUT_RDWR);
    close(g_listen_fd);
    g_listen_fd = -1;
  }
}

static bool probe_device(void) {
  snd_pcm_t *pcm = NULL;
  int rc = snd_pcm_open(&pcm, g_device, SND_PCM_STREAM_PLAYBACK, 0);
  if (rc < 0) {
    log_line("no audio device (%s): %s", g_device, snd_strerror(rc));
    return false;
  }
  snd_pcm_close(pcm);
  log_line("audio device %s available", g_device);
  return true;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc)
      g_sock_path = argv[++i];
    else if (strcmp(argv[i], "--device") == 0 && i + 1 < argc)
      g_device = argv[++i];
    else {
      fprintf(stderr, "usage: sevyn-audiod [--socket <path>] [--device <alsa>]\n");
      return 2;
    }
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = handle_signal;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);

  memset(&g_st, 0, sizeof(g_st));
  pthread_mutex_init(&g_st.mu, NULL);
  /* Pacing waits on this condition with CLOCK_MONOTONIC deadlines
   * (see pace_wait_locked): the default condition clock is
   * CLOCK_REALTIME, which would interpret a monotonic deadline as a
   * 1970 time — already past — and never wait at all. */
  pthread_condattr_t cond_attr;
  pthread_condattr_init(&cond_attr);
  pthread_condattr_setclock(&cond_attr, CLOCK_MONOTONIC);
  pthread_cond_init(&g_st.cond, &cond_attr);
  pthread_condattr_destroy(&cond_attr);
  g_st.volume = 100;
  g_st.device_available = probe_device();

  unlink(g_sock_path);
  g_listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (g_listen_fd < 0) {
    log_line("cannot create socket: %s", strerror(errno));
    return 1;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", g_sock_path);
  if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    log_line("cannot bind %s: %s", g_sock_path, strerror(errno));
    return 1;
  }
  if (listen(g_listen_fd, 8) != 0) {
    log_line("cannot listen: %s", strerror(errno));
    return 1;
  }
  log_line("audiod listening on %s (device %s)", g_sock_path, g_device);

  for (;;) {
    if (g_shutting_down)
      break;
    int fd = accept(g_listen_fd, NULL, NULL);
    if (fd < 0) {
      if (g_shutting_down)
        break;
      if (errno == EINTR)
        continue;
      log_line("accept failed: %s", strerror(errno));
      continue;
    }
    int *pfd = malloc(sizeof(int));
    if (pfd == NULL) {
      close(fd);
      continue;
    }
    *pfd = fd;
    pthread_t th;
    if (pthread_create(&th, NULL, client_thread, pfd) != 0) {
      free(pfd);
      close(fd);
    }
  }

  /* Clean shutdown: stop playback, close the decoder + device. */
  pthread_mutex_lock(&g_st.mu);
  stop_playback_locked();
  pthread_mutex_unlock(&g_st.mu);
  if (g_listen_fd >= 0)
    close(g_listen_fd);
  unlink(g_sock_path);
  log_line("audiod stopped");
  return 0;
}
