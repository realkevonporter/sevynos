/* SevynOS v2 M1 — status daemon (sevyn-statusd).
 *
 * The live system-status service. It owns six values — battery, wifi,
 * volume, ai.god_mode (P2), ai.relay (relay 1b), ai.screen (relay
 * frames, R8/S2) — and pushes every
 * change to all subscribers over a Unix socket.
 * Nothing in the system polls for status: changes arrive by event.
 *
 * Event sources (all watched with poll()/inotify, no polling loops):
 *   - /sys/class/power_supply/<name>/capacity and /sys/class/net/<if>/operstate
 *     via inotify (present on real hardware; absent in QEMU, where the
 *     values stay "unknown" until set).
 *   - SET commands on the Unix socket /run/sevyn-status.sock (local
 *     control: volume has no sysfs source, so it is set this way).
 *   - SET commands on /dev/ttyS1 (the host control serial in QEMU; this
 *     is how the M1 harness injects a change from outside the guest).
 *
 * Protocol (line-based, \n-terminated):
 *   client -> SUBSCRIBE   : register + receive current values immediately
 *   client -> SET k v     : set a value, broadcast STATUS k v to subscribers
 *   client -> GET         : receive current values (this client only)
 *   client -> POWEROFF    : clean guest poweroff (M1 harness end-of-test)
 *   client -> REBOOT      : clean guest reboot (same teardown, then reboot)
 *   daemon -> STATUS k v  : a value changed
 *
 * Time (system-clock fix — the GF65's CMOS RTC reads 2010-01-03 and
 * nothing corrects it: the v1 time service (ac06e00) set the clock
 * with `date -s`, which only worked while Genesis ran as root; the
 * Phase 2 non-root session user (cc1639c) silently broke it — every
 * sync fails EPERM and no privileged path was ever added. The daemon
 * runs as root, so it owns the privileged half; the unprivileged
 * side (LinuxTimeService, `sevyn time`) only asks):
 *   client -> SET_TIME <epoch-ms> [offset-ms] [source]
 *                         : set CLOCK_REALTIME + the RTC, persist the
 *                           last-known time, record the sync state.
 *                           Replies OK <epoch-ms> or ERR <reason>
 *                           (to the requesting client only).
 *   client -> GET_TIME    : reply TIME now_ms=.. last_sync_ms=..
 *                           offset_ms=.. source=.. rtc=.. restored_ms=..
 *                           (requesting client only; last_sync_ms 0 =
 *                           no sync yet this boot).
 *   client -> SET_TIMEZONE <tz>
 *                         : validate an IANA name, write /etc/timezone
 *                           + re-link /etc/localtime. Replies OK/ERR.
 *   daemon -> TIME ...    : the GET_TIME reply (see above).
 * At startup the daemon restores the last-known good time when it is
 * newer than the current clock — the dead-RTC-battery mask: a reboot
 * with a dead battery no longer comes up in 2010. The file is
 * written on every successful SET_TIME; the newest of the two paths
 * wins (installed systems persist /var/lib/sevynos on the rootfs,
 * .img systems persist /data on the data disk).
 *
 * Trust model (unchanged): the socket is world-accessible, exactly
 * like the existing SET/POWEROFF verbs — any local user can already
 * power the machine off through it, so a time verb grants nothing
 * new. No passwordless-sudo rule for `date` was added on purpose:
 * a narrow daemon verb beats a broad sudo hole.
 *
 * Build: gcc, libc only. Run as root from the guest init script.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/rtc.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define SOCK_PATH_ENV "SEVYN_STATUS_SOCK"
#define SOCK_PATH "/run/sevyn-status.sock"
#define CTL_TTY "/dev/ttyS1"
#define MAX_CLIENTS 16
#define LINE_MAX 256

static int console_fd = -1;

/* Retrying console writer: loops a write until complete, waiting for
 * POLLOUT on EAGAIN. The guest console is opened O_NONBLOCK, so a
 * single write can fail outright when the serial buffer is momentarily
 * full — the line would silently vanish. Retrying keeps every logged
 * line in the serial stream. Capped at ~5s so a wedged console cannot
 * stall the process forever. */
