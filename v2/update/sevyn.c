/* SevynOS v2 M4 — the `sevyn` CLI.
 *
 * The Terminal app's command surface (the locked rule: the Terminal
 * exposes only the `sevyn` CLI, never bash). M8 seeded it with the
 * update verbs; M4 grows it into the recovery + system surface:
 * shell control (the Terminal is the recovery path when the shell
 * dies), files (list/cat/mkdir/write), and Sevyn Code status.
 *
 * Usage:
 *   sevyn                       REPL (no args): read commands from
 *                               stdin until EOF / exit. This is what
 *                               code-server spawns as its terminal
 *                               shell, so it must work with no args.
 *   sevyn help                  print this help
 *   sevyn update check|apply|status|channel <c>
 *   sevyn shell kill|start|restart|status
 *   sevyn files list [path]     list a real directory (default /data)
 *   sevyn files cat <path>      print a file (64 KB cap)
 *   sevyn files mkdir <path>    create a directory
 *   sevyn files write <path> <text...>
 *                               write text to a file (create/truncate)
 *   sevyn code status           Sevyn Code: running, serving, version,
 *                               terminal shell
 *
 * Exit 0 on success, 1 on error. No shell quoting, no pipes, no
 * globbing anywhere in this CLI — the exec bridge splits on
 * whitespace and the CLI takes argv as-is.
 *
 * Build: gcc, libc only.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define DEFAULT_SOCK "/run/sevyn-update.sock"
#define SHELL_BIN "/usr/local/bin/sevyn-rn-host"
#define SHELL_PID_FILE "/run/sevyn-shell.pid"
#define SHELL_LOG "/tmp/sevyn-host.log"
#define CODE_BIN_DIR "/usr/share/sevyn/code-server"
#define CODE_PID_FILE "/run/code-server.pid"
#define CODE_SETTINGS "/root/.local/share/code-server/User/settings.json"
#define CODE_URL "http://127.0.0.1:8080"

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

static void print_usage(FILE *f)
{
    fprintf(f,
            "usage: sevyn [help|<command> ...]\n"
            "  sevyn                       REPL: read commands from stdin\n"
            "  sevyn help                  this help\n"
            "  sevyn update check          check for a newer version\n"
            "  sevyn update apply          install into the idle slot "
            "and reboot\n"
            "  sevyn update status         show version, channel, slots\n"
            "  sevyn update channel <c>    set channel (nightly|stable)\n"
            "  sevyn shell kill            stop the shell (recover from "
            "the Terminal)\n"
            "  sevyn shell start           start the shell\n"
            "  sevyn shell restart         restart the shell\n"
            "  sevyn shell status          is the shell running?\n"
            "  sevyn files list [path]     list a directory (default "
            "/data)\n"
            "  sevyn files cat <path>      print a file (64 KB cap)\n"
            "  sevyn files mkdir <path>    create a directory\n"
            "  sevyn files write <path> <text...>\n"
            "                              write text to a file\n"
            "  sevyn code status           Sevyn Code: running, serving,\n"
            "                              version, terminal shell\n");
}

static int usage(void)
{
    print_usage(stderr);
    return 1;
}

/* Extract the string value of a JSON `"key": "value"` pair, searching
 * from `from` (or the start). Returns malloc'd value or NULL. */
static char *json_string_after(const char *text, const char *from,
                               const char *key)
{
    const char *p = from ? strstr(text, from) : text;
    if (!p)
        p = text;
    p = strstr(p, key);
    if (!p)
        return NULL;
    p = strchr(p + strlen(key), ':');
    if (!p)
        return NULL;
    p++;
    while (*p == ' ' || *p == '\t')
        p++;
    if (*p != '"')
        return NULL;
    p++;
    const char *end = strchr(p, '"');
    if (!end)
        return NULL;
    size_t n = (size_t)(end - p);
    char *out = malloc(n + 1);
    if (!out)
        return NULL;
    memcpy(out, p, n);
    out[n] = '\0';
    return out;
}

/* ------------------------------------------------------------------ */
/* update (M8, unchanged)                                              */
/* ------------------------------------------------------------------ */

