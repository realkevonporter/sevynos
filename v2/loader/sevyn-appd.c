/* SevynOS v2 M3 — app daemon (sevyn-appd).
 *
 * Owns the app lifecycle after boot:
 *   - seeds the registry from pristine on first boot (registry.json
 *     missing => fresh image; a registry that exists — even an empty
 *     one — is never re-seeded, so a deleted stock app stays deleted
 *     until the user reinstalls it from pristine),
 *   - serves the app socket /run/sevyn-apps.sock for the shell host
 *     (LIST / LAUNCH / CLOSE / INSTALL / UNINSTALL / REINSTALL /
 *     SUBSCRIBE for EVENT lines),
 *   - reads the harness control serial /dev/ttyS2 for the same verbs
 *     (replies go to the console as APPD log lines),
 *   - spawns one sevyn-rn-host process per running app (windowed,
 *     sandboxed: a crashing app never takes down the shell), reaps
 *     children, writes/removes pid files under /run/sevyn/apps, and
 *     broadcasts EVENT LAUNCHED / STOPPED / CRASHED / INSTALLED /
 *     UNINSTALLED to subscribers. The host is launched with
 *     --app <id> --name <name> --color <#rrggbb> --glyph <letter>
 *     [--permissions <csv>] from the registry entry.
 *
 * The loader does the registry + signature work; appd forks it for
 * INSTALL / UNINSTALL / REINSTALL / LIST and parses the list output.
 * The host binary is forked directly for LAUNCH.
 *
 * Single-threaded poll loop; no threads. The loader runs are
 * synchronous fork + waitpid, so the reaper (waitpid WNOHANG in the
 * poll loop) can never steal a loader child's status.
 *
 * Socket protocol (newline-terminated ASCII, one reply per command):
 *   SUBSCRIBE            -> OK subscribed (this connection then also
 *                           receives EVENT lines)
 *   LIST                 -> APP <loader list line> ... then OK list
 *   LAUNCH <id>          -> OK launched <id> / ERR <reason>
 *   CLOSE <id>           -> OK closed <id> / ERR not-running
 *   INSTALL <path>       -> OK installed <id> / ERR <reason>
 *   UNINSTALL <id>       -> OK uninstalled <id> / ERR <reason>
 *   REINSTALL <id>       -> OK reinstalled <id> / ERR <reason>
 * Events (subscribers only):
 *   EVENT LAUNCHED <id>
 *   EVENT STOPPED <id> <exit-code>       (clean exit, or SIGTERM after
 *                                          a CLOSE request)
 *   EVENT CRASHED <id> <exit-code|signal N>
 *   EVENT INSTALLED <id>
 *   EVENT UNINSTALLED <id>
 *
 * Control serial (ttyS2): same verbs, one per line. Replies are
 * APPD log lines on the console (the harness reads the serial log):
 *   APPD INSTALL OK <id> / APPD INSTALL FAIL <reason>
 *   APPD UNINSTALL OK <id> / APPD UNINSTALL FAIL <reason>
 *   APPD REINSTALL OK <id> / APPD REINSTALL FAIL <reason>
 *   APPD LAUNCH OK <id> / APPD LAUNCH FAIL <reason>
 *   APPD CLOSE OK <id> / APPD CLOSE FAIL <reason>
 *   APPD LIST <loader list line> (one per app)
 *   APPD PONG
 *
 * Paths come from the environment for the host-side unit tests:
 *   SEVYN_APPS_DIR, SEVYN_PRISTINE_DIR, SEVYN_RUN_DIR,
 *   SEVYN_LOADER (default /usr/local/bin/sevyn-loader),
 *   SEVYN_HOST (default /usr/local/bin/sevyn-rn-host),
 *   SEVYN_APPS_SOCK (default /run/sevyn-apps.sock),
 *   SEVYN_APP_CTL (default /dev/ttyS2).
 *
 * Build: gcc, libc only. Unzip/signature work lives in the loader.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
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
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define DEFAULT_APPS_DIR "/var/lib/sevyn/apps"
#define DEFAULT_PRISTINE_DIR "/usr/share/sevyn/pristine"
#define DEFAULT_RUN_DIR "/run/sevyn/apps"
#define DEFAULT_LOADER "/usr/local/bin/sevyn-loader"
#define DEFAULT_HOST "/usr/local/bin/sevyn-rn-host"
#define DEFAULT_SOCK "/run/sevyn-apps.sock"
#define DEFAULT_CTL "/dev/ttyS2"
#define MAX_APPS 32
#define MAX_CLIENTS 16
#define LINE_CAP 2048

static const char *g_apps_dir;
static const char *g_pristine_dir;
static const char *g_run_dir;
static const char *g_loader;
static const char *g_host;
static const char *g_sock_path;
static const char *g_ctl_path;
static int g_console_fd = -1;
static volatile sig_atomic_t g_stop = 0;

static void on_signal(int sig)
{
    (void)sig;
    g_stop = 1;
}

/* Retrying console writer (same pattern as statusd / the loader). */
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

