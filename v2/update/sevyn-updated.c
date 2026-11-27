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
 * the apply child mounts the ESP (found by its SEVYNESP label, not
 * by partition number — M11 dual-boot), and syncs the new slot's
 * kernel + initramfs into place (temp + fsync + sha256 re-read +
 * rename), then rewrites /EFI/ubuntu/grub.cfg atomically with a
 * default entry (the new active slot) and, when the previous kernel
 * could be preserved, a "previous" entry booting the good slot
 * from /vmlinuz.prev. Any sync failure aborts the apply WITHOUT
 * flipping the state — the running system keeps booting the old
 * kernel. With no ESP at all (the QEMU -kernel path: the data
 * device is a whole disk, no partition table) the sync is skipped
 * and the slot flip still works, because the harness boots -kernel
 * from the active slot.
 *   On startup, when the booted slot's attempt counter reaches 2
 * and the booted slot is not the good slot, the daemon restores
 * the ESP from the good slot, flips active back to good, and
 * reboots. No auto-reboot timer: the fallback fires on the second
 * boot attempt (manual reboot / power-cycle after the first failed
 * boot), so a slow first boot can never false-trigger it.
 *   ESP sync rework, 2026-11-15 (the M12 Genesis nightly exposed
 * the flaw — see esp_sync_files): the old order preserved the
 * running kernel as .prev FIRST and then wrote the new files, so
 * at the peak the 1152 MiB ESP held old + .prev + temp-new —
 * three copies of the boot set. Once the initramfs grew past
 * ~366 MiB (Genesis: 437 MiB) that peak passed the ESP size and
 * the update died mid-copy with ENOSPC. The new order deletes the
 * stale .prev first, writes the new files, and re-creates .prev
 * afterwards from the GOOD SLOT's copy on the data partition
 * (the slot holds the same running kernel the ESP had) — peak is
 * two copies, never three — and a free-space pre-check refuses
 * the update loudly BEFORE copying anything when even that would
 * not fit. When the good slot's files are gone, .prev degrades:
 * the update still lands, the GRUB "previous" entry is omitted,
 * and the degradation is logged loudly; the slot copy
 * (esp_sync_restore) remains the real fallback.
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
 *   URL <url>         -> OK url <url> / ERR <reason>
 *                        Sets the feed URL (persisted in
 *                        /data/update-config.json alongside the
 *                        channel). The feed at that URL must still
 *                        be signed by a trusted key — the URL only
 *                        chooses where the signed feed comes from,
 *                        so a local/dev feed (a build just made on
 *                        another machine, served over plain HTTP on
 *                        the LAN) is testable without waiting for
 *                        the nightly release pipeline. The URL is
 *                        sticky across channel changes; STATUS shows
 *                        it, so a dev override is never silent.
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
 * The daemon fetches with an in-daemon OpenSSL client (plain HTTP, or
 * HTTPS verified against the staged CA bundle, failing closed);
 * downloads are verified by sha256 + size before anything is written
 * to a slot.
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
 *   SEVYN_UPDATE_CA_BUNDLE (default
 *     /etc/ssl/certs/ca-certificates.crt),
 *   SEVYN_UPDATE_SLOT (host-test hook: the booted slot when the
 *     kernel cmdline carries no sevyn.slot=),
 *   SEVYN_UPDATE_ESP_DIR (host-test hook: use this directory as the
 *     ESP, skipping device discovery + mount),
 *   SEVYN_UPDATE_ESP_SIZE_BYTES (host-test hook: pretend the ESP is
 *     exactly this many bytes, measuring used space by walking the
 *     ESP dir — so the host tests can prove the space logic on a
 *     small fixture ESP instead of the host filesystem),
 *   SEVYN_UPDATE_PROC_MOUNTS (host-test hook: mounts table to read
 *     for ESP discovery; default /proc/mounts),
 *   SEVYN_UPDATE_BY_PARTUUID_DIR (host-test hook: /dev/disk/by-partuuid
 *     stand-in; default /dev/disk/by-partuuid).
 *
 * M11 — dual-boot: the ESP is found by its filesystem label
 * (SEVYNESP), not by assuming it is partition 1 — on a dual-boot
 * disk the Windows ESP is partition 1. The ESP sync preserves
 * every non-SevynOS `menuentry` block in grub.cfg verbatim (the
 * Windows 11 / Linux chainload entries the installer writes),
 * and the
 * SevynOS entries carry sevyn.data=PARTUUID=<uuid> for the data
 * partition the system booted from (so init finds the right data
 * partition when another SevynOS install's SEVYN_DATA label is
 * also present). Without a PARTUUID (single-disk systems) the
 * entries are unchanged.
 *
 * Build: gcc, libc + libssl + libcrypto. Links json.c + verify.c +
 *   canonical.c.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netdb.h>
#include <netinet/in.h>
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
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/ssl.h>

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
#define DEFAULT_CA_BUNDLE "/etc/ssl/certs/ca-certificates.crt"
#define MAX_CLIENTS 16
#define MAX_KEYS 8
#define MAX_ARTIFACTS 4
#define LINE_CAP 2048
#define FETCH_MANIFEST_TIMEOUT 30
#define FETCH_ARTIFACT_TIMEOUT 300

static const char *g_sock_path;
static const char *g_ctl_path;
static const char *g_data_dir;
static const char *g_trusted_keys_path;
static const char *g_version_file;
static const char *g_tmp_dir;
static const char *g_health_file;
static const char *g_ca_bundle; /* SEVYN_UPDATE_CA_BUNDLE, or NULL */
static const char *g_esp_dir;    /* SEVYN_UPDATE_ESP_DIR, or NULL */
static const char *g_esp_size;   /* SEVYN_UPDATE_ESP_SIZE_BYTES, or NULL */
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

/* Last fetch failure, for the error strings: the whole reason the
 * download died (e.g. "TLS certificate verification failed:
 * self-signed certificate", "HTTP 404", "connect to
 * example.com:443 failed: Connection refused"). The old wget path
 * kept only the first line of wget's stderr, which hid the real
 * cause — the GF65's TLS failure showed only the benign "TLS
 * certificate validation not implemented" note while the handshake
 * error sat on the discarded lines. This buffer always carries
 * the full reason. */
static char g_fetch_detail[512] = "";

static void set_fetch_detail(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_fetch_detail, sizeof(g_fetch_detail), fmt, ap);
    va_end(ap);
}

/* --- in-daemon HTTP(S) fetch (replaces the wget subprocess) ---
 *
 * BusyBox wget can never fetch HTTPS on SevynOS: the image ships
 * Ubuntu's busybox-static verbatim, wget first tries `openssl
 * s_client` (absent from the image) and falls back to BusyBox's
 * built-in TLS, which cannot handshake against a modern server.
 * So the daemon fetches with OpenSSL directly: plain HTTP over a
 * socket, HTTPS over TLS with the peer verified against the staged
 * CA bundle, failing closed on any verification error. Follows up
 * to 5 redirects (the GitHub releases/download feed URL 302s to
 * the asset host). Streams the body to out_path; a failed fetch
 * unlinks the partial file. */

#define FETCH_MAX_REDIRECTS 5