static void write_all_console(const char *buf, size_t n)
{
    size_t off = 0;
    int tries = 0;
    while (off < n && tries < 50) {
        ssize_t w = write(console_fd, buf + off, n - off);
        if (w > 0) {
            off += (size_t)w;
            continue;
        }
        if (w < 0 && errno != EAGAIN && errno != EINTR)
            break;
        struct pollfd pfd = { .fd = console_fd, .events = POLLOUT };
        (void)!poll(&pfd, 1, 100);
        tries++;
    }
}

static void log_line(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    if (console_fd >= 0)
        write_all_console(buf, (size_t)n);
}

struct value {
    const char *key;
    char current[64];
};

/* The keys this daemon owns. Every other key is ignored on SET
 * (log + drop) — a writer that asks for a key it does not own is a
 * bug, not a crash. `ai.god_mode` is the God Mode mark (P2): the AI
 * daemon SETs it on/off as the mode changes, and the shell tray
 * reads it from the snapshot to show the GOD pill. `ai.relay` is
 * the relay mark (1b): `sevyn tailscale up/down/revoke` SETs it
 * on/off as the tailnet join changes, and the tray reads it to
 * show the RELAY pill. `ai.screen` is the screen-observation
 * mark (relay frames, R8/S2): the relay agent — not the daemon —
 * SETs it on when the first frame of a session is delivered and
 * off when the session ends, and the tray reads it to show the
 * red SCREEN pill. The agent talks to statusd directly over the
 * socket (the same fire-and-forget SET the daemon uses); the
 * daemon itself never touches this key. */
static struct value values[] = {
    { "battery", "unknown" },
    { "wifi", "unknown" },
    { "volume", "50" },
    { "ai.god_mode", "off" },
    { "ai.relay", "off" },
    { "ai.screen", "off" },
};
#define NVALUES (sizeof(values) / sizeof(values[0]))

struct client {
    int fd;
    bool subscribed;
    char buf[LINE_MAX];
    size_t len;
};

static struct client clients[MAX_CLIENTS];
static int nclients;

static struct value *find_value(const char *key)
{
    for (size_t i = 0; i < NVALUES; i++)
        if (strcmp(values[i].key, key) == 0)
            return &values[i];
    return NULL;
}

static void send_all_values(int fd)
{
    for (size_t i = 0; i < NVALUES; i++) {
        char line[128];
        int n = snprintf(line, sizeof(line), "STATUS %s %s\n", values[i].key, values[i].current);
        (void)!write(fd, line, (size_t)n);
    }
}

static void broadcast(const char *key, const char *val)
{
    char line[128];
    int n = snprintf(line, sizeof(line), "STATUS %s %s\n", key, val);
    for (int i = 0; i < nclients; i++) {
        if (clients[i].subscribed)
            (void)!write(clients[i].fd, line, (size_t)n);
    }
    log_line("STATUSD broadcast %s %s", key, val);
}

static void set_value(const char *key, const char *val)
{
    struct value *v = find_value(key);
    if (!v) {
        log_line("STATUSD ignoring unknown key %s", key);
        return;
    }
    if (strcmp(v->current, val) == 0)
        return;
    snprintf(v->current, sizeof(v->current), "%s", val);
    broadcast(key, val);
}

/* Read a small sysfs file into buf (no trailing newline). Returns false if
 * the file cannot be read. */
static bool read_sysfs(const char *path, char *buf, size_t cap)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0)
        return false;
    ssize_t n = read(fd, buf, cap - 1);
    close(fd);
    if (n <= 0)
        return false;
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' '))
        n--;
    buf[n] = '\0';
    return true;
}

/* --- sysfs watchers (inotify) --- */

struct watch {
    int wd;
    const char *key;      /* value this watch feeds */
    char path[256];       /* file being watched */
    const char *map_up;   /* sysfs text -> published value, or NULL (raw) */
};

static struct watch watches[8];
static int nwatches;
static int inotify_fd = -1;

static void add_watch(const char *path, const char *key)
{
    if (nwatches >= (int)(sizeof(watches) / sizeof(watches[0])))
        return;
    int wd = inotify_add_watch(inotify_fd, path, IN_MODIFY | IN_ATTRIB);
    if (wd < 0) {
        log_line("STATUSD watch failed %s: %s", path, strerror(errno));
        return;
    }
    watches[nwatches].wd = wd;
    watches[nwatches].key = key;
    snprintf(watches[nwatches].path, sizeof(watches[nwatches].path), "%s", path);
    nwatches++;
    log_line("STATUSD watching %s -> %s", path, key);
}

