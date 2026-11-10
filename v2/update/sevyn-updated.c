/* SevynOS v2 M8 — system update daemon (sevyn-updated).
 *
 * Owns in-place OS updates (no USB re-flash):
 *   - checks the update feed (the nightly release's updates-v2.json;
 *     the old tree's updates.json describes the old tree's kernel and
 *     initramfs, not the v2 image, so the v2 image has its own feed
 *     file — same protocol, same signing tooling),
 *   - verifies the feed signature BEFORE trusting any artifact URL or
 *     hash, downloads the new kernel + initramfs into the IDLE A/B
 *     slot, marks it active, and reboots,
 *   - owns the slot state on the persistent data disk
 *     (/data/slot-state.json): on startup it increments the boot
 *     attempt counter for the booted slot; when the shell reaches
 *     READY it marks the booted slot good (attempts reset). A slot
 *     that fails to boot twice is never booted again — the daemon
 *     restores the ESP from the good slot and reboots into it (see
 *     the M9 ESP sync below); GRUB's "previous" entry is the manual
 *     half, for a kernel that will not boot at all.
 *
 * M9 — ESP sync (bare metal): on hardware GRUB boots the kernel +
 * initramfs from the EFI System Partition, NOT from the data-disk
 * slots, so a slot update alone never boots. After the slot install
 * the apply child mounts the ESP (partition 1 of the data disk,
 * vfat), preserves the running kernel as /vmlinuz.prev +
 * /initramfs.prev.cpio.gz, copies the new slot's kernel +
 * initramfs into place (temp + fsync + sha256 re-read + rename),
 * and rewrites /EFI/ubuntu/grub.cfg atomically with two entries:
 * the default boots the new active slot from /vmlinuz, "SevynOS
 * (previous)" boots the good slot from /vmlinuz.prev. Any sync
 * failure aborts the apply WITHOUT flipping the state — the running
 * system keeps booting the old kernel. With no ESP at all (the
 * QEMU -kernel path: the data device is a whole disk, no partition
 * table) the sync is skipped and the slot flip still works, because
 * the harness boots -kernel from the active slot.
 *   On startup, when the booted slot's attempt counter reaches 2
 * and the booted slot is not the good slot, the daemon restores
 * the ESP from the good slot, flips active back to good, and
 * reboots. No auto-reboot timer: the fallback fires on the second
 * boot attempt (manual reboot / power-cycle after the first failed
 * boot), so a slow first boot can never false-trigger it.
 *
 * Feed protocol (established in the repo — tools/update-signing/ and
 * services/update/src/feed-signing.ts; this daemon re-implements it
 * in C, it does NOT reuse the old tree's code):
 *   feed: {version, channel, publishedAt, releaseNotes,
 *          artifacts: [{kind, url, sha256, sizeBytes}],
 *          signatures: {"<keyId>": "<base64 Ed25519 signature>"}}
 *   The signature covers the canonical body: the manifest with
 *   "signatures" removed, keys sorted recursively, compact JSON
 *   (canonical.c — byte-identical to canonical.mjs). Verification
 *   succeeds when at least one signature from a trusted keyId
 *   verifies. Unknown keyIds never confer trust; a feed with no
 *   trusted signature is refused. The trust anchor is
 *   /usr/share/sevyn/trusted-update-keys.json:
 *   {"keys": [{"keyId", "publicKeyJwk": {"kty": "OKP",
 *   "crv": "Ed25519", "x": "<base64url>"}}]} — baked into the image
 *   (a committed file, or a test keypair generated at build time).
 *   The daemon re-reads the anchor on every check, and fails closed
 *   when it is missing or empty.
 *   The update channel (nightly vs stable) is a user choice, kept in
 *   /data/update-config.json; the feed's channel must match it.
 *
 * A/B slots (persistent data disk, ext4, mounted at /data):
 *   /data/slots/A/{vmlinuz, initramfs.cpio.gz}
 *   /data/slots/B/{vmlinuz, initramfs.cpio.gz}
 *   /data/slot-state.json  {"active": "A", "good": "A",
 *                            "attempts": 0, "version": "..."}
 *   /data/update-config.json {"channel": "nightly", "url": "..."}
 * The daemon degrades gracefully with no data disk (logs, socket
 * still serves STATUS; CHECK/APPLY refuse with "no-data-disk").
 *
 * Socket protocol (newline-terminated ASCII, one reply per command):
 *   PING              -> OK pong
 *   STATUS            -> OK version=<v> channel=<c> active=<slot>
 *                        good=<slot> attempts=<n> applying=<yes|no>
 *                        available=<unknown|none|<version>>
 *   CHECK             -> OK none <version> / OK available <version>
 *                        / ERR <reason>
 *   APPLY             -> OK applying <version> (the download runs in
 *                        a child; progress and the outcome arrive as
 *                        UPDATE log lines + EVENT lines to subscribers)
 *   CHANNEL <c>       -> OK channel <c> / ERR <reason>
 *   SUBSCRIBE         -> OK subscribed (then receives EVENT lines)
 * Events (subscribers only):
 *   EVENT APPLY STARTED <version>
 *   EVENT APPLIED <version> <slot>
 *   EVENT APPLY FAILED <reason>
 *   EVENT SLOT GOOD <slot>
 *
 * Control serial (ttyS3): same verbs, one per line. Replies are
 * UPDATE log lines on the console (the harness reads the serial log):
 *   UPDATE PONG / UPDATE STATUS ... / UPDATE CHECK NONE|AVAILABLE|FAIL
 *   UPDATE APPLY STARTED|FAIL / UPDATE APPLIED <version> slot=<slot>
 *   UPDATE SLOT GOOD <slot> / UPDATE ready ...
 *
 * The daemon fetches with wget (busybox in the image); downloads are
 * verified by sha256 + size before anything is written to a slot.
 * The apply child writes to temp names and renames, fsyncs files and
 * the slot dir, flips the state atomically, syncs, then reboots.
 *
 * Paths come from the environment for the host-side unit tests:
 *   SEVYN_UPDATE_SOCK (default /run/sevyn-update.sock),
 *   SEVYN_UPDATE_CTL (default /dev/ttyS3),
 *   SEVYN_UPDATE_DATA (default /data),
 *   SEVYN_UPDATE_TRUSTED_KEYS (default
 *     /usr/share/sevyn/trusted-update-keys.json),
 *   SEVYN_UPDATE_VERSION_FILE (default /usr/share/sevyn/os-version),
 *   SEVYN_UPDATE_TMP (default /tmp/sevyn-update),
 *   SEVYN_UPDATE_HEALTH_FILE (default /tmp/sevyn-host.log),
 *   SEVYN_UPDATE_WGET (default wget),
 *   SEVYN_UPDATE_SLOT (host-test hook: the booted slot when the
 *     kernel cmdline carries no sevyn.slot=),
 *   SEVYN_UPDATE_ESP_DIR (host-test hook: use this directory as the
 *     ESP, skipping device discovery + mount),
 *   SEVYN_UPDATE_PROC_MOUNTS (host-test hook: mounts table to read
 *     for ESP discovery; default /proc/mounts).
 *
 * Build: gcc, libc + libcrypto. Links json.c + verify.c + canonical.c.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "../loader/json.h"
#include "../loader/verify.h"
#include "canonical.h"

#define DEFAULT_SOCK "/run/sevyn-update.sock"
#define DEFAULT_CTL "/dev/ttyS3"
#define DEFAULT_DATA "/data"
#define DEFAULT_TRUSTED_KEYS "/usr/share/sevyn/trusted-update-keys.json"
#define DEFAULT_VERSION_FILE "/usr/share/sevyn/os-version"
#define DEFAULT_TMP "/tmp/sevyn-update"
#define DEFAULT_HEALTH_FILE "/tmp/sevyn-host.log"
#define DEFAULT_HEALTH_MARKER "SEVYNOS_M2_READY"
#define DEFAULT_FEED_URL \
    "https://github.com/realkevonporter/sevynos/releases/download/" \
    "nightly/updates-v2.json"
#define DEFAULT_WGET "wget"
#define MAX_CLIENTS 16
#define MAX_KEYS 8
#define MAX_ARTIFACTS 4
#define LINE_CAP 2048
#define WGET_MANIFEST_TIMEOUT 30
#define WGET_ARTIFACT_TIMEOUT 300

static const char *g_sock_path;
static const char *g_ctl_path;
static const char *g_data_dir;
static const char *g_trusted_keys_path;
static const char *g_version_file;
static const char *g_tmp_dir;
static const char *g_health_file;
static const char *g_wget;
static const char *g_esp_dir;    /* SEVYN_UPDATE_ESP_DIR, or NULL */
static const char *g_proc_mounts; /* SEVYN_UPDATE_PROC_MOUNTS, or NULL */