struct fetch_url {
    int tls; /* 1 = https, 0 = http */
    char host[256];
    char port[8];
    char path[1024];
};

/* Split scheme://host[:port][/path...]. IPv6 literals are refused
 * (the feed and test URLs never use them); the host may be a name
 * or an IPv4 address. */
static int parse_fetch_url(const char *url, struct fetch_url *out)
{
    const char *scheme_end = strstr(url, "://");
    if (!scheme_end) {
        set_fetch_detail("invalid URL (no scheme): %.200s", url);
        return -1;
    }
    size_t scheme_len = (size_t)(scheme_end - url);
    if (scheme_len == 5 && strncmp(url, "https", 5) == 0)
        out->tls = 1;
    else if (scheme_len == 4 && strncmp(url, "http", 4) == 0)
        out->tls = 0;
    else {
        set_fetch_detail("unsupported URL scheme: %.200s", url);
        return -1;
    }
    const char *rest = scheme_end + 3;
    if (rest[0] == '[') {
        set_fetch_detail("IPv6 URL literals are not supported: %.200s",
                         url);
        return -1;
    }
    const char *slash = strchr(rest, '/');
    const char *host_end = slash ? slash : rest + strlen(rest);
    const char *colon = memchr(rest, ':', (size_t)(host_end - rest));
    const char *host_start = rest;
    const char *host_stop = colon ? colon : host_end;
    if (host_stop - host_start < 1 ||
        host_stop - host_start >= (ptrdiff_t)sizeof(out->host)) {
        set_fetch_detail("invalid URL host: %.200s", url);
        return -1;
    }
    memcpy(out->host, host_start, (size_t)(host_stop - host_start));
    out->host[host_stop - host_start] = '\0';
    if (colon) {
        const char *port_start = colon + 1;
        if (port_start >= host_end ||
            (size_t)(host_end - port_start) >= sizeof(out->port)) {
            set_fetch_detail("invalid URL port: %.200s", url);
            return -1;
        }
        memcpy(out->port, port_start, (size_t)(host_end - port_start));
        out->port[host_end - port_start] = '\0';
        for (const char *p = out->port; *p; p++)
            if (*p < '0' || *p > '9') {
                set_fetch_detail("invalid URL port: %.200s", url);
                return -1;
            }
    } else {
        snprintf(out->port, sizeof(out->port), "%d",
                 out->tls ? 443 : 80);
    }
    if (slash) {
        if (strlen(slash) >= sizeof(out->path)) {
            set_fetch_detail("URL path too long: %.200s", url);
            return -1;
        }
        snprintf(out->path, sizeof(out->path), "%s", slash);
    } else {
        snprintf(out->path, sizeof(out->path), "/");
    }
    return 0;
}

static int is_default_port(const struct fetch_url *u)
{
    return (u->tls && strcmp(u->port, "443") == 0) ||
           (!u->tls && strcmp(u->port, "80") == 0);
}

/* "scheme://host[:port]" for the request line's Host header and for
 * building redirect targets. */
static void url_origin(const struct fetch_url *u, char *out, size_t cap)
{
    snprintf(out, cap, "%s://%s%s%s", u->tls ? "https" : "http",
             u->host, is_default_port(u) ? "" : ":",
             is_default_port(u) ? "" : u->port);
}

static int connect_with_timeout(const char *host, const char *port,
                                int timeout_s)
{
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo(host, port, &hints, &res);
    if (gai != 0) {
        set_fetch_detail("cannot resolve host %s: %s", host,
                         gai_strerror(gai));
        return -1;
    }
    int fd = -1;
    int last_err = ECONNREFUSED;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0)
            continue;
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags < 0) {
            close(fd);
            fd = -1;
            continue;
        }
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
        if (rc != 0 && errno == EINPROGRESS) {
            struct pollfd pfd = { .fd = fd, .events = POLLOUT };
            int pr = poll(&pfd, 1, timeout_s * 1000);
            if (pr > 0) {
                int soerr = 0;
                socklen_t sl = sizeof(soerr);
                if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) == 0 &&
                    soerr == 0)
                    rc = 0;
                else {
                    last_err = soerr ? soerr : ECONNREFUSED;
                    close(fd);
                    fd = -1;
                    continue;
                }
            } else {
                last_err = (pr == 0) ? ETIMEDOUT : errno;
                close(fd);
                fd = -1;
                continue;
            }
        }
        if (rc != 0) {
            last_err = errno;
            close(fd);
            fd = -1;
            continue;
        }
        /* Connected: blocking again, with per-operation timeouts. */
        fcntl(fd, F_SETFL, flags);
        struct timeval tv;
        tv.tv_sec = timeout_s;
        tv.tv_usec = 0;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        break;
    }
    freeaddrinfo(res);
    if (fd < 0) {
        if (last_err == ETIMEDOUT)
            set_fetch_detail("connect to %s:%s timed out", host, port);
        else
            set_fetch_detail("connect to %s:%s failed: %s", host, port,
                             strerror(last_err));
    }
    return fd;
}

static int is_ip_literal(const char *host)
{
    struct in_addr a4;
    struct in6_addr a6;
    return inet_pton(AF_INET, host, &a4) == 1 ||
           inet_pton(AF_INET6, host, &a6) == 1;
}

/* Wrap a connected socket in TLS, verifying the peer against the
 * staged CA bundle and failing closed on any error. On success
 * *ctx_out owns the context (free it after SSL_free). */
static SSL *tls_wrap(int fd, const struct fetch_url *u, SSL_CTX **ctx_out)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) {
        set_fetch_detail("TLS setup failed: %s",
                         ERR_error_string(ERR_get_error(), NULL));
        return NULL;
    }
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    if (SSL_CTX_load_verify_locations(ctx, g_ca_bundle, NULL) != 1) {
        set_fetch_detail("cannot load CA bundle %s", g_ca_bundle);
        SSL_CTX_free(ctx);
        return NULL;
    }
    SSL *ssl = SSL_new(ctx);
    if (!ssl) {
        set_fetch_detail("TLS setup failed: %s",
                         ERR_error_string(ERR_get_error(), NULL));
        SSL_CTX_free(ctx);
        return NULL;
    }
    SSL_set_fd(ssl, fd);
    /* Hostname verification, fail closed: the handshake fails
     * unless the certificate is valid for this host. No SNI for
     * IP literals (the name is an address, not a hostname). */
    if (SSL_set1_host(ssl, u->host) != 1) {
        set_fetch_detail("TLS setup failed: hostname check");
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        return NULL;
    }
    if (!is_ip_literal(u->host) &&
        SSL_set_tlsext_host_name(ssl, u->host) != 1) {
        set_fetch_detail("TLS setup failed: SNI");
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        return NULL;
    }
    if (SSL_connect(ssl) != 1) {
        /* A failed handshake can BE a verification failure: the
         * verify result is set even when the handshake aborts on
         * the cert, so report that precisely instead of the
         * generic handshake error — "verification failed" tells
         * the operator the cert was refused, not the network. */
        long verify = SSL_get_verify_result(ssl);
        if (verify != X509_V_OK) {
            set_fetch_detail("TLS certificate verification failed: %s",
                             X509_verify_cert_error_string(verify));
        } else {
            unsigned long e = ERR_get_error();
            set_fetch_detail("TLS handshake failed: %s",
                             e ? ERR_error_string(e, NULL) : "unknown error");
        }
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        return NULL;
    }
    long verify = SSL_get_verify_result(ssl);
    if (verify != X509_V_OK) {
        set_fetch_detail("TLS certificate verification failed: %s",
                         X509_verify_cert_error_string(verify));
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        return NULL;
    }
    *ctx_out = ctx;
    return ssl;
}