static void setup_sysfs_watches(void)
{
    inotify_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (inotify_fd < 0) {
        log_line("STATUSD inotify unavailable: %s", strerror(errno));
        return;
    }
    /* Battery: first power_supply entry with a capacity file. */
    const char *bats[] = { "BAT0", "BAT1", "battery", NULL };
    for (int i = 0; bats[i]; i++) {
        char path[256];
        snprintf(path, sizeof(path), "/sys/class/power_supply/%s/capacity", bats[i]);
        struct stat st;
        if (stat(path, &st) == 0) {
            char val[64];
            if (read_sysfs(path, val, sizeof(val)))
                set_value("battery", val);
            add_watch(path, "battery");
            break;
        }
    }
    /* Wifi: first wireless interface's operstate. The tray shows
     * "Wi-Fi" only for "on" (see StatusTray.tsx), so the raw
     * operstate is mapped onto the tray contract — "up" means
     * connected, anything else means off (same mapping as the
     * inotify handler below). */
    const char *ifs[] = { "wlan0", "wlp0s0", "wlp2s0", "wlan1", NULL };
    for (int i = 0; ifs[i]; i++) {
        char path[256];
        snprintf(path, sizeof(path), "/sys/class/net/%s/operstate", ifs[i]);
        struct stat st;
        if (stat(path, &st) == 0) {
            char val[64];
            if (read_sysfs(path, val, sizeof(val)))
                set_value("wifi", strcmp(val, "up") == 0 ? "on" : "off");
            add_watch(path, "wifi");
            break;
        }
    }
}

static void handle_inotify(void)
{
    char buf[4096];
    ssize_t n;
    while ((n = read(inotify_fd, buf, sizeof(buf))) > 0) {
        char *p = buf;
        while (p < buf + n) {
            struct inotify_event *ev = (struct inotify_event *)p;
            for (int i = 0; i < nwatches; i++) {
                if (watches[i].wd == ev->wd) {
                    char val[64];
                    if (!read_sysfs(watches[i].path, val, sizeof(val)))
                        break;
                    /* Wifi: the tray shows "Wi-Fi" only for the
                     * value "on" (see StatusTray.tsx), so the
                     * sysfs operstate is mapped onto the tray
                     * contract here — "up" means connected, anything
                     * else means off. The SET path stays raw (the
                     * M1 harness SETs "up" and asserts the
                     * broadcast verbatim). */
                    if (strcmp(watches[i].key, "wifi") == 0)
                        set_value("wifi",
                                  strcmp(val, "up") == 0 ? "on" : "off");
                    else
                        set_value(watches[i].key, val);
                }
            }
            p += sizeof(struct inotify_event) + ev->len;
        }
    }
}

/* --- system clock (SET_TIME / GET_TIME / SET_TIMEZONE) --- */

#define TIME_MIN_MS 1577836800000LL /* 2020-01-01T00:00:00Z */
#define TIME_MAX_MS 4102444800000LL /* 2100-01-01T00:00:00Z */
#define TIMEZONE_DIR "/usr/share/zoneinfo"
#define TIMEZONE_FILE "/etc/timezone"
#define LOCALTIME_PATH "/etc/localtime"

/* Last-known-time persistence. Installed systems persist
 * /var/lib/sevynos on the rootfs; .img systems run the rootfs from
 * initramfs, so /data (the persistent data disk) is the path that
 * survives a reboot there. Both are written, newest wins on read. */
static const char *LAST_KNOWN_TIME_PATHS[] = {
    "/var/lib/sevynos/last-known-time",
    "/data/sevynos/last-known-time",
    NULL,
};

static struct {
    long long last_sync_ms; /* 0 = no sync yet this boot */
    long long offset_ms;
    char source[32];
    char rtc[16]; /* "unknown" | "ok" | "unavailable" | "failed" */
    long long restored_ms; /* 0 = no restore this boot */
} time_state = { 0, 0, "none", "unknown", 0 };

