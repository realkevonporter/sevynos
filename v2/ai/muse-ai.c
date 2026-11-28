/* SevynOS v2 AI — muse-ai backend (P0).
 *
 * A local bridge process between sevyn-aid and the Muse API. It
 * speaks the backend protocol (DESIGN.md §0.2): one task line on
 * stdin, action lines on stdout, ending with END. The daemon spawns
 * it per ASK, grant-checks every action line it emits, and executes
 * the allowed ones.
 *
 * How it works: it reads the task + a bounded device snapshot, calls
 * the Meta Model API (Chat Completions, OpenAI-compatible, with tool
 * calling) and iterates plan -> act -> observe -> re-plan, up to a
 * few API rounds. READ tool calls are executed here immediately (the
 * backend reads the file and feeds the content back to the model);
 * every other tool call becomes a final action line for the daemon.
 *
 * Endpoint (resolved in P0_BUILD.md): Meta Model API, base URL
 * https://api.meta.ai/v1, auth `Authorization: Bearer <key>`, model
 * muse-spark-1.3 (v1 default; muse-wonder-1.0 is the more capable
 * option). The backend talks to exactly ONE host (api.meta.ai) —
 * the endpoint allow-list rule (§1.2). The base URL comes from
 * MUSE_API_BASE (default the Model API); the host tests point it at
 * a fake API on loopback, so no real key or network is ever needed
 * in CI.
 *
 * Auth: the key is read from /data/ai/muse-key (0600, root-only),
 * env override SEVYN_AI_KEY_FILE for tests. No key -> a clear
 * "no Muse API key configured" failure (an ERR chatter line + END),
 * not a crash. The key is never printed, never logged, never in the
 * image or in git.
 *
 * Fail-closed, always: offline / unreachable / bad key / malformed
 * API response / too many actions -> no action lines, END, and the
 * daemon reports allowed=0. The backend NEVER invents actions,
 * never falls back to a stub, never queues a task.
 *
 * Bounds (P0): task line 16 KiB; per-read cap 64 KiB; per-ASK read
 * budget 256 KiB; at most 64 actions per ASK; at most 4 API rounds;
 * 60 s per API call (the daemon's 300 s per-backend timeout is the
 * backstop); response body capped at 512 KiB.
 *
 * Build: gcc -O2 -Wall -Wextra, libc + OpenSSL + the M3 JSON parser.
 * The daemon's sevyn-aid.c links the same json.c.
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "json.h"

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

#define TASK_CAP 16384        /* ASK task line, matches the daemon */
#define READ_CAP 65536        /* per-read cap (§1.6) */
#define READ_BUDGET (256 * 1024) /* per-ASK read budget (§1.6) */
#define MAX_ACTIONS 64        /* per-ASK action cap (muse-ai.limits) */
#define MAX_API_ROUNDS 4      /* plan -> act -> observe -> re-plan */
#define MAX_SESSION_ROUNDS 16 /* session agent loop cap (P1, §1.4.1) */
#define API_TIMEOUT_S 60      /* per API call (daemon allows 300 s) */
#define SESSION_RESULT_TIMEOUT_S 300 /* wait for a daemon RESULT (P1):
                                      * the daemon's per-action budget
                                      * for muse-ai, so a RESULT that
                                      * never comes ends the session
                                      * instead of hanging it. */
#define ACTION_LINE_CAP 2048  /* daemon action-line cap (LINE_CAP) */
#define RESP_CAP (512 * 1024) /* API response body cap */
/* The final prose answer (phase 3, B1): the model answers in text
 * when it calls no tools; that text is carried to the daemon as one
 * escaped TEXT line, capped here so the daemon's reply (TASK_CAP)
 * always fits it. The daemon stashes it in a TEXT_CAP+1 slot. */
#define TEXT_CAP (8 * 1024)
/* Conversation history (phase 3, B1): the daemon may send HISTORY
 * lines before the task. The backend keeps at most this many turns
 * and this many bytes total, oldest first — the daemon already
 * drops oldest pairs to fit TASK_CAP, so these are a second,
 * backend-side bound. */
#define HISTORY_MAX_TURNS 32
#define HISTORY_CAP (32 * 1024)
#define KEY_MAX 512           /* API key, trimmed */
#define SNAPSHOT_CAP (8 * 1024) /* device snapshot in the prompt */
#define PRISTINE_PREFIX "/usr/share/sevyn/pristine/"

#define DEFAULT_API_BASE "https://api.meta.ai/v1"
#define DEFAULT_MODEL "muse-spark-1.3"
#define DEFAULT_KEY_FILE "/data/ai/muse-key"
#define DEFAULT_CA_BUNDLE "/etc/ssl/certs/ca-certificates.crt"
#define DEFAULT_GRANT "/usr/share/sevyn/ai/grant.json"
#define DEFAULT_SETTINGS "/data/settings.json"
#define DEFAULT_REGISTRY "/var/lib/sevyn/apps/registry.json"
#define DEFAULT_AID_LOG "/data/logs/aid.log"

/* ------------------------------------------------------------------ */
/* growable string buffer (for building request JSON)                 */
/* ------------------------------------------------------------------ */

struct strbuf {
    char *data;
    size_t len;
    size_t cap;
};

static int sb_init(struct strbuf *sb)
{
    sb->cap = 4096;
    sb->len = 0;
    sb->data = malloc(sb->cap);
    if (!sb->data)
        return -1;
    sb->data[0] = '\0';
    return 0;
}

static void sb_free(struct strbuf *sb)
{
    free(sb->data);
    sb->data = NULL;
    sb->len = sb->cap = 0;
}

static int sb_reserve(struct strbuf *sb, size_t extra)
{
    if (sb->len + extra + 1 <= sb->cap)
        return 0;
    size_t ncap = sb->cap;
    while (ncap < sb->len + extra + 1)
        ncap *= 2;
    char *nd = realloc(sb->data, ncap);
    if (!nd)
        return -1;
    sb->data = nd;
    sb->cap = ncap;
    return 0;
}

static int sb_append(struct strbuf *sb, const char *s)
{
    size_t n = strlen(s);
    if (sb_reserve(sb, n) != 0)
        return -1;
    memcpy(sb->data + sb->len, s, n + 1);
    sb->len += n;
    return 0;
}

/* Append s JSON-escaped (no surrounding quotes). */
static int sb_append_esc(struct strbuf *sb, const char *s)
{
    char *e = json_escape(s ? s : "");
    if (!e)
        return -1;
    int rc = sb_append(sb, e);
    free(e);
    return rc;
}

static int sb_appendf(struct strbuf *sb, const char *fmt, ...)
{
    char tmp[4096];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n < 0)
        return -1;
    if ((size_t)n >= sizeof(tmp))
        return -1;
    return sb_append(sb, tmp);
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

static const char *env_or(const char *name, const char *dflt)
{
    const char *v = getenv(name);
    return (v && *v) ? v : dflt;
}

/* Read a whole file (up to cap bytes). Returns malloc'd text or NULL. */
static char *read_file_cap(const char *path, size_t cap)
{
    FILE *f = fopen(path, "r");
    if (!f)
        return NULL;
    char *buf = malloc(cap + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, cap, f);
    fclose(f);
    buf[n] = '\0';
    return buf;
}

/* Read one line from stdin (fd 0) with a deadline, unbuffered.
 * stdin is a pipe from the daemon: the daemon writes the task line,
 * then (in session mode) a RESULT line after each action — so the
 * read must NOT use buffered stdio (fgets), which could swallow a
 * RESULT line into its buffer while this code waits on the next
 * one. Returns malloc'd text without the trailing newline, or NULL
 * on EOF / timeout / error. A line longer than the buffer is
 * truncated, not fatal. */
static char *read_line_timeout(int timeout_s)
{
    char *buf = malloc(TASK_CAP + 2);
    if (!buf)
        return NULL;
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += timeout_s;
    size_t llen = 0;
    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long remain_ms = (deadline.tv_sec - now.tv_sec) * 1000 +
                         (deadline.tv_nsec - now.tv_nsec) / 1000000;
        if (remain_ms <= 0) {
            free(buf);
            return NULL;
        }
        struct pollfd pfd = { .fd = STDIN_FILENO, .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain_ms);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            free(buf);
            return NULL;
        }
        if (pr == 0) {
            free(buf);
            return NULL;
        }
        char c;
        ssize_t r = read(STDIN_FILENO, &c, 1);
        if (r == 0) {
            free(buf);
            return NULL;
        }
        if (r < 0) {
            if (errno == EINTR)
                continue;
            free(buf);
            return NULL;
        }
        if (c == '\n') {
            buf[llen] = '\0';
            return buf;
        }
        if (llen + 1 < TASK_CAP + 2)
            buf[llen++] = c;
    }
}