struct fetch_stream {
    int fd;
    SSL *ssl; /* NULL for plain HTTP */
    unsigned char buf[8192];
    size_t len;
    size_t pos;
};

/* Fill the buffer; returns bytes available (>0), 0 on clean EOF,
 * -1 on error. */
static int stream_fill(struct fetch_stream *s)
{
    if (s->pos < s->len)
        return (int)(s->len - s->pos);
    ssize_t n;
    if (s->ssl)
        n = SSL_read(s->ssl, s->buf, (int)sizeof(s->buf));
    else
        n = recv(s->fd, s->buf, sizeof(s->buf), 0);
    if (n <= 0)
        return (int)n; /* 0 = EOF, <0 = error */
    s->len = (size_t)n;
    s->pos = 0;
    return (int)n;
}

/* Read exactly n bytes into out (buffered). 0 = ok, -1 = EOF/error. */
static int stream_read_exact(struct fetch_stream *s, void *out, size_t n)
{
    unsigned char *dst = out;
    while (n > 0) {
        if (s->pos >= s->len) {
            if (stream_fill(s) <= 0)
                return -1;
        }
        size_t avail = s->len - s->pos;
        size_t take = avail < n ? avail : n;
        memcpy(dst, s->buf + s->pos, take);
        s->pos += take;
        dst += take;
        n -= take;
    }
    return 0;
}

/* Read one CRLF-terminated line (without the terminator). 0 = ok,
 * -1 = EOF/error/line too long. */
static int stream_read_line(struct fetch_stream *s, char *out, size_t cap)
{
    size_t n = 0;
    for (;;) {
        if (s->pos >= s->len) {
            if (stream_fill(s) <= 0)
                return -1;
        }
        unsigned char c = s->buf[s->pos++];
        if (c == '\n')
            break;
        if (c == '\r')
            continue;
        if (n + 1 >= cap)
            return -1;
        out[n++] = (char)c;
    }
    out[n] = '\0';
    return 0;
}

/* Write all bytes (plain or TLS). 0 = ok, -1 = error. */
static int stream_write_all(struct fetch_stream *s, const void *buf, size_t n)
{
    const unsigned char *p = buf;
    while (n > 0) {
        int w;
        if (s->ssl)
            w = SSL_write(s->ssl, p, (int)n);
        else
            w = (int)send(s->fd, p, n, 0);
        if (w <= 0)
            return -1;
        p += (size_t)w;
        n -= (size_t)w;
    }
    return 0;
}

static int stream_body_length(struct fetch_stream *st, FILE *out,
                              unsigned long long remaining)
{
    unsigned char buf[65536];
    while (remaining > 0) {
        size_t want = remaining < sizeof(buf) ? (size_t)remaining : sizeof(buf);
        if (stream_read_exact(st, buf, want) != 0) {
            set_fetch_detail("download truncated");
            return -1;
        }
        if (fwrite(buf, 1, want, out) != want) {
            set_fetch_detail("write failed: %s", strerror(errno));
            return -1;
        }
        remaining -= want;
    }
    return 0;
}

static int stream_body_eof(struct fetch_stream *st, FILE *out)
{
    for (;;) {
        int n = stream_fill(st);
        if (n < 0) {
            set_fetch_detail("download failed: %s",
                             errno ? strerror(errno) : "connection closed");
            return -1;
        }
        if (n == 0)
            return 0;
        if (fwrite(st->buf + st->pos, 1, (size_t)n, out) != (size_t)n) {
            set_fetch_detail("write failed: %s", strerror(errno));
            return -1;
        }
        st->pos += (size_t)n;
    }
}

static int stream_body_chunked(struct fetch_stream *st, FILE *out)
{
    char line[256];
    for (;;) {
        if (stream_read_line(st, line, sizeof(line)) != 0) {
            set_fetch_detail("truncated chunked body");
            return -1;
        }
        char *semi = strchr(line, ';');
        if (semi)
            *semi = '\0';
        unsigned long chunk = strtoul(line, NULL, 16);
        if (chunk == 0) {
            /* Trailers until an empty line. */
            for (;;) {
                if (stream_read_line(st, line, sizeof(line)) != 0) {
                    set_fetch_detail("truncated chunked trailer");
                    return -1;
                }
                if (line[0] == '\0')
                    return 0;
            }
        }
        if (stream_body_length(st, out, (unsigned long long)chunk) != 0)
            return -1;
        /* Chunk terminator CRLF. */
        if (stream_read_line(st, line, sizeof(line)) != 0) {
            set_fetch_detail("truncated chunked body");
            return -1;
        }
    }
}

/* Resolve a Location value against the fetched URL (absolute URL,
 * absolute path, or relative path). */
static int resolve_redirect(const struct fetch_url *u, const char *loc,
                            char *out, size_t cap)
{
    if (strncmp(loc, "http://", 7) == 0 || strncmp(loc, "https://", 8) == 0) {
        if (snprintf(out, cap, "%s", loc) >= (int)cap) {
            set_fetch_detail("redirect URL too long");
            return -1;
        }
        return 0;
    }
    char origin[512];
    url_origin(u, origin, sizeof(origin));
    if (loc[0] == '/') {
        if (snprintf(out, cap, "%s%s", origin, loc) >= (int)cap) {
            set_fetch_detail("redirect URL too long");
            return -1;
        }
        return 0;
    }
    /* Relative to the current path's directory. */
    const char *last_slash = strrchr(u->path, '/');
    size_t dir_len = last_slash ? (size_t)(last_slash - u->path) + 1 : 1;
    if (snprintf(out, cap, "%s%.*s%s", origin, (int)dir_len, u->path, loc) >=
        (int)cap) {
        set_fetch_detail("redirect URL too long");
        return -1;
    }
    return 0;
}

/* One request/response exchange on an already-connected stream.
 * Returns 0 = body written to out_path, 1 = redirect (next URL in
 * next_url), -1 = failed (detail set). */