static int file_exists(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0;
}

static int mkdir_p(const char *path)
{
    if (path[0] == '\0')
        return 0;
    char tmp[PATH_MAX];
    size_t n = strlen(path);
    if (n >= sizeof(tmp))
        return -1;
    memcpy(tmp, path, n + 1);
    for (char *p = tmp + 1; *p; p++) {
        if (*p == '/') {
            *p = '\0';
            if (mkdir(tmp, 0755) < 0 && errno != EEXIST)
                return -1;
            *p = '/';
        }
    }
    if (mkdir(tmp, 0755) < 0 && errno != EEXIST)
        return -1;
    return 0;
}

static int write_file(const char *path, const char *data)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return -1;
    size_t len = strlen(data), off = 0;
    while (off < len) {
        ssize_t w = write(fd, data + off, len - off);
        if (w < 0) {
            if (errno == EINTR)
                continue;
            close(fd);
            return -1;
        }
        off += (size_t)w;
    }
    if (close(fd) < 0)
        return -1;
    return 0;
}

/* --- running apps --- */

struct app_proc {
    char id[65];
    pid_t pid;
    int closing; /* set when CLOSE asked for SIGTERM: a SIGTERM death
                  * after a close request is STOPPED, not CRASHED */
};

static struct app_proc g_apps[MAX_APPS];
static size_t g_napps = 0;

static struct app_proc *find_app(const char *id)
{
    for (size_t i = 0; i < g_napps; i++)
        if (strcmp(g_apps[i].id, id) == 0)
            return &g_apps[i];
    return NULL;
}

static struct app_proc *find_app_by_pid(pid_t pid)
{
    for (size_t i = 0; i < g_napps; i++)
        if (g_apps[i].pid == pid)
            return &g_apps[i];
    return NULL;
}

static void remove_app(struct app_proc *a)
{
    size_t idx = (size_t)(a - g_apps);
    memmove(&g_apps[idx], &g_apps[idx + 1],
            (g_napps - idx - 1) * sizeof(*a));
    g_napps--;
}

static char *pid_path(const char *id)
{
    char *dir = path_join(g_run_dir, "");
    if (!dir)
        return NULL;
    size_t n = strlen(dir) + strlen(id) + 5;
    char *full = (char *)malloc(n + 1);
    if (!full) {
        free(dir);
        return NULL;
    }
    snprintf(full, n + 1, "%s%s.pid", dir, id);
    free(dir);
    return full;
}

/* --- clients (socket) --- */

struct client {
    int fd;
    int subscribed;
    char in[LINE_CAP];
    size_t in_len;
    char *out; /* pending output bytes */
    size_t out_len, out_off;
    int dead;
};

static struct client g_clients[MAX_CLIENTS];
static size_t g_nclients = 0;

/* Mark a client dead (fd closed, output freed). The slot is compacted
 * out at the end of the poll iteration so the pollfd array stays
 * aligned with g_clients while the loop runs. */
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