/* ------------------------------------------------------------------ */
/* key                                                                 */
/* ------------------------------------------------------------------ */

/* Read the Muse API key: the file holds the bare key (one line,
 * trailing whitespace trimmed). Returns malloc'd key or NULL when
 * there is no key — a missing key is a configuration state, not an
 * error, and the caller reports it clearly. The key is never printed. */
static char *read_key(void)
{
    const char *path = env_or("SEVYN_AI_KEY_FILE", DEFAULT_KEY_FILE);
    char *text = read_file_cap(path, KEY_MAX);
    if (!text)
        return NULL;
    /* Trim trailing whitespace/newlines. */
    size_t n = strlen(text);
    while (n > 0 && (text[n - 1] == '\n' || text[n - 1] == '\r' ||
                     text[n - 1] == ' ' || text[n - 1] == '\t'))
        text[--n] = '\0';
    /* Trim leading whitespace. */
    char *p = text;
    while (*p == ' ' || *p == '\t')
        p++;
    if (p != text)
        memmove(text, p, strlen(p) + 1);
    if (text[0] == '\0') {
        free(text);
        return NULL;
    }
    return text;
}

/* ------------------------------------------------------------------ */
/* grant + snapshot (context per ASK, §1.6)                            */
/* ------------------------------------------------------------------ */

/* Read the grant file and return a comma-separated permission list
 * (malloc'd). Best-effort: an unreadable grant yields "unknown" —
 * the daemon is the authority on the grant, not this list; it is
 * only here so the model prefers actions the grant allows. */
static char *grant_csv(void)
{
    const char *path = env_or("SEVYN_AI_GRANT", DEFAULT_GRANT);
    char *text = read_file_cap(path, 65536);
    if (!text)
        return strdup("unknown");
    char err[256];
    jval_t *root = json_parse(text, err, sizeof(err));
    if (!root) {
        free(text);
        return strdup("unknown");
    }
    const jval_t *perms = json_obj_get(root, "permissions");
    struct strbuf sb;
    if (!perms || perms->type != J_ARR || sb_init(&sb) != 0) {
        json_free(root);
        free(text);
        return strdup("unknown");
    }
    size_t n = json_arr_len(perms);
    for (size_t i = 0; i < n; i++) {
        const char *s = json_str(json_arr_get(perms, i));
        if (!s)
            continue;
        if (sb.len > 0)
            sb_append(&sb, ",");
        sb_append(&sb, s);
    }
    json_free(root);
    free(text);
    if (sb.len == 0) {
        sb_free(&sb);
        return strdup("none");
    }
    return sb.data;
}

/* Append the last `lines` lines of a file (best-effort) to sb. */
static void sb_append_tail(struct strbuf *sb, const char *path,
                           size_t lines, size_t max_bytes)
{
    char *text = read_file_cap(path, max_bytes * 2);
    if (!text) {
        sb_append(sb, "(unavailable)");
        return;
    }
    /* Find the start of the last `lines` lines. */
    size_t total = strlen(text);
    size_t start = 0, count = 0;
    for (size_t i = total; i > 0; i--) {
        if (text[i - 1] == '\n') {
            count++;
            if (count >= lines) {
                start = i;
                break;
            }
        }
    }
    const char *tail = text + start;
    size_t n = strlen(tail);
    if (n > max_bytes)
        tail += n - max_bytes;
    sb_append(sb, tail);
    free(text);
}

/* Build the bounded device snapshot (§1.6): settings, the app
 * registry (truncated), and the last ~50 AID log lines. Everything
 * is best-effort — a missing file reads "(unavailable)", never an
 * error. No user files, message history, or call history. */
static char *build_snapshot(void)
{
    struct strbuf sb;
    if (sb_init(&sb) != 0)
        return strdup("(snapshot unavailable)");
    sb_append(&sb, "Settings: ");
    char *settings = read_file_cap(
        env_or("SEVYN_AI_SETTINGS", DEFAULT_SETTINGS), 4096);
    if (settings) {
        sb_append(&sb, settings);
        free(settings);
    } else {
        sb_append(&sb, "(unavailable)");
    }
    sb_append(&sb, "\nApp registry: ");
    char *reg = read_file_cap(
        env_or("SEVYN_AI_REGISTRY", DEFAULT_REGISTRY), 2048);
    if (reg) {
        sb_append(&sb, reg);
        free(reg);
    } else {
        sb_append(&sb, "(unavailable)");
    }
    sb_append(&sb, "\nRecent AID log:\n");
    sb_append_tail(&sb, env_or("SEVYN_AI_LOG", DEFAULT_AID_LOG), 50,
                   4096);
    if (sb.len > SNAPSHOT_CAP)
        sb.data[SNAPSHOT_CAP] = '\0';
    return sb.data;
}

/* ------------------------------------------------------------------ */
/* READ (backend-side, phase 1)                                        */
/* ------------------------------------------------------------------ */

/* The same bounds as the daemon's READ executor: absolute path only,
 * under /data/ or /var/lib/sevyn/, no ".." traversal, regular file
 * only, 64 KiB per read. A read that would exceed the per-ASK budget
 * is refused before it happens. Returns malloc'd content (or NULL
 * with a one-line reason in err). The caller emits a READ action
 * line for every successful read, so the fetch lands in the daemon's
 * audit trail. */
static size_t g_read_total = 0;

static int read_path_allowed(const char *path)
{
    if (!path || path[0] != '/')
        return 0;
    if (strstr(path, "..") != NULL)
        return 0;
    /* A path with whitespace can never survive the daemon's
     * single-token action parse — the first word would become the
     * path and the rest the content. Refuse it here so the model
     * gets a fast error instead of acting on the wrong file. */
    if (strpbrk(path, " \t\n\r") != NULL)
        return 0;
    /* Test-only override (SEVYN_AI_READ_ROOT): when set, READ may
     * only touch paths under it (the host test cannot write /data).
     * Unset in production, where the /data/ + /var/lib/sevyn/
     * roots apply. The daemon enforces the same override. */
    const char *root = getenv("SEVYN_AI_READ_ROOT");
    if (root && *root) {
        size_t n = strlen(root);
        return strncmp(path, root, n) == 0 && path[n] == '/';
    }
    if (strncmp(path, "/data/", 6) != 0 &&
        strncmp(path, "/var/lib/sevyn/", 15) != 0)
        return 0;
    return 1;
}

static char *backend_read(const char *path, char *err, size_t errcap)
{
    if (!read_path_allowed(path)) {
        snprintf(err, errcap, "path not allowed: %s", path);
        return NULL;
    }
    struct stat st;
    if (stat(path, &st) != 0) {
        snprintf(err, errcap, "cannot stat %s: %s", path,
                 strerror(errno));
        return NULL;
    }
    if (!S_ISREG(st.st_mode)) {
        snprintf(err, errcap, "not a regular file: %s", path);
        return NULL;
    }
    /* Over the per-read cap: refuse, don't truncate — a truncated
     * prefix would mislead the model into thinking it read the whole
     * file. The refusal is local (no API call is needed to decide). */
    if (st.st_size > (off_t)READ_CAP) {
        snprintf(err, errcap, "file over the 64 KiB read cap: %s", path);
        return NULL;
    }
    if (g_read_total + READ_CAP > READ_BUDGET) {
        snprintf(err, errcap, "per-ASK read budget exhausted");
        return NULL;
    }
    char *content = read_file_cap(path, READ_CAP);
    if (!content) {
        snprintf(err, errcap, "cannot read %s: %s", path,
                 strerror(errno));
        return NULL;
    }
    g_read_total += strlen(content);
    return content;
}

/* WRITE validation (P1, §1.4.3): mirrors the daemon's bounds, so
 * the model gets a fast local refusal instead of emitting an
 * action the daemon will deny. The daemon re-validates as the
 * authority — this is a fast path, not the boundary. */