static long long now_ms(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0)
        return 0;
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* RTC_SET_TIME on /dev/rtc0 (UTC — the kernel's convention).
 * Returns 0 on success, 1 when there is no RTC device, -1 on any
 * other failure. Never fatal: a missing RTC just means the hardware
 * clock keeps its (possibly wrong) value until NTP corrects the
 * system clock again. */
static int write_rtc(long long epoch_ms)
{
    int fd = open("/dev/rtc0", O_RDWR);
    if (fd < 0)
        return 1;
    time_t s = (time_t)(epoch_ms / 1000);
    struct tm tmv;
    if (gmtime_r(&s, &tmv) == NULL) {
        close(fd);
        return -1;
    }
    struct rtc_time rt;
    memset(&rt, 0, sizeof(rt));
    rt.tm_sec = tmv.tm_sec;
    rt.tm_min = tmv.tm_min;
    rt.tm_hour = tmv.tm_hour;
    rt.tm_mday = tmv.tm_mday;
    rt.tm_mon = tmv.tm_mon;
    rt.tm_year = tmv.tm_year;
    rt.tm_wday = tmv.tm_wday;
    rt.tm_yday = tmv.tm_yday;
    rt.tm_isdst = 0;
    int rc = ioctl(fd, RTC_SET_TIME, &rt);
    close(fd);
    return rc == 0 ? 0 : -1;
}

/* Set the system clock + RTC from an in-range epoch-ms value.
 * Returns 0 on success, -1 when clock_settime itself failed (an
 * RTC failure does not fail it — the system clock is what matters). */
static int apply_system_time(long long epoch_ms)
{
    struct timespec ts;
    ts.tv_sec = (time_t)(epoch_ms / 1000);
    ts.tv_nsec = (long)(epoch_ms % 1000) * 1000000L;
    if (clock_settime(CLOCK_REALTIME, &ts) != 0)
        return -1;
    int rtc = write_rtc(epoch_ms);
    snprintf(time_state.rtc, sizeof(time_state.rtc), "%s",
             rtc == 0 ? "ok" : rtc == 1 ? "unavailable" : "failed");
    return 0;
}

/* Write one last-known-time file (best effort). A missing or
 * unwritable path is not an error — the other path may persist. */
static void write_last_known_time_one(const char *path, long long epoch_ms)
{
    char dir[256];
    snprintf(dir, sizeof(dir), "%s", path);
    char *slash = strrchr(dir, '/');
    if (slash) {
        *slash = '\0';
        mkdir(dir, 0755);
    }
    FILE *f = fopen(path, "w");
    if (!f)
        return;
    fprintf(f, "%lld\n", epoch_ms);
    (void)fclose(f);
}

static void persist_last_known_time(long long epoch_ms)
{
    for (int i = 0; LAST_KNOWN_TIME_PATHS[i]; i++)
        write_last_known_time_one(LAST_KNOWN_TIME_PATHS[i], epoch_ms);
}

static bool read_last_known_time_one(const char *path, long long *out)
{
    FILE *f = fopen(path, "r");
    if (!f)
        return false;
    char buf[64];
    if (!fgets(buf, sizeof(buf), f)) {
        fclose(f);
        return false;
    }
    fclose(f);
    char *end = NULL;
    long long v = strtoll(buf, &end, 10);
    if (end == buf || v < TIME_MIN_MS || v > TIME_MAX_MS)
        return false;
    *out = v;
    return true;
}

/* Newest persisted last-known time across the paths, or 0. */
static long long read_last_known_time(void)
{
    long long best = 0;
    for (int i = 0; LAST_KNOWN_TIME_PATHS[i]; i++) {
        long long v = 0;
        if (read_last_known_time_one(LAST_KNOWN_TIME_PATHS[i], &v) && v > best)
            best = v;
    }
    return best;
}

/* Dead-RTC-battery mask: at startup, when the persisted last-known
 * time is newer than the current clock (a CMOS RTC that reads 2010
 * after a dead battery, say), adopt it. The clock is still wrong by
 * the powered-off interval, but it is years closer than 2010 — and
 * NTP on network-up corrects the rest. Never moves the clock
 * backwards. */
static void restore_last_known_time(void)
{
    long long known = read_last_known_time();
    if (known == 0)
        return;
    long long cur = now_ms();
    if (known <= cur) {
        log_line("STATUSD last-known time %lld not newer than clock %lld; keeping clock",
                 known, cur);
        return;
    }
    if (apply_system_time(known) != 0) {
        log_line("STATUSD last-known time restore failed: %s", strerror(errno));
        return;
    }
    time_state.restored_ms = known;
    log_line("STATUSD clock restored from last-known time %lld (was %lld)",
             known, cur);
}

/* Reply one line to a single client (time verbs only — the old
 * SET/GET/POWEROFF/REBOOT verbs stay fire-and-forget). A negative fd
 * means "no reply channel" (the host control serial is read-only),
 * so the verb still applies, silently. */
static void send_reply(int fd, const char *fmt, ...)
{
    if (fd < 0)
        return;
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    (void)!write(fd, buf, (size_t)n);
}

static void handle_set_time(const char *line, int reply_fd)
{
    char epoch_s[64] = "", offset_s[64] = "", source[32] = "";
    int n = sscanf(line, "%*s %63s %63s %31s", epoch_s, offset_s, source);
    if (n < 1) {
        send_reply(reply_fd, "ERR usage: SET_TIME <epoch-ms> [offset-ms] [source]");
        return;
    }
    char *end = NULL;
    long long epoch_ms = strtoll(epoch_s, &end, 10);
    if (end == epoch_s || *end != '\0' || epoch_ms < TIME_MIN_MS ||
        epoch_ms > TIME_MAX_MS) {
        send_reply(reply_fd, "ERR invalid epoch-ms");
        return;
    }
    long long offset_ms = 0;
    if (n >= 2) {
        offset_ms = strtoll(offset_s, &end, 10);
        if (end == offset_s || *end != '\0' || offset_ms < -86400000LL ||
            offset_ms > 86400000LL) {
            send_reply(reply_fd, "ERR invalid offset-ms");
            return;
        }
    }
    const char *src = "manual";
    if (n >= 3) {
        /* The token is single-word by construction; restrict the
         * charset so the recorded source can never carry
         * log-breaking bytes. */
        bool ok = source[0] != '\0';
        for (const char *p = source; *p; p++) {
            char c = *p;
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-' ||
                  c == '.' || c == ':'))
                ok = false;
        }
        if (!ok) {
            send_reply(reply_fd, "ERR invalid source");
            return;
        }
        src = source;
    }
    if (apply_system_time(epoch_ms) != 0) {
        send_reply(reply_fd, "ERR clock_settime failed: %s", strerror(errno));
        log_line("STATUSD SET_TIME %lld failed: %s", epoch_ms, strerror(errno));
        return;
    }
    time_state.last_sync_ms = now_ms();
    time_state.offset_ms = offset_ms;
    snprintf(time_state.source, sizeof(time_state.source), "%s", src);
    persist_last_known_time(epoch_ms);
    log_line("STATUSD time set to %lld (offset %lld ms, source %s, rtc %s)",
             epoch_ms, offset_ms, src, time_state.rtc);
    send_reply(reply_fd, "OK %lld", epoch_ms);
}