static int fetch_exchange(struct fetch_stream *st, const struct fetch_url *u,
                          const char *out_path,
                          char *next_url, size_t next_cap)
{
    char req[2048];
    int n = snprintf(req, sizeof(req),
                     "GET %s HTTP/1.1\r\n"
                     "Host: %s%s%s\r\n"
                     "User-Agent: sevyn-updated\r\n"
                     "Accept: */*\r\n"
                     "Connection: close\r\n\r\n",
                     u->path, u->host,
                     is_default_port(u) ? "" : ":",
                     is_default_port(u) ? "" : u->port);
    if (n < 0 || n >= (int)sizeof(req)) {
        set_fetch_detail("request too long");
        return -1;
    }
    if (stream_write_all(st, req, (size_t)n) != 0) {
        set_fetch_detail("request failed: %s",
                         errno ? strerror(errno) : "connection closed");
        return -1;
    }
    char line[4096];
    if (stream_read_line(st, line, sizeof(line)) != 0) {
        set_fetch_detail("no response from %s", u->host);
        return -1;
    }
    int status = 0;
    if (sscanf(line, "HTTP/%*d.%*d %d", &status) != 1) {
        set_fetch_detail("bad HTTP response: %.120s", line);
        return -1;
    }
    /* Headers. */
    long content_length = -1;
    int chunked = 0;
    char location[2048] = "";
    size_t header_bytes = 0;
    for (;;) {
        if (stream_read_line(st, line, sizeof(line)) != 0) {
            set_fetch_detail("truncated HTTP headers");
            return -1;
        }
        header_bytes += strlen(line) + 2;
        if (header_bytes > 65536) {
            set_fetch_detail("HTTP headers too large");
            return -1;
        }
        if (line[0] == '\0')
            break;
        /* Header names are case-insensitive. */
        if (strncasecmp(line, "Content-Length:", 15) == 0) {
            content_length = strtol(line + 15, NULL, 10);
            if (content_length < 0)
                content_length = -1;
        } else if (strncasecmp(line, "Transfer-Encoding:", 18) == 0) {
            if (strcasestr(line + 18, "chunked") != NULL)
                chunked = 1;
        } else if (strncasecmp(line, "Location:", 9) == 0) {
            const char *v = line + 9;
            while (*v == ' ' || *v == '\t')
                v++;
            snprintf(location, sizeof(location), "%.2047s", v);
        }
    }
    if ((status == 301 || status == 302 || status == 303 ||
         status == 307 || status == 308) && location[0]) {
        if (resolve_redirect(u, location, next_url, next_cap) != 0)
            return -1;
        return 1;
    }
    if (status == 301 || status == 302 || status == 303 ||
        status == 307 || status == 308) {
        set_fetch_detail("redirect without Location (HTTP %d)", status);
        return -1;
    }
    if (status != 200) {
        set_fetch_detail("HTTP %d", status);
        return -1;
    }
    FILE *out = fopen(out_path, "wb");
    if (!out) {
        set_fetch_detail("cannot write %s: %s", out_path, strerror(errno));
        return -1;
    }
    int ok = 0;
    if (chunked)
        ok = stream_body_chunked(st, out);
    else if (content_length >= 0)
        ok = stream_body_length(st, out, (unsigned long long)content_length);
    else
        ok = stream_body_eof(st, out);
    if (fclose(out) != 0)
        ok = -1;
    if (ok != 0) {
        unlink(out_path);
        return -1;
    }
    return 0;
}

static int fetch_once(const char *url, const char *out_path, int timeout_s)
{
    char cur[2048];
    if (snprintf(cur, sizeof(cur), "%s", url) >= (int)sizeof(cur)) {
        set_fetch_detail("URL too long: %.200s", url);
        return -1;
    }
    for (int hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
        struct fetch_url u;
        if (parse_fetch_url(cur, &u) != 0)
            return -1;
        int fd = connect_with_timeout(u.host, u.port, timeout_s);
        if (fd < 0)
            return -1;
        SSL_CTX *ctx = NULL;
        SSL *ssl = NULL;
        if (u.tls) {
            ssl = tls_wrap(fd, &u, &ctx);
            if (!ssl) {
                close(fd);
                return -1;
            }
        }
        struct fetch_stream st = { .fd = fd, .ssl = ssl, .len = 0, .pos = 0 };
        int rc = fetch_exchange(&st, &u, out_path, cur, sizeof(cur));
        /* fetch_exchange returns: 0 done, 1 redirect (cur updated),
         * -1 failed. */
        if (ssl) {
            SSL_free(ssl);
            SSL_CTX_free(ctx);
        }
        close(fd);
        if (rc == 0)
            return 0;
        if (rc == 1)
            continue;
        return -1;
    }
    set_fetch_detail("too many redirects (over %d)", FETCH_MAX_REDIRECTS);
    return -1;
}

/* Retry a download: one transient failure (flaky wifi, a dropped
 * connection, a server blip) must not strand the device on a stale
 * build. Each attempt logs its reason; the caller keeps the whole
 * reason text, so a future failure shows its real cause. */