static int write_path_allowed(const char *path)
{
    if (!path || path[0] != '/')
        return 0;
    if (strstr(path, "..") != NULL)
        return 0;
    /* Same whitespace rule as read_path_allowed: a path with
     * whitespace would be split by the daemon's single-token parse,
     * so the write would land on the wrong file. */
    if (strpbrk(path, " \t\n\r") != NULL)
        return 0;
    if (strncmp(path, PRISTINE_PREFIX,
                sizeof(PRISTINE_PREFIX) - 1) == 0)
        return 0;
    const char *root = getenv("SEVYN_AI_WRITE_ROOT");
    if (root && *root) {
        size_t n = strlen(root);
        return strncmp(path, root, n) == 0 && path[n] == '/';
    }
    if (strncmp(path, "/data/", 6) != 0 &&
        strncmp(path, "/var/lib/sevyn/", 15) != 0)
        return 0;
    return 1;
}

/* Validate a WRITE before emitting it: path allowed, and (when the
 * file exists) a regular file within the read cap, so the model
 * does not replace a file it could not have fully read. A new file
 * needs an existing parent directory. Returns 0 with reason in err
 * on refusal, 1 when the write may be emitted. */
static int write_precheck(const char *path, char *err, size_t errcap)
{
    if (!write_path_allowed(path)) {
        snprintf(err, errcap, "path not allowed: %s", path);
        return 0;
    }
    /* The daemon's action line carries the path as one token of at
     * most 127 chars (parse_action) — a longer path can never be
     * emitted, so refuse it here with a fast error. */
    size_t plen = strlen(path);
    if (plen >= 128) {
        snprintf(err, errcap, "path too long: %.100s", path);
        return 0;
    }
    struct stat st;
    if (stat(path, &st) == 0) {
        if (!S_ISREG(st.st_mode)) {
            snprintf(err, errcap, "not a regular file: %s", path);
            return 0;
        }
        if (st.st_size > (off_t)READ_CAP) {
            snprintf(err, errcap,
                     "file over the 64 KiB cap: %s", path);
            return 0;
        }
        return 1;
    }
    char parent[128];
    memcpy(parent, path, plen + 1);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) {
        snprintf(err, errcap, "bad parent for %s", path);
        return 0;
    }
    *slash = '\0';
    struct stat pst;
    if (stat(parent, &pst) != 0 || !S_ISDIR(pst.st_mode)) {
        snprintf(err, errcap, "parent directory missing: %s", parent);
        return 0;
    }
    return 1;
}

/* Escape WRITE content for the action line: \ -> \\, newline ->
 * \n, tab -> \t. Returns malloc'd text. */
static char *escape_write_content(const char *content)
{
    size_t n = strlen(content);
    char *out = malloc(n * 2 + 1);
    if (!out)
        return NULL;
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        char c = content[i];
        if (c == '\\') {
            out[w++] = '\\';
            out[w++] = '\\';
        } else if (c == '\n') {
            out[w++] = '\\';
            out[w++] = 'n';
        } else if (c == '\t') {
            out[w++] = '\\';
            out[w++] = 't';
        } else {
            out[w++] = c;
        }
    }
    out[w] = '\0';
    return out;
}

/* Inverse of escape_write_content: \\ -> \, \n -> newline,
 * \t -> tab. Any other backslash is kept as-is (the daemon only
 * ever sends the three escapes above). Returns malloc'd text. */
static char *unescape_write_content(const char *content)
{
    size_t n = strlen(content);
    char *out = malloc(n + 1);
    if (!out)
        return NULL;
    size_t w = 0;
    for (size_t i = 0; i < n; i++) {
        if (content[i] == '\\' && i + 1 < n) {
            char e = content[i + 1];
            if (e == 'n') {
                out[w++] = '\n';
                i++;
            } else if (e == 't') {
                out[w++] = '\t';
                i++;
            } else if (e == '\\') {
                out[w++] = '\\';
                i++;
            } else {
                out[w++] = content[i];
            }
        } else {
            out[w++] = content[i];
        }
    }
    out[w] = '\0';
    return out;
}

/* Truncate an escaped TEXT to TEXT_CAP bytes, never splitting an
 * escape pair, and mark the cut with "...". The input is already
 * escaped; the output fits the daemon's stash whole. Returns
 * malloc'd text. */
static char *cap_text(const char *esc)
{
    size_t n = strlen(esc);
    if (n <= TEXT_CAP)
        return strdup(esc);
    size_t cut = TEXT_CAP - 3; /* room for "..." */
    /* A run of backslashes ending at cut-1: odd means the last one
     * starts a pair whose partner is cut off — back off one. */
    size_t bs = 0;
    while (cut > bs && esc[cut - 1 - bs] == '\\')
        bs++;
    if (bs % 2 == 1)
        cut--;
    char *out = malloc(cut + 3 + 1);
    if (!out)
        return NULL;
    memcpy(out, esc, cut);
    memcpy(out + cut, "...", 4);
    return out;
}

/* ------------------------------------------------------------------ */
/* HTTP client (POST JSON, read the response)                         */
/* ------------------------------------------------------------------ */

/* A minimal HTTP/1.1 client: POST a JSON body, read the response.
 * Supports http:// (plain, for the loopback mock in tests) and
 * https:// (OpenSSL, for the real Model API). Handles Content-Length
 * and chunked bodies. The response body is capped at RESP_CAP;
 * anything larger is an error — fail-closed, never a partial parse.
 * The socket has a connect + read/write timeout (API_TIMEOUT_S), so
 * a hung API call cannot stall the backend past the daemon's limit. */

struct http_resp {
    int status; /* HTTP status, or -1 on transport error */
    char *body; /* malloc'd, NUL-terminated (NULL on error) */
    size_t body_len;
    char err[256];
};

static int set_timeouts(int fd, int timeout_s)
{
    struct timeval tv;
    tv.tv_sec = timeout_s;
    tv.tv_usec = 0;
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv)) != 0)
        return -1;
    if (setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv)) != 0)
        return -1;
    return 0;
}

/* Connect with a timeout (non-blocking connect + select). */
static int connect_timeout(const char *host, const char *port,
                           int timeout_s)
{
    struct addrinfo hints, *res = NULL, *ai;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, port, &hints, &res) != 0)
        return -1;
    int fd = -1;
    for (ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0)
            continue;
        int flags = fcntl(fd, F_GETFL, 0);
        if (flags >= 0)
            fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
        if (rc == 0)
            break;
        if (rc < 0 && errno != EINPROGRESS) {
            close(fd);
            fd = -1;
            continue;
        }
        fd_set wf;
        FD_ZERO(&wf);
        FD_SET(fd, &wf);
        struct timeval tv;
        tv.tv_sec = timeout_s;
        tv.tv_usec = 0;
        rc = select(fd + 1, NULL, &wf, NULL, &tv);
        if (rc <= 0) {
            close(fd);
            fd = -1;
            continue;
        }
        int so_err = 0;
        socklen_t slen = sizeof(so_err);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_err, &slen) != 0 ||
            so_err != 0) {
            close(fd);
            fd = -1;
            continue;
        }
        break;
    }
    freeaddrinfo(res);
    if (fd < 0)
        return -1;
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0)
        fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
    if (set_timeouts(fd, timeout_s) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/* Write all bytes (plain socket or TLS). Returns 0 on success. */
static int write_all_conn(SSL *ssl, int fd, const char *buf, size_t len)
{
    size_t off = 0;
    while (off < len) {
        ssize_t n = ssl ? SSL_write(ssl, buf + off, (int)(len - off))
                        : send(fd, buf + off, len - off, 0);
        if (n <= 0)
            return -1;
        off += (size_t)n;
    }
    return 0;
}

/* Read until EOF or the cap. Returns malloc'd bytes (or NULL). */
static char *read_all_conn(SSL *ssl, int fd, size_t cap, size_t *out_len)
{
    size_t len = 0, alloc = 65536;
    char *buf = malloc(alloc + 1);
    if (!buf)
        return NULL;
    for (;;) {
        if (len + 16384 > alloc) {
            if (alloc >= cap) {
                free(buf);
                return NULL;
            }
            size_t nalloc = alloc * 2;
            if (nalloc > cap)
                nalloc = cap;
            char *nb = realloc(buf, nalloc + 1);
            if (!nb) {
                free(buf);
                return NULL;
            }
            buf = nb;
            alloc = nalloc;
        }
        size_t want = alloc - len;
        if (want > 16384)
            want = 16384;
        ssize_t n = ssl ? SSL_read(ssl, buf + len, (int)want)
                        : recv(fd, buf + len, want, 0);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            free(buf);
            return NULL;
        }
        if (n == 0)
            break;
        len += (size_t)n;
        if (len >= cap) {
            /* The response is bigger than the cap: refuse it. */
            free(buf);
            return NULL;
        }
    }
    buf[len] = '\0';
    *out_len = len;
    return buf;
}

