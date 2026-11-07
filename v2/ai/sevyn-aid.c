/* SevynOS v2 M4.5 — the AI daemon (sevyn-aid).
 *
 * The AI connector, baked into the OS. ANY AI plugs in via this
 * daemon and drives the whole system — no single-AI lock-in
 * (openness lock). The AI acts through the system's permission
 * model, never around it: every action a backend proposes is checked
 * against the AI permission grant before it runs, and anything
 * outside the grant is refused and logged, never executed.
 *
 * Backends are plain executables in the backends directory, one per
 * AI. A backend speaks a tiny line protocol on stdin/stdout: it
 * reads one task line, prints action lines, ends with END. The
 * daemon spawns the selected backend per ASK, so swapping the AI is
 * a SELECT — no code change, no rebuild, no reboot. Two stub
 * backends ship in the image (echo-ai, plan-ai); they are simple
 * local scripts for the proof — the point is the swap works through
 * the same connector, not shipping a real model.
 *
 * Socket protocol (/run/sevyn-ai.sock, one line in, one line out):
 *   PING              -> OK pong
 *   LIST              -> OK selected=<id> backends=<csv>
 *   SELECT <id>       -> OK selected <id> / ERR unknown backend <id>
 *   STATUS            -> OK selected=<id> backends=<csv> grant=<csv>
 *   ASK <task...>     -> OK backend=<id> allowed=<n> denied=<m>
 *                        failed=<k>
 * The harness control serial (/dev/ttyS4) takes the same verbs; its
 * replies go to the console as AID log lines (like appd's ttyS2).
 *
 * Backend action lines (one per line, then END):
 *   LAUNCH <id>       app.launch   -> appd LAUNCH
 *   CLOSE <id>        app.close    -> appd CLOSE
 *   LIST              app.list     -> appd LIST (count logged)
 *   SET <key> <value> status.set   -> statusd SET
 *   UNINSTALL <id>    app.uninstall (NOT in the grant — refused)
 *   INSTALL <path>    app.install   (NOT in the grant — refused)
 *   REBOOT            system.reboot (NOT in the grant — refused)
 * Unknown verbs are refused as unknown.
 *
 * Grant (/usr/share/sevyn/ai/grant.json):
 *   {"permissions": ["app.launch", "app.close", "app.list",
 *                    "status.set"]}
 * A missing or unparseable grant is fatal: the daemon refuses to
 * start rather than run an AI with an unknown grant (fail-closed).
 *
 * Selection is persisted to /data/ai-selected.json (falling back to
 * /run/ai-selected.json when there is no data disk) so the user's
 * choice survives a reboot. Settings changes it through
 * `sevyn ai select` (same CLI the Terminal uses).
 *
 * Env overrides (host tests): SEVYN_AI_SOCK, SEVYN_AI_CTL,
 * SEVYN_AI_BACKENDS_DIR, SEVYN_AI_GRANT, SEVYN_AI_SELECTED,
 * SEVYN_AI_APPD_SOCK, SEVYN_AI_STATUS_SOCK.
 *
 * Build: gcc, libc only (+ the M3 JSON parser for the grant).
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "json.h"

#define DEFAULT_SOCK "/run/sevyn-ai.sock"
#define DEFAULT_CTL "/dev/ttyS4"
#define DEFAULT_BACKENDS_DIR "/usr/share/sevyn/ai/backends"
#define DEFAULT_GRANT "/usr/share/sevyn/ai/grant.json"
#define DEFAULT_SELECTED "/data/ai-selected.json"
#define FALLBACK_SELECTED "/run/ai-selected.json"
#define DEFAULT_APPD_SOCK "/run/sevyn-apps.sock"
#define DEFAULT_STATUS_SOCK "/run/sevyn-status.sock"

#define LINE_CAP 2048
#define MAX_CLIENTS 16
#define MAX_BACKENDS 32
#define MAX_ACTIONS 32
#define BACKEND_TIMEOUT_S 5

static const char *g_sock_path;
static const char *g_ctl_path;
static const char *g_backends_dir;
static const char *g_grant_path;
static const char *g_selected_path;
static const char *g_appd_sock;
static const char *g_status_sock;
static int g_console_fd = -1;
static volatile sig_atomic_t g_stop = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

static const char *env_or(const char *name, const char *dflt)
{
    const char *v = getenv(name);
    return (v && *v) ? v : dflt;
}

/* Retrying console writer (same pattern as statusd / appd). */
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