#define ESP_MOUNT_POINT "/esp"
#define ESP_GRUB_CFG_REL "EFI/ubuntu/grub.cfg"
static int g_console_fd = -1;
static volatile sig_atomic_t g_stop = 0;

static char g_channel[32] = "nightly";
static char g_url[1024] = "";
static char g_version[128] = "unknown";
static char g_boot_slot = 0; /* 'A' / 'B' from sevyn.slot=, or 0 */
static int g_applying = 0;
static pid_t g_apply_pid = -1;
static char g_available[128] = ""; /* "" = unknown; "none" = up to date */
static int g_marked_good = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

/* Retrying console writer (same pattern as statusd / appd / loader). */
static void write_all_console(const char *buf, size_t n)
{
    size_t off = 0;
    int tries = 0;
    while (off < n && tries < 50) {
        ssize_t w = write(g_console_fd, buf + off, n - off);
        if (w > 0) {
            off += (size_t)w;
            continue;
        }
        if (w < 0 && errno != EAGAIN && errno != EINTR)
            break;
        struct pollfd pfd = { .fd = g_console_fd, .events = POLLOUT };
        (void)!poll(&pfd, 1, 100);
        tries++;
    }
}

static void log_line(const char *fmt, ...)
{
    char buf[2048];
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
    if (g_console_fd >= 0)
        write_all_console(buf, (size_t)n);
    (void)!fwrite(buf, 1, (size_t)n, stderr);
}

/* --- small file helpers --- */

static char *path_join(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b);
    char *out = (char *)malloc(la + lb + 2);
    if (!out)
        return NULL;
    memcpy(out, a, la);
    if (la > 0 && out[la - 1] != '/')
        out[la++] = '/';
    memcpy(out + la, b, lb + 1);
    return out;
}

static int mkdir_p(const char *path)
{
    if (!path || path[0] == '\0')
        return 0;
    char tmp[PATH_MAX];
    size_t n = strlen(path);
    if (n >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, n + 1);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST)
        return -1;
    return 0;
}

/* Read a whole file into a malloc'd NUL-terminated buffer (NULL on
 * error). */
static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long n = ftell(f);
    if (n < 0) {
        fclose(f);
        return NULL;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return NULL;
    }
    char *buf = (char *)malloc((size_t)n + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (n > 0 && fread(buf, 1, (size_t)n, f) != (size_t)n) {
        free(buf);
        fclose(f);
        return NULL;
    }
    buf[n] = '\0';
    fclose(f);
    return buf;
}

static int sync_dir(const char *path)
{
    int fd = open(path, O_RDONLY | O_DIRECTORY);
    if (fd < 0)
        return -1;
    int rc = fsync(fd);
    close(fd);
    return rc;
}

/* Write text to path atomically (temp + rename) and fsync the file
 * and its directory. Returns 0 on success. */
static int write_file_atomic(const char *path, const char *text)
{
    char tmp[PATH_MAX];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", path, (long)getpid()) >=
        (int)sizeof(tmp))
        return -1;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return -1;
    size_t n = strlen(text);
    ssize_t w = write(fd, text, n);
    if (w < 0 || (size_t)w != n || fsync(fd) != 0) {
        close(fd);
        unlink(tmp);
        return -1;
    }
    if (close(fd) != 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, path) != 0) {
        unlink(tmp);
        return -1;
    }
    char dir[PATH_MAX];
    snprintf(dir, sizeof(dir), "%s", path);
    char *slash = strrchr(dir, '/');
    if (slash)
        *slash = '\0';
    else
        snprintf(dir, sizeof(dir), ".");
    (void)sync_dir(dir);
    return 0;
}

/* --- slot state + config (persistent data disk) --- */

struct slot_state {
    char active;   /* 'A' or 'B' */
    char good;     /* 'A' or 'B' */
    int attempts;  /* consecutive failed boots of the active slot */
    char version[128];
};

static char *slot_state_path(void)
{
    return path_join(g_data_dir, "slot-state.json");
}

static char *config_path(void)
{
    return path_join(g_data_dir, "update-config.json");
}

/* Parse slot state from text. Missing fields fall back to the
 * booted slot / 0 attempts / current version. Returns 0 on success,
 * -1 when the text is not a JSON object at all. */
static int parse_slot_state(const char *text, struct slot_state *st)
{
    char err[256];
    jval_t *v = json_parse(text, err, sizeof(err));
    if (!v || v->type != J_OBJ) {
        json_free(v);
        return -1;
    }
    st->active = g_boot_slot ? g_boot_slot : 'A';
    st->good = st->active;
    st->attempts = 0;
    snprintf(st->version, sizeof(st->version), "%s", g_version);
    const jval_t *a = json_obj_get(v, "active");
    const char *s = json_str(a);
    if (s && (s[0] == 'A' || s[0] == 'B') && s[1] == '\0')
        st->active = s[0];
    const jval_t *gd = json_obj_get(v, "good");
    s = json_str(gd);
    if (s && (s[0] == 'A' || s[0] == 'B') && s[1] == '\0')
        st->good = s[0];
    const jval_t *at = json_obj_get(v, "attempts");
    if (at && at->type == J_NUM && at->number >= 0 && at->number < 1000)
        st->attempts = (int)at->number;
    const jval_t *ver = json_obj_get(v, "version");
    s = json_str(ver);
    if (s && *s)
        snprintf(st->version, sizeof(st->version), "%s", s);
    json_free(v);
    return 0;
}

static int read_slot_state(struct slot_state *st)
{
    char *path = slot_state_path();
    if (!path)
        return -1;
    char *text = read_file(path);
    free(path);
    if (!text)
        return -1;
    int rc = parse_slot_state(text, st);
    free(text);
    return rc;
}

static int write_slot_state(const struct slot_state *st)
{
    char *path = slot_state_path();
    if (!path)
        return -1;
    char text[512];
    snprintf(text, sizeof(text),
             "{\n  \"active\": \"%c\",\n  \"good\": \"%c\",\n"
             "  \"attempts\": %d,\n  \"version\": \"%s\"\n}\n",
             st->active, st->good, st->attempts, st->version);
    int rc = write_file_atomic(path, text);
    free(path);
    return rc;
}

static int data_disk_present(void)
{
    struct stat st;
    return stat(g_data_dir, &st) == 0 && S_ISDIR(st.st_mode);
}

/* Load the update config (channel + optional URL override). Missing
 * file or bad values keep the defaults. */
static void load_config(void)
{
    char *path = config_path();
    if (!path)
        return;
    char *text = read_file(path);
    free(path);
    if (!text)
        return;
    char err[256];
    jval_t *v = json_parse(text, err, sizeof(err));
    free(text);
    if (!v || v->type != J_OBJ) {
        json_free(v);
        return;
    }
    const char *s = json_str(json_obj_get(v, "channel"));
    if (s && (strcmp(s, "nightly") == 0 || strcmp(s, "stable") == 0))
        snprintf(g_channel, sizeof(g_channel), "%s", s);
    s = json_str(json_obj_get(v, "url"));
    if (s && *s)
        snprintf(g_url, sizeof(g_url), "%s", s);
    json_free(v);
}

static int save_config(void)
{
    char *path = config_path();
    if (!path)
        return -1;
    char *esc = json_escape(g_url);
    if (!esc) {
        free(path);
        return -1;
    }
    char text[1400];
    snprintf(text, sizeof(text),
             "{\n  \"channel\": \"%s\",\n  \"url\": \"%s\"\n}\n",
             g_channel, esc);
    free(esc);
    int rc = write_file_atomic(path, text);
    free(path);
    return rc;
}

/* Kernel cmdline: sevyn.slot=A|B and sevyn.update_url=<url>. The
 * cmdline URL wins over the config file (the harness sets it).
 * SEVYN_UPDATE_SLOT (A|B) is a host-test hook: it applies only when
 * the cmdline carries no sevyn.slot= (the host's own cmdline never
 * does). */