/* Broadcast an event line to subscribed clients only. */
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

/* Flush pending output for clients whose socket is writable.
 * Dead clients are skipped; compact_clients() removes them. */
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

/* --- loader invocations --- */

/* Run the loader with argv (NULL-terminated, argv[0] = loader path).
 * If capture is non-NULL, the loader's stdout is captured into a
 * malloc'd buffer (caller frees). Returns the loader's exit code, or
 * -1 if it could not be run. The loader's own console logging still
 * reaches the serial log (its stderr is inherited). */
static int run_loader(char *const argv[], char **capture)
{
    int pipefd[2] = { -1, -1 };
    if (capture) {
        if (pipe(pipefd) != 0)
            return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        if (capture) {
            close(pipefd[0]);
            close(pipefd[1]);
        }
        return -1;
    }
    if (pid == 0) {
        if (capture) {
            close(pipefd[0]);
            dup2(pipefd[1], STDOUT_FILENO);
            close(pipefd[1]);
        }
        execv(g_loader, argv);
        _exit(127);
    }
    if (capture)
        close(pipefd[1]);
    char *buf = NULL;
    size_t len = 0, cap = 0;
    if (capture) {
        char tmp[4096];
        ssize_t r;
        while ((r = read(pipefd[0], tmp, sizeof(tmp))) > 0) {
            if (len + (size_t)r + 1 > cap) {
                cap = (len + (size_t)r + 1) * 2;
                char *nb = (char *)realloc(buf, cap);
                if (!nb) {
                    free(buf);
                    buf = NULL;
                    break;
                }
                buf = nb;
            }
            memcpy(buf + len, tmp, (size_t)r);
            len += (size_t)r;
        }
        close(pipefd[0]);
        if (buf)
            buf[len] = '\0';
        *capture = buf;
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR)
            return -1;
    }
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return -1;
}

/* List installed apps via the loader. Returns a malloc'd buffer of
 * "id|name|version|color|glyph|system=..|protected=..|perms=..|key=.."
 * lines (caller frees), or NULL on failure. */
static char *loader_list(void)
{
    char *argv[] = { (char *)g_loader, "list", NULL };
    char *out = NULL;
    if (run_loader(argv, &out) != 0) {
        free(out);
        return NULL;
    }
    return out ? out : strdup("");
}

/* Find one app's list line by id. Returns a malloc'd copy of the line
 * (without the newline), or NULL when not installed. */