/* Atomic write: tmp file in the same directory + rename. */
static int write_file_atomic(const char *path, const char *data)
{
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f)
        return -1;
    size_t len = strlen(data);
    if (fwrite(data, 1, len, f) != len) {
        fclose(f);
        unlink(tmp);
        return -1;
    }
    if (fclose(f) != 0) {
        unlink(tmp);
        return -1;
    }
    if (rename(tmp, path) != 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* grant                                                               */
/* ------------------------------------------------------------------ */

/* The AI permission grant: the action permissions the connector
 * allows. Anything not listed here is refused, never executed. */
static char **g_grant = NULL;
static size_t g_ngrant = 0;

static int grant_has(const char *perm)
{
    for (size_t i = 0; i < g_ngrant; i++)
        if (strcmp(g_grant[i], perm) == 0)
            return 1;
    return 0;
}

/* Load the grant JSON: {"permissions": [...]}. Fatal on any failure
 * (missing file, bad JSON, wrong shape) — fail closed. */
static int load_grant(void)
{
    char *text = read_file_cap(g_grant_path, 65536);
    if (!text) {
        log_line("AID fatal: cannot read grant %s: %s", g_grant_path,
                 strerror(errno));
        return -1;
    }
    char err[256];
    jval_t *root = json_parse(text, err, sizeof(err));
    if (!root) {
        log_line("AID fatal: grant %s is not valid JSON: %s",
                 g_grant_path, err);
        free(text);
        return -1;
    }
    const jval_t *perms = json_obj_get(root, "permissions");
    if (!perms || perms->type != J_ARR) {
        log_line("AID fatal: grant %s has no permissions array",
                 g_grant_path);
        json_free(root);
        free(text);
        return -1;
    }
    size_t n = json_arr_len(perms);
    g_grant = calloc(n ? n : 1, sizeof(char *));
    if (!g_grant) {
        json_free(root);
        free(text);
        return -1;
    }
    for (size_t i = 0; i < n; i++) {
        const char *s = json_str(json_arr_get(perms, i));
        if (!s) {
            log_line("AID fatal: grant %s has a non-string permission",
                     g_grant_path);
            json_free(root);
            free(text);
            return -1;
        }
        g_grant[g_ngrant++] = strdup(s);
    }
    json_free(root);
    free(text);
    log_line("AID grant loaded (%zu permissions)", g_ngrant);
    return 0;
}

static void grant_csv(char *out, size_t cap)
{
    size_t n = 0;
    out[0] = '\0';
    for (size_t i = 0; i < g_ngrant; i++) {
        int w = snprintf(out + n, cap - n, "%s%s", i ? "," : "",
                         g_grant[i]);
        if (w < 0 || (size_t)w >= cap - n)
            break;
        n += (size_t)w;
    }
}

/* ------------------------------------------------------------------ */
/* backends                                                            */
/* ------------------------------------------------------------------ */

static char g_backends[MAX_BACKENDS][128];
static size_t g_nbackends = 0;

static int cmp_str(const void *a, const void *b)
{
    return strcmp((const char *)a, (const char *)b);
}

/* Scan the backends directory: every executable regular file is a
 * backend; its id is its filename. Sorted, so LIST order is stable. */
static void scan_backends(void)
{
    g_nbackends = 0;
    DIR *d = opendir(g_backends_dir);
    if (!d) {
        log_line("AID backends dir %s unreadable: %s", g_backends_dir,
                 strerror(errno));
        return;
    }
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (de->d_name[0] == '.')
            continue;
        if (g_nbackends >= MAX_BACKENDS)
            break;
        char full[4096];
        snprintf(full, sizeof(full), "%s/%s", g_backends_dir,
                 de->d_name);
        struct stat st;
        if (stat(full, &st) != 0 || !S_ISREG(st.st_mode))
            continue;
        if (access(full, X_OK) != 0)
            continue;
        snprintf(g_backends[g_nbackends], sizeof(g_backends[0]), "%s",
                 de->d_name);
        g_nbackends++;
    }
    closedir(d);
    qsort(g_backends, g_nbackends, sizeof(g_backends[0]), cmp_str);
}