static void parse_cmdline(void)
{
    char *text = read_file("/proc/cmdline");
    if (text) {
        char *save = NULL;
        for (char *tok = strtok_r(text, " \t\n", &save); tok;
             tok = strtok_r(NULL, " \t\n", &save)) {
            if (strncmp(tok, "sevyn.slot=", 11) == 0 && tok[11] != '\0' &&
                (tok[11] == 'A' || tok[11] == 'B') && tok[12] == '\0')
                g_boot_slot = tok[11];
            else if (strncmp(tok, "sevyn.update_url=", 17) == 0 &&
                     tok[17] != '\0')
                snprintf(g_url, sizeof(g_url), "%s", tok + 17);
        }
        free(text);
    }
    if (!g_boot_slot) {
        const char *slot = getenv("SEVYN_UPDATE_SLOT");
        if (slot && (slot[0] == 'A' || slot[0] == 'B') &&
            slot[1] == '\0')
            g_boot_slot = slot[0];
    }
}

static void load_version(void)
{
    char *text = read_file(g_version_file);
    if (!text)
        return;
    /* First line, trimmed of surrounding whitespace. */
    char *nl = strchr(text, '\n');
    if (nl)
        *nl = '\0';
    char *s = text;
    while (*s == ' ' || *s == '\t')
        s++;
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t' ||
                     s[n - 1] == '\r'))
        s[--n] = '\0';
    if (*s)
        snprintf(g_version, sizeof(g_version), "%s", s);
    free(text);
}

/* --- trusted keys + feed verification --- */

struct trusted_key {
    char key_id[128];
    unsigned char pub[32];
};

struct feed_artifact {
    char kind[32];
    char url[1024];
    char sha256[65];
    unsigned long long size_bytes;
};

struct feed {
    char version[128];
    char channel[32];
    struct feed_artifact artifacts[MAX_ARTIFACTS];
    size_t nartifacts;
};

/* Load the trust anchor. Returns the number of keys, or -1 on
 * unreadable/malformed input (fail closed: zero trusted keys). */
static int load_trusted_keys(struct trusted_key *keys, size_t cap)
{
    char *text = read_file(g_trusted_keys_path);
    if (!text)
        return -1;
    char err[256];
    jval_t *v = json_parse(text, err, sizeof(err));
    free(text);
    if (!v || v->type != J_OBJ) {
        json_free(v);
        return -1;
    }
    const jval_t *arr = json_obj_get(v, "keys");
    if (!arr || arr->type != J_ARR) {
        json_free(v);
        return -1;
    }
    int n = 0;
    for (size_t i = 0; i < json_arr_len(arr) && (size_t)n < cap; i++) {
        const jval_t *e = json_arr_get(arr, i);
        if (!e || e->type != J_OBJ)
            continue;
        const char *kid = json_str(json_obj_get(e, "keyId"));
        const jval_t *jwk = json_obj_get(e, "publicKeyJwk");
        if (!kid || !*kid || !jwk || jwk->type != J_OBJ)
            continue;
        const char *kty = json_str(json_obj_get(jwk, "kty"));
        const char *crv = json_str(json_obj_get(jwk, "crv"));
        const char *x = json_str(json_obj_get(jwk, "x"));
        if (!kty || strcmp(kty, "OKP") != 0 || !crv ||
            strcmp(crv, "Ed25519") != 0 || !x || !*x)
            continue;
        size_t plen = 0;
        unsigned char *pub = b64url_decode(x, &plen);
        if (!pub || plen != 32) {
            free(pub);
            continue;
        }
        snprintf(keys[n].key_id, sizeof(keys[n].key_id), "%s", kid);
        memcpy(keys[n].pub, pub, 32);
        free(pub);
        n++;
    }
    json_free(v);
    return n;
}

/* Run wget (or $SEVYN_UPDATE_WGET) with a timeout, writing the
 * response body to out_path. Returns 0 when wget exits 0. */
static int run_wget(const char *url, const char *out_path, int timeout_s)
{
    char timeout[16];
    snprintf(timeout, sizeof(timeout), "%d", timeout_s);
    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0) {
        int devnull = open("/dev/null", O_WRONLY);
        if (devnull >= 0) {
            dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO)
                close(devnull);
        }
        execlp(g_wget, g_wget, "-q", "-T", timeout, "-O", out_path,
               url, (char *)NULL);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
        ;
    return (WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : -1;
}

/* Fetch + verify the feed. On success fills `feed` and returns 0.
 * On failure returns -1 and writes a one-line reason into err. */
static int fetch_feed(struct feed *feed, char *err, size_t errcap)
{
    if (!data_disk_present()) {
        snprintf(err, errcap, "no-data-disk");
        return -1;
    }
    if (mkdir_p(g_tmp_dir) != 0) {
        snprintf(err, errcap, "cannot create tmp dir");
        return -1;
    }
    char manifest_path[PATH_MAX];
    snprintf(manifest_path, sizeof(manifest_path), "%s/manifest.%ld.json",
             g_tmp_dir, (long)getpid());
    if (run_wget(g_url, manifest_path, WGET_MANIFEST_TIMEOUT) != 0) {
        snprintf(err, errcap, "download failed: %s", g_url);
        unlink(manifest_path);
        return -1;
    }
    char *text = read_file(manifest_path);
    unlink(manifest_path);
    if (!text) {
        snprintf(err, errcap, "cannot read downloaded manifest");
        return -1;
    }
    char jerr[256];
    jval_t *v = json_parse(text, jerr, sizeof(jerr));
    if (!v || v->type != J_OBJ) {
        snprintf(err, errcap, "manifest is not valid JSON: %s", jerr);
        json_free(v);
        free(text);
        return -1;
    }
    /* Field validation (before any trust decision the shape must be
     * sane). */
    const char *version = json_str(json_obj_get(v, "version"));
    const char *channel = json_str(json_obj_get(v, "channel"));
    const jval_t *arts = json_obj_get(v, "artifacts");
    if (!version || !*version) {
        snprintf(err, errcap, "manifest has no version");
        json_free(v);
        free(text);
        return -1;
    }
    if (!channel || !*channel) {
        snprintf(err, errcap, "manifest has no channel");
        json_free(v);
        free(text);
        return -1;
    }
    if (strcmp(channel, g_channel) != 0) {
        snprintf(err, errcap,
                 "channel mismatch: feed is %s, device is %s", channel,
                 g_channel);
        json_free(v);
        free(text);
        return -1;
    }
    if (!arts || arts->type != J_ARR) {
        snprintf(err, errcap, "manifest has no artifacts array");
        json_free(v);
        free(text);
        return -1;
    }
    memset(feed, 0, sizeof(*feed));
    snprintf(feed->version, sizeof(feed->version), "%s", version);
    snprintf(feed->channel, sizeof(feed->channel), "%s", channel);
    for (size_t i = 0; i < json_arr_len(arts); i++) {
        const jval_t *a = json_arr_get(arts, i);
        if (!a || a->type != J_OBJ)
            continue;
        const char *kind = json_str(json_obj_get(a, "kind"));
        const char *url = json_str(json_obj_get(a, "url"));
        const char *sha = json_str(json_obj_get(a, "sha256"));
        const jval_t *sz = json_obj_get(a, "sizeBytes");
        if (!kind || !url || !sha || !sz || sz->type != J_NUM ||
            !sz->numraw)
            continue;
        if (strncmp(url, "http://", 7) != 0 &&
            strncmp(url, "https://", 8) != 0)
            continue;
        if (!is_hex(sha, 64))
            continue;
        /* sizeBytes must be a plain non-negative integer lexeme. */
        int ok = sz->numraw[0] != '\0';
        for (const char *p = sz->numraw; *p; p++)
            if (!isdigit((unsigned char)*p))
                ok = 0;
        if (!ok)
            continue;
        if (feed->nartifacts >= MAX_ARTIFACTS)
            continue;
        struct feed_artifact *fa = &feed->artifacts[feed->nartifacts++];
        snprintf(fa->kind, sizeof(fa->kind), "%s", kind);
        snprintf(fa->url, sizeof(fa->url), "%s", url);
        snprintf(fa->sha256, sizeof(fa->sha256), "%s", sha);
        fa->size_bytes = strtoull(sz->numraw, NULL, 10);
    }
    /* The feed must carry exactly the two artifacts the updater
     * installs. */
    const struct feed_artifact *kern = NULL;
    const struct feed_artifact *initrd = NULL;
    for (size_t i = 0; i < feed->nartifacts; i++) {
        if (strcmp(feed->artifacts[i].kind, "vmlinuz") == 0)
            kern = &feed->artifacts[i];
        else if (strcmp(feed->artifacts[i].kind, "initramfs") == 0)
            initrd = &feed->artifacts[i];
    }
    if (!kern || !initrd) {
        snprintf(err, errcap,
                 "manifest lacks vmlinuz/initramfs artifacts");
        json_free(v);
        free(text);
        return -1;
    }
    /* Signature verification (the established rule): at least one
     * signature from a trusted keyId must verify over the canonical
     * body. */
    struct trusted_key keys[MAX_KEYS];
    int nkeys = load_trusted_keys(keys, MAX_KEYS);
    if (nkeys <= 0) {
        snprintf(err, errcap,
                 "no trusted update keys are configured on this "
                 "device — refusing to trust the feed");
        json_free(v);
        free(text);
        return -1;
    }
    const jval_t *sigs = json_obj_get(v, "signatures");
    if (!sigs || sigs->type != J_OBJ || sigs->len == 0) {
        snprintf(err, errcap,
                 "the feed is not signed (missing \"signatures\") — "
                 "refusing to trust it");
        json_free(v);
        free(text);
        return -1;
    }
    char *body = canonical_feed_body(v);
    if (!body) {
        snprintf(err, errcap, "cannot canonicalize manifest");
        json_free(v);
        free(text);
        return -1;
    }
    int saw_trusted = 0;
    int verified = 0;
    char verified_kid[128] = "";
    for (int i = 0; i < nkeys; i++) {
        const jval_t *sigv = json_obj_get(sigs, keys[i].key_id);
        const char *enc = json_str(sigv);
        if (!enc)
            continue;
        saw_trusted = 1;
        size_t siglen = 0;
        unsigned char *sig = b64_decode(enc, &siglen);
        if (!sig || siglen != 64) {
            free(sig);
            continue;
        }
        if (ed25519_verify(keys[i].pub, sig, (const unsigned char *)body,
                           strlen(body))) {
            verified = 1;
            snprintf(verified_kid, sizeof(verified_kid), "%s",
                     keys[i].key_id);
            free(sig);
            break;
        }
        free(sig);
    }
    free(body);
    if (!verified) {
        if (!saw_trusted)
            snprintf(err, errcap,
                     "the feed carries no signature from a trusted "
                     "key");
        else
            snprintf(err, errcap,
                     "a trusted signature is present but does not "
                     "verify — the feed may have been tampered with");
        json_free(v);
        free(text);
        return -1;
    }
    log_line("UPDATE feed verified version=%s channel=%s key=%s",
             feed->version, feed->channel, verified_kid);
    json_free(v);
    free(text);
    return 0;
}