static void handle_get_time(int reply_fd)
{
    send_reply(reply_fd,
               "TIME now_ms=%lld last_sync_ms=%lld offset_ms=%lld source=%s rtc=%s restored_ms=%lld",
               now_ms(), time_state.last_sync_ms, time_state.offset_ms,
               time_state.source, time_state.rtc, time_state.restored_ms);
}

/* IANA name: two or three '/'-separated components of [A-Za-z0-9_+-].
 * Same shape LinuxTimeService.setTimezone enforces (the ".."
 * rejection there is subsumed here — '.' is not in the charset).
 * Single-component names ("UTC") are invalid, matching the service. */
static bool valid_timezone(const char *tz)
{
    if (!tz || !*tz || strlen(tz) > 64)
        return false;
    if (tz[0] == '/' || tz[strlen(tz) - 1] == '/')
        return false;
    int components = 1;
    bool last_slash = false;
    for (const char *p = tz; *p; p++) {
        char c = *p;
        if (c == '/') {
            if (last_slash)
                return false;
            last_slash = true;
            if (++components > 3)
                return false;
            continue;
        }
        last_slash = false;
        bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '+' || c == '-';
        if (!ok)
            return false;
    }
    return components >= 2;
}

static int apply_timezone(const char *tz, char *err, size_t errcap)
{
    if (!valid_timezone(tz)) {
        snprintf(err, errcap, "invalid timezone");
        return -1;
    }
    char zoneinfo[256];
    snprintf(zoneinfo, sizeof(zoneinfo), "%s/%s", TIMEZONE_DIR, tz);
    struct stat st;
    if (stat(zoneinfo, &st) != 0 || !S_ISREG(st.st_mode)) {
        snprintf(err, errcap, "unknown timezone");
        return -1;
    }
    FILE *f = fopen(TIMEZONE_FILE, "w");
    if (!f) {
        snprintf(err, errcap, "cannot write %s: %s", TIMEZONE_FILE, strerror(errno));
        return -1;
    }
    fprintf(f, "%s\n", tz);
    if (fclose(f) != 0) {
        snprintf(err, errcap, "cannot write %s", TIMEZONE_FILE);
        return -1;
    }
    unlink(LOCALTIME_PATH);
    if (symlink(zoneinfo, LOCALTIME_PATH) != 0) {
        snprintf(err, errcap, "cannot link %s: %s", LOCALTIME_PATH, strerror(errno));
        return -1;
    }
    return 0;
}