static int backend_index(const char *id)
{
    for (size_t i = 0; i < g_nbackends; i++)
        if (strcmp(g_backends[i], id) == 0)
            return (int)i;
    return -1;
}

static void backends_csv(char *out, size_t cap)
{
    size_t n = 0;
    out[0] = '\0';
    for (size_t i = 0; i < g_nbackends; i++) {
        int w = snprintf(out + n, cap - n, "%s%s", i ? "," : "",
                         g_backends[i]);
        if (w < 0 || (size_t)w >= cap - n)
            break;
        n += (size_t)w;
    }
}

/* ------------------------------------------------------------------ */
/* selection (persisted)                                               */
/* ------------------------------------------------------------------ */

static char g_selected[128] = "echo-ai";

static void load_selection(void)
{
    /* Primary first, then the tmpfs fallback (a daemon restart in a
     * boot without a data disk still finds the choice). */
    char *text = read_file_cap(g_selected_path, 256);
    if (!text && strcmp(g_selected_path, FALLBACK_SELECTED) != 0)
        text = read_file_cap(FALLBACK_SELECTED, 256);
    if (!text) {
        /* No persisted selection yet: default stands. */
        return;
    }
    /* Trim trailing whitespace/newlines. */
    size_t n = strlen(text);
    while (n > 0 && (text[n - 1] == '\n' || text[n - 1] == '\r' ||
                     text[n - 1] == ' ' || text[n - 1] == '\t'))
        text[--n] = '\0';
    if (n > 0 && n < sizeof(g_selected))
        snprintf(g_selected, sizeof(g_selected), "%s", text);
    free(text);
}

static int save_selection(void)
{
    char data[256];
    snprintf(data, sizeof(data), "%s\n", g_selected);
    if (write_file_atomic(g_selected_path, data) == 0)
        return 0;
    /* The data disk may be absent (no /data mount): fall back to the
     * tmpfs path so the choice still holds for this boot. */
    if (strcmp(g_selected_path, FALLBACK_SELECTED) != 0) {
        g_selected_path = FALLBACK_SELECTED;
        return write_file_atomic(g_selected_path, data);
    }
    return -1;
}

/* ------------------------------------------------------------------ */
/* downstream clients: appd + statusd                                  */
/* ------------------------------------------------------------------ */

/* Connect to a Unix socket. -1 on failure. */
static int sock_connect(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(addr.sun_path)) {
        close(fd);
        return -1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/* Send one line (with trailing newline). */
static int sock_send_line(int fd, const char *line)
{
    char buf[LINE_CAP + 2];
    size_t n = strlen(line);
    if (n + 1 >= sizeof(buf))
        return -1;
    memcpy(buf, line, n);
    buf[n++] = '\n';
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, buf + off, n - off);
        if (w <= 0)
            return -1;
        off += (size_t)w;
    }
    return 0;
}

/* Read one line (up to the newline), with a 5 s deadline. Returns
 * the length, 0 on EOF, -1 on error/timeout. */