/* Case-insensitive substring search (for header names). */
static const char *strcasestr_local(const char *hay, const char *needle)
{
    size_t nlen = strlen(needle);
    for (const char *p = hay; *p; p++) {
        if (strncasecmp(p, needle, nlen) == 0)
            return p;
    }
    return NULL;
}

/* Decode a chunked body in place. Returns the decoded length, or
 * (size_t)-1 on a malformed body. */
static size_t decode_chunked(char *body, size_t len)
{
    size_t out = 0, pos = 0;
    while (pos < len) {
        /* Chunk-size line (hex, up to CRLF). */
        char *eol = memchr(body + pos, '\n', len - pos);
        if (!eol)
            return (size_t)-1;
        char sizebuf[32];
        size_t slen = (size_t)(eol - (body + pos));
        if (slen >= sizeof(sizebuf))
            return (size_t)-1;
        memcpy(sizebuf, body + pos, slen);
        sizebuf[slen] = '\0';
        /* Strip a trailing CR and any chunk extensions. */
        char *semi = strchr(sizebuf, ';');
        if (semi)
            *semi = '\0';
        if (slen > 0 && sizebuf[slen - 1] == '\r')
            sizebuf[slen - 1] = '\0';
        char *endp = NULL;
        long chunk = strtol(sizebuf, &endp, 16);
        if (endp == sizebuf || chunk < 0)
            return (size_t)-1;
        pos = (size_t)(eol - body) + 1;
        if (chunk == 0)
            return out;
        if (pos + (size_t)chunk > len)
            return (size_t)-1;
        memmove(body + out, body + pos, (size_t)chunk);
        out += (size_t)chunk;
        pos += (size_t)chunk;
        /* Skip the CRLF after the chunk. */
        if (pos + 1 < len && body[pos] == '\r' && body[pos + 1] == '\n')
            pos += 2;
        else if (pos < len && body[pos] == '\n')
            pos += 1;
    }
    return (size_t)-1;
}

/* POST a JSON body to url (http:// or https://) with a Bearer key.
 * Fills resp (body is malloc'd, NUL-terminated). Returns 0 when a
 * complete HTTP response was read (check resp->status), -1 on a
 * transport error (resp->err says why). */
static int http_post(const char *url, const char *body, const char *api_key,
                     int timeout_s, struct http_resp *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status = -1;
    int use_tls = 0;
    const char *p = NULL;
    if (strncmp(url, "https://", 8) == 0) {
        use_tls = 1;
        p = url + 8;
    } else if (strncmp(url, "http://", 7) == 0) {
        p = url + 7;
    } else {
        snprintf(resp->err, sizeof(resp->err),
                 "unsupported URL scheme (want http:// or https://)");
        return -1;
    }
    /* host[:port][/path] */
    const char *slash = strchr(p, '/');
    const char *host_end = slash ? slash : p + strlen(p);
    char host[256], port[16], path[1024];
    const char *colon = memchr(p, ':', (size_t)(host_end - p));
    if (colon) {
        size_t hlen = (size_t)(colon - p);
        if (hlen >= sizeof(host)) {
            snprintf(resp->err, sizeof(resp->err), "host too long");
            return -1;
        }
        memcpy(host, p, hlen);
        host[hlen] = '\0';
        size_t plen = (size_t)(host_end - colon - 1);
        if (plen >= sizeof(port)) {
            snprintf(resp->err, sizeof(resp->err), "port too long");
            return -1;
        }
        memcpy(port, colon + 1, plen);
        port[plen] = '\0';
    } else {
        size_t hlen = (size_t)(host_end - p);
        if (hlen >= sizeof(host)) {
            snprintf(resp->err, sizeof(resp->err), "host too long");
            return -1;
        }
        memcpy(host, p, hlen);
        host[hlen] = '\0';
        snprintf(port, sizeof(port), "%d", use_tls ? 443 : 80);
    }
    if (slash)
        snprintf(path, sizeof(path), "%s", slash);
    else
        snprintf(path, sizeof(path), "/");

    int fd = connect_timeout(host, port, timeout_s);
    if (fd < 0) {
        snprintf(resp->err, sizeof(resp->err),
                 "cannot connect to %.200s:%.10s", host, port);
        return -1;
    }
    SSL_CTX *ctx = NULL;
    SSL *ssl = NULL;
    if (use_tls) {
        ctx = SSL_CTX_new(TLS_client_method());
        if (!ctx) {
            snprintf(resp->err, sizeof(resp->err),
                     "cannot create TLS context");
            close(fd);
            return -1;
        }
        /* Verify the server's certificate against the system CA
         * bundle (/etc/ssl/certs/ca-certificates.crt, staged in the
         * image) — loaded EXPLICITLY, as the updater does: OpenSSL's
         * compiled-in default paths do not exist in the image, so
         * SSL_CTX_set_default_verify_paths found no CA and every
         * handshake failed ("TLS handshake failed" on-device,
         * 2026-11-27). SEVYN_AI_CA_BUNDLE overrides the bundle
         * path (tests). The backend sends a Bearer API key, so an
         * unverified connection would hand the key to whoever
         * answers. A verification failure aborts the handshake —
         * fail-closed, never an insecure transport. The loopback
         * mock in tests is plain HTTP, so this never applies there. */
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
        if (SSL_CTX_load_verify_locations(
                ctx, env_or("SEVYN_AI_CA_BUNDLE", DEFAULT_CA_BUNDLE),
                NULL) != 1) {
            snprintf(resp->err, sizeof(resp->err),
                     "cannot load CA bundle");
            SSL_CTX_free(ctx);
            close(fd);
            return -1;
        }
        ssl = SSL_new(ctx);
        if (!ssl) {
            snprintf(resp->err, sizeof(resp->err),
                     "cannot create TLS session");
            SSL_CTX_free(ctx);
            close(fd);
            return -1;
        }
        SSL_set_fd(ssl, fd);
        SSL_set_tlsext_host_name(ssl, host);
        if (SSL_connect(ssl) != 1) {
            snprintf(resp->err, sizeof(resp->err), "TLS handshake failed");
            SSL_free(ssl);
            SSL_CTX_free(ctx);
            close(fd);
            return -1;
        }
    }
    /* Request. */
    struct strbuf req;
    if (sb_init(&req) != 0) {
        snprintf(resp->err, sizeof(resp->err), "out of memory");
        goto fail;
    }
    sb_appendf(&req, "POST %s HTTP/1.1\r\n", path);
    sb_appendf(&req, "Host: %s\r\n", host);
    sb_append(&req, "Content-Type: application/json\r\n");
    sb_appendf(&req, "Authorization: Bearer %s\r\n", api_key);
    sb_appendf(&req, "Content-Length: %zu\r\n", strlen(body));
    sb_append(&req, "Connection: close\r\n\r\n");
    sb_append(&req, body);
    if (write_all_conn(ssl, fd, req.data, req.len) != 0) {
        sb_free(&req);
        snprintf(resp->err, sizeof(resp->err), "cannot send request");
        goto fail;
    }
    sb_free(&req);
    size_t raw_len = 0;
    char *raw = read_all_conn(ssl, fd, RESP_CAP + 65536, &raw_len);
    if (ssl) {
        SSL_shutdown(ssl);
        SSL_free(ssl);
        SSL_CTX_free(ctx);
    }
    close(fd);
    if (!raw) {
        snprintf(resp->err, sizeof(resp->err),
                 "cannot read response (or response over the cap)");
        return -1;
    }
    /* Status line. */
    int status = 0;
    if (sscanf(raw, "HTTP/%*s %d", &status) != 1) {
        free(raw);
        snprintf(resp->err, sizeof(resp->err),
                 "malformed HTTP response");
        return -1;
    }
    resp->status = status;
    /* Split headers / body. */
    char *split = strstr(raw, "\r\n\r\n");
    size_t hdr_len = 0;
    char *body_start = NULL;
    if (split) {
        hdr_len = (size_t)(split - raw);
        body_start = split + 4;
    } else {
        split = strstr(raw, "\n\n");
        if (split) {
            hdr_len = (size_t)(split - raw);
            body_start = split + 2;
        }
    }
    if (!body_start) {
        free(raw);
        snprintf(resp->err, sizeof(resp->err),
                 "malformed HTTP response (no header/body split)");
        return -1;
    }
    size_t body_len = raw_len - (size_t)(body_start - raw);
    /* Chunked? */
    char *headers = malloc(hdr_len + 1);
    if (!headers) {
        free(raw);
        snprintf(resp->err, sizeof(resp->err), "out of memory");
        return -1;
    }
    memcpy(headers, raw, hdr_len);
    headers[hdr_len] = '\0';
    int chunked = strcasestr_local(headers, "transfer-encoding: chunked") != NULL;
    free(headers);
    char *body_buf = malloc(body_len + 1);
    if (!body_buf) {
        free(raw);
        snprintf(resp->err, sizeof(resp->err), "out of memory");
        return -1;
    }
    memcpy(body_buf, body_start, body_len);
    body_buf[body_len] = '\0';
    free(raw);
    if (chunked) {
        size_t decoded = decode_chunked(body_buf, body_len);
        if (decoded == (size_t)-1) {
            free(body_buf);
            snprintf(resp->err, sizeof(resp->err),
                     "malformed chunked response");
            return -1;
        }
        body_len = decoded;
        body_buf[body_len] = '\0';
    }
    if (body_len > RESP_CAP) {
        free(body_buf);
        snprintf(resp->err, sizeof(resp->err),
                 "response body over the cap");
        return -1;
    }
    resp->body = body_buf;
    resp->body_len = body_len;
    return 0;

fail:
    if (ssl) {
        SSL_free(ssl);
        SSL_CTX_free(ctx);
    }
    close(fd);
    return -1;
}