/* --- apply (runs in a forked child) --- */

static const struct feed_artifact *feed_find(const struct feed *feed,
                                             const char *kind)
{
    for (size_t i = 0; i < feed->nartifacts; i++)
        if (strcmp(feed->artifacts[i].kind, kind) == 0)
            return &feed->artifacts[i];
    return NULL;
}

/* Download one artifact and verify sha256 + size. The verified file
 * lands at out_path. Returns 0 on success. */
static int download_verified(const struct feed_artifact *fa,
                             const char *out_path, char *err, size_t errcap)
{
    if (run_wget(fa->url, out_path, WGET_ARTIFACT_TIMEOUT) != 0) {
        snprintf(err, errcap, "download failed: %s", fa->url);
        unlink(out_path);
        return -1;
    }
    struct stat st;
    if (stat(out_path, &st) != 0) {
        snprintf(err, errcap, "downloaded file vanished: %s", fa->kind);
        return -1;
    }
    if ((unsigned long long)st.st_size != fa->size_bytes) {
        snprintf(err, errcap,
                 "%s size mismatch: got %lld, manifest says %llu",
                 fa->kind, (long long)st.st_size, fa->size_bytes);
        unlink(out_path);
        return -1;
    }
    char hash[65];
    if (sha256_file_hex(out_path, hash) != 0) {
        snprintf(err, errcap, "cannot hash downloaded %s", fa->kind);
        unlink(out_path);
        return -1;
    }
    if (strcmp(hash, fa->sha256) != 0) {
        snprintf(err, errcap,
                 "%s sha256 mismatch: downloaded file does not match "
                 "the signed manifest",
                 fa->kind);
        unlink(out_path);
        return -1;
    }
    return 0;
}

/* Copy a file and fsync the destination. Used by the slot install
 * and the ESP sync (both copy across filesystems, so rename alone
 * cannot do it). Returns 0 on success. */
static int copy_file_fsync(const char *src_path, const char *dst_path)
{
    int in = open(src_path, O_RDONLY);
    if (in < 0)
        return -1;
    int out = open(dst_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0) {
        close(in);
        return -1;
    }
    char buf[65536];
    ssize_t n;
    int ok = 1;
    while ((n = read(in, buf, sizeof(buf))) > 0) {
        ssize_t off = 0;
        while (off < n) {
            ssize_t w = write(out, buf + off, (size_t)(n - off));
            if (w <= 0) {
                ok = 0;
                break;
            }
            off += w;
        }
        if (!ok)
            break;
    }
    if (n < 0)
        ok = 0;
    if (ok && fsync(out) != 0)
        ok = 0;
    if (close(out) != 0)
        ok = 0;
    close(in);
    if (!ok) {
        unlink(dst_path);
        return -1;
    }
    return 0;
}

/* Write a verified file into the slot dir under a temp name, then
 * rename into place and fsync. Returns 0 on success. */
static int install_into_slot(const char *slot_dir, const char *name,
                             const char *src_path)
{
    char tmp[PATH_MAX];
    char dst[PATH_MAX];
    if (snprintf(tmp, sizeof(tmp), "%s/%s.tmp.%ld", slot_dir, name,
                 (long)getpid()) >= (int)sizeof(tmp))
        return -1;
    if (snprintf(dst, sizeof(dst), "%s/%s", slot_dir, name) >=
        (int)sizeof(dst))
        return -1;
    /* Copy (rename would cross filesystems: tmp dir vs /data). */
    if (copy_file_fsync(src_path, tmp) != 0)
        return -1;
    if (rename(tmp, dst) != 0) {
        unlink(tmp);
        return -1;
    }
    return sync_dir(slot_dir);
}

/* --- ESP sync (M9) --- */

/* Copy src to dst via a temp name, verifying the copy's sha256
 * matches the source's. Returns 0 on success. */