static void handle_set_timezone(const char *line, int reply_fd)
{
    char tz[64] = "";
    if (sscanf(line, "%*s %63s", tz) != 1) {
        send_reply(reply_fd, "ERR usage: SET_TIMEZONE <tz>");
        return;
    }
    char err[128];
    if (apply_timezone(tz, err, sizeof(err)) != 0) {
        send_reply(reply_fd, "ERR %s", err);
        return;
    }
    log_line("STATUSD timezone set to %s", tz);
    send_reply(reply_fd, "OK %s", tz);
}

/* --- command handling --- */

/* Poweroff / reboot: ask init (PID 1) to do the clean teardown, and
 * fall back to the legacy direct reboot when this image's init has
 * no trap. The init trap (M9 image) stops the daemons, syncs,
 * unmounts /data, then powers off or reboots for real; it writes
 * /run/sevyn-power-teardown first, so this wait (up to ~5 s) tells
 * the two apart. Older images ignore the signal (PID 1 only
 * delivers signals it has a handler for), so without the fallback
 * their harness POWEROFF would hang instead of powering off. */
static void request_power(const char *action)
{
    FILE *f = fopen("/run/sevyn-power-action", "w");
    if (f) {
        fprintf(f, "%s\n", action);
        fclose(f);
    }
    log_line("STATUSD power %s requested (init trap)", action);
    kill(1, SIGTERM);
    for (int i = 0; i < 50; i++) {
        struct stat st;
        if (stat("/run/sevyn-power-teardown", &st) == 0) {
            log_line("STATUSD init teardown in progress; exiting");
            _exit(0);
        }
        struct timespec ts = { 0, 100 * 1000 * 1000 };
        nanosleep(&ts, NULL);
    }
    log_line("STATUSD no init trap answered; direct %s", action);
    sync();
    reboot(strcmp(action, "reboot") == 0 ? RB_AUTOBOOT : RB_POWER_OFF);
    _exit(0);
}

static void handle_command(const char *line, int reply_fd)
{
    char cmd[32], key[64], val[64];
    if (sscanf(line, "%31s %63s %63s", cmd, key, val) < 1)
        return;
    if (strcmp(cmd, "SET") == 0) {
        if (sscanf(line, "%*s %63s %63s", key, val) == 2) {
            log_line("STATUSD SET %s %s", key, val);
            set_value(key, val);
        }
    } else if (strcmp(cmd, "SET_TIME") == 0) {
        handle_set_time(line, reply_fd);
    } else if (strcmp(cmd, "GET_TIME") == 0) {
        handle_get_time(reply_fd);
    } else if (strcmp(cmd, "SET_TIMEZONE") == 0) {
        handle_set_timezone(line, reply_fd);
    } else if (strcmp(cmd, "POWEROFF") == 0) {
        request_power("poweroff");
    } else if (strcmp(cmd, "REBOOT") == 0) {
        request_power("reboot");
    }
}

static void handle_client_line(struct client *c, const char *line)
{
    if (strncmp(line, "SUBSCRIBE", 9) == 0) {
        c->subscribed = true;
        send_all_values(c->fd);
        log_line("STATUSD subscriber added");
    } else if (strcmp(line, "GET") == 0) {
        /* Exact match: the prefix form would swallow GET_TIME. */
        send_all_values(c->fd);
    } else {
        handle_command(line, c->fd);
    }
}

/* Feed bytes into a client's line buffer; complete lines are handled. */
static bool feed_client(struct client *c, const char *data, ssize_t n)
{
    for (ssize_t i = 0; i < n; i++) {
        char ch = data[i];
        if (ch == '\n') {
            c->buf[c->len] = '\0';
            handle_client_line(c, c->buf);
            c->len = 0;
        } else if (c->len < sizeof(c->buf) - 1) {
            c->buf[c->len++] = ch;
        }
    }
    return true;
}