#define FETCH_ATTEMPTS 3
static int run_fetch(const char *url, const char *out_path, int timeout_s)
{
    for (int attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
        if (fetch_once(url, out_path, timeout_s) == 0)
            return 0;
        log_line("UPDATE download attempt %d/%d failed: %s (%s)", attempt,
                 FETCH_ATTEMPTS, url, g_fetch_detail);
        if (attempt < FETCH_ATTEMPTS)
            sleep(1);
    }
    return -1;
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
    if (run_fetch(g_url, manifest_path, FETCH_MANIFEST_TIMEOUT) != 0) {
        snprintf(err, errcap, "download failed: %.400s (%.400s)", g_url,
                 g_fetch_detail);
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
            /* Key ids are short in practice, but the JSON string
             * is unbounded — bound the copy to the buffer. */
            snprintf(verified_kid, sizeof(verified_kid), "%.120s",
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
    if (run_fetch(fa->url, out_path, FETCH_ARTIFACT_TIMEOUT) != 0) {
        snprintf(err, errcap, "download failed: %.400s (%.400s)", fa->url,
                 g_fetch_detail);
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

/* Pull every `menuentry "..." { ... }` block that is NOT a SevynOS
 * entry out of an existing grub.cfg, verbatim (the installer
 * writes the Windows / Linux chainload entries; the updater must
 * never drop them when it rewrites the menu). Returns a malloc'd
 * concatenation of the blocks, or NULL when there are none. */
static char *extract_other_entries(const char *cfg_path)
{
    FILE *f = fopen(cfg_path, "r");
    if (!f)
        return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long size = ftell(f);
    if (size <= 0 || size > 65536) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    char *text = malloc((size_t)size + 1);
    if (!text) {
        fclose(f);
        return NULL;
    }
    if (fread(text, 1, (size_t)size, f) != (size_t)size) {
        free(text);
        fclose(f);
        return NULL;
    }
    text[size] = '\0';
    fclose(f);
    /* Walk the menuentry blocks; keep every block whose title is
     * not "SevynOS" or "SevynOS (previous)". */
    char *kept = NULL;
    size_t kept_len = 0;
    char *scan = text;
    for (;;) {
        char *start = strstr(scan, "menuentry \"");
        if (!start)
            break;
        char *title_end = strchr(start + 11, '"');
        if (!title_end)
            break;
        size_t title_len = (size_t)(title_end - (start + 11));
        int is_sevyn =
            (title_len == 7 && strncmp(start + 11, "SevynOS", 7) == 0) ||
            (title_len == 18 &&
             strncmp(start + 11, "SevynOS (previous)", 18) == 0);
        /* The block ends at the line that is exactly "}". */
        char *end = strstr(title_end, "\n}\n");
        if (!end)
            break;
        size_t len = (size_t)(end - start) + 3; /* include "}\n" */
        if (!is_sevyn) {
            char *nkept = realloc(kept, kept_len + len + 1);
            if (!nkept) {
                free(kept);
                free(text);
                return NULL;
            }
            kept = nkept;
            memcpy(kept + kept_len, start, len);
            kept_len += len;
            kept[kept_len] = '\0';
        }
        scan = end + 3;
    }
    free(text);
    return kept;
}

/* --- ESP sync (M9, reworked 2026-11-15) --- */

/* Size of a regular file. Missing files report size 0, exists 0;
 * any other stat failure is an error. */
static int file_size_or_missing(const char *path,
                                unsigned long long *size_out,
                                int *exists_out)
{
    struct stat st;
    if (stat(path, &st) != 0) {
        if (errno == ENOENT) {
            *size_out = 0;
            *exists_out = 0;
            return 0;
        }
        return -1;
    }
    if (!S_ISREG(st.st_mode)) {
        *size_out = 0;
        *exists_out = 0;
        return 0;
    }
    *size_out = (unsigned long long)st.st_size;
    *exists_out = 1;
    return 0;
}

/* Recursive size of the regular files under dir. Used only for the
 * SEVYN_UPDATE_ESP_SIZE_BYTES host-test hook, where statvfs would
 * report the host filesystem instead of the fixture ESP. */
static int dir_usage(const char *dir, unsigned long long *used_out)
{
    DIR *d = opendir(dir);
    if (!d)
        return -1;
    unsigned long long used = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0)
            continue;
        char *child = path_join(dir, e->d_name);
        if (!child) {
            closedir(d);
            return -1;
        }
        struct stat st;
        if (lstat(child, &st) != 0) {
            free(child);
            continue;
        }
        if (S_ISDIR(st.st_mode)) {
            unsigned long long sub = 0;
            if (dir_usage(child, &sub) != 0) {
                free(child);
                closedir(d);
                return -1;
            }
            used += sub;
        } else if (S_ISREG(st.st_mode)) {
            used += (unsigned long long)st.st_size;
        }
        free(child);
    }
    closedir(d);
    *used_out = used;
    return 0;
}

/* ESP capacity + free space. Normally from statvfs; the
 * SEVYN_UPDATE_ESP_SIZE_BYTES host-test hook caps the capacity at
 * that many bytes (used measured by walking the ESP dir). */
static int esp_usage(const char *esp_dir, unsigned long long *total_out,
                     unsigned long long *avail_out, char *err, size_t errcap)
{
    if (g_esp_size && *g_esp_size) {
        char *end = NULL;
        unsigned long long total = strtoull(g_esp_size, &end, 10);
        if (end == g_esp_size || *end != '\0' || total == 0) {
            snprintf(err, errcap, "bad SEVYN_UPDATE_ESP_SIZE_BYTES: %s",
                     g_esp_size);
            return -1;
        }
        unsigned long long used = 0;
        if (dir_usage(esp_dir, &used) != 0) {
            snprintf(err, errcap, "cannot measure ESP dir %s: %s",
                     esp_dir, strerror(errno));
            return -1;
        }
        *total_out = total;
        *avail_out = used >= total ? 0 : total - used;
        return 0;
    }
    struct statvfs sv;
    if (statvfs(esp_dir, &sv) != 0) {
        snprintf(err, errcap, "cannot statfs ESP %s: %s",
                 esp_dir, strerror(errno));
        return -1;
    }
    *total_out = (unsigned long long)sv.f_blocks *
        (unsigned long long)sv.f_frsize;
    *avail_out = (unsigned long long)sv.f_bavail *
        (unsigned long long)sv.f_frsize;
    return 0;
}

static unsigned long long sat_sub(unsigned long long a,
                                  unsigned long long b)
{
    return a >= b ? a - b : 0;
}

/* A temp name is "<dst>.tmp.<pid>" — match names whose ".tmp."
 * suffix is followed only by digits, so a real file that merely
 * contains ".tmp." is never removed. */
static int is_tmp_name(const char *name)
{
    const char *t = strstr(name, ".tmp.");
    if (!t)
        return 0;
    t += 5;
    if (*t == '\0')
        return 0;
    for (const char *p = t; *p; p++) {
        if (*p < '0' || *p > '9')
            return 0;
    }
    return 1;
}

/* Remove stale temp files (<name>.tmp.<pid>) left by an interrupted
 * sync, at the ESP top level and under EFI/ubuntu (where grub.cfg's
 * temp lives). Best-effort: a leftover temp only costs space until
 * the next sync, and the space pre-check accounts for whatever is
 * still there. Returns the number removed. */
static int esp_cleanup_stale_tmps(const char *esp_dir)
{
    int removed = 0;
    char efi_ubuntu[PATH_MAX];
    const char *dirs[2];
    dirs[0] = esp_dir;
    if (snprintf(efi_ubuntu, sizeof(efi_ubuntu), "%s/EFI/ubuntu",
                 esp_dir) >= (int)sizeof(efi_ubuntu))
        dirs[1] = NULL;
    else
        dirs[1] = efi_ubuntu;
    for (int i = 0; i < 2; i++) {
        if (!dirs[i])
            continue;
        DIR *d = opendir(dirs[i]);
        if (!d)
            continue;
        struct dirent *e;
        while ((e = readdir(d)) != NULL) {
            if (!is_tmp_name(e->d_name))
                continue;
            char *child = path_join(dirs[i], e->d_name);
            if (!child)
                continue;
            struct stat st;
            if (lstat(child, &st) == 0 && S_ISREG(st.st_mode) &&
                unlink(child) == 0)
                removed++;
            free(child);
        }
        closedir(d);
    }
    return removed;
}

/* Free-space headroom the sync keeps in reserve on top of the
 * computed peak: FAT metadata + the grub.cfg rewrite + slack for
 * the next kernel growing a little. */
#define ESP_SYNC_FREE_MARGIN_BYTES (32ULL * 1024 * 1024)

/* The ESP sync core: operates on a plain directory (the mounted ESP
 * or the SEVYN_UPDATE_ESP_DIR hook), so the host unit tests
 * exercise it directly. new_* are the slot files to boot; good_*
 * are the good slot's files to preserve as /vmlinuz.prev (the
 * running kernel on apply, the good slot itself on restore).
 * Rewrites grub.cfg with the default entry, plus the "previous"
 * entry when .prev exists on disk. Returns 0 on success, -1 on
 * failure with err filled; on any failure before the grub.cfg
 * rewrite the old menu still boots — copies go through temp names
 * + rename, and the slot state is only flipped by the caller
 * after a successful sync. partuuid (M11, NULL when unknown) pins
 * sevyn.data=PARTUUID=... on the SevynOS entries; the other OS
 * entries (Windows 11, Linux, ...) in the existing grub.cfg are
 * preserved verbatim.
 *
 * Order (reworked 2026-11-15 — see the M9 header note): the stale
 * .prev is deleted BEFORE the new files land, and re-created
 * afterwards from the good slot's copy on the data partition.
 * The peak is two copies of the boot set, never three: on a
 * 1152 MiB ESP with a 437 MiB initramfs the peak is ~842 MiB. */
static int esp_sync_files(const char *esp_dir,
                          const char *new_kern, const char *new_initrd,
                          const char *good_kern, const char *good_initrd,
                          char active_slot, char good_slot,
                          const char *partuuid,
                          char *err, size_t errcap)
{
    /* Stale temps from an interrupted sync first: they inflate the
     * usage measurement and eat the space the pre-check needs. */
    int cleaned = esp_cleanup_stale_tmps(esp_dir);
    if (cleaned > 0)
        log_line("UPDATE ESP sync: removed %d stale temp file(s)", cleaned);

    /* Measure everything before touching anything. */
    unsigned long long new_kern_size, new_initrd_size;
    unsigned long long good_kern_size, good_initrd_size;
    unsigned long long old_kern_size, old_initrd_size;
    unsigned long long prev_kern_size, prev_initrd_size;
    int exists = 0;
    if (file_size_or_missing(new_kern, &new_kern_size, &exists) != 0 ||
        !exists) {
        snprintf(err, errcap, "ESP sync: new slot kernel missing: %s",
                 new_kern);
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }
    if (file_size_or_missing(new_initrd, &new_initrd_size, &exists) != 0 ||
        !exists) {
        snprintf(err, errcap, "ESP sync: new slot initramfs missing: %s",
                 new_initrd);
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }
    /* .prev is re-created from the good slot: when its files are
     * gone the update still lands, but degraded (see below). */
    int prev_available = 1;
    if (file_size_or_missing(good_kern, &good_kern_size, &exists) != 0 ||
        !exists)
        prev_available = 0;
    if (prev_available &&
        (file_size_or_missing(good_initrd, &good_initrd_size,
                              &exists) != 0 || !exists))
        prev_available = 0;
    if (!prev_available) {
        log_line("UPDATE ESP sync: good slot files missing — the GRUB "
                 "'previous' entry will be omitted; the slot restore "
                 "remains the fallback");
    }
    char old_kern[PATH_MAX], old_initrd[PATH_MAX];
    char prev_kern[PATH_MAX], prev_initrd[PATH_MAX];
    if (snprintf(old_kern, sizeof(old_kern), "%s/vmlinuz", esp_dir) >=
            (int)sizeof(old_kern) ||
        snprintf(old_initrd, sizeof(old_initrd),
                 "%s/initramfs.cpio.gz", esp_dir) >=
            (int)sizeof(old_initrd) ||
        snprintf(prev_kern, sizeof(prev_kern), "%s/vmlinuz.prev",
                 esp_dir) >= (int)sizeof(prev_kern) ||
        snprintf(prev_initrd, sizeof(prev_initrd),
                 "%s/initramfs.prev.cpio.gz", esp_dir) >=
            (int)sizeof(prev_initrd)) {
        snprintf(err, errcap, "ESP sync: ESP path too long");
        return -1;
    }
    if (file_size_or_missing(old_kern, &old_kern_size, &exists) != 0 ||
        file_size_or_missing(old_initrd, &old_initrd_size, &exists) != 0 ||
        file_size_or_missing(prev_kern, &prev_kern_size, &exists) != 0 ||
        file_size_or_missing(prev_initrd, &prev_initrd_size,
                             &exists) != 0) {
        snprintf(err, errcap, "ESP sync: cannot stat ESP files: %s",
                 strerror(errno));
        return -1;
    }
    unsigned long long total = 0, avail = 0;
    if (esp_usage(esp_dir, &total, &avail, err, errcap) != 0) {
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }
    unsigned long long used_now = total >= avail ? total - avail : 0;
    unsigned long long prev_total = prev_kern_size + prev_initrd_size;
    unsigned long long used_after_prev_delete =
        sat_sub(used_now, prev_total);
    unsigned long long used_after_new =
        sat_sub(used_after_prev_delete, old_kern_size + old_initrd_size) +
        new_kern_size + new_initrd_size;
    /* Peak simultaneous usage: the new-initramfs temp (initramfs is
     * written first), the new-kernel temp, and the .prev re-creation
     * temp — whichever is largest. */
    unsigned long long peak =
        used_after_prev_delete + new_initrd_size;
    unsigned long long peak_kern =
        sat_sub(used_after_prev_delete, old_initrd_size) +
        new_initrd_size + new_kern_size;
    if (peak_kern > peak)
        peak = peak_kern;
    if (prev_available) {
        unsigned long long peak_prev =
            used_after_new + good_kern_size + good_initrd_size;
        if (peak_prev > peak)
            peak = peak_prev;
    }
    if (peak + ESP_SYNC_FREE_MARGIN_BYTES > total) {
        snprintf(err, errcap,
                 "ESP sync needs %llu MiB at peak (ESP is %llu MiB, "
                 "%llu MiB free) — refusing before copying so the "
                 "running system keeps booting",
                 (peak + ESP_SYNC_FREE_MARGIN_BYTES) / (1024 * 1024),
                 total / (1024 * 1024), avail / (1024 * 1024));
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }

    /* Delete the stale .prev first: the space it frees is what the
     * new temp writes need. */
    if (prev_total > 0) {
        log_line("UPDATE ESP sync: removing stale .prev (frees %llu MiB)",
                 prev_total / (1024 * 1024));
        (void)unlink(prev_kern);
        (void)unlink(prev_initrd);
    }
    /* New initramfs first, then the new kernel: a failure here
     * leaves the old kernel in place. */
    if (esp_copy_verified(new_initrd, old_initrd) != 0) {
        snprintf(err, errcap, "ESP sync failed copying new initramfs");
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }
    if (esp_copy_verified(new_kern, old_kern) != 0) {
        snprintf(err, errcap, "ESP sync failed copying new kernel");
        log_line("UPDATE ESP SYNC FAIL %s", err);
        return -1;
    }
    /* Re-create .prev from the good slot's copy: the same running
     * kernel the ESP had, now sourced from the data partition
     * instead of the ESP's own (deleted) copy. */
    int prev_on_disk = 0;
    if (prev_available) {
        if (esp_copy_verified(good_kern, prev_kern) != 0 ||
            esp_copy_verified(good_initrd, prev_initrd) != 0) {
            (void)unlink(prev_kern);
            (void)unlink(prev_initrd);
            log_line("UPDATE ESP sync: WARNING — could not preserve "
                     ".prev from the good slot; the GRUB 'previous' "
                     "entry will be omitted; the slot restore "
                     "remains the fallback");
            prev_available = 0;
        } else {
            prev_on_disk = 1;
        }
    }
    if (sync_dir(esp_dir) != 0) {
        snprintf(err, errcap, "ESP sync failed syncing ESP dir");
        return -1;
    }
    /* grub.cfg: default boots the active slot from /vmlinuz; the
     * previous entry boots the good slot from /vmlinuz.prev, when
     * .prev exists on disk. M11: preserve the other OS entries
     * verbatim, and pin the data partition by PARTUUID when known. */
    char cfg_path[PATH_MAX];
    if (snprintf(cfg_path, sizeof(cfg_path), "%s/%s", esp_dir,
                 ESP_GRUB_CFG_REL) >= (int)sizeof(cfg_path)) {
        snprintf(err, errcap, "ESP sync: grub.cfg path too long");
        return -1;
    }
    char *other = extract_other_entries(cfg_path);
    char data_arg[128] = "";
    if (partuuid)
        snprintf(data_arg, sizeof(data_arg),
                 " sevyn.data=PARTUUID=%s", partuuid);
    /* The menu is built on the heap, sized to what it actually
     * holds: the preserved other-OS entries are unbounded input
     * (a hand-edited menu, several detected OSes), and the old
     * fixed 2048-byte buffer refused the whole update ("grub.cfg
     * too long") once they passed ~1.4 KiB — the update never
     * landed, for a menu the updater itself did not write. */
    size_t other_len = other ? strlen(other) : 0;
    int sevyn_len;
    if (prev_on_disk) {
        sevyn_len = snprintf(NULL, 0,
             "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
             "# Written by sevyn-updated (ESP sync): the default entry boots\n"
             "# the active slot from /vmlinuz; the previous entry boots the\n"
             "# good slot from the preserved /vmlinuz.prev.\n"
             "set timeout=3\n"
             "set default=0\n"
             "menuentry \"SevynOS\" {\n"
             "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.cpio.gz\n"
             "}\n"
             "menuentry \"SevynOS (previous)\" {\n"
             "    linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.prev.cpio.gz\n"
             "}\n",
             active_slot, data_arg, good_slot, data_arg);
    } else {
        log_line("UPDATE ESP sync: WARNING — no .prev on disk; the "
                 "GRUB 'previous' entry is omitted for this update; "
                 "the slot restore remains the fallback");
        sevyn_len = snprintf(NULL, 0,
             "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
             "# Written by sevyn-updated (ESP sync): the default entry boots\n"
             "# the active slot from /vmlinuz. No 'previous' entry: the\n"
             "# previous kernel could not be preserved on this ESP\n"
             "# (see the update log); the slot restore is the fallback.\n"
             "set timeout=3\n"
             "set default=0\n"
             "menuentry \"SevynOS\" {\n"
             "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.cpio.gz\n"
             "}\n",
             active_slot, data_arg);
    }
    if (sevyn_len < 0) {
        free(other);
        snprintf(err, errcap, "ESP sync: cannot build grub.cfg");
        return -1;
    }
    char *cfg_text = malloc((size_t)sevyn_len + other_len + 1);
    if (!cfg_text) {
        free(other);
        snprintf(err, errcap, "ESP sync: out of memory for grub.cfg");
        return -1;
    }
    if (prev_on_disk) {
        snprintf(cfg_text, (size_t)sevyn_len + 1,
             "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
             "# Written by sevyn-updated (ESP sync): the default entry boots\n"
             "# the active slot from /vmlinuz; the previous entry boots the\n"
             "# good slot from the preserved /vmlinuz.prev.\n"
             "set timeout=3\n"
             "set default=0\n"
             "menuentry \"SevynOS\" {\n"
             "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.cpio.gz\n"
             "}\n"
             "menuentry \"SevynOS (previous)\" {\n"
             "    linux /vmlinuz.prev console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.prev.cpio.gz\n"
             "}\n",
             active_slot, data_arg, good_slot, data_arg);
    } else {
        snprintf(cfg_text, (size_t)sevyn_len + 1,
             "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
             "# Written by sevyn-updated (ESP sync): the default entry boots\n"
             "# the active slot from /vmlinuz. No 'previous' entry: the\n"
             "# previous kernel could not be preserved on this ESP\n"
             "# (see the update log); the slot restore is the fallback.\n"
             "set timeout=3\n"
             "set default=0\n"
             "menuentry \"SevynOS\" {\n"
             "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=%c%s\n"
             "    initrd /initramfs.cpio.gz\n"
             "}\n",
             active_slot, data_arg);
    }
    if (other) {
        strcat(cfg_text, other);
        free(other);
    }
    char efi_dir[PATH_MAX];
    if (snprintf(efi_dir, sizeof(efi_dir), "%s/EFI/ubuntu", esp_dir) >=
        (int)sizeof(efi_dir)) {
        free(cfg_text);
        snprintf(err, errcap, "ESP sync: EFI dir path too long");
        return -1;
    }
    /* The EFI/ubuntu dir exists on every image (GRUB lives there);
     * create it if a test ESP is bare. */
    if (mkdir_p(efi_dir) != 0) {
        free(cfg_text);
        snprintf(err, errcap, "ESP sync: cannot create EFI dir");
        return -1;
    }
    if (write_file_atomic(cfg_path, cfg_text) != 0) {
        free(cfg_text);
        snprintf(err, errcap, "ESP sync: cannot write grub.cfg");
        return -1;
    }
    free(cfg_text);
    return 0;
}

/* The device carrying the data partition (from the mounts table),
 * realpath-resolved. Returns a malloc'd "/dev/..." or NULL. */
static char *data_device(void)
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
    return device;
}

/* M11: the SevynOS ESP by its filesystem label. Returns a malloc'd
 * device path or NULL when the label is absent. */
static char *esp_find_by_label(void)
{
    const char *label_path = "/dev/disk/by-label/SEVYNESP";
    struct stat st;
    if (stat(label_path, &st) != 0 || !S_ISBLK(st.st_mode))
        return NULL;
    char resolved[PATH_MAX];
    if (realpath(label_path, resolved) == NULL)
        return NULL;
    return strdup(resolved);
}

/* M11: the PARTUUID of the data partition the system booted from
 * (so the updater's grub.cfg can pin sevyn.data=PARTUUID=...).
 * Returns a malloc'd UUID or NULL when it cannot be resolved. */
static char *data_partuuid(void)
{
    char *device = data_device();
    if (!device)
        return NULL;
    const char *dir = getenv("SEVYN_UPDATE_BY_PARTUUID_DIR");
    if (!dir || !*dir)
        dir = "/dev/disk/by-partuuid";
    DIR *d = opendir(dir);
    if (!d) {
        free(device);
        return NULL;
    }
    char *uuid = NULL;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.')
            continue;
        char link[PATH_MAX];
        if (snprintf(link, sizeof(link), "%s/%s", dir, e->d_name) >=
            (int)sizeof(link))
            continue;
        char resolved[PATH_MAX];
        if (realpath(link, resolved) == NULL)
            continue;
        if (strcmp(resolved, device) == 0) {
            uuid = strdup(e->d_name);
            break;
        }
    }
    closedir(d);
    free(device);
    return uuid;
}