static char *loader_list_one(const char *id)
{
    char *list = loader_list();
    if (!list)
        return NULL;
    char *found = NULL;
    char *save = NULL;
    for (char *line = strtok_r(list, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        size_t idlen = strlen(id);
        if (strncmp(line, id, idlen) == 0 && line[idlen] == '|') {
            found = strdup(line);
            break;
        }
    }
    free(list);
    return found;
}

/* Extract one |-separated field (0-based) from a list line. */
static void list_line_field(const char *line, int want, char *out,
                            size_t outcap)
{
    out[0] = '\0';
    int field = 0;
    const char *p = line;
    for (;;) {
        const char *bar = strchr(p, '|');
        size_t n = bar ? (size_t)(bar - p) : strlen(p);
        if (field == want) {
            if (n >= outcap)
                n = outcap - 1;
            memcpy(out, p, n);
            out[n] = '\0';
            return;
        }
        if (!bar)
            return;
        p = bar + 1;
        field++;
    }
}

/* Extract the perms= field (csv) from a list line. Empty string when
 * the app has no permissions. */
static void list_line_perms(const char *line, char *out, size_t outcap)
{
    out[0] = '\0';
    const char *p = strstr(line, "|perms=");
    if (!p)
        return;
    p += 7;
    const char *e = strchr(p, '|');
    size_t n = e ? (size_t)(e - p) : strlen(p);
    if (n >= outcap)
        n = outcap - 1;
    memcpy(out, p, n);
    out[n] = '\0';
}

/* --- app lifecycle --- */

/* Launch an app. On success returns 0 and the pid is recorded; on
 * failure returns -1 with err set. */
static int launch_app(const char *id, char *err, size_t errcap)
{
    if (find_app(id)) {
        snprintf(err, errcap, "already-running");
        return -1;
    }
    char *line = loader_list_one(id);
    if (!line) {
        snprintf(err, errcap, "not-installed");
        return -1;
    }
    char perms[512];
    list_line_perms(line, perms, sizeof(perms));
    char app_name[65], app_color[16], app_glyph[8];
    list_line_field(line, 1, app_name, sizeof(app_name));
    list_line_field(line, 3, app_color, sizeof(app_color));
    list_line_field(line, 4, app_glyph, sizeof(app_glyph));
    free(line);
    if (g_napps >= MAX_APPS) {
        snprintf(err, errcap, "too-many-apps");
        return -1;
    }
    char *bundle = path_join(g_apps_dir, id);
    if (!bundle) {
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    size_t n = strlen(bundle) + 9;
    char *hbc = (char *)malloc(n + 1);
    if (!hbc) {
        free(bundle);
        snprintf(err, errcap, "out of memory");
        return -1;
    }
    snprintf(hbc, n + 1, "%s/app.hbc", bundle);
    free(bundle);
    if (!file_exists(hbc)) {
        free(hbc);
        snprintf(err, errcap, "no app.hbc");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        free(hbc);
        snprintf(err, errcap, "fork failed: %s", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        /* Child: its own session; stdio stays inherited (the console),
         * so the host's logLine output reaches the serial log. */
        setsid();
        if (perms[0]) {
            execl(g_host, g_host, "--bundle", hbc, "--width", "800",
                  "--height", "500", "--app", id, "--name", app_name,
                  "--color", app_color, "--glyph", app_glyph,
                  "--permissions", perms, (char *)NULL);
        } else {
            execl(g_host, g_host, "--bundle", hbc, "--width", "800",
                  "--height", "500", "--app", id, "--name", app_name,
                  "--color", app_color, "--glyph", app_glyph,
                  (char *)NULL);
        }
        _exit(127);
    }
    free(hbc);
    struct app_proc *a = &g_apps[g_napps++];
    snprintf(a->id, sizeof(a->id), "%s", id);
    a->pid = pid;
    char *pp = pid_path(id);
    if (pp) {
        char pidbuf[32];
        snprintf(pidbuf, sizeof(pidbuf), "%ld\n", (long)pid);
        write_file(pp, pidbuf);
        free(pp);
    }
    log_line("APPD launched %s (pid %ld)", id, (long)pid);
    broadcast_event("EVENT LAUNCHED %s\n", id);
    return 0;
}

static int close_app(const char *id, char *err, size_t errcap)
{
    struct app_proc *a = find_app(id);
    if (!a) {
        snprintf(err, errcap, "not-running");
        return -1;
    }
    if (kill(a->pid, SIGTERM) != 0) {
        snprintf(err, errcap, "kill failed: %s", strerror(errno));
        return -1;
    }
    a->closing = 1;
    log_line("APPD closing %s (pid %ld)", id, (long)a->pid);
    return 0;
}

/* Reap exited children. Called from the poll loop. */
static void reap_children(void)
{
    int status = 0;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        struct app_proc *a = find_app_by_pid(pid);
        if (!a)
            continue; /* a loader child reaped elsewhere: not ours */
        char id[65];
        snprintf(id, sizeof(id), "%s", a->id);
        int was_closing = a->closing;
        remove_app(a);
        char *pp = pid_path(id);
        if (pp) {
            unlink(pp);
            free(pp);
        }
        if (WIFEXITED(status)) {
            int code = WEXITSTATUS(status);
            if (code == 0) {
                log_line("APP STOPPED %s %d", id, code);
                broadcast_event("EVENT STOPPED %s %d\n", id, code);
            } else {
                log_line("APP CRASHED %s %d", id, code);
                broadcast_event("EVENT CRASHED %s %d\n", id, code);
            }
        } else if (WIFSIGNALED(status)) {
            int sig = WTERMSIG(status);
            if (was_closing && sig == SIGTERM) {
                /* Asked to close: a SIGTERM death is a clean stop. */
                log_line("APP STOPPED %s signal %d", id, sig);
                broadcast_event("EVENT STOPPED %s signal %d\n", id, sig);
            } else {
                log_line("APP CRASHED %s signal %d", id, sig);
                broadcast_event("EVENT CRASHED %s signal %d\n", id, sig);
            }
        }
    }
}

/* --- command handling --- */

/* Run one verb. `reply` is called with the reply line for socket
 * clients (NULL for control-serial callers, whose replies go to the
 * console instead). Returns nothing; the verb's outcome is in the
 * reply. */
typedef void (*reply_fn)(void *ctx, const char *line);

static void run_verb(const char *verb_line, reply_fn reply, void *ctx,
                     int from_ctl)
{
    char line[LINE_CAP];
    snprintf(line, sizeof(line), "%s", verb_line);
    /* Split verb + arg. */
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
    char err[256];
    char out[LINE_CAP];

    if (strcmp(line, "PING") == 0) {
        if (from_ctl)
            log_line("APPD PONG");
        else if (reply)
            reply(ctx, "OK pong\n");
        return;
    }
    if (strcmp(line, "SUBSCRIBE") == 0) {
        if (!from_ctl && reply) {
            /* Mark the calling client subscribed. The ctx is the
             * client pointer; see handle_client_line. */
            struct client *c = (struct client *)ctx;
            c->subscribed = 1;
            reply(ctx, "OK subscribed\n");
        }
        return;
    }
    if (strcmp(line, "LIST") == 0) {
        char *list = loader_list();
        if (!list) {
            if (from_ctl)
                log_line("APPD LIST FAIL loader error");
            else if (reply)
                reply(ctx, "ERR loader error\n");
            return;
        }
        if (from_ctl) {
            char *save = NULL;
            for (char *l = strtok_r(list, "\n", &save); l;
                 l = strtok_r(NULL, "\n", &save))
                log_line("APPD LIST %s", l);
            log_line("APPD LIST OK");
        } else if (reply) {
            char *save = NULL;
            for (char *l = strtok_r(list, "\n", &save); l;
                 l = strtok_r(NULL, "\n", &save)) {
                snprintf(out, sizeof(out), "APP %s\n", l);
                reply(ctx, out);
            }
            reply(ctx, "OK list\n");
        }
        free(list);
        return;
    }
    if (strcmp(line, "LAUNCH") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("APPD LAUNCH FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: LAUNCH <id>\n");
            return;
        }
        if (launch_app(arg, err, sizeof(err)) == 0) {
            if (from_ctl)
                log_line("APPD LAUNCH OK %s", arg);
            else if (reply) {
                snprintf(out, sizeof(out), "OK launched %s\n", arg);
                reply(ctx, out);
            }
        } else {
            if (from_ctl)
                log_line("APPD LAUNCH FAIL %s %s", arg, err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR %s\n", err);
                reply(ctx, out);
            }
        }
        return;
    }
    if (strcmp(line, "CLOSE") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("APPD CLOSE FAIL usage");
            else if (reply)
                reply(ctx, "ERR usage: CLOSE <id>\n");
            return;
        }
        if (close_app(arg, err, sizeof(err)) == 0) {
            if (from_ctl)
                log_line("APPD CLOSE OK %s", arg);
            else if (reply) {
                snprintf(out, sizeof(out), "OK closed %s\n", arg);
                reply(ctx, out);
            }
        } else {
            if (from_ctl)
                log_line("APPD CLOSE FAIL %s %s", arg, err);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR %s\n", err);
                reply(ctx, out);
            }
        }
        return;
    }
    if (strcmp(line, "INSTALL") == 0 || strcmp(line, "UNINSTALL") == 0 ||
        strcmp(line, "REINSTALL") == 0) {
        if (!arg) {
            if (from_ctl)
                log_line("APPD %s FAIL usage", line);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR usage: %.16s <arg>\n", line);
                reply(ctx, out);
            }
            return;
        }
        const char *what = line;
        char *argv[4];
        argv[0] = (char *)g_loader;
        if (strcmp(line, "INSTALL") == 0) {
            argv[1] = "install";
            argv[2] = arg;
        } else if (strcmp(line, "UNINSTALL") == 0) {
            argv[1] = "uninstall";
            argv[2] = arg;
        } else {
            argv[1] = "reinstall";
            argv[2] = arg;
        }
        argv[3] = NULL;
        int rc = run_loader(argv, NULL);
        const char *id_for_event = arg;
        char idbuf[65];
        if (strcmp(line, "INSTALL") == 0) {
            /* The id is inside the bundle; read it back from the
             * registry listing by bundle name is unreliable, so the
             * event carries the bundle path's basename instead. The
             * shell re-LISTs after an install anyway. */
            const char *base = strrchr(arg, '/');
            base = base ? base + 1 : arg;
            snprintf(idbuf, sizeof(idbuf), "%s", base);
            size_t bl = strlen(idbuf);
            if (bl > 6 && strcmp(idbuf + bl - 6, ".sevyn") == 0)
                idbuf[bl - 6] = '\0';
            id_for_event = idbuf;
        }
        if (rc == 0) {
            if (from_ctl)
                log_line("APPD %s OK %s", what, arg);
            else if (reply) {
                snprintf(out, sizeof(out), "OK %s %s\n",
                         strcmp(what, "INSTALL") == 0
                             ? "installed"
                             : strcmp(what, "UNINSTALL") == 0
                                   ? "uninstalled"
                                   : "reinstalled",
                         arg);
                reply(ctx, out);
            }
            if (strcmp(what, "INSTALL") == 0)
                broadcast_event("EVENT INSTALLED %s\n", id_for_event);
            else if (strcmp(what, "UNINSTALL") == 0)
                broadcast_event("EVENT UNINSTALLED %s\n", id_for_event);
            else
                broadcast_event("EVENT INSTALLED %s\n", id_for_event);
        } else {
            if (from_ctl)
                log_line("APPD %s FAIL %s rc=%d", what, arg, rc);
            else if (reply) {
                snprintf(out, sizeof(out), "ERR loader rc=%d\n", rc);
                reply(ctx, out);
            }
        }
        return;
    }
    if (from_ctl)
        log_line("APPD unknown command: %s", line);
    else if (reply)
        reply(ctx, "ERR unknown command\n");
}