/* ------------------------------------------------------------------ */
/* Chat Completions request (tools + messages)                         */
/* ------------------------------------------------------------------ */

/* The tools the model may call, OpenAI function-calling format.
 * READ is executed here (the backend reads the file and feeds the
 * content back); the rest become action lines for the daemon. */
static const char *TOOLS_JSON =
    "["
    "{\"type\":\"function\",\"function\":{\"name\":\"launch\","
    "\"description\":\"Launch an app by id.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"id\":{\"type\":\"string\",\"description\":\"The app id to launch.\"}},"
    "\"required\":[\"id\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"close\","
    "\"description\":\"Close a running app by id.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"id\":{\"type\":\"string\",\"description\":\"The app id to close.\"}},"
    "\"required\":[\"id\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"list\","
    "\"description\":\"List the running apps.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"set\","
    "\"description\":\"Set a status key to a value.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"key\":{\"type\":\"string\"},\"value\":{\"type\":\"string\"}},"
    "\"required\":[\"key\",\"value\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"read\","
    "\"description\":\"Read a device file (settings, logs, app registry). "
    "Returns the file content. Only /data/ and /var/lib/sevyn/ are "
    "readable; each read is capped at 64 KiB.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"path\":{\"type\":\"string\",\"description\":\"Absolute path to read.\"}},"
    "\"required\":[\"path\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"exec\","
    "\"description\":\"Run sevyn CLI verbs (e.g. \\\"update status\\\"). "
    "Never a shell command; only sevyn verbs.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"args\":{\"type\":\"string\",\"description\":\"The sevyn CLI arguments, e.g. \\\"update status\\\".\"}},"
    "\"required\":[\"args\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"write\","
    "\"description\":\"Replace a file's content. Only /data/ and "
    "/var/lib/sevyn/ are writable; the previous copy is kept as "
    "<path>.sevyn-bak. The existing file must be 64 KiB or smaller, "
    "and the content must fit one action line (about 1900 bytes).\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"path\":{\"type\":\"string\",\"description\":\"Absolute path to write.\"},"
    "\"content\":{\"type\":\"string\",\"description\":\"The new file content.\"}},"
    "\"required\":[\"path\",\"content\"]}}},"
    "{\"type\":\"function\",\"function\":{\"name\":\"update\","
    "\"description\":\"Check for a system update (\\\"check\\\"), or "
    "apply one (\\\"apply\\\" — the device reboots when it lands). "
    "Apply is god-mode-only; under the standard grant it is refused.\","
    "\"parameters\":{\"type\":\"object\",\"properties\":"
    "{\"action\":{\"type\":\"string\",\"description\":\"\\\"check\\\" or \\\"apply\\\" (default \\\"check\\\").\"}},"
    "\"required\":[]}}}"
    "]";

/* A list of JSON message objects (each a full {"role":...} object). */
struct msg_list {
    char **items;
    size_t len;
    size_t cap;
};

static int msg_push(struct msg_list *ml, char *json)
{
    if (ml->len >= ml->cap) {
        size_t ncap = ml->cap ? ml->cap * 2 : 8;
        char **ni = realloc(ml->items, ncap * sizeof(char *));
        if (!ni)
            return -1;
        ml->items = ni;
        ml->cap = ncap;
    }
    ml->items[ml->len++] = json;
    return 0;
}

static void msg_free_all(struct msg_list *ml)
{
    for (size_t i = 0; i < ml->len; i++)
        free(ml->items[i]);
    free(ml->items);
    ml->items = NULL;
    ml->len = ml->cap = 0;
}

/* A list of action lines to emit at the end. */
struct action_list {
    char **items;
    size_t len;
    size_t cap;
};

static int act_push(struct action_list *al, char *line)
{
    if (al->len >= MAX_ACTIONS)
        return -1;
    if (al->len >= al->cap) {
        size_t ncap = al->cap ? al->cap * 2 : 8;
        char **ni = realloc(al->items, ncap * sizeof(char *));
        if (!ni)
            return -1;
        al->items = ni;
        al->cap = ncap;
    }
    al->items[al->len++] = line;
    return 0;
}

static void act_free_all(struct action_list *al)
{
    for (size_t i = 0; i < al->len; i++)
        free(al->items[i]);
    free(al->items);
    al->items = NULL;
    al->len = al->cap = 0;
}

/* Build the Chat Completions request body from the message list. */
static char *build_request(const char *model, struct msg_list *ml)
{
    struct strbuf sb;
    if (sb_init(&sb) != 0)
        return NULL;
    sb_append(&sb, "{\"model\":\"");
    sb_append_esc(&sb, model);
    sb_append(&sb, "\",\"messages\":[");
    for (size_t i = 0; i < ml->len; i++) {
        if (i > 0)
            sb_append(&sb, ",");
        sb_append(&sb, ml->items[i]);
    }
    sb_append(&sb, "],\"tools\":");
    sb_append(&sb, TOOLS_JSON);
    sb_append(&sb, ",\"tool_choice\":\"auto\"}");
    return sb.data;
}

/* ------------------------------------------------------------------ */
/* response parsing                                                    */
/* ------------------------------------------------------------------ */

struct tool_call {
    char *id;
    char *name;
    char *args_json;
};

struct tool_calls {
    struct tool_call *items;
    size_t len;
};

static void tool_calls_free(struct tool_calls *tc)
{
    for (size_t i = 0; i < tc->len; i++) {
        free(tc->items[i].id);
        free(tc->items[i].name);
        free(tc->items[i].args_json);
    }
    free(tc->items);
    tc->items = NULL;
    tc->len = 0;
}

/* Extract choices[0].message.tool_calls from an API response body.
 * Returns 0 on success (tc->len may be 0 when the model made no
 * tool calls), -1 when the response is malformed — fail-closed. */