static int esp_copy_verified(const char *src, const char *dst)
{
    char hash_src[65];
    if (sha256_file_hex(src, hash_src) != 0)
        return -1;
    char tmp[PATH_MAX];
    if (snprintf(tmp, sizeof(tmp), "%s.tmp.%ld", dst, (long)getpid()) >=
        (int)sizeof(tmp))
        return -1;
    if (copy_file_fsync(src, tmp) != 0)
        return -1;
    char hash_tmp[65];
    if (sha256_file_hex(tmp, hash_tmp) != 0) {
        unlink(tmp);
        return -1;
    }
    if (strcmp(hash_src, hash_tmp) != 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, dst) != 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

/* The ESP sync core: operates on a plain directory (the mounted ESP
 * or the SEVYN_UPDATE_ESP_DIR hook), so the host unit tests
 * exercise it directly. new_* are the slot files to boot; prev_*
 * are the kernel to preserve as /vmlinuz.prev (the running kernel
 * on apply, the good slot on restore). Rewrites grub.cfg with the
 * two entries. On any failure the live /vmlinuz is untouched
 * (copies go through temp names + rename) and -1 is returned. */
static int esp_sync_files(const char *esp_dir,
                          const char *new_kern, const char *new_initrd,
                          const char *prev_kern, const char *prev_initrd,
                          char active_slot, char good_slot)
{
    char dst[PATH_MAX];
    /* Preserve the previous kernel first: if the new copy fails
     * after this, the ESP still boots the old kernel (now also the
     * .prev one). */
    if (snprintf(dst, sizeof(dst), "%s/vmlinuz.prev", esp_dir) >=
        (int)sizeof(dst))
        return -1;
    if (esp_copy_verified(prev_kern, dst) != 0)
        return -1;
    if (snprintf(dst, sizeof(dst), "%s/initramfs.prev.cpio.gz",
                 esp_dir) >= (int)sizeof(dst))
        return -1;
    if (esp_copy_verified(prev_initrd, dst) != 0)
        return -1;
    /* New kernel + initramfs into place. */
    if (snprintf(dst, sizeof(dst), "%s/vmlinuz", esp_dir) >=
        (int)sizeof(dst))
        return -1;
    if (esp_copy_verified(new_kern, dst) != 0)
        return -1;
    if (snprintf(dst, sizeof(dst), "%s/initramfs.cpio.gz", esp_dir) >=
        (int)sizeof(dst))
        return -1;
    if (esp_copy_verified(new_initrd, dst) != 0)
        return -1;
    if (sync_dir(esp_dir) != 0)
        return -1;
    /* grub.cfg: default boots the active slot from /vmlinuz, the
     * previous entry boots the good slot from /vmlinuz.prev. */
    char cfg_text[1024];
    snprintf(cfg_text, sizeof(cfg_text),
             "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
             "# Written by sevyn-updated (ESP sync): the default entry boots\n"
             "# the active slot from /vmlinuz; the previous entry boots the\n"
             "# good slot from the preserved /vmlinuz.prev.\n"
             "set timeout=3\n"
             "set default=0\n"
             "menuentry \"SevynOS\" {\n"
             "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=%c\n"
             "    initrd /initramfs.cpio.gz\n"
             "}\n"
             "menuentry \"SevynOS (previous)\" {\n"
             "    linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=%c\n"
             "    initrd /initramfs.prev.cpio.gz\n"
             "}\n",
             active_slot, good_slot);
    char efi_dir[PATH_MAX];
    if (snprintf(efi_dir, sizeof(efi_dir), "%s/EFI/ubuntu", esp_dir) >=
        (int)sizeof(efi_dir))
        return -1;
    /* The EFI/ubuntu dir exists on every image (GRUB lives there);
     * create it if a test ESP is bare. */
    if (mkdir_p(efi_dir) != 0)
        return -1;
    char cfg_path[PATH_MAX];
    if (snprintf(cfg_path, sizeof(cfg_path), "%s/%s", esp_dir,
                 ESP_GRUB_CFG_REL) >= (int)sizeof(cfg_path))
        return -1;
    if (write_file_atomic(cfg_path, cfg_text) != 0)
        return -1;
    return 0;
}

/* Find the ESP device: partition 1 of the disk carrying the data
 * partition (from the mounts table). Returns a malloc'd "/dev/..."
 * or NULL when there is no ESP (whole-disk data device, ESP device
 * absent, or the mounts table has no data entry). */
static char *esp_find_device(void)
{
    const char *mounts_path =
        g_proc_mounts ? g_proc_mounts : "/proc/mounts";
    FILE *f = fopen(mounts_path, "r");
    if (!f)
        return NULL;
    char line[1024];
    char *device = NULL;
    size_t data_len = strlen(g_data_dir);
    while (fgets(line, sizeof(line), f)) {
        /* fields: device mountpoint fstype options ... */
        char *sp1 = strchr(line, ' ');
        if (!sp1)
            continue;
        char *sp2 = strchr(sp1 + 1, ' ');
        if (!sp2)
            continue;
        if ((size_t)(sp2 - (sp1 + 1)) != data_len)
            continue;
        if (strncmp(sp1 + 1, g_data_dir, data_len) != 0)
            continue;
        size_t dev_len = (size_t)(sp1 - line);
        device = malloc(dev_len + 1);
        if (!device)
            break;
        memcpy(device, line, dev_len);
        device[dev_len] = '\0';
        break;
    }
    fclose(f);
    if (!device)
        return NULL;
    /* Resolve /dev/disk/by-label/... symlinks. */
    char resolved[PATH_MAX];
    if (realpath(device, resolved) != NULL) {
        free(device);
        device = strdup(resolved);
        if (!device)
            return NULL;
    }
    /* Derive the parent disk + partition 1. Two layouts:
     *   sd-style: sda2 / vda2 -> parent sda / vda, ESP sda1 / vda1
     *     (the part before the trailing digits has no digits);
     *   p-style: nvme0n1p2 / mmcblk0p2 -> parent nvme0n1, ESP p1.
     * Anything else (whole disk, e.g. /dev/vda or /dev/nvme0n1) has
     * no ESP partition. */
    const char *base = strrchr(device, '/');
    base = base ? base + 1 : device;
    size_t blen = strlen(base);
    size_t i = blen;
    while (i > 0 && isdigit((unsigned char)base[i - 1]))
        i--;
    if (i == blen) { /* no trailing digits: whole disk */
        free(device);
        return NULL;
    }
    int pstyle = 0;
    size_t parent_len;
    if (i > 1 && base[i - 1] == 'p' &&
        isdigit((unsigned char)base[i - 2])) {
        pstyle = 1;
        parent_len = i - 1;
    } else {
        /* sd-style only when the disk name has no digits of its
         * own (nvme0n1 without its p2 is a whole disk, not a
         * partition). */
        int has_digit = 0;
        for (size_t j = 0; j < i; j++)
            if (isdigit((unsigned char)base[j]))
                has_digit = 1;
        if (has_digit) {
            free(device);
            return NULL;
        }
        parent_len = i;
    }
    char *esp = malloc(strlen(device) - blen + parent_len + 3);
    if (!esp) {
        free(device);
        return NULL;
    }
    size_t dev_prefix = (size_t)(base - device);
    memcpy(esp, device, dev_prefix);
    memcpy(esp + dev_prefix, base, parent_len);
    esp[dev_prefix + parent_len] = '\0';
    if (pstyle)
        strcat(esp, "p1");
    else
        strcat(esp, "1");
    free(device);
    struct stat st;
    if (stat(esp, &st) != 0 || !S_ISBLK(st.st_mode)) {
        free(esp);
        return NULL;
    }
    return esp;
}

/* Resolve the ESP directory for a sync: the SEVYN_UPDATE_ESP_DIR
 * hook wins (no mount); otherwise discover the ESP device and mount
 * it at /esp. Returns 0 with *esp_out set and *mounted_out (1 =
 * caller must esp_release); 1 when there is no ESP (skip the sync);
 * -1 on error with err filled. */
static int esp_resolve(const char **esp_out, int *mounted_out,
                       char *err, size_t errcap)
{
    *mounted_out = 0;
    if (g_esp_dir && *g_esp_dir) {
        *esp_out = g_esp_dir;
        return 0;
    }
    char *dev = esp_find_device();
    if (!dev) {
        log_line("UPDATE no ESP found (whole-disk data device); "
                 "slot-only update");
        return 1;
    }
    if (mkdir_p(ESP_MOUNT_POINT) != 0) {
        snprintf(err, errcap, "cannot create %s", ESP_MOUNT_POINT);
        free(dev);
        return -1;
    }
    if (mount(dev, ESP_MOUNT_POINT, "vfat", 0, NULL) != 0) {
        snprintf(err, errcap, "cannot mount ESP %s: %s", dev,
                 strerror(errno));
        free(dev);
        return -1;
    }
    free(dev);
    *esp_out = ESP_MOUNT_POINT;
    *mounted_out = 1;
    return 0;
}

static void esp_release(int mounted)
{
    if (mounted)
        (void)umount(ESP_MOUNT_POINT);
}

/* ESP sync for an apply: the new slot's files become /vmlinuz, the
 * running ESP kernel is preserved as /vmlinuz.prev. Returns 0 when
 * synced (or when there is no ESP), -1 on failure. */
static int esp_sync_apply(const char *slot_dir, char idle, char good,
                          char *err, size_t errcap)
{
    char new_kern[PATH_MAX], new_initrd[PATH_MAX];
    if (snprintf(new_kern, sizeof(new_kern), "%s/vmlinuz",
                 slot_dir) >= (int)sizeof(new_kern))
        return -1;
    if (snprintf(new_initrd, sizeof(new_initrd), "%s/initramfs.cpio.gz",
                 slot_dir) >= (int)sizeof(new_initrd))
        return -1;
    const char *esp = NULL;
    int mounted = 0;
    int rc = esp_resolve(&esp, &mounted, err, errcap);
    if (rc != 0)
        return rc == 1 ? 0 : -1;
    char prev_kern[PATH_MAX], prev_initrd[PATH_MAX];
    if (snprintf(prev_kern, sizeof(prev_kern), "%s/vmlinuz",
                 esp) >= (int)sizeof(prev_kern)) {
        esp_release(mounted);
        return -1;
    }
    if (snprintf(prev_initrd, sizeof(prev_initrd),
                 "%s/initramfs.cpio.gz",
                 esp) >= (int)sizeof(prev_initrd)) {
        esp_release(mounted);
        return -1;
    }
    int r = esp_sync_files(esp, new_kern, new_initrd, prev_kern,
                           prev_initrd, idle, good);
    esp_release(mounted);
    if (r != 0)
        snprintf(err, errcap, "ESP sync failed");
    return r;
}

/* ESP restore for a twice-failed boot: the good slot's files become
 * both /vmlinuz and /vmlinuz.prev, grub.cfg points both entries at
 * the good slot. Returns 0 on success (or no ESP), -1 on failure. */
static int esp_sync_restore(const char *slot_dir, char good,
                            char *err, size_t errcap)
{
    char kern[PATH_MAX], initrd[PATH_MAX];
    if (snprintf(kern, sizeof(kern), "%s/vmlinuz",
                 slot_dir) >= (int)sizeof(kern))
        return -1;
    if (snprintf(initrd, sizeof(initrd), "%s/initramfs.cpio.gz",
                 slot_dir) >= (int)sizeof(initrd))
        return -1;
    const char *esp = NULL;
    int mounted = 0;
    int rc = esp_resolve(&esp, &mounted, err, errcap);
    if (rc != 0)
        return rc == 1 ? 0 : -1;
    int r = esp_sync_files(esp, kern, initrd, kern, initrd, good, good);
    esp_release(mounted);
    if (r != 0)
        snprintf(err, errcap, "ESP restore failed");
    return r;
}

/* The apply child: fetch + verify the feed, download + verify both
 * artifacts, write them to the idle slot, flip the state, sync, and
 * reboot. On any failure it logs UPDATE APPLY FAIL and exits 1
 * without touching the slot state — the running system is untouched.
 * Never returns. */
static void apply_child(int listen_fd, int ctl_fd)
{
    /* Drop the parent's fds (the child reboots or exits). */
    if (listen_fd >= 0)
        close(listen_fd);
    if (ctl_fd >= 0)
        close(ctl_fd);
    char err[512];
    struct feed feed;
    if (fetch_feed(&feed, err, sizeof(err)) != 0) {
        log_line("UPDATE APPLY FAIL %s", err);
        _exit(1);
    }
    if (strcmp(feed.version, g_version) == 0) {
        log_line("UPDATE APPLY FAIL already on %s", feed.version);
        _exit(1);
    }
    struct slot_state st;
    if (read_slot_state(&st) != 0) {
        log_line("UPDATE APPLY FAIL cannot read slot state");
        _exit(1);
    }
    char idle = (st.active == 'A') ? 'B' : 'A';
    char slot_dir[PATH_MAX];
    snprintf(slot_dir, sizeof(slot_dir), "%s/slots/%c", g_data_dir, idle);
    if (mkdir_p(slot_dir) != 0) {
        log_line("UPDATE APPLY FAIL cannot create slot dir");
        _exit(1);
    }
    const struct feed_artifact *kern = feed_find(&feed, "vmlinuz");
    const struct feed_artifact *initrd = feed_find(&feed, "initramfs");
    char dl_kern[PATH_MAX], dl_initrd[PATH_MAX];
    snprintf(dl_kern, sizeof(dl_kern), "%s/vmlinuz.%ld", g_tmp_dir,
             (long)getpid());
    snprintf(dl_initrd, sizeof(dl_initrd), "%s/initramfs.%ld", g_tmp_dir,
             (long)getpid());
    if (download_verified(kern, dl_kern, err, sizeof(err)) != 0) {
        log_line("UPDATE APPLY FAIL %s", err);
        _exit(1);
    }
    if (download_verified(initrd, dl_initrd, err, sizeof(err)) != 0) {
        log_line("UPDATE APPLY FAIL %s", err);
        unlink(dl_kern);
        _exit(1);
    }
    if (install_into_slot(slot_dir, "vmlinuz", dl_kern) != 0 ||
        install_into_slot(slot_dir, "initramfs.cpio.gz", dl_initrd) != 0) {
        log_line("UPDATE APPLY FAIL cannot write slot %c", idle);
        unlink(dl_kern);
        unlink(dl_initrd);
        _exit(1);
    }
    unlink(dl_kern);
    unlink(dl_initrd);
    /* M9: sync the ESP before flipping the state — on bare metal
     * GRUB boots from the ESP, so without this the new slot would
     * never boot. A sync failure aborts the apply WITHOUT flipping
     * the state; the running system keeps booting the old kernel. */
    if (esp_sync_apply(slot_dir, idle, st.good, err, sizeof(err)) != 0) {
        log_line("UPDATE APPLY FAIL %s", err);
        _exit(1);
    }
    /* Flip the state: the idle slot becomes active; the good slot is
     * untouched until the new slot proves itself healthy. */
    st.active = idle;
    st.attempts = 0;
    snprintf(st.version, sizeof(st.version), "%s", feed.version);
    if (write_slot_state(&st) != 0) {
        log_line("UPDATE APPLY FAIL cannot write slot state");
        _exit(1);
    }
    sync();
    log_line("UPDATE APPLIED %s slot=%c", feed.version, idle);
    /* Reboot into the new slot. -f: no init dance, the kernel
     * reboots now; QEMU -no-reboot turns this into a clean exit the
     * harness treats as an expected reboot. */
    execlp("reboot", "reboot", "-f", (char *)NULL);
    log_line("UPDATE APPLY FAIL cannot reboot: %s", strerror(errno));
    _exit(1);
}

/* --- clients (socket) --- */

struct client {
    int fd;
    int subscribed;
    char in[LINE_CAP];
    size_t in_len;
    char *out;
    size_t out_len, out_off;
    int dead;
};

static struct client g_clients[MAX_CLIENTS];
static size_t g_nclients = 0;

static void client_close(struct client *c)
{
    if (c->fd >= 0)
        close(c->fd);
    c->fd = -1;
    free(c->out);
    c->out = NULL;
    c->out_len = c->out_off = 0;
    c->dead = 1;
}

static void compact_clients(void)
{
    size_t w = 0;
    for (size_t r = 0; r < g_nclients; r++) {
        if (!g_clients[r].dead) {
            if (w != r)
                g_clients[w] = g_clients[r];
            w++;
        }
    }
    g_nclients = w;
}

static int client_send(struct client *c, const char *data, size_t len)
{
    if (c->dead)
        return -1;
    char *nb = (char *)realloc(c->out, c->out_len + len);
    if (!nb) {
        c->dead = 1;
        return -1;
    }
    c->out = nb;
    memcpy(c->out + c->out_len, data, len);
    c->out_len += len;
    return 0;
}

static int client_send_str(struct client *c, const char *s)
{
    return client_send(c, s, strlen(s));
}

static void broadcast_event(const char *fmt, ...)
{
    char buf[LINE_CAP];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    for (size_t i = 0; i < g_nclients; i++) {
        if (g_clients[i].subscribed)
            client_send(&g_clients[i], buf, (size_t)n);
    }
}

static void flush_clients(void)
{
    for (size_t i = 0; i < g_nclients; i++) {
        struct client *c = &g_clients[i];
        if (c->dead)
            continue;
        if (c->out_off < c->out_len) {
            ssize_t w = write(c->fd, c->out + c->out_off,
                              c->out_len - c->out_off);
            if (w > 0) {
                c->out_off += (size_t)w;
                if (c->out_off == c->out_len) {
                    free(c->out);
                    c->out = NULL;
                    c->out_len = c->out_off = 0;
                }
            } else if (w < 0 && errno != EAGAIN && errno != EINTR) {
                client_close(c);
            }
        }
    }
}

/* --- verbs --- */

typedef void (*reply_fn)(void *ctx, const char *line);

static int g_listen_fd = -1;
static int g_ctl_fd = -1;

static void status_line(char *out, size_t outcap)
{
    struct slot_state st;
    if (!data_disk_present()) {
        snprintf(out, outcap,
                 "version=%s channel=%s active=? good=? attempts=? "
                 "applying=%s available=%s no-data-disk",
                 g_version, g_channel, g_applying ? "yes" : "no",
                 g_available[0] ? g_available : "unknown");
        return;
    }
    if (read_slot_state(&st) != 0) {
        snprintf(out, outcap,
                 "version=%s channel=%s active=? good=? attempts=? "
                 "applying=%s available=%s no-state",
                 g_version, g_channel, g_applying ? "yes" : "no",
                 g_available[0] ? g_available : "unknown");
        return;
    }
    snprintf(out, outcap,
             "version=%s channel=%s active=%c good=%c attempts=%d "
             "applying=%s available=%s",
             g_version, g_channel, st.active, st.good, st.attempts,
             g_applying ? "yes" : "no",
             g_available[0] ? g_available : "unknown");
}

static void run_verb(const char *verb_line, reply_fn reply, void *ctx,
                     int from_ctl)
{
    char line[LINE_CAP];
    snprintf(line, sizeof(line), "%s", verb_line);
    char *sp = strchr(line, ' ');
    char *arg = NULL;
    if (sp) {
        *sp = '\0';
        arg = sp + 1;
        while (*arg == ' ')
            arg++;
        if (!*arg)
            arg = NULL;
    }
    char out[LINE_CAP];

    if (strcmp(line, "PING") == 0) {
        if (from_ctl)
            log_line("UPDATE PONG");
        else if (reply)
            reply(ctx, "OK pong\n");
        return;
    }
    if (strcmp(line, "SUBSCRIBE") == 0) {
        if (!from_ctl && reply) {
            struct client *c = (struct client *)ctx;
            c->subscribed = 1;
            reply(ctx, "OK subscribed\n");
        }
        return;
    }
    if (strcmp(line, "STATUS") == 0) {
        char st[1024];
        status_line(st, sizeof(st));
        if (from_ctl)
            log_line("UPDATE STATUS %s", st);
        else if (reply) {
            snprintf(out, sizeof(out), "OK %s\n", st);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "CHECK") == 0) {
        struct feed feed;
        char err[512];
        if (fetch_feed(&feed, err, sizeof(err)) != 0) {
            snprintf(g_available, sizeof(g_available), "%s", "");
            if (from_ctl)
                log_line("UPDATE CHECK FAIL %s", err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR %s\n", err);
                reply(ctx, out);
            }
            return;
        }
        if (strcmp(feed.version, g_version) == 0) {
            snprintf(g_available, sizeof(g_available), "none");
            if (from_ctl)
                log_line("UPDATE CHECK NONE %s", feed.version);
            else if (reply) {
                snprintf(out, sizeof(out), "OK none %s\n", feed.version);
                reply(ctx, out);
            }
        } else {
            snprintf(g_available, sizeof(g_available), "%s",
                     feed.version);
            if (from_ctl)
                log_line("UPDATE CHECK AVAILABLE %s", feed.version);
            else if (reply) {
                snprintf(out, sizeof(out), "OK available %s\n",
                         feed.version);
                reply(ctx, out);
            }
        }
        return;
    }
    if (strcmp(line, "APPLY") == 0) {
        if (g_applying) {
            if (from_ctl)
                log_line("UPDATE APPLY FAIL already-running");
            else if (reply)
                reply(ctx, "ERR already-running\n");
            return;
        }
        if (!data_disk_present()) {
            if (from_ctl)
                log_line("UPDATE APPLY FAIL no-data-disk");
            else if (reply)
                reply(ctx, "ERR no-data-disk\n");
            return;
        }
        /* Fetch + verify synchronously first, so a bad feed or an
         * up-to-date system is refused with a clear error before
         * anything is forked. The child re-fetches and re-verifies. */
        struct feed feed;
        char err[512];
        if (fetch_feed(&feed, err, sizeof(err)) != 0) {
            if (from_ctl)
                log_line("UPDATE APPLY FAIL %s", err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR %s\n", err);
                reply(ctx, out);
            }
            return;
        }
        if (strcmp(feed.version, g_version) == 0) {
            if (from_ctl)
                log_line("UPDATE APPLY FAIL already on %s",
                         feed.version);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR already on %s\n",
                         feed.version);
                reply(ctx, out);
            }
            return;
        }
        pid_t pid = fork();
        if (pid < 0) {
            if (from_ctl)
                log_line("UPDATE APPLY FAIL fork: %s",
                         strerror(errno));
            else if (reply)
                reply(ctx, "ERR fork failed\n");
            return;
        }
        if (pid == 0)
            apply_child(g_listen_fd, g_ctl_fd);
        g_applying = 1;
        g_apply_pid = pid;
        snprintf(g_available, sizeof(g_available), "%s", feed.version);
        broadcast_event("EVENT APPLY STARTED %s\n", feed.version);
        if (from_ctl)
            log_line("UPDATE APPLY STARTED %s", feed.version);
        else if (reply) {
            snprintf(out, sizeof(out), "OK applying %s\n", feed.version);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "CHANNEL") == 0) {
        if (!arg || (strcmp(arg, "nightly") != 0 &&
                     strcmp(arg, "stable") != 0)) {
            if (from_ctl)
                log_line("UPDATE CHANNEL FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: CHANNEL <nightly|stable>\n");
            return;
        }
        if (!data_disk_present()) {
            if (from_ctl)
                log_line("UPDATE CHANNEL FAIL no-data-disk");
            else if (reply)
                reply(ctx, "ERR no-data-disk\n");
            return;
        }
        snprintf(g_channel, sizeof(g_channel), "%s", arg);
        if (save_config() != 0) {
            if (from_ctl)
                log_line("UPDATE CHANNEL FAIL cannot save config");
            else if (reply)
                reply(ctx, "ERR cannot save config\n");
            return;
        }
        snprintf(g_available, sizeof(g_available), "%s", "");
        if (from_ctl)
            log_line("UPDATE CHANNEL OK %s", arg);
        else if (reply) {
            snprintf(out, sizeof(out), "OK channel %s\n", arg);
            reply(ctx, out);
        }
        return;
    }
    if (from_ctl)
        log_line("UPDATE unknown verb: %s", line);
    else if (reply)
        reply(ctx, "ERR unknown verb\n");
}