static void socket_reply(void *ctx, const char *line)
{
    client_send_str((struct client *)ctx, line);
}

/* --- first-boot seed --- */

static int cmp_str(const void *a, const void *b)
{
    /* qsort hands us pointers to the array elements (char *), so
     * dereference once to get the strings. */
    return strcmp(*(char *const *)a, *(char *const *)b);
}

static void seed_from_pristine(void)
{
    char *reg = path_join(g_apps_dir, "registry.json");
    if (reg && file_exists(reg)) {
        free(reg);
        return; /* not a fresh image: never re-seed */
    }
    free(reg);
    if (mkdir_p(g_apps_dir) != 0) {
        log_line("APPD seed failed: cannot create %s", g_apps_dir);
        return;
    }
    DIR *d = opendir(g_pristine_dir);
    if (!d) {
        log_line("APPD seed: no pristine dir %s", g_pristine_dir);
        return;
    }
    /* Collect *.sevyn names, sorted for a deterministic boot order. */
    char *names[256];
    size_t n = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL && n < 256) {
        size_t l = strlen(de->d_name);
        if (l > 6 && strcmp(de->d_name + l - 6, ".sevyn") == 0)
            names[n++] = strdup(de->d_name);
    }
    closedir(d);
    qsort(names, n, sizeof(char *), cmp_str);
    for (size_t i = 0; i < n; i++) {
        char *bundle = path_join(g_pristine_dir, names[i]);
        char *argv[] = { (char *)g_loader, "install", bundle, NULL };
        int rc = bundle ? run_loader(argv, NULL) : -1;
        if (rc == 0)
            log_line("APPD seeded %s", names[i]);
        else
            log_line("APPD seed failed %s rc=%d", names[i], rc);
        free(bundle);
        free(names[i]);
    }
    log_line("APPD seed complete (%zu bundles)", n);
}