static int sock_read_line(int fd, char *buf, size_t cap)
{
    size_t n = 0;
    while (n + 1 < cap) {
        struct pollfd pfd = { .fd = fd, .events = POLLIN };
        int pr = poll(&pfd, 1, 5000);
        if (pr <= 0)
            return -1;
        char c;
        ssize_t r = read(fd, &c, 1);
        if (r == 0)
            return n == 0 ? 0 : (int)n;
        if (r < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        if (c == '\n')
            break;
        buf[n++] = c;
    }
    buf[n] = '\0';
    return (int)n;
}

/* One appd verb: connect, send, read one reply line. Returns 0 when
 * the reply starts with "OK ", -1 otherwise (reason in err). */
static int appd_call(const char *verb_line, char *err, size_t errcap)
{
    int fd = sock_connect(g_appd_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach appd");
        return -1;
    }
    int rc = -1;
    if (sock_send_line(fd, verb_line) == 0) {
        char line[LINE_CAP];
        int n = sock_read_line(fd, line, sizeof(line));
        if (n > 0 && strncmp(line, "OK ", 3) == 0) {
            rc = 0;
        } else if (n > 0) {
            snprintf(err, errcap, "%s", line);
        } else {
            snprintf(err, errcap, "no reply from appd");
        }
    } else {
        snprintf(err, errcap, "cannot talk to appd");
    }
    close(fd);
    return rc;
}

/* appd LIST: count the APP lines (replies are APP <line> ... then
 * "OK list"). Returns the count, or -1 on failure. */
static int appd_list_count(char *err, size_t errcap)
{
    int fd = sock_connect(g_appd_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach appd");
        return -1;
    }
    int count = -1;
    if (sock_send_line(fd, "LIST") == 0) {
        count = 0;
        for (;;) {
            char line[LINE_CAP];
            int n = sock_read_line(fd, line, sizeof(line));
            if (n <= 0) {
                count = -1;
                snprintf(err, errcap, "no reply from appd");
                break;
            }
            if (strncmp(line, "OK ", 3) == 0)
                break;
            if (strncmp(line, "APP ", 4) == 0)
                count++;
        }
    } else {
        snprintf(err, errcap, "cannot talk to appd");
    }
    close(fd);
    return count;
}

/* statusd SET: fire-and-forget — statusd sends no reply, it
 * broadcasts the new value (and logs STATUSD SET, which is what the
 * harness asserts on). */
static int status_set(const char *key, const char *val, char *err,
                      size_t errcap)
{
    int fd = sock_connect(g_status_sock);
    if (fd < 0) {
        snprintf(err, errcap, "cannot reach statusd");
        return -1;
    }
    char line[LINE_CAP];
    snprintf(line, sizeof(line), "SET %s %s", key, val);
    int rc = sock_send_line(fd, line);
    if (rc != 0)
        snprintf(err, errcap, "cannot talk to statusd");
    close(fd);
    return rc;
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

/* One backend-proposed action. verb is the raw verb; perm is the
 * permission it needs (NULL = unknown verb, always refused). */
struct action {
    char verb[32];
    char arg1[128];
    char arg2[128];
    const char *perm;
};

static const char *perm_for_verb(const char *verb)
{
    if (strcmp(verb, "LAUNCH") == 0)
        return "app.launch";
    if (strcmp(verb, "CLOSE") == 0)
        return "app.close";
    if (strcmp(verb, "LIST") == 0)
        return "app.list";
    if (strcmp(verb, "SET") == 0)
        return "status.set";
    if (strcmp(verb, "UNINSTALL") == 0)
        return "app.uninstall";
    if (strcmp(verb, "INSTALL") == 0)
        return "app.install";
    if (strcmp(verb, "REBOOT") == 0)
        return "system.reboot";
    return NULL;
}

/* Parse one backend action line into an action. Returns 0 on success,
 * -1 on a line that is not an action at all (blank / garbage). */
static int parse_action(const char *line, struct action *a)
{
    memset(a, 0, sizeof(*a));
    char verb[32], arg1[128], arg2[128];
    int n = sscanf(line, "%31s %127s %127s", verb, arg1, arg2);
    if (n < 1)
        return -1;
    snprintf(a->verb, sizeof(a->verb), "%s", verb);
    if (n >= 2)
        snprintf(a->arg1, sizeof(a->arg1), "%s", arg1);
    if (n >= 3)
        snprintf(a->arg2, sizeof(a->arg2), "%s", arg2);
    a->perm = perm_for_verb(verb);
    /* A line that is not a known verb is backend chatter, not an
     * action: ignore it (a backend may print debug output). Only
     * action-shaped lines act — and only known verbs outside the
     * grant are DENIED, never executed. */
    if (!a->perm)
        return -1;
    /* Arity: LAUNCH/CLOSE/UNINSTALL/INSTALL take one arg; SET takes
     * two; LIST/REBOOT take none. A malformed action is not an
     * action. */
    if ((strcmp(verb, "LAUNCH") == 0 || strcmp(verb, "CLOSE") == 0 ||
         strcmp(verb, "UNINSTALL") == 0 ||
         strcmp(verb, "INSTALL") == 0) &&
        n != 2)
        return -1;
    if (strcmp(verb, "SET") == 0 && n != 3)
        return -1;
    if ((strcmp(verb, "LIST") == 0 || strcmp(verb, "REBOOT") == 0) &&
        n != 1)
        return -1;
    return 0;
}

/* Execute one granted action. Returns 0 on success, -1 with reason
 * in err. UNINSTALL/INSTALL/REBOOT have no executor here: the shipped
 * grant never includes them, and the daemon must not invent one. */
static int execute_action(const struct action *a, char *err,
                          size_t errcap)
{
    char verb_line[LINE_CAP];
    if (strcmp(a->verb, "LAUNCH") == 0) {
        snprintf(verb_line, sizeof(verb_line), "LAUNCH %s", a->arg1);
        return appd_call(verb_line, err, errcap);
    }
    if (strcmp(a->verb, "CLOSE") == 0) {
        snprintf(verb_line, sizeof(verb_line), "CLOSE %s", a->arg1);
        return appd_call(verb_line, err, errcap);
    }
    if (strcmp(a->verb, "LIST") == 0) {
        int count = appd_list_count(err, errcap);
        if (count < 0)
            return -1;
        snprintf(err, errcap, "%d apps", count);
        return 0;
    }
    if (strcmp(a->verb, "SET") == 0)
        return status_set(a->arg1, a->arg2, err, errcap);
    snprintf(err, errcap, "no executor for %s", a->verb);
    return -1;
}

/* ------------------------------------------------------------------ */
/* backends: spawn + run                                               */
/* ------------------------------------------------------------------ */

/* Run one backend on a task: write the task line to its stdin, read
 * action lines from its stdout until END / EOF / timeout. Returns 0
 * with the parsed actions, -1 with reason in err. */
static int run_backend(const char *backend_path, const char *task,
                       struct action *actions, size_t *n_actions,
                       char *err, size_t errcap)
{
    int in_pipe[2], out_pipe[2];
    if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0) {
        snprintf(err, errcap, "cannot create pipes");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(in_pipe[0]);
        close(in_pipe[1]);
        close(out_pipe[0]);
        close(out_pipe[1]);
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        /* Child: async-signal-safe calls only, then exec. */
        close(in_pipe[1]);
        close(out_pipe[0]);
        dup2(in_pipe[0], STDIN_FILENO);
        dup2(out_pipe[1], STDOUT_FILENO);
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0)
            dup2(nullfd, STDERR_FILENO);
        execl(backend_path, backend_path, (char *)NULL);
        _exit(127);
    }
    close(in_pipe[0]);
    close(out_pipe[1]);

    /* Feed the task, then close stdin (the backend reads one line). */
    char task_line[LINE_CAP];
    snprintf(task_line, sizeof(task_line), "%s\n", task);
    size_t off = 0, total = strlen(task_line);
    while (off < total) {
        ssize_t w = write(in_pipe[1], task_line + off, total - off);
        if (w <= 0)
            break;
        off += (size_t)w;
    }
    close(in_pipe[1]);

    *n_actions = 0;
    int rc = 0;
    char line[LINE_CAP];
    size_t llen = 0;
    int saw_end = 0;
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += BACKEND_TIMEOUT_S;
    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long remain_ms =
            (deadline.tv_sec - now.tv_sec) * 1000 +
            (deadline.tv_nsec - now.tv_nsec) / 1000000;
        if (remain_ms <= 0) {
            kill(pid, SIGKILL);
            snprintf(err, errcap, "backend timed out");
            rc = -1;
            break;
        }
        struct pollfd pfd = { .fd = out_pipe[0], .events = POLLIN };
        int pr = poll(&pfd, 1, (int)remain_ms);
        if (pr < 0) {
            if (errno == EINTR)
                continue;
            snprintf(err, errcap, "poll failed: %s", strerror(errno));
            rc = -1;
            break;
        }
        if (pr == 0) {
            kill(pid, SIGKILL);
            snprintf(err, errcap, "backend timed out");
            rc = -1;
            break;
        }
        char c;
        ssize_t r = read(out_pipe[0], &c, 1);
        if (r == 0)
            break; /* EOF */
        if (r < 0) {
            if (errno == EINTR)
                continue;
            snprintf(err, errcap, "read failed: %s", strerror(errno));
            rc = -1;
            break;
        }
        if (c == '\n') {
            line[llen] = '\0';
            llen = 0;
            if (strcmp(line, "END") == 0) {
                saw_end = 1;
                break;
            }
            if (line[0] == '\0')
                continue;
            if (*n_actions >= MAX_ACTIONS) {
                snprintf(err, errcap, "backend proposed too many actions");
                rc = -1;
                break;
            }
            struct action a;
            if (parse_action(line, &a) == 0)
                actions[(*n_actions)++] = a;
            /* Unparseable lines are ignored, not fatal: a backend
             * may print chatter; only action-shaped lines act. */
        } else if (llen + 1 < sizeof(line)) {
            line[llen++] = c;
        }
    }
    close(out_pipe[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    if (rc == 0 && !saw_end) {
        /* EOF without END: accept the actions read so far (the
         * backend may just exit); log it so a sloppy backend is
         * visible in the log. */
        log_line("AID backend ended without END (%zu actions kept)",
                 *n_actions);
    }
    return rc;
}

/* ------------------------------------------------------------------ */
/* command handling                                                    */
/* ------------------------------------------------------------------ */

/* Run one verb. `reply` is called with the reply line for socket
 * clients (NULL for control-serial callers, whose replies go to the
 * console instead). Mirrors appd's run_verb. */
typedef void (*reply_fn)(void *ctx, const char *line);

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
    char backends[4096];
    char grant[4096];
    backends_csv(backends, sizeof(backends));
    grant_csv(grant, sizeof(grant));

    if (strcmp(line, "PING") == 0) {
        if (from_ctl)
            log_line("AID PONG");
        else if (reply)
            reply(ctx, "OK pong\n");
        return;
    }
    if (strcmp(line, "LIST") == 0) {
        scan_backends();
        backends_csv(backends, sizeof(backends));
        if (from_ctl)
            log_line("AID LIST selected=%s backends=%s", g_selected,
                     backends);
        else if (reply) {
            snprintf(out, sizeof(out), "OK selected=%s backends=%s\n",
                     g_selected, backends);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "SELECT") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("AID SELECT FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: SELECT <id>\n");
            return;
        }
        scan_backends();
        if (backend_index(arg) < 0) {
            if (from_ctl)
                log_line("AID SELECT FAIL unknown backend %s", arg);
            else if (reply) {
                snprintf(out, sizeof(out),
                         "ERR unknown backend %s\n", arg);
                reply(ctx, out);
            }
            return;
        }
        snprintf(g_selected, sizeof(g_selected), "%s", arg);
        if (save_selection() != 0)
            log_line("AID SELECT %s (selection NOT persisted)", arg);
        if (from_ctl)
            log_line("AID SELECT OK %s", arg);
        else if (reply) {
            snprintf(out, sizeof(out), "OK selected %s\n", arg);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "STATUS") == 0) {
        scan_backends();
        backends_csv(backends, sizeof(backends));
        if (from_ctl)
            log_line("AID STATUS selected=%s backends=%s grant=%s",
                     g_selected, backends, grant);
        else if (reply) {
            snprintf(out, sizeof(out),
                     "OK selected=%s backends=%s grant=%s\n",
                     g_selected, backends, grant);
            reply(ctx, out);
        }
        return;
    }
    if (strcmp(line, "ASK") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("AID ASK FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: ASK <task>\n");
            return;
        }
        scan_backends();
        int bi = backend_index(g_selected);
        if (bi < 0) {
            if (from_ctl)
                log_line("AID ASK FAIL no backend selected");
            else if (reply)
                reply(ctx, "ERR no backend selected\n");
            return;
        }
        char backend_path[4096];
        snprintf(backend_path, sizeof(backend_path), "%s/%s",
                 g_backends_dir, g_backends[bi]);
        struct action actions[MAX_ACTIONS];
        size_t n_actions = 0;
        char err[256];
        if (run_backend(backend_path, arg, actions, &n_actions, err,
                        sizeof(err)) != 0) {
            if (from_ctl)
                log_line("AID ASK FAIL backend %s: %s", g_selected,
                         err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR backend %s failed: %s\n",
                         g_selected, err);
                reply(ctx, out);
            }
            return;
        }
        int allowed = 0, denied = 0, failed = 0;
        for (size_t i = 0; i < n_actions; i++) {
            struct action *a = &actions[i];
            char action_line[LINE_CAP];
            if (a->arg2[0])
                snprintf(action_line, sizeof(action_line), "%s %s %s",
                         a->verb, a->arg1, a->arg2);
            else if (a->arg1[0])
                snprintf(action_line, sizeof(action_line), "%s %s",
                         a->verb, a->arg1);
            else
                snprintf(action_line, sizeof(action_line), "%s",
                         a->verb);
            /* The permission boundary: anything without a permission
             * or outside the grant is refused here and never runs. */
            if (!a->perm || !grant_has(a->perm)) {
                denied++;
                log_line("AID DENIED %s %s (%s)", g_selected,
                         action_line,
                         a->perm ? a->perm : "unknown action");
                continue;
            }
            char xerr[256];
            if (execute_action(a, xerr, sizeof(xerr)) == 0) {
                allowed++;
                log_line("AID ALLOW %s %s", g_selected, action_line);
            } else {
                failed++;
                log_line("AID EXEC FAIL %s %s: %s", g_selected,
                         action_line, xerr);
            }
        }
        log_line("AID ASK backend=%s task=\"%s\" allowed=%d denied=%d "
                 "failed=%d",
                 g_selected, arg, allowed, denied, failed);
        if (from_ctl)
            log_line("AID ASK OK backend=%s allowed=%d denied=%d "
                     "failed=%d",
                     g_selected, allowed, denied, failed);
        else if (reply) {
            snprintf(out, sizeof(out),
                     "OK backend=%s allowed=%d denied=%d failed=%d\n",
                     g_selected, allowed, denied, failed);
            reply(ctx, out);
        }
        return;
    }
    if (from_ctl)
        log_line("AID unknown command: %s", line);
    else if (reply)
        reply(ctx, "ERR unknown command\n");
}