static int parse_tool_calls(const char *body, struct tool_calls *tc)
{
    memset(tc, 0, sizeof(*tc));
    char err[256];
    jval_t *root = json_parse(body, err, sizeof(err));
    if (!root)
        return -1;
    const jval_t *choices = json_obj_get(root, "choices");
    if (!choices || choices->type != J_ARR || json_arr_len(choices) < 1) {
        json_free(root);
        return -1;
    }
    const jval_t *msg =
        json_obj_get(json_arr_get(choices, 0), "message");
    if (!msg || msg->type != J_OBJ) {
        json_free(root);
        return -1;
    }
    const jval_t *calls = json_obj_get(msg, "tool_calls");
    if (!calls || calls->type != J_ARR) {
        /* No tool calls: the model answered in text (or with
         * nothing). Not an error — the task is done. */
        json_free(root);
        return 0;
    }
    size_t n = json_arr_len(calls);
    tc->items = calloc(n ? n : 1, sizeof(struct tool_call));
    if (!tc->items) {
        json_free(root);
        return -1;
    }
    for (size_t i = 0; i < n; i++) {
        const jval_t *c = json_arr_get(calls, i);
        const jval_t *fn = json_obj_get(c, "function");
        const char *id = json_str(json_obj_get(c, "id"));
        const char *name = fn ? json_str(json_obj_get(fn, "name")) : NULL;
        const char *args = fn ? json_str(json_obj_get(fn, "arguments")) : NULL;
        if (!id || !name || !args)
            continue;
        tc->items[tc->len].id = strdup(id);
        tc->items[tc->len].name = strdup(name);
        tc->items[tc->len].args_json = strdup(args);
        if (!tc->items[tc->len].id || !tc->items[tc->len].name ||
            !tc->items[tc->len].args_json) {
            tool_calls_free(tc);
            json_free(root);
            return -1;
        }
        tc->len++;
    }
    json_free(root);
    return 0;
}

/* Extract choices[0].message.content from an API response body.
 * Returns a strdup'd string, or NULL when absent, null, or not a
 * string. The caller frees it. A round with no tool calls is the
 * model's final answer: this is the TEXT the daemon carries back
 * (phase 3, B1) instead of freeing the body with it. */
static char *parse_message_content(const char *body)
{
    char err[256];
    jval_t *root = json_parse(body, err, sizeof(err));
    if (!root)
        return NULL;
    const jval_t *choices = json_obj_get(root, "choices");
    if (!choices || choices->type != J_ARR || json_arr_len(choices) < 1) {
        json_free(root);
        return NULL;
    }
    const jval_t *msg =
        json_obj_get(json_arr_get(choices, 0), "message");
    if (!msg || msg->type != J_OBJ) {
        json_free(root);
        return NULL;
    }
    const char *content = json_str(json_obj_get(msg, "content"));
    char *out = content ? strdup(content) : NULL;
    json_free(root);
    return out;
}

/* Get one string field from a tool-call arguments JSON object.
 * Returns malloc'd value or NULL. */
static char *args_field(const char *args_json, const char *key)
{
    char err[256];
    jval_t *root = json_parse(args_json, err, sizeof(err));
    if (!root)
        return NULL;
    const char *v = json_str(json_obj_get(root, key));
    char *out = v ? strdup(v) : NULL;
    json_free(root);
    return out;
}

/* Rebuild the assistant message (with its tool calls) for the
 * conversation, so the model sees its own calls before the tool
 * results. */
static char *assistant_msg_json(struct tool_calls *tc)
{
    struct strbuf sb;
    if (sb_init(&sb) != 0)
        return NULL;
    sb_append(&sb, "{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[");
    for (size_t i = 0; i < tc->len; i++) {
        if (i > 0)
            sb_append(&sb, ",");
        sb_append(&sb, "{\"id\":\"");
        sb_append_esc(&sb, tc->items[i].id);
        sb_append(&sb, "\",\"type\":\"function\",\"function\":{\"name\":\"");
        sb_append_esc(&sb, tc->items[i].name);
        sb_append(&sb, "\",\"arguments\":\"");
        sb_append_esc(&sb, tc->items[i].args_json);
        sb_append(&sb, "\"}}");
    }
    sb_append(&sb, "]}");
    return sb.data;
}

/* Build a tool-result message for the conversation. */
static char *tool_msg_json(const char *call_id, const char *content)
{
    struct strbuf sb;
    if (sb_init(&sb) != 0)
        return NULL;
    sb_append(&sb, "{\"role\":\"tool\",\"tool_call_id\":\"");
    sb_append_esc(&sb, call_id);
    sb_append(&sb, "\",\"content\":\"");
    sb_append_esc(&sb, content);
    sb_append(&sb, "\"}");
    return sb.data;
}

/* Build a plain history message for the conversation (phase 3, B1):
 * a stored turn, user or assistant, with its prose. Unlike
 * assistant_msg_json() (tool calls, content null), history turns
 * carry their text — the model sees what was actually said. */