/* --- main loop --- */

int main(int argc, char **argv)
{
    (void)argc;
    (void)argv;
    g_apps_dir = getenv("SEVYN_APPS_DIR");
    if (!g_apps_dir || !*g_apps_dir)
        g_apps_dir = DEFAULT_APPS_DIR;
    g_pristine_dir = getenv("SEVYN_PRISTINE_DIR");
    if (!g_pristine_dir || !*g_pristine_dir)
        g_pristine_dir = DEFAULT_PRISTINE_DIR;
    g_run_dir = getenv("SEVYN_RUN_DIR");
    if (!g_run_dir || !*g_run_dir)
        g_run_dir = DEFAULT_RUN_DIR;
    g_loader = getenv("SEVYN_LOADER");
    if (!g_loader || !*g_loader)
        g_loader = DEFAULT_LOADER;
    g_host = getenv("SEVYN_HOST");
    if (!g_host || !*g_host)
        g_host = DEFAULT_HOST;
    g_sock_path = getenv("SEVYN_APPS_SOCK");
    if (!g_sock_path || !*g_sock_path)
        g_sock_path = DEFAULT_SOCK;
    g_ctl_path = getenv("SEVYN_APP_CTL");
    if (!g_ctl_path || !*g_ctl_path)
        g_ctl_path = DEFAULT_CTL;

    g_console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);

    if (mkdir_p(g_apps_dir) != 0 || mkdir_p(g_run_dir) != 0) {
        log_line("APPD cannot create dirs: %s", strerror(errno));
        return 1;
    }

    seed_from_pristine();

    /* Listen socket. */
    unlink(g_sock_path);
    int listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listen_fd < 0) {
        log_line("APPD socket failed: %s", strerror(errno));
        return 1;
    }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(g_sock_path) >= sizeof(addr.sun_path)) {
        log_line("APPD socket path too long");
        return 1;
    }
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", g_sock_path);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        log_line("APPD bind failed: %s", strerror(errno));
        return 1;
    }
    if (listen(listen_fd, 8) != 0) {
        log_line("APPD listen failed: %s", strerror(errno));
        return 1;
    }
    fcntl(listen_fd, F_SETFL, O_NONBLOCK);

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
        log_line("APPD no control serial %s: %s (socket only)",
                 g_ctl_path, strerror(errno));

    log_line("APPD ready sock=%s ctl=%s", g_sock_path,
             ctl_fd >= 0 ? g_ctl_path : "(none)");

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
        /* Clients. The pollfd array was built from g_clients in the
         * same order, and closing only marks a slot dead (no shifting),
         * so pfds[idx + i] stays aligned with g_clients[i]. */
        for (size_t i = 0; i < g_nclients; i++) {
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
                    if (nread < 0 && (errno == EAGAIN || errno == EINTR)) {
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
                                /* SUBSCRIBE needs the client pointer
                                 * as ctx; other verbs ignore ctx. */
                                run_verb(c->in, socket_reply, c, 0);
                                c->in_len = 0;
                            }
                        } else if (c->in_len + 1 < sizeof(c->in)) {
                            c->in[c->in_len++] = ch;
                        }
                    }
                }
            }
        }
        flush_clients();
        compact_clients();
        reap_children();
    }

    log_line("APPD stopping");
    for (size_t i = 0; i < g_napps; i++)
        kill(g_apps[i].pid, SIGTERM);
    close(listen_fd);
    unlink(g_sock_path);
    if (ctl_fd >= 0)
        close(ctl_fd);
    return 0;
}