static int connect_daemon(void)
{
    const char *path = getenv("SEVYN_UPDATE_SOCK");
    if (!path || !*path)
        path = DEFAULT_SOCK;
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

/* Send one line (with trailing newline). Returns 0 on success. */
static int send_line(int fd, const char *line)
{
    size_t n = strlen(line);
    char buf[2048];
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

/* Read one line (up to the newline). Returns the length, 0 on EOF,
 * -1 on error/timeout. */
static int read_line(int fd, char *buf, size_t cap)
{
    size_t n = 0;
    while (n + 1 < cap) {
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

/* Print the reply line, stripping the leading "OK " / "ERR ".
 * Returns 0 for OK, 1 for ERR. */
static int print_reply(const char *line)
{
    if (strncmp(line, "OK ", 3) == 0) {
        printf("%s\n", line + 3);
        return 0;
    }
    if (strncmp(line, "ERR ", 4) == 0) {
        fprintf(stderr, "error: %s\n", line + 4);
        return 1;
    }
    printf("%s\n", line);
    return 0;
}

static int cmd_update(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    const char *verb = argv[2];

    if (strcmp(verb, "check") != 0 && strcmp(verb, "apply") != 0 &&
        strcmp(verb, "status") != 0 && strcmp(verb, "channel") != 0)
        return usage();
    if (strcmp(verb, "channel") == 0 && argc != 4)
        return usage();
    if (strcmp(verb, "channel") != 0 && argc != 3)
        return usage();

    int fd = connect_daemon();
    if (fd < 0) {
        fprintf(stderr, "error: cannot reach the update daemon\n");
        return 1;
    }

    if (strcmp(verb, "apply") == 0) {
        /* Subscribe first so progress events print as they arrive,
         * then send APPLY and read until the terminal event. */
        if (send_line(fd, "SUBSCRIBE") != 0 ||
            send_line(fd, "APPLY") != 0) {
            fprintf(stderr, "error: cannot talk to the update daemon\n");
            close(fd);
            return 1;
        }
        char line[2048];
        int rc = 1;
        /* The apply child downloads ~50 MB and reboots; wait up to
         * 10 minutes for the terminal event (60 s per poll tick). */
        int waited_s = 0;
        for (;;) {
            struct pollfd pfd = { .fd = fd, .events = POLLIN };
            int pr = poll(&pfd, 1, 60000);
            if (pr < 0) {
                if (errno == EINTR)
                    continue;
                break;
            }
            if (pr == 0) {
                waited_s += 60;
                if (waited_s >= 600) {
                    fprintf(stderr, "error: timed out waiting for the "
                                    "update to finish\n");
                    break;
                }
                continue;
            }
            waited_s = 0;
            int n = read_line(fd, line, sizeof(line));
            if (n <= 0)
                break;
            if (strncmp(line, "OK subscribed", 13) == 0)
                continue;
            if (strncmp(line, "OK applying ", 12) == 0) {
                printf("applying %s\n", line + 12);
                continue;
            }
            if (strncmp(line, "ERR ", 4) == 0) {
                fprintf(stderr, "error: %s\n", line + 4);
                break;
            }
            if (strncmp(line, "EVENT APPLY STARTED ", 20) == 0) {
                printf("started %s\n", line + 20);
                continue;
            }
            if (strncmp(line, "EVENT APPLIED ", 14) == 0) {
                printf("applied %s\n", line + 14);
                rc = 0;
                break;
            }
            if (strncmp(line, "EVENT APPLY FAILED", 18) == 0) {
                fprintf(stderr,
                        "error: apply failed (see the update log)\n");
                break;
            }
            printf("%s\n", line);
        }
        close(fd);
        return rc;
    }

    char cmd[2048];
    if (strcmp(verb, "channel") == 0)
        snprintf(cmd, sizeof(cmd), "CHANNEL %s", argv[3]);
    else
        snprintf(cmd, sizeof(cmd), "%s", verb);
    /* Socket verbs are uppercase; the CLI verbs are lowercase. */
    if (strcmp(verb, "check") == 0)
        snprintf(cmd, sizeof(cmd), "CHECK");
    else if (strcmp(verb, "status") == 0)
        snprintf(cmd, sizeof(cmd), "STATUS");
    if (send_line(fd, cmd) != 0) {
        fprintf(stderr, "error: cannot talk to the update daemon\n");
        close(fd);
        return 1;
    }
    char line[2048];
    int n = read_line(fd, line, sizeof(line));
    close(fd);
    if (n <= 0) {
        fprintf(stderr, "error: no reply from the update daemon\n");
        return 1;
    }
    return print_reply(line);
}

/* ------------------------------------------------------------------ */
/* shell — the recovery path                                           */
/* ------------------------------------------------------------------ */

/* The shell host writes its pid to SEVYN_SHELL_PID_FILE (default
 * /run/sevyn-shell.pid) at startup in shell mode. A stale file (pid
 * dead) counts as not running. */
static pid_t shell_pid(void)
{
    const char *path = env_or("SEVYN_SHELL_PID_FILE", SHELL_PID_FILE);
    char *text = read_file_cap(path, 64);
    if (!text)
        return -1;
    pid_t pid = (pid_t)atoi(text);
    free(text);
    if (pid <= 0)
        return -1;
    if (kill(pid, 0) != 0)
        return -1;
    return pid;
}

static int cmd_shell_status(void)
{
    pid_t pid = shell_pid();
    if (pid < 0) {
        printf("shell: not running\n");
        return 1;
    }
    printf("shell: running (pid %d)\n", (int)pid);
    return 0;
}

static int cmd_shell_kill(void)
{
    pid_t pid = shell_pid();
    if (pid < 0) {
        fprintf(stderr, "error: shell is not running\n");
        return 1;
    }
    if (kill(pid, SIGTERM) != 0) {
        fprintf(stderr, "error: cannot signal the shell: %s\n",
                strerror(errno));
        return 1;
    }
    /* Give it up to 5 s to exit cleanly, then SIGKILL. */
    for (int i = 0; i < 50; i++) {
        if (kill(pid, 0) != 0) {
            printf("shell stopped (pid %d)\n", (int)pid);
            return 0;
        }
        usleep(100000);
    }
    kill(pid, SIGKILL);
    printf("shell stopped (pid %d, forced)\n", (int)pid);
    return 0;
}

static int cmd_shell_start(void)
{
    pid_t pid = shell_pid();
    if (pid >= 0) {
        fprintf(stderr, "error: shell is already running (pid %d)\n",
                (int)pid);
        return 1;
    }
    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "error: fork failed: %s\n", strerror(errno));
        return 1;
    }
    if (child == 0) {
        /* Detach: the shell outlives this CLI process. stderr goes
         * to the host log, like init does; stdin/out are /dev/null. */
        setsid();
        int logfd = open(SHELL_LOG, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (logfd >= 0)
            dup2(logfd, STDERR_FILENO);
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0) {
            dup2(nullfd, STDIN_FILENO);
            dup2(nullfd, STDOUT_FILENO);
        }
        execl(SHELL_BIN, SHELL_BIN, (char *)NULL);
        _exit(127);
    }
    /* The child writes its pid file at startup; wait briefly and
     * confirm it is alive. */
    for (int i = 0; i < 20; i++) {
        usleep(100000);
        if (shell_pid() >= 0)
            break;
    }
    pid = shell_pid();
    if (pid < 0) {
        fprintf(stderr, "error: shell did not start (see %s)\n",
                SHELL_LOG);
        return 1;
    }
    printf("shell started (pid %d)\n", (int)pid);
    return 0;
}

static int cmd_shell(int argc, char **argv)
{
    if (argc != 3)
        return usage();
    if (strcmp(argv[2], "status") == 0)
        return cmd_shell_status();
    if (strcmp(argv[2], "kill") == 0)
        return cmd_shell_kill();
    if (strcmp(argv[2], "start") == 0)
        return cmd_shell_start();
    if (strcmp(argv[2], "restart") == 0) {
        int rc = cmd_shell_kill();
        if (rc != 0)
            return rc;
        return cmd_shell_start();
    }
    return usage();
}

/* ------------------------------------------------------------------ */
/* files — real directories, through the CLI only                      */
/* ------------------------------------------------------------------ */

struct entry {
    char *name;
    char type; /* d = directory, f = file, l = link, ? = other */
};

static int cmp_entry(const void *a, const void *b)
{
    return strcmp(((const struct entry *)a)->name,
                  ((const struct entry *)b)->name);
}

static int cmd_files_list(const char *path)
{
    DIR *d = opendir(path);
    if (!d) {
        fprintf(stderr, "error: cannot list %s: %s\n", path,
                strerror(errno));
        return 1;
    }
    struct entry *list = NULL;
    size_t n = 0, cap = 0;
    struct dirent *de;
    while ((de = readdir(d)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 ||
            strcmp(de->d_name, "..") == 0)
            continue;
        if (n == cap) {
            cap = cap ? cap * 2 : 32;
            list = realloc(list, cap * sizeof(*list));
            if (!list) {
                closedir(d);
                return 1;
            }
        }
        char type = '?';
        if (de->d_type == DT_DIR)
            type = 'd';
        else if (de->d_type == DT_REG)
            type = 'f';
        else if (de->d_type == DT_LNK)
            type = 'l';
        else if (de->d_type == DT_UNKNOWN) {
            char full[4096];
            snprintf(full, sizeof(full), "%s/%s", path, de->d_name);
            struct stat st;
            if (stat(full, &st) == 0) {
                if (S_ISDIR(st.st_mode))
                    type = 'd';
                else if (S_ISREG(st.st_mode))
                    type = 'f';
                else if (S_ISLNK(st.st_mode))
                    type = 'l';
            }
        }
        list[n].name = strdup(de->d_name);
        list[n].type = type;
        n++;
    }
    closedir(d);
    qsort(list, n, sizeof(*list), cmp_entry);
    for (size_t i = 0; i < n; i++) {
        printf("%c %s\n", list[i].type, list[i].name);
        free(list[i].name);
    }
    free(list);
    return 0;
}

static int cmd_files_cat(const char *path)
{
    char *text = read_file_cap(path, 65536);
    if (!text) {
        fprintf(stderr, "error: cannot read %s: %s\n", path,
                strerror(errno));
        return 1;
    }
    fputs(text, stdout);
    free(text);
    return 0;
}

static int cmd_files(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    if (strcmp(argv[2], "list") == 0) {
        if (argc != 3 && argc != 4)
            return usage();
        return cmd_files_list(argc == 4 ? argv[3] : "/data");
    }
    if (strcmp(argv[2], "cat") == 0) {
        if (argc != 4)
            return usage();
        return cmd_files_cat(argv[3]);
    }
    if (strcmp(argv[2], "mkdir") == 0) {
        if (argc != 4)
            return usage();
        if (mkdir(argv[3], 0755) != 0 && errno != EEXIST) {
            fprintf(stderr, "error: cannot create %s: %s\n", argv[3],
                    strerror(errno));
            return 1;
        }
        printf("created %s\n", argv[3]);
        return 0;
    }
    if (strcmp(argv[2], "write") == 0) {
        if (argc < 5)
            return usage();
        FILE *f = fopen(argv[3], "w");
        if (!f) {
            fprintf(stderr, "error: cannot write %s: %s\n", argv[3],
                    strerror(errno));
            return 1;
        }
        size_t total = 0;
        for (int i = 4; i < argc; i++) {
            if (i > 4)
                fputc(' ', f);
            fputs(argv[i], f);
            total += strlen(argv[i]) + (i > 4 ? 1 : 0);
        }
        fputc('\n', f);
        total += 1;
        fclose(f);
        printf("wrote %zu bytes to %s\n", total, argv[3]);
        return 0;
    }
    return usage();
}

/* ------------------------------------------------------------------ */
/* code — Sevyn Code (code-server) status                              */
/* ------------------------------------------------------------------ */

/* HTTP GET / on 127.0.0.1:8080; true when the workbench HTML carries
 * the codeServerVersion marker (i.e. the IDE is really serving, not
 * just a process sitting there). */
static int code_serving(void)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0)
        return 0;
    struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8080);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return 0;
    }
    const char *req = "GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n";
    if (send(fd, req, strlen(req), 0) < 0) {
        close(fd);
        return 0;
    }
    char buf[65536];
    size_t n = 0;
    for (;;) {
        ssize_t r = recv(fd, buf + n, sizeof(buf) - n - 1, 0);
        if (r <= 0)
            break;
        n += (size_t)r;
        buf[n] = '\0';
        if (strstr(buf, "codeServerVersion"))
            break;
        if (n + 1 >= sizeof(buf))
            break;
    }
    close(fd);
    buf[n] = '\0';
    return strstr(buf, "codeServerVersion") != NULL;
}