static char *history_msg_json(const char *role, const char *content)
{
    struct strbuf sb;
    if (sb_init(&sb) != 0)
        return NULL;
    sb_append(&sb, "{\"role\":\"");
    sb_append_esc(&sb, role);
    sb_append(&sb, "\",\"content\":\"");
    sb_append_esc(&sb, content);
    sb_append(&sb, "\"}");
    return sb.data;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/* Emit the action lines, then the final TEXT line (the model's prose
 * answer, phase 3, B1) when there is one, then END. Always called —
 * even on a fail-closed path (with zero actions), so the daemon
 * never waits on a backend that has already decided. TEXT is not an
 * action: it is never grant-checked and never counts against
 * MAX_ACTIONS. The order is the same in ASK and session mode. */
static void emit_actions(struct action_list *al, const char *final_text)
{
    for (size_t i = 0; i < al->len; i++)
        printf("%s\n", al->items[i]);
    if (final_text && final_text[0] != '\0')
        printf("TEXT %s\n", final_text);
    printf("END\n");
    fflush(stdout);
}

int main(void)
{
    /* The task: one line on stdin — or, in session mode (P1,
     * §1.4.1), a "SESSION" marker line first, then the task line.
     * Both reads use the unbuffered reader: the daemon writes
     * RESULT lines to the same stdin later, and buffered stdio
     * would swallow them. A first line that is not "SESSION" is
     * the task itself (ASK mode, backward compatible). */
    int session_mode = 0;
    char *first = read_line_timeout(30);
    if (!first || first[0] == '\0') {
        printf("ERR empty task\nEND\n");
        free(first);
        return 0;
    }
    char *task = first;
    /* Conversation history (phase 3, B1): after the SESSION marker
     * the daemon may send HISTORY lines — one per stored turn —
     * before the task line. The first line that is not a well-formed
     * HISTORY line is the task. A daemon that sends no history
     * (ASK, and sessions) behaves exactly as before. A HISTORY line
     * is well-formed only when its role is exactly "user" or
     * "assistant" and its text is non-empty — so a task that merely
     * starts with the word HISTORY is still read as the task. */
    struct msg_list history;
    memset(&history, 0, sizeof(history));
    size_t history_bytes = 0;
    if (strcmp(first, "SESSION") == 0) {
        session_mode = 1;
        free(first);
        task = NULL;
        for (;;) {
            char *line = read_line_timeout(30);
            if (!line || line[0] == '\0') {
                free(line);
                break;
            }
            if (strncmp(line, "HISTORY ", 8) == 0) {
                char *rest = line + 8;
                char *sp = strchr(rest, ' ');
                const char *role = NULL;
                if (sp) {
                    size_t role_len = (size_t)(sp - rest);
                    if (role_len == 4 && strncmp(rest, "user", 4) == 0)
                        role = "user";
                    else if (role_len == 9 &&
                             strncmp(rest, "assistant", 9) == 0)
                        role = "assistant";
                }
                if (role && sp[1] != '\0') {
                    char *text = unescape_write_content(sp + 1);
                    if (text) {
                        char *h = history_msg_json(role, text);
                        free(text);
                        if (h) {
                            /* Caps: at most HISTORY_MAX_TURNS turns
                             * and HISTORY_CAP bytes total, oldest
                             * first. A single turn always fits
                             * (the daemon's payload is TASK_CAP). */
                            while ((history.len >= HISTORY_MAX_TURNS ||
                                    history_bytes + strlen(h) >
                                        HISTORY_CAP) &&
                                   history.len > 0) {
                                history_bytes -=
                                    strlen(history.items[0]);
                                free(history.items[0]);
                                memmove(&history.items[0],
                                        &history.items[1],
                                        (history.len - 1) *
                                            sizeof(char *));
                                history.len--;
                            }
                            if (history.len < HISTORY_MAX_TURNS &&
                                history_bytes + strlen(h) <=
                                    HISTORY_CAP &&
                                msg_push(&history, h) == 0) {
                                history_bytes += strlen(h);
                            } else {
                                free(h);
                            }
                        }
                    }
                    free(line);
                    continue;
                }
            }
            /* Not a history line: this is the task. */
            task = line;
            break;
        }
        if (!task || task[0] == '\0') {
            printf("ERR empty task\nEND\n");
            free(task);
            msg_free_all(&history);
            return 0;
        }
    }
    struct action_list actions;
    memset(&actions, 0, sizeof(actions));
    /* The model's final prose answer (phase 3, B1): set when a round
     * makes no tool calls, emitted at done: after the actions. */
    char *final_text = NULL;

    /* Auth first: no key, no API call, no actions. */
    char *key = read_key();
    if (!key) {
        printf("ERR no Muse API key configured\n");
        emit_actions(&actions, NULL);
        free(task);
        msg_free_all(&history);
        return 0;
    }

    const char *api_base = env_or("MUSE_API_BASE", DEFAULT_API_BASE);
    const char *model = env_or("MUSE_MODEL", DEFAULT_MODEL);
    struct strbuf url;
    if (sb_init(&url) != 0) {
        printf("ERR out of memory\n");
        emit_actions(&actions, NULL);
        free(key);
        free(task);
        msg_free_all(&history);
        return 0;
    }
    sb_append(&url, api_base);
    /* The base URL must not end with a slash. */
    size_t ulen = strlen(url.data);
    while (ulen > 0 && url.data[ulen - 1] == '/')
        url.data[--ulen] = '\0';
    url.len = ulen;
    sb_append(&url, "/chat/completions");

    /* Context (§1.6): the grant + a bounded device snapshot. */
    char *grant = grant_csv();
    char *snapshot = build_snapshot();
    struct msg_list msgs;
    memset(&msgs, 0, sizeof(msgs));

    struct strbuf sys;
    if (sb_init(&sys) != 0) {
        printf("ERR out of memory\n");
        goto done;
    }
    sb_append(&sys,
              "{\"role\":\"system\",\"content\":\""
              "You are the on-device assistant for SevynOS, running "
              "inside the muse-ai backend. The user gives you a task; "
              "you carry it out by calling the provided tools. Rules: "
              "1. Only act through the tools — never invent an action, "
              "a file, or an app id. "
              "2. Use read to inspect device state before acting when "
              "you need facts (settings, logs, the app registry). "
              "3. exec runs sevyn CLI verbs only (e.g. \\\"update "
              "status\\\"), never a shell command. "
              "4. The daemon checks every action against the device "
              "grant before running it. The grant allows: ");
    sb_append_esc(&sys, grant);
    sb_append(&sys,
              ". Prefer actions the grant allows; an action outside "
              "the grant is refused. "
              "5. If you cannot do the task with the tools, call no "
              "tools — do nothing. "
              "6. Keep actions minimal: only what the task asks for. "
              "7. write replaces a whole file: read it first, then "
              "write the full corrected content. Only /data/ and "
              "/var/lib/sevyn/ are writable, the existing file must "
              "be 64 KiB or smaller, and the content must fit one "
              "action line (about 1900 bytes) — for a longer fix, "
              "write the file in pieces or say so. The previous copy "
              "is kept as <path>.sevyn-bak. "
              "8. update check asks whether a system update is "
              "available; update apply installs it and the device "
              "reboots. Apply is god-mode-only and is refused under "
              "the standard grant — do not retry a refused apply.\"}");
    if (msg_push(&msgs, sys.data) != 0) {
        sb_free(&sys);
        printf("ERR out of memory\n");
        goto done;
    }
    if (session_mode) {
        /* Session mode (P1, §1.4.1): the daemon reports each
         * action's result, so the model can re-plan — read, fix,
         * re-check. This message is only added when the session
         * marker was actually seen, and it follows the main system
         * message. */
        struct strbuf sess;
        if (sb_init(&sess) == 0) {
            sb_append(&sess,
                      "{\"role\":\"system\",\"content\":\""
                      "You are in a session: after each tool call the "
                      "daemon reports what happened (OK, DENIED, or "
                      "FAILED with a reason). Use the result to "
                      "decide the next step — read a file, fix it "
                      "with write, then read it again to check the "
                      "fix. End the session by calling no tools.\"}");
            if (msg_push(&msgs, sess.data) != 0)
                sb_free(&sess);
        }
    }

    /* Conversation history (phase 3, B1): the stored turns, oldest
     * first, between the system messages and the new task — so the
     * model sees what was already said. Ownership of each message
     * moves to msgs; the list itself is freed below. */
    for (size_t i = 0; i < history.len; i++) {
        char *h = history.items[i];
        history.items[i] = NULL;
        if (msg_push(&msgs, h) != 0) {
            free(h);
            printf("ERR out of memory\n");
            goto done;
        }
    }
    msg_free_all(&history);

    struct strbuf user;
    if (sb_init(&user) != 0) {
        printf("ERR out of memory\n");
        goto done;
    }
    sb_append(&user, "{\"role\":\"user\",\"content\":\"Task: ");
    sb_append_esc(&user, task);
    sb_append(&user, "\\n\\nDevice state:\\n");
    sb_append_esc(&user, snapshot);
    sb_append(&user, "\"}");
    if (msg_push(&msgs, user.data) != 0) {
        sb_free(&user);
        printf("ERR out of memory\n");
        goto done;
    }

    /* Agent loop: plan -> act -> observe -> re-plan. READs are
     * executed here and fed back. In ASK mode every other tool call
     * becomes a final action and ends the loop. In session mode
     * (P1, §1.4.1) each action is emitted immediately and the
     * daemon's RESULT is fed back, so the model re-plans — read,
     * fix, re-check — until it calls no tools or the session round
     * cap is reached. */
    int max_rounds =
        session_mode ? MAX_SESSION_ROUNDS : MAX_API_ROUNDS;
    size_t emitted = 0; /* session-mode actions emitted so far */
    int session_over = 0;
    for (int round = 0; round < max_rounds && !session_over; round++) {
        char *req = build_request(model, &msgs);
        if (!req) {
            printf("ERR out of memory\n");
            break;
        }
        struct http_resp resp;
        int rc = http_post(url.data, req, key, API_TIMEOUT_S, &resp);
        free(req);
        if (rc != 0) {
            printf("ERR Muse API unreachable: %s\n", resp.err);
            break;
        }
        if (resp.status != 200) {
            printf("ERR Muse API returned HTTP %d\n", resp.status);
            free(resp.body);
            break;
        }
        struct tool_calls tc;
        if (parse_tool_calls(resp.body, &tc) != 0) {
            printf("ERR Muse API response malformed\n");
            free(resp.body);
            break;
        }
        /* The model's prose answer (phase 3, B1): extracted before
         * the body is freed. Only a no-tool round has one. */
        char *content = NULL;
        if (tc.len == 0)
            content = parse_message_content(resp.body);
        free(resp.body);
        if (tc.len == 0) {
            /* The model made no tool calls: done. Its prose answer
             * (if any) is the turn's TEXT, carried to the daemon
             * instead of freed — a blank answer carries nothing. */
            if (content && content[0] != '\0') {
                int blank = 1;
                for (const char *p = content; *p; p++) {
                    if (*p != ' ' && *p != '\t' && *p != '\n' &&
                        *p != '\r') {
                        blank = 0;
                        break;
                    }
                }
                if (!blank) {
                    char *esc = escape_write_content(content);
                    if (esc) {
                        free(final_text);
                        final_text = cap_text(esc);
                        free(esc);
                    }
                }
            }
            free(content);
            tool_calls_free(&tc);
            break;
        }
        /* The assistant's own message goes back into the
         * conversation, then the tool results follow it. */
        char *amsg = assistant_msg_json(&tc);
        if (!amsg || msg_push(&msgs, amsg) != 0) {
            free(amsg);
            printf("ERR out of memory\n");
            tool_calls_free(&tc);
            break;
        }
        int made_action = 0;
        for (size_t i = 0; i < tc.len; i++) {
            struct tool_call *c = &tc.items[i];
            if (strcmp(c->name, "read") == 0) {
                char *path = args_field(c->args_json, "path");
                if (!path) {
                    char *tm = tool_msg_json(
                        c->id, "ERR: read needs a path");
                    if (tm && msg_push(&msgs, tm) != 0)
                        free(tm);
                    continue;
                }
                char rerr[256];
                char *content = backend_read(path, rerr, sizeof(rerr));
                if (content) {
                    /* Audit trail: the fetch is a READ action line
                     * for the daemon to log. In session mode it is
                     * emitted now and the daemon's verdict is read
                     * back before the tool result is built, so a
                     * denied/failed read reaches the model. */
                    char *result = NULL;
                    if (session_mode) {
                        printf("READ %s\n", path);
                        fflush(stdout);
                        emitted++;
                        result = read_line_timeout(
                            SESSION_RESULT_TIMEOUT_S);
                        if (!result) {
                            free(content);
                            free(path);
                            session_over = 1;
                            break;
                        }
                    } else {
                        struct strbuf line;
                        if (sb_init(&line) == 0) {
                            sb_append(&line, "READ ");
                            sb_append(&line, path);
                            if (act_push(&actions, line.data) != 0)
                                sb_free(&line);
                        }
                    }
                    struct strbuf cm;
                    if (sb_init(&cm) == 0) {
                        sb_append(&cm, content);
                        if (result &&
                            strncmp(result, "RESULT OK", 9) != 0) {
                            sb_append(&cm, "\nDaemon: ");
                            sb_append(&cm, result);
                        }
                        char *tm = tool_msg_json(c->id, cm.data);
                        if (tm && msg_push(&msgs, tm) != 0)
                            free(tm);
                        sb_free(&cm);
                    }
                    free(result);
                    free(content);
                    if (session_mode && emitted >= MAX_ACTIONS) {
                        free(path);
                        printf("ERR action cap reached\n");
                        session_over = 1;
                        break;
                    }
                } else {
                    struct strbuf em;
                    if (sb_init(&em) == 0) {
                        sb_append(&em, "ERR: ");
                        sb_append(&em, rerr);
                        char *tm = tool_msg_json(c->id, em.data);
                        if (tm && msg_push(&msgs, tm) != 0)
                            free(tm);
                        sb_free(&em);
                    }
                }
                free(path);
                continue;
            }
            /* A non-READ tool call becomes an action line.
             * tool_err carries a specific refusal for the model
             * (a failed write precheck, a too-long content); when
             * it is NULL and no line was built, the arguments were
             * missing. */
            char *line = NULL;
            char *tool_err = NULL;
            if (strcmp(c->name, "launch") == 0) {
                char *id = args_field(c->args_json, "id");
                if (id) {
                    struct strbuf sb;
                    if (sb_init(&sb) == 0) {
                        sb_append(&sb, "LAUNCH ");
                        sb_append(&sb, id);
                        line = sb.data;
                    }
                    free(id);
                }
            } else if (strcmp(c->name, "close") == 0) {
                char *id = args_field(c->args_json, "id");
                if (id) {
                    struct strbuf sb;
                    if (sb_init(&sb) == 0) {
                        sb_append(&sb, "CLOSE ");
                        sb_append(&sb, id);
                        line = sb.data;
                    }
                    free(id);
                }
            } else if (strcmp(c->name, "list") == 0) {
                line = strdup("LIST");
            } else if (strcmp(c->name, "set") == 0) {
                char *k = args_field(c->args_json, "key");
                char *v = args_field(c->args_json, "value");
                if (k && v) {
                    struct strbuf sb;
                    if (sb_init(&sb) == 0) {
                        sb_append(&sb, "SET ");
                        sb_append(&sb, k);
                        sb_append(&sb, " ");
                        sb_append(&sb, v);
                        line = sb.data;
                    }
                }
                free(k);
                free(v);
            } else if (strcmp(c->name, "exec") == 0) {
                char *args = args_field(c->args_json, "args");
                if (args && args[0] != '\0') {
                    struct strbuf sb;
                    if (sb_init(&sb) == 0) {
                        sb_append(&sb, "EXEC ");
                        sb_append(&sb, args);
                        line = sb.data;
                    }
                }
                free(args);
            } else if (strcmp(c->name, "write") == 0) {
                /* P1: replace a file's content. The precheck
                 * mirrors the daemon's bounds (§1.4.3); the content
                 * is escaped onto one action line, and a content
                 * that does not fit the line is refused here, not
                 * truncated. */
                char *p = args_field(c->args_json, "path");
                char *ct = args_field(c->args_json, "content");
                if (!p || !ct) {
                    tool_err =
                        strdup("ERR: write needs a path and content");
                } else {
                    char werr[256];
                    if (!write_precheck(p, werr, sizeof(werr))) {
                        struct strbuf em;
                        if (sb_init(&em) == 0) {
                            sb_append(&em, "ERR: ");
                            sb_append(&em, werr);
                            tool_err = em.data;
                        }
                    } else {
                        char *esc = escape_write_content(ct);
                        if (!esc) {
                            tool_err = strdup("ERR: out of memory");
                        } else {
                            size_t need = strlen("WRITE ") +
                                          strlen(p) + 1 +
                                          strlen(esc) + 1;
                            if (need > ACTION_LINE_CAP) {
                                tool_err = strdup(
                                    "ERR: write content too long for "
                                    "one action line (about 1900 "
                                    "bytes max)");
                            } else {
                                struct strbuf sb;
                                if (sb_init(&sb) == 0) {
                                    sb_append(&sb, "WRITE ");
                                    sb_append(&sb, p);
                                    sb_append(&sb, " ");
                                    sb_append(&sb, esc);
                                    line = sb.data;
                                }
                            }
                            free(esc);
                        }
                    }
                }
                free(p);
                free(ct);
            } else if (strcmp(c->name, "update") == 0) {
                /* P1: check for, or apply, a system update. */
                char *act = args_field(c->args_json, "action");
                if (!act || strcmp(act, "check") == 0) {
                    line = strdup("UPDATE");
                } else if (strcmp(act, "apply") == 0) {
                    line = strdup("UPDATE apply");
                } else {
                    tool_err = strdup(
                        "ERR: update action must be \"check\" or "
                        "\"apply\"");
                }
                free(act);
            } else {
                /* Unknown tool: tell the model so it can correct
                 * itself, and record nothing. */
                struct strbuf em;
                if (sb_init(&em) == 0) {
                    sb_append(&em, "ERR: unknown tool ");
                    sb_append(&em, c->name);
                    char *tm = tool_msg_json(c->id, em.data);
                    if (tm && msg_push(&msgs, tm) != 0)
                        free(tm);
                    sb_free(&em);
                }
                continue;
            }
            if (!line) {
                /* No action line: tell the model why (a specific
                 * refusal, or missing arguments), record nothing. */
                struct strbuf em;
                if (sb_init(&em) == 0) {
                    if (tool_err) {
                        sb_append(&em, tool_err);
                    } else {
                        sb_append(&em, "ERR: tool ");
                        sb_append(&em, c->name);
                        sb_append(&em, " is missing its arguments");
                    }
                    char *tm = tool_msg_json(c->id, em.data);
                    if (tm && msg_push(&msgs, tm) != 0)
                        free(tm);
                    sb_free(&em);
                }
                free(tool_err);
                continue;
            }
            free(tool_err);
            if (session_mode) {
                /* Emit now, read the RESULT, feed it back — the
                 * model re-plans on the outcome instead of ending
                 * the session. */
                printf("%s\n", line);
                fflush(stdout);
                emitted++;
                free(line);
                char *result =
                    read_line_timeout(SESSION_RESULT_TIMEOUT_S);
                if (!result) {
                    /* The daemon is gone (or the per-action budget
                     * expired): end the session. */
                    session_over = 1;
                    break;
                }
                struct strbuf rm;
                if (sb_init(&rm) == 0) {
                    sb_append(&rm, "Daemon: ");
                    sb_append(&rm, result);
                    char *tm = tool_msg_json(c->id, rm.data);
                    if (tm && msg_push(&msgs, tm) != 0)
                        free(tm);
                    sb_free(&rm);
                }
                free(result);
                if (emitted >= MAX_ACTIONS) {
                    printf("ERR action cap reached\n");
                    session_over = 1;
                    break;
                }
                continue;
            }
            if (act_push(&actions, line) != 0) {
                free(line);
                printf("ERR action cap reached\n");
                made_action = 1;
                break;
            }
            made_action = 1;
        }
        tool_calls_free(&tc);
        if (made_action)
            break;
        /* Only READs this round: loop again with the observations. */
        if (actions.len >= MAX_ACTIONS)
            break;
    }

done:
    emit_actions(&actions, final_text);
    act_free_all(&actions);
    msg_free_all(&msgs);
    msg_free_all(&history);
    sb_free(&url);
    free(grant);
    free(snapshot);
    free(key);
    free(task);
    free(final_text);
    return 0;
}