static void socket_reply(void *ctx, const char *line)
{
    struct client *c = (struct client *)ctx;
    client_send_str(c, line);
}

static void handle_client_line(struct client *c, const char *line)
{
    run_verb(line, socket_reply, c, 0);
}

/* --- slot lifecycle: attempts on boot, good on READY --- */

/* M9 fallback restore: when the booted slot has failed twice and is
 * not the good slot, restore the ESP from the good slot, flip active
 * back to good, and reboot. Runs once at startup, before the socket
 * is up. A restore failure logs loudly and leaves the system up
 * (rebooting would only retry the failed slot). Never returns on a
 * successful restore (reboot replaces the process). */
static void maybe_restore_esp(void)
{
    if (!data_disk_present() || !g_boot_slot)
        return;
    struct slot_state st;
    if (read_slot_state(&st) != 0)
        return;
    if (st.attempts < 2 || g_boot_slot == st.good)
        return;
    log_line("UPDATE slot %c failed twice; restoring ESP from good "
             "slot %c",
             g_boot_slot, st.good);
    char slot_dir[PATH_MAX];
    snprintf(slot_dir, sizeof(slot_dir), "%s/slots/%c", g_data_dir,
             st.good);
    char err[512];
    if (esp_sync_restore(slot_dir, st.good, err, sizeof(err)) != 0) {
        log_line("UPDATE ESP restore FAILED: %s; staying up", err);
        return;
    }
    st.active = st.good;
    st.attempts = 0;
    if (write_slot_state(&st) != 0) {
        log_line("UPDATE ESP restore cannot write slot state; "
                 "staying up");
        return;
    }
    sync();
    log_line("UPDATE ESP restored from slot %c; rebooting", st.good);
    execlp("reboot", "reboot", "-f", (char *)NULL);
    log_line("UPDATE ESP restore cannot reboot: %s", strerror(errno));
}