static void remove_client(int idx)
{
    close(clients[idx].fd);
    clients[idx] = clients[--nclients];
}

int main(void)
{
    console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);

    int listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (listen_fd < 0) {
        log_line("STATUSD error: socket: %s", strerror(errno));
        return 1;
    }
    /* Socket path override for checks: the M10 `sevyn comms
     * [--socket <path>]` precedent — a second daemon on a scratch
     * socket lets the host-side harness (test-statusd-time.py)
     * drive the real daemon without root. Production always uses
     * the default. */
    const char *sock_path = getenv(SOCK_PATH_ENV);
    if (!sock_path || !*sock_path)
        sock_path = SOCK_PATH;
    unlink(sock_path);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sock_path);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        log_line("STATUSD error: bind: %s", strerror(errno));
        return 1;
    }
    if (listen(listen_fd, 8) < 0) {
        log_line("STATUSD error: listen: %s", strerror(errno));
        return 1;
    }

    /* Host control serial (QEMU second serial port). Optional. */
    int ctl_fd = open(CTL_TTY, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (ctl_fd < 0)
        log_line("STATUSD no control tty %s (%s) — host injection unavailable",
                 CTL_TTY, strerror(errno));
    else
        log_line("STATUSD control tty %s open", CTL_TTY);

    setup_sysfs_watches();
    restore_last_known_time();
    log_line("STATUSD READY socket=%s battery=%s wifi=%s volume=%s",
             sock_path, values[0].current, values[1].current, values[2].current);

    char ctl_buf[LINE_MAX];
    size_t ctl_len = 0;

    for (;;) {
        struct pollfd fds[2 + MAX_CLIENTS];
        int nfds = 0;
        fds[nfds].fd = listen_fd;
        fds[nfds].events = POLLIN;
        nfds++;
        if (ctl_fd >= 0) {
            fds[nfds].fd = ctl_fd;
            fds[nfds].events = POLLIN;
            nfds++;
        }
        int base = nfds;
        for (int i = 0; i < nclients; i++) {
            fds[nfds].fd = clients[i].fd;
            fds[nfds].events = POLLIN;
            nfds++;
        }
        int inotify_slot = -1;
        if (inotify_fd >= 0) {
            inotify_slot = nfds;
            fds[nfds].fd = inotify_fd;
            fds[nfds].events = POLLIN;
            nfds++;
        }
        int r = poll(fds, (nfds_t)nfds, -1);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            log_line("STATUSD poll error: %s", strerror(errno));
            return 1;
        }
        if (fds[0].revents & POLLIN) {
            for (;;) {
                int fd = accept4(listen_fd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
                if (fd < 0)
                    break;
                if (nclients >= MAX_CLIENTS) {
                    close(fd);
                    continue;
                }
                clients[nclients].fd = fd;
                clients[nclients].subscribed = false;
                clients[nclients].len = 0;
                nclients++;
            }
        }
        if (ctl_fd >= 0 && nfds > 1 && (fds[1].revents & (POLLIN | POLLHUP))) {
            char tmp[256];
            ssize_t n = read(ctl_fd, tmp, sizeof(tmp));
            if (n == 0) {
                /* Host closed the control serial; stop watching it. */
                close(ctl_fd);
                ctl_fd = -1;
            } else if (n > 0) {
                for (ssize_t i = 0; i < n; i++) {
                    char ch = tmp[i];
                    if (ch == '\n') {
                        ctl_buf[ctl_len] = '\0';
                        handle_command(ctl_buf, -1);
                        ctl_len = 0;
                    } else if (ctl_len < sizeof(ctl_buf) - 1) {
                        ctl_buf[ctl_len++] = ch;
                    }
                }
            }
        }
        if (inotify_slot >= 0 && (fds[inotify_slot].revents & POLLIN))
            handle_inotify();
        for (int i = 0; i < nclients; i++) {
            short rev = fds[base + i].revents;
            if (rev & (POLLIN | POLLHUP | POLLERR)) {
                char tmp[256];
                ssize_t n = read(clients[i].fd, tmp, sizeof(tmp));
                if (n <= 0) {
                    remove_client(i);
                    i--;
                } else {
                    feed_client(&clients[i], tmp, n);
                }
            }
        }
    }
}