static int cmd_code(int argc, char **argv)
{
    if (argc != 3 || strcmp(argv[2], "status") != 0)
        return usage();
    const char *pid_path = env_or("SEVYN_CODE_PID_FILE", CODE_PID_FILE);
    const char *settings_path =
        env_or("SEVYN_CODE_SETTINGS", CODE_SETTINGS);
    const char *root = env_or("SEVYN_CODE_ROOT", CODE_BIN_DIR);

    int running = 0;
    char *pid_text = read_file_cap(pid_path, 64);
    if (pid_text) {
        pid_t pid = (pid_t)atoi(pid_text);
        free(pid_text);
        if (pid > 0 && kill(pid, 0) == 0)
            running = 1;
    }
    int serving = code_serving();

    char pkg[4096];
    snprintf(pkg, sizeof(pkg), "%s/package.json", root);
    char *pkg_text = read_file_cap(pkg, 65536);
    char *version = NULL;
    if (pkg_text) {
        version = json_string_after(pkg_text, NULL, "\"version\"");
        free(pkg_text);
    }
    char *settings = read_file_cap(settings_path, 65536);
    char *profile = NULL;
    char *term_shell = NULL;
    if (settings) {
        profile = json_string_after(
            settings, NULL,
            "\"terminal.integrated.defaultProfile.linux\"");
        /* The profile's path: find the profile object, then its path. */
        const char *prof_at = profile ? strstr(settings, profile) : NULL;
        if (prof_at)
            term_shell =
                json_string_after(settings, prof_at, "\"path\"");
        free(settings);
    }
    printf("running: %s\n", running ? "yes" : "no");
    printf("serving: %s\n", serving ? "yes" : "no");
    printf("url: %s\n", CODE_URL);
    printf("version: %s\n", version ? version : "unknown");
    printf("terminal-profile: %s\n", profile ? profile : "unknown");
    printf("terminal-shell: %s\n", term_shell ? term_shell : "unknown");
    free(version);
    free(profile);
    free(term_shell);
    return running ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* dispatch + REPL                                                     */
/* ------------------------------------------------------------------ */

static int dispatch(int argc, char **argv)
{
    if (argc < 2)
        return usage();
    if (strcmp(argv[1], "help") == 0) {
        print_usage(stdout);
        return 0;
    }
    if (strcmp(argv[1], "update") == 0)
        return cmd_update(argc, argv);
    if (strcmp(argv[1], "shell") == 0)
        return cmd_shell(argc, argv);
    if (strcmp(argv[1], "files") == 0)
        return cmd_files(argc, argv);
    if (strcmp(argv[1], "code") == 0)
        return cmd_code(argc, argv);
    return usage();
}

/* No-args mode: the REPL. code-server spawns `sevyn` with no args
 * as its integrated terminal shell, so this must work standalone. */
static int repl(void)
{
    printf("SevynOS sevyn shell — type 'help' for commands, "
           "'exit' to quit.\n");
    char line[4096];
    for (;;) {
        printf("sevyn> ");
        fflush(stdout);
        if (!fgets(line, sizeof(line), stdin))
            break;
        /* Tokenize on whitespace (no quoting — same rule as the
         * exec bridge). */
        char *save = NULL;
        char *tok = strtok_r(line, " \t\r\n", &save);
        if (!tok)
            continue;
        if (strcmp(tok, "exit") == 0 || strcmp(tok, "quit") == 0)
            break;
        char *args[34];
        int argc = 0;
        args[argc++] = (char *)"sevyn";
        args[argc++] = tok;
        while (argc < 33 &&
               (tok = strtok_r(NULL, " \t\r\n", &save)) != NULL)
            args[argc++] = tok;
        args[argc] = NULL;
        dispatch(argc, args);
    }
    printf("\n");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 1)
        return repl();
    return dispatch(argc, argv);
}