static void note_boot_attempt(void)
{
    if (!data_disk_present() || !g_boot_slot)
        return;
    struct slot_state st;
    if (read_slot_state(&st) != 0) {
        st.active = g_boot_slot;
        st.good = g_boot_slot;
        st.attempts = 0;
        snprintf(st.version, sizeof(st.version), "%s", g_version);
    }
    st.attempts++;
    if (write_slot_state(&st) != 0) {
        log_line("UPDATE cannot record boot attempt");
        return;
    }
    log_line("UPDATE boot slot=%c attempts=%d", g_boot_slot,
             st.attempts);
}

static void check_health(void)
{
    if (g_marked_good || !data_disk_present() || !g_boot_slot)
        return;
    char *text = read_file(g_health_file);
    if (!text)
        return;
    int ready = strstr(text, DEFAULT_HEALTH_MARKER) != NULL;
    free(text);
    if (!ready)
        return;
    struct slot_state st;
    if (read_slot_state(&st) != 0) {
        st.active = g_boot_slot;
        st.good = g_boot_slot;
        st.attempts = 0;
    }
    /* The booted slot proved itself healthy: it becomes both the
     * good slot AND the active slot. The active flip matters on a
     * fallback boot (booted=good, active=failed): without it the next
     * boot would retry the failed slot and the system would
     * ping-pong between the broken and the working slot. */
    st.active = g_boot_slot;
    st.good = g_boot_slot;
    st.attempts = 0;
    snprintf(st.version, sizeof(st.version), "%s", g_version);
    if (write_slot_state(&st) != 0) {
        log_line("UPDATE cannot mark slot good");
        return;
    }
    g_marked_good = 1;
    log_line("UPDATE SLOT GOOD %c", g_boot_slot);
    broadcast_event("EVENT SLOT GOOD %c\n", g_boot_slot);
}