/* ------------------------------------------------------------------ */
/* socket clients + main loop                                          */
/* ------------------------------------------------------------------ */

struct client {
    int fd;
    int dead;
    char in[LINE_CAP];
    size_t in_len;
};

#define MAX_CLIENTS_ARR MAX_CLIENTS
static struct client g_clients[MAX_CLIENTS];
static size_t g_nclients = 0;

static void socket_reply(void *ctx, const char *line)
{
    /* Replies are one short line; the client (the CLI) reads it and
     * closes. A blocking write is fine here — the peer is local and
     * the reply fits the socket buffer. */
    int fd = (int)(intptr_t)ctx;
    size_t n = strlen(line), off = 0;
    while (off < n) {
        ssize_t w = write(fd, line + off, n - off);
        if (w <= 0)
            break;
        off += (size_t)w;
    }
}

static void client_close(struct client *c)
{
    if (c->fd >= 0)
        close(c->fd);
    c->fd = -1;
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

int main(void)
{
    g_sock_path = env_or("SEVYN_AI_SOCK", DEFAULT_SOCK);
    g_ctl_path = env_or("SEVYN_AI_CTL", DEFAULT_CTL);
    g_backends_dir = env_or("SEVYN_AI_BACKENDS_DIR", DEFAULT_BACKENDS_DIR);
    g_grant_path = env_or("SEVYN_AI_GRANT", DEFAULT_GRANT);
    g_selected_path = env_or("SEVYN_AI_SELECTED", DEFAULT_SELECTED);
    g_appd_sock = env_or("SEVYN_AI_APPD_SOCK", DEFAULT_APPD_SOCK);
    g_status_sock = env_or("SEVYN_AI_STATUS_SOCK", DEFAULT_STATUS_SOCK);

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGPIPE, SIG_IGN);

    g_console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    if (g_console_fd < 0)
        g_console_fd = -1; /* stderr only (host test rig) */

    if (load_grant() != 0)
        return 1;

    scan_backends();
    load_selection();
    if (backend_index(g_selected) < 0) {
        if (g_nbackends > 0) {
            log_line("AID selected backend %s not found; using %s",
                     g_selected, g_backends[0]);
            snprintf(g_selected, sizeof(g_selected), "%s",
                     g_backends[0]);
        } else {
            log_line("AID warning: no backends found in %s",
                     g_backends_dir);
        }
    }
    char backends[4096];
    backends_csv(backends, sizeof(backends));

    int listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        log_line("AID socket failed: %s", strerror(errno));
        return 1;
    }
    unlink(g_sock_path);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(g_sock_path) >= sizeof(addr.sun_path)) {
        log_line("AID socket path too long");
        return 1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", g_sock_path);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        log_line("AID bind failed: %s", strerror(errno));
        return 1;
    }
    if (listen(listen_fd, 8) != 0) {
        log_line("AID listen failed: %s", strerror(errno));
        return 1;
    }
    fcntl(listen_fd, F_SETFL, O_NONBLOCK);

    /* Control serial (read-only). Missing on the host test rig until
     * the harness creates it — retry for a while, then run without
     * it (the socket still serves the CLI). */
    int ctl_fd = -1;
    for (int i = 0; i < 50 && ctl_fd < 0 && !g_stop; i++) {
        ctl_fd = open(g_ctl_path, O_RDONLY | O_NONBLOCK);
        if (ctl_fd < 0)
            usleep(100 * 1000);
    }
    if (ctl_fd < 0)
        log_line("AID no control serial %s: %s (socket only)",
                 g_ctl_path, strerror(errno));

    log_line("AID ready sock=%s ctl=%s backends=%s selected=%s",
             g_sock_path, ctl_fd >= 0 ? g_ctl_path : "(none)",
             backends, g_selected);

    char ctl_buf[LINE_CAP];
    size_t ctl_len = 0;

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
            nfds++;
        }
        int r = poll(pfds, (nfds_t)nfds, 100);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        /* Clients accepted below were NOT in this poll() set: only
         * service the clients that were polled (the M3 lesson — a
         * fresh connection's slot holds stale revents). */
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
            if (nread == 0) {
                /* Writer went away (EOF): close the fd so poll does
                 * not spin on it. The socket still serves the CLI. */
                log_line("AID control serial closed");
                close(ctl_fd);
                ctl_fd = -1;
            } else if (nread > 0) {
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
                    if (nread < 0 &&
                        (errno == EAGAIN || errno == EINTR)) {
                        /* try again next loop */
                    } else {
                        client_close(c);
                        continue;
                    }
                } else {
                    for (ssize_t j = 0; j < nread; j++) {
                        char ch = tmp[j];
                        if (ch == '\n' || ch == '\r') {
                            if (c->in_len > 0) {
                                c->in[c->in_len] = '\0';
                                run_verb(c->in, socket_reply,
                                         (void *)(intptr_t)c->fd, 0);
                                c->in_len = 0;
                            }
                        } else if (c->in_len + 1 < sizeof(c->in)) {
                            c->in[c->in_len++] = ch;
                        }
                    }
                }
            }
        }
        compact_clients();
    }

    log_line("AID stopping");
    close(listen_fd);
    unlink(g_sock_path);
    if (ctl_fd >= 0)
        close(ctl_fd);
    return 0;
}