/* The filesystem label of a device, via blkid (in the image at
 * /usr/sbin/blkid; the init uses it for the same job). Returns 1
 * when the label matches, 0 otherwise — including when blkid is
 * absent or fails. A missing answer is never a yes. */
static int esp_label_is(const char *dev, const char *label)
{
    if (strncmp(dev, "/dev/", 5) != 0)
        return 0;
    char cmd[PATH_MAX + 64];
    if (snprintf(cmd, sizeof(cmd), "blkid -s LABEL -o value %s "
                 "2>/dev/null", dev) >= (int)sizeof(cmd))
        return 0;
    FILE *f = popen(cmd, "r");
    if (!f)
        return 0;
    char got[128] = "";
    if (!fgets(got, sizeof(got), f)) {
        pclose(f);
        return 0;
    }
    pclose(f);
    got[strcspn(got, "\r\n")] = '\0';
    return strcmp(got, label) == 0;
}

/* Find the ESP device: the SevynOS ESP by label (M11 dual-boot),
 * falling back to partition 1 of the disk carrying the data
 * partition (from the mounts table). Returns a malloc'd "/dev/..."
 * or NULL when there is no ESP (whole-disk data device, ESP device
 * absent, or the mounts table has no data entry). */
static char *esp_find_device(void)
{
    char *by_label = esp_find_by_label();
    if (by_label)
        return by_label;
    /* udev's trigger is async (the init says so twice): the
     * by-label symlink may not exist yet when the daemon starts
     * at boot and runs the fallback restore. Poll up to 5s for
     * it before falling back — the init already waited for the
     * data disk's symlink from the same trigger batch, so the
     * ESP's event is imminent, not minutes away. (Kept short
     * deliberately: the host test's apply wait loop is 10s.) */
    for (int i = 0; i < 50; i++) {
        (void)poll(NULL, 0, 100);
        by_label = esp_find_by_label();
        if (by_label)
            return by_label;
    }
    char *device = data_device();
    if (!device)
        return NULL;
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
    struct stat st;
    if (stat(esp, &st) != 0 || !S_ISBLK(st.st_mode)) {
        free(esp);
        free(device);
        return NULL;
    }
    /* The partition-1 fallback predates dual-boot: on a disk with
     * another OS, partition 1 is that OS's ESP, not SevynOS's.
     * Writing there corrupts it (observed in the v2 harness: the
     * fallback restore copied vmlinuz.prev onto the Windows ESP,
     * then the 374 MB initramfs copy failed for space and the
     * restore aborted). Only trust partition 1 when its
     * filesystem label is SEVYNESP; otherwise refuse (no ESP)
     * rather than guess. */
    if (!esp_label_is(esp, "SEVYNESP")) {
        log_line("UPDATE refusing to use %s as the ESP: its label "
                 "is not SEVYNESP (dual-boot disk?)",
                 esp);
        free(esp);
        free(device);
        return NULL;
    }
    free(device);
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

/* ESP sync for an apply: the new slot's files become /vmlinuz, and
 * the running kernel is preserved as /vmlinuz.prev — re-created
 * from the good slot's copy after the new files land (see
 * esp_sync_files). Returns 0 when synced (or when there is no
 * ESP), -1 on failure with err filled. */
static int esp_sync_apply(const char *slot_dir, char idle, char good,
                          char *err, size_t errcap)
{
    err[0] = '\0';
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
    /* The good slot's files are the running kernel: .prev is
     * re-created from them after the new files land. */
    char good_kern[PATH_MAX], good_initrd[PATH_MAX];
    if (snprintf(good_kern, sizeof(good_kern), "%s/slots/%c/vmlinuz",
                 g_data_dir, good) >= (int)sizeof(good_kern)) {
        esp_release(mounted);
        return -1;
    }
    if (snprintf(good_initrd, sizeof(good_initrd),
                 "%s/slots/%c/initramfs.cpio.gz",
                 g_data_dir, good) >= (int)sizeof(good_initrd)) {
        esp_release(mounted);
        return -1;
    }
    char *partuuid = data_partuuid();
    int r = esp_sync_files(esp, new_kern, new_initrd, good_kern,
                           good_initrd, idle, good, partuuid,
                           err, errcap);
    free(partuuid);
    esp_release(mounted);
    if (r != 0 && err[0] == '\0')
        snprintf(err, errcap, "ESP sync failed");
    return r;
}

/* ESP restore for a twice-failed boot: the good slot's files become
 * both /vmlinuz and /vmlinuz.prev, grub.cfg points both entries at
 * the good slot. Returns 0 on success (or no ESP), -1 on failure
 * with err filled. */
static int esp_sync_restore(const char *slot_dir, char good,
                            char *err, size_t errcap)
{
    err[0] = '\0';
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
    char *partuuid = data_partuuid();
    int r = esp_sync_files(esp, kern, initrd, kern, initrd, good, good,
                           partuuid, err, errcap);
    free(partuuid);
    esp_release(mounted);
    if (r != 0 && err[0] == '\0')
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
    char err[1024];
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
             "applying=%s available=%s url=%s",
             g_version, g_channel, st.active, st.good, st.attempts,
             g_applying ? "yes" : "no",
             g_available[0] ? g_available : "unknown",
             g_url[0] ? g_url : "(default)");
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
        char st[2048]; /* a long feed URL rides in the status line */
        status_line(st, sizeof(st));
        if (from_ctl)
            log_line("UPDATE STATUS %s", st);
        else if (reply) {
            /* The reply buffer is LINE_CAP (2048); the status line
             * alone can fill it. Build the reply in its own buffer
             * so a long URL is never truncated mid-value. */
            char full[4096];
            snprintf(full, sizeof(full), "OK %s\n", st);
            reply(ctx, full);
        }
        return;
    }
    if (strcmp(line, "CHECK") == 0) {
        struct feed feed;
        char err[1024];
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
        char err[1024];
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
    if (strcmp(line, "URL") == 0) {
        /* Set the feed URL (persisted with the channel). The URL
         * only chooses where the signed feed comes from: CHECK and
         * APPLY still verify the feed signature against the trusted
         * keys, so pointing at a local/dev feed cannot install
         * unsigned code. http/https only, no whitespace — the verb
         * line is space-split, and a URL with a space in it is
         * never a real feed URL. Sticky across channel changes;
         * STATUS shows the current URL so a dev override is never
         * silent. */
        if (!arg || strlen(arg) >= sizeof(g_url) ||
            (strncmp(arg, "http://", 7) != 0 &&
             strncmp(arg, "https://", 8) != 0) ||
            strchr(arg, ' ') != NULL || strchr(arg, '\t') != NULL ||
            strchr(arg, '\r') != NULL || strchr(arg, '\n') != NULL) {
            if (from_ctl)
                log_line("UPDATE URL FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: URL <http://...|https://...>\n");
            return;
        }
        if (!data_disk_present()) {
            if (from_ctl)
                log_line("UPDATE URL FAIL no-data-disk");
            else if (reply)
                reply(ctx, "ERR no-data-disk\n");
            return;
        }
        snprintf(g_url, sizeof(g_url), "%s", arg);
        if (save_config() != 0) {
            if (from_ctl)
                log_line("UPDATE URL FAIL cannot save config");
            else if (reply)
                reply(ctx, "ERR cannot save config\n");
            return;
        }
        snprintf(g_available, sizeof(g_available), "%s", "");
        if (from_ctl)
            log_line("UPDATE URL OK %s", arg);
        else if (reply) {
            snprintf(out, sizeof(out), "OK url %s\n", arg);
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
    g_ca_bundle = getenv("SEVYN_UPDATE_CA_BUNDLE");
    if (!g_ca_bundle || !*g_ca_bundle)
        g_ca_bundle = DEFAULT_CA_BUNDLE;
    g_esp_dir = getenv("SEVYN_UPDATE_ESP_DIR");
    g_esp_size = getenv("SEVYN_UPDATE_ESP_SIZE_BYTES");
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
        /* Reap the apply child (fetches are synchronous, so the
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