/* --- main loop --- */

int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    g_sock_path = getenv("SEVYN_UPDATE_SOCK");
    if (!g_sock_path || !*g_sock_path)
        g_sock_path = DEFAULT_SOCK;
    g_ctl_path = getenv("SEVYN_UPDATE_CTL");
    if (!g_ctl_path || !*g_ctl_path)
        g_ctl_path = DEFAULT_CTL;
    g_data_dir = getenv("SEVYN_UPDATE_DATA");
    if (!g_data_dir || !*g_data_dir)
        g_data_dir = DEFAULT_DATA;
    g_trusted_keys_path = getenv("SEVYN_UPDATE_TRUSTED_KEYS");
    if (!g_trusted_keys_path || !*g_trusted_keys_path)
        g_trusted_keys_path = DEFAULT_TRUSTED_KEYS;
    g_version_file = getenv("SEVYN_UPDATE_VERSION_FILE");
    if (!g_version_file || !*g_version_file)
        g_version_file = DEFAULT_VERSION_FILE;
    g_tmp_dir = getenv("SEVYN_UPDATE_TMP");
    if (!g_tmp_dir || !*g_tmp_dir)
        g_tmp_dir = DEFAULT_TMP;
    g_health_file = getenv("SEVYN_UPDATE_HEALTH_FILE");
    if (!g_health_file || !*g_health_file)
        g_health_file = DEFAULT_HEALTH_FILE;
    g_wget = getenv("SEVYN_UPDATE_WGET");
    if (!g_wget || !*g_wget)
        g_wget = DEFAULT_WGET;
    g_esp_dir = getenv("SEVYN_UPDATE_ESP_DIR");
    g_proc_mounts = getenv("SEVYN_UPDATE_PROC_MOUNTS");

    g_console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);

    load_version();
    load_config();
    parse_cmdline(); /* cmdline URL wins over the config file */
    if (!g_url[0])
        snprintf(g_url, sizeof(g_url), "%s", DEFAULT_FEED_URL);

    if (!data_disk_present())
        log_line("UPDATE no data disk at %s (degraded: STATUS only)",
                 g_data_dir);
    note_boot_attempt();
    maybe_restore_esp();

    /* Listen socket. */
    unlink(g_sock_path);
    int listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        log_line("UPDATE socket failed: %s", strerror(errno));
        return 1;
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(g_sock_path) >= sizeof(addr.sun_path)) {
        log_line("UPDATE socket path too long");
        return 1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", g_sock_path);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        log_line("UPDATE bind failed: %s", strerror(errno));
        return 1;
    }
    if (listen(listen_fd, 8) != 0) {
        log_line("UPDATE listen failed: %s", strerror(errno));
        return 1;
    }
    fcntl(listen_fd, F_SETFL, O_NONBLOCK);
    g_listen_fd = listen_fd;

    /* Control serial (read-only). Missing on the host test rig until
     * the harness creates it — retry for a while, then run without
     * it (the socket still serves the shell). */
    int ctl_fd = -1;
    for (int i = 0; i < 50 && ctl_fd < 0 && !g_stop; i++) {
        ctl_fd = open(g_ctl_path, O_RDONLY | O_NONBLOCK);
        if (ctl_fd < 0)
            usleep(100 * 1000);
    }
    if (ctl_fd < 0)
        log_line("UPDATE no control serial %s: %s (socket only)",
                 g_ctl_path, strerror(errno));
    g_ctl_fd = ctl_fd;

    log_line("UPDATE ready version=%s channel=%s sock=%s ctl=%s",
             g_version, g_channel, g_sock_path,
             ctl_fd >= 0 ? g_ctl_path : "(none)");

    char ctl_buf[LINE_CAP];
    size_t ctl_len = 0;
    int health_tick = 0;

    while (!g_stop) {
        struct pollfd pfds[2 + MAX_CLIENTS];
        int nfds = 0;
        pfds[nfds].fd = listen_fd;
        pfds[nfds].events = POLLIN;
        nfds++;
        if (ctl_fd >= 0) {
            pfds[nfds].fd = ctl_fd;
            pfds[nfds].events = POLLIN;
            nfds++;
        }
        for (size_t i = 0; i < g_nclients; i++) {
            pfds[nfds].fd = g_clients[i].fd;
            pfds[nfds].events = POLLIN;
            if (g_clients[i].out_off < g_clients[i].out_len)
                pfds[nfds].events |= POLLOUT;
            nfds++;
        }
        int r = poll(pfds, (nfds_t)nfds, 100);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        /* See appd: only service the clients that were polled;
         * clients accepted this iteration are read next time. */
        size_t nclients_polled = g_nclients;
        int idx = 0;
        /* Listener. */
        if (pfds[idx].revents & POLLIN) {
            for (;;) {
                int cfd = accept(listen_fd, NULL, NULL);
                if (cfd < 0)
                    break;
                if (g_nclients >= MAX_CLIENTS) {
                    close(cfd);
                    continue;
                }
                fcntl(cfd, F_SETFL, O_NONBLOCK);
                struct client *c = &g_clients[g_nclients++];
                memset(c, 0, sizeof(*c));
                c->fd = cfd;
            }
        }
        idx++;
        /* Control serial. */
        if (ctl_fd >= 0 && idx < nfds && (pfds[idx].revents & POLLIN)) {
            char tmp[1024];
            ssize_t nread = read(ctl_fd, tmp, sizeof(tmp));
            if (nread > 0) {
                for (ssize_t i = 0; i < nread; i++) {
                    char ch = tmp[i];
                    if (ch == '\n' || ch == '\r') {
                        if (ctl_len > 0) {
                            ctl_buf[ctl_len] = '\0';
                            run_verb(ctl_buf, NULL, NULL, 1);
                            ctl_len = 0;
                        }
                    } else if (ctl_len + 1 < sizeof(ctl_buf)) {
                        ctl_buf[ctl_len++] = ch;
                    }
                }
            }
        }
        if (ctl_fd >= 0)
            idx++;
        /* Clients. */
        for (size_t i = 0; i < nclients_polled; i++) {
            struct client *c = &g_clients[i];
            if (c->dead)
                continue;
            short revents = pfds[idx + (int)i].revents;
            if (revents & (POLLERR | POLLHUP | POLLNVAL)) {
                client_close(c);
                continue;
            }
            if (revents & POLLIN) {
                char tmp[1024];
                ssize_t nread = read(c->fd, tmp, sizeof(tmp));
                if (nread <= 0) {
                    if (nread < 0 && errno == EAGAIN)
                        continue;
                    client_close(c);
                    continue;
                }
                for (ssize_t j = 0; j < nread; j++) {
                    char ch = tmp[j];
                    if (ch == '\n' || ch == '\r') {
                        if (c->in_len > 0) {
                            c->in[c->in_len] = '\0';
                            handle_client_line(c, c->in);
                            c->in_len = 0;
                        }
                    } else if (c->in_len + 1 < sizeof(c->in)) {
                        c->in[c->in_len++] = ch;
                    }
                }
            }
        }
        flush_clients();
        compact_clients();
        /* Reap the apply child (wget runs are synchronous, so the
         * reaper can never steal one's status). */
        if (g_apply_pid > 0) {
            int status = 0;
            pid_t done = waitpid(g_apply_pid, &status, WNOHANG);
            if (done == g_apply_pid) {
                g_apply_pid = -1;
                g_applying = 0;
                if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
                    struct slot_state st;
                    if (read_slot_state(&st) == 0)
                        broadcast_event("EVENT APPLIED %s %c\n",
                                        st.version, st.active);
                } else {
                    broadcast_event("EVENT APPLY FAILED\n");
                }
            }
        }
        /* Health watch (~once a second). */
        if (++health_tick >= 10) {
            health_tick = 0;
            check_health();
        }
    }

    log_line("UPDATE stopping");
    close(listen_fd);
    if (ctl_fd >= 0)
        close(ctl_fd);
    unlink(g_sock_path);
    return 0;
}
