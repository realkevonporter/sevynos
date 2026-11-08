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
 *   sevyn browser open [url]    open a URL (launch Chromium if needed).
 *                               Prints "opened:" + the tab when CDP
 *                               answers, "launched:" when Chromium is
 *                               still starting (poll `browser status`
 *                               / `browser tabs` for readiness).
 *   sevyn browser tabs          list open tabs (CDP)
 *   sevyn browser activate <id> bring a tab forward
 *   sevyn browser close <id>    close a tab
 *   sevyn browser status        Chromium running? CDP answering? tabs?
 *   sevyn net status            link, address, gateway, DNS, wifi
 *   sevyn net dns <host>        resolve a name through the guest DNS
 *   sevyn net announce          announce the link state to statusd
 *                               (wifi on/off; init calls this at boot)
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
#include <ifaddrs.h>
#include <net/if.h>
#include <netdb.h>
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
#define CHROMIUM_BIN "/usr/share/sevyn/chromium/chrome"
#define CHROMIUM_PROFILE "/tmp/chromium-profile"
#define CHROMIUM_LOG "/tmp/chromium.log"
#define STATUS_SOCK "/run/sevyn-status.sock"

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

static const char *env_or(const char *name, const char *dflt)
{
    const char *v = getenv(name);
    return (v && *v) ? v : dflt;
}

/* Read a whole file (up to cap bytes). Returns malloc'd text or NULL. */
/* Read a small file into a malloc'd buffer (cap bytes max). Strips
 * trailing newlines/spaces: sysfs files (operstate, etc.) end with
 * "\n", and callers compare the value exactly (first_up_iface needs
 * operstate == "up", not "up\n"). Same contract as statusd's
 * read_sysfs. */
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
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' '))
        n--;
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
            "  sevyn files lines <path>    count the lines in a file\n"
            "  sevyn files cat <path> [start] [count]\n"
            "  sevyn files grep <path> <pattern>\n"
            "                            print a file (64 KB cap), optionally a line range\n"
            "  sevyn files mkdir <path>    create a directory\n"
            "  sevyn files write <path> <text...>\n"
            "                              write text to a file\n"
            "  sevyn ai list               list the plugged-in AIs\n"
            "  sevyn ai select <id>        plug in a different AI\n"
            "  sevyn ai status             show the selected AI + grant\n"
            "  sevyn ai ask <task...>      ask the AI to do something\n"
            "  sevyn code status           Sevyn Code: running, serving,\n"
            "                              version, terminal shell\n"
            "  sevyn browser open [url]    open a URL (launches Chromium\n"
            "                              if it is not running; prints\n"
            "                              \"opened:\" + tab, or \"launched:\"\n"
            "                              while Chromium is starting)\n"
            "  sevyn browser tabs          list open tabs\n"
            "  sevyn browser activate <id> bring a tab forward\n"
            "  sevyn browser close <id>    close a tab\n"
            "  sevyn browser status        Chromium + CDP + tab count\n"
            "  sevyn net status            link, address, gateway, DNS,\n"
            "                              wifi\n"
            "  sevyn net dns <host>        resolve a name (guest DNS)\n"
            "  sevyn net announce          announce the link state to\n"
            "                              statusd (wifi on/off)\n");
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

/* Connect to a daemon's Unix socket (env override, else default). */
static int connect_sock(const char *env_name, const char *dflt)
{
    const char *path = getenv(env_name);
    if (!path || !*path)
        path = dflt;
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

static int connect_daemon(void)
{
    return connect_sock("SEVYN_UPDATE_SOCK", DEFAULT_SOCK);
}

#define AI_SOCK "/run/sevyn-ai.sock"

static int connect_ai(void)
{
    return connect_sock("SEVYN_AI_SOCK", AI_SOCK);
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

/* Print a file, optionally a line range: cat <path> [start] [count]
 * (start is 1-based; count defaults to the rest of the file). The
 * Terminal only shows the last 21 lines, so a range is the only way
 * to page through a long file (e.g. /tmp/chromium.log). */
static int cmd_files_cat(const char *path, long start, long count)
{
    char *text = read_file_cap(path, 65536);
    if (!text) {
        fprintf(stderr, "error: cannot read %s: %s\n", path,
                strerror(errno));
        return 1;
    }
    if (start < 0) {
        /* Negative start = the last -start lines (a tail). Count the
         * lines, then print from (total + start + 1). */
        long total = 0;
        for (const char *q = text; *q; q++)
            if (*q == 10) total++;
        if (text[0] && text[strlen(text) - 1] != 10)
            total++;
        long from = total + start + 1;
        if (from < 1) from = 1;
        start = from;
        /* Keep an explicit count (e.g. -42 21 = 21 lines ending 21
         * before the end); only default to the rest of the file when
         * no count was given. */
        if (count < 0)
            count = -1;
    }
    if (start <= 1 && count < 0) {
        fputs(text, stdout);
        free(text);
        return 0;
    }
    long line = 1;
    const char *p = text;
    const char *line_start = text;
    while (*p) {
        if (*p == '\n') {
            if (line >= start && (count < 0 || line < start + count))
                fwrite(line_start, 1, (size_t)(p - line_start + 1),
                       stdout);
            line++;
            line_start = p + 1;
        }
        p++;
    }
    if (*line_start && line >= start &&
        (count < 0 || line < start + count))
        fputs(line_start, stdout);
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
    if (strcmp(argv[2], "lines") == 0) {
        if (argc != 4)
            return usage();
        char *text = read_file_cap(argv[3], 65536);
        if (!text) {
            fprintf(stderr, "error: cannot read %s: %s\n", argv[3],
                    strerror(errno));
            return 1;
        }
        long total = 0;
        for (const char *q = text; *q; q++)
            if (*q == 10) total++;
        if (text[0] && text[strlen(text) - 1] != 10)
            total++;
        printf("%ld\n", total);
        free(text);
        return 0;
    }
    if (strcmp(argv[2], "grep") == 0) {
        if (argc != 5)
            return usage();
        char *text = read_file_cap(argv[3], 65536);
        if (!text) {
            fprintf(stderr, "error: cannot read %s: %s\n", argv[3],
                    strerror(errno));
            return 1;
        }
        const char *needle = argv[4];
        long line = 1;
        const char *p = text;
        const char *line_start = text;
        for (;;) {
            if (*p == 10 || *p == 0) {
                size_t len = (size_t)(p - line_start);
                char *buf = malloc(len + 1);
                if (!buf) {
                    free(text);
                    return 1;
                }
                memcpy(buf, line_start, len);
                buf[len] = 0;
                if (strstr(buf, needle)) {
                    /* Truncate to 100 chars: the Terminal wraps long
                     * lines and the wrap overlaps, making them unreadable. */
                    if (len > 100)
                        buf[100] = 0;
                    printf("%ld: %s\n", line, buf);
                }
                free(buf);
                if (*p == 0)
                    break;
                line++;
                line_start = p + 1;
            }
            p++;
        }
        free(text);
        return 0;
    }
    if (strcmp(argv[2], "cat") == 0) {
        if (argc < 4 || argc > 6)
            return usage();
        long start = argc > 4 ? strtol(argv[4], NULL, 10) : 1;
        long count = argc > 5 ? strtol(argv[5], NULL, 10) : -1;
        return cmd_files_cat(argv[3], start, count);
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
/* ai (M4.5) — the AI connector CLI                                    */
/* ------------------------------------------------------------------ */

/* Talk to sevyn-aid (the AI daemon). list/select/status/ask map
 * straight onto the daemon's socket verbs; ask joins the task words
 * with spaces (no quoting — same rule as the exec bridge). */
static int cmd_ai(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    const char *verb = argv[2];

    if (strcmp(verb, "list") != 0 && strcmp(verb, "select") != 0 &&
        strcmp(verb, "status") != 0 && strcmp(verb, "ask") != 0)
        return usage();
    if (strcmp(verb, "select") == 0 && argc != 4)
        return usage();
    if (strcmp(verb, "ask") == 0 && argc < 4)
        return usage();
    if ((strcmp(verb, "list") == 0 || strcmp(verb, "status") == 0) &&
        argc != 3)
        return usage();

    int fd = connect_ai();
    if (fd < 0) {
        fprintf(stderr, "error: cannot reach the AI daemon\n");
        return 1;
    }

    char cmd[2048];
    if (strcmp(verb, "select") == 0)
        snprintf(cmd, sizeof(cmd), "SELECT %s", argv[3]);
    else if (strcmp(verb, "ask") == 0) {
        size_t n = 0;
        n += (size_t)snprintf(cmd + n, sizeof(cmd) - n, "ASK");
        for (int i = 3; i < argc && n < sizeof(cmd) - 1; i++)
            n += (size_t)snprintf(cmd + n, sizeof(cmd) - n, " %s",
                                  argv[i]);
    } else if (strcmp(verb, "list") == 0)
        snprintf(cmd, sizeof(cmd), "LIST");
    else
        snprintf(cmd, sizeof(cmd), "STATUS");
    if (send_line(fd, cmd) != 0) {
        fprintf(stderr, "error: cannot talk to the AI daemon\n");
        close(fd);
        return 1;
    }
    char line[2048];
    int n = read_line(fd, line, sizeof(line));
    close(fd);
    if (n <= 0) {
        fprintf(stderr, "error: no reply from the AI daemon\n");
        return 1;
    }
    return print_reply(line);
}

/* ------------------------------------------------------------------ */
/* browser (M5) — Chromium over CDP                                    */
/* ------------------------------------------------------------------ */

/* Chromium runs as a real Wayland client (--ozone-platform=wayland)
 * with its DevTools port on 127.0.0.1:9222. The CLI drives it over
 * plain CDP HTTP: GET /json/version (is it up?), GET /json/list
 * (tabs), PUT /json/new?<url> (new tab — GET is 405 on modern
 * Chromium, so this needs a real HTTP client, not wget), GET
 * /json/activate/<id>, GET /json/close/<id>. Env overrides exist so
 * the host-side test can point at a stub: SEVYN_CDP_PORT,
 * SEVYN_CHROMIUM_BIN, SEVYN_CDP_WAIT_S. */

static int cdp_port(void)
{
    const char *v = getenv("SEVYN_CDP_PORT");
    if (v && *v) {
        int p = atoi(v);
        if (p > 0 && p < 65536)
            return p;
    }
    return 9222;
}

/* One CDP HTTP request. Returns the HTTP status code (0 on transport
 * failure); body_out gets the response body, NUL-terminated (up to
 * cap-1 bytes). Reads Content-Length bytes of body, then returns —
 * it must NOT wait for EOF (see the read loop). */
static int cdp_request(const char *method, const char *path, char *body_out,
                       size_t cap)
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
    addr.sin_port = htons((uint16_t)cdp_port());
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return 0;
    }
    char req[4096];
    /* HTTP/1.1 + Connection: close. Chromium's DevTools server
     * silently drops HTTP/1.0 requests (closes without responding),
     * so the CLI could never see CDP — every browser status/tabs
     * call reported "not running" even with Chromium up and curl
     * answering (diagnosed 2026-11-08 against the real server; the
     * unit test's fake Python CDP server accepted 1.0, hiding it). */
    int rn = snprintf(req, sizeof(req),
                      "%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                      "Connection: close\r\n\r\n", method,
                      path);
    if (rn < 0 || (size_t)rn >= sizeof(req)) {
        close(fd);
        return 0;
    }
    if (send(fd, req, (size_t)rn, 0) < 0) {
        close(fd);
        return 0;
    }
    /* Read headers + body. We send HTTP/1.1, so the server may keep
     * the connection open after the body (keep-alive) instead of
     * closing it; reading until EOF would burn the whole 5 s socket
     * timeout on EVERY request, and browser status (3 requests)
     * would exceed the host's 10 s exec limit under TCG. Parse
     * Content-Length and stop once the full body has arrived. */
    char *buf = malloc(cap + 4096);
    if (!buf) {
        close(fd);
        return 0;
    }
    size_t n = 0;
    size_t want = (size_t)-1; /* total bytes wanted (headers + body) */
    for (;;) {
        if (n >= cap + 4095)
            break;
        if (want != (size_t)-1 && n >= want)
            break;
        ssize_t r = recv(fd, buf + n, cap + 4095 - n, 0);
        if (r <= 0)
            break;
        n += (size_t)r;
        if (want == (size_t)-1) {
            /* Look for the end of headers, then Content-Length. */
            buf[n] = 0;
            const char *hdr_end = strstr(buf, "\r\n\r\n");
            if (hdr_end) {
                size_t hlen = (size_t)(hdr_end + 4 - buf);
                long clen = -1;
                const char *cl = strcasestr(buf, "Content-Length:");
                if (cl && cl < hdr_end)
                    clen = strtol(cl + 15, NULL, 10);
                if (clen >= 0)
                    want = hlen + (size_t)clen;
                else
                    want = n; /* no length: take what we have */
            }
        }
    }
    close(fd);
    buf[n] = '\0';
    /* HTTP status line: "HTTP/1.1 200 OK". */
    int status = 0;
    if (n >= 12 && strncmp(buf, "HTTP/", 5) == 0)
        status = atoi(buf + 9);
    const char *body = strstr(buf, "\r\n\r\n");
    if (body)
        body += 4;
    else
        body = buf + n;
    size_t blen = (size_t)(buf + n - body);
    if (blen >= cap)
        blen = cap - 1;
    memcpy(body_out, body, blen);
    body_out[blen] = '\0';
    free(buf);
    return status;
}

/* Is Chromium up and answering CDP? */
static int browser_running(void)
{
    char body[4096];
    return cdp_request("GET", "/json/version", body, sizeof(body)) == 200;
}

/* Launch Chromium detached and return immediately. The caller must
 * NOT wait for CDP here: the host exec kills this CLI after 10 s,
 * and Chromium's cold start (a 365 MB binary) is slower than that
 * under TCG — the old code waited up to 60 s for CDP and was killed
 * at 10 s on every cold start (M5 local run, 2026-11-07). Double
 * fork: the intermediate child exits at once (the CLI reaps it),
 * the grandchild setsid + execs Chromium and re-parents to init.
 * The old single fork also blocked the CLI in waitpid until
 * Chromium exited — a healthy launch hung the CLI forever.
 * Returns 0 when the launch was attempted (the fork succeeded), 1
 * when even the fork failed. Whether Chromium actually came up is
 * observable via `browser status` (running: yes + cdp: yes) and
 * via /tmp/chromium.log (Chromium's stdout/stderr). The URL (if
 * any) is the first tab; without one Chromium opens about:blank. */
static int browser_launch(const char *url)
{
    const char *bin = env_or("SEVYN_CHROMIUM_BIN", CHROMIUM_BIN);
    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "error: fork failed: %s\n", strerror(errno));
        return 1;
    }
    if (child == 0) {
        /* Intermediate child: fork once more and exit, so the CLI
         * parent reaps this child immediately and the grandchild
         * (Chromium) is re-parented to init. */
        pid_t grand = fork();
        if (grand < 0)
            _exit(127);
        if (grand > 0)
            _exit(0);
        /* Grandchild: Chromium. Detach, point it at the compositor
         * and the staged CA bundle, send its output to the
         * chromium log, stdin from /dev/null. */
        setsid();
        if (!getenv("WAYLAND_DISPLAY"))
            setenv("WAYLAND_DISPLAY", "wayland-0", 1);
        if (!getenv("XDG_RUNTIME_DIR"))
            setenv("XDG_RUNTIME_DIR", "/run", 1);
        /* System CA bundle for TLS (the image stages
         * /etc/ssl/certs; Chromium honours SSL_CERT_FILE). */
        if (!getenv("SSL_CERT_FILE"))
            setenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt",
                   1);
        int logfd = open(CHROMIUM_LOG, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (logfd >= 0) {
            dup2(logfd, STDOUT_FILENO);
            dup2(logfd, STDERR_FILENO);
        }
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd >= 0)
            dup2(nullfd, STDIN_FILENO);
        char port[32];
        snprintf(port, sizeof(port), "--remote-debugging-port=%d",
                 cdp_port());
        char datadir[512];
        snprintf(datadir, sizeof(datadir), "--user-data-dir=%s",
                 CHROMIUM_PROFILE);
        /* --window-size=800,500: the same size class as the .sevyn
         * app windows, so the compositor cascades it alongside them
         * instead of maximising it over the shell. */
        /* --disable-gpu: the GPU process cannot start in the
         * image — Mesa has no DRI driver for virtio-gpu
         * (/usr/lib/dri/virtio_gpu_dri.so is absent), so ANGLE's EGL
         * init fails, all EGL display types fail, and the GPU process
         * exits; the browser then never answers CDP (diagnosed
         * 2026-11-07 via /tmp/chromium.log). Software rendering is
         * the right call anyway: the shell's compositor is the pixman
         * CPU renderer, so there is no GPU to use. */
        /* DBUS_SESSION_BUS_ADDRESS=/dev/null: the image runs no
         * D-Bus daemon, so Chromium's startup D-Bus calls (session
         * bus) otherwise block on a ~25s connect timeout each and
         * the browser never reaches CDP in time (diagnosed
         * 2026-11-07 via /tmp/chromium.log — the log was full of
         * dbus/object_proxy "Failed to call method" + "Failed to
         * connect to the bus" lines). /dev/null makes those calls
         * fail fast. The system bus already fails fast (its socket
         * does not exist). */
        setenv("DBUS_SESSION_BUS_ADDRESS", "/dev/null", 1);
        if (url && *url)
            execl(bin, bin, "--no-sandbox", "--disable-gpu",
                  "--disable-dev-shm-usage",
                  "--disable-crash-reporter",
                  "--disable-component-update",
                  "--no-first-run",
                  "--ozone-platform=wayland",
                  "--window-size=800,500",
                  port, datadir, url, (char *)NULL);
        else
            execl(bin, bin, "--no-sandbox", "--disable-gpu",
                  "--disable-dev-shm-usage",
                  "--disable-crash-reporter",
                  "--disable-component-update",
                  "--no-first-run",
                  "--ozone-platform=wayland",
                  "--window-size=800,500",
                  port, datadir, (char *)NULL);
        /* execl failed: stderr is the chromium log, so the reason
         * lands there for `sevyn files cat /tmp/chromium.log`. */
        fprintf(stderr, "error: exec %s failed: %s\n", bin,
                strerror(errno));
        _exit(127);
    }
    /* Reap the intermediate child (it exits at once); Chromium
     * outlives us. */
    int st;
    while (waitpid(child, &st, 0) < 0 && errno == EINTR) {
    }
    return 0;
}

/* Prepend https:// when the URL has no scheme (the address bar and
 * the CLI both accept bare hostnames). */
static void normalize_url(const char *url, char *out, size_t cap)
{
    if (strstr(url, "://") != NULL) {
        snprintf(out, cap, "%s", url);
        return;
    }
    snprintf(out, cap, "https://%s", url);
}

/* Extract one page target's id/title/url from a /json/list body.
 * Targets are flat objects; find each `"type": "page"`, take the
 * enclosing { ... } slice, and pull the three fields out of it. The
 * callback gets (id, title, url) per page tab. */
static void for_each_page_tab(const char *body,
                              void (*fn)(const char *, const char *,
                                         const char *, void *),
                              void *ctx)
{
    const char *p = body;
    for (;;) {
        const char *type = strstr(p, "\"type\": \"page\"");
        if (!type)
            return;
        /* Enclosing object: last '{' before the type, first '}'
         * after it. */
        const char *open = type;
        while (open > body && *open != '{')
            open--;
        const char *close = strchr(type, '}');
        if (!close || *open != '{') {
            p = type + 1;
            continue;
        }
        size_t n = (size_t)(close - open + 1);
        char *obj = malloc(n + 1);
        if (!obj) {
            p = type + 1;
            continue;
        }
        memcpy(obj, open, n);
        obj[n] = '\0';
        char *id = json_string_after(obj, NULL, "\"id\"");
        char *title = json_string_after(obj, NULL, "\"title\"");
        char *url = json_string_after(obj, NULL, "\"url\"");
        if (id && title && url)
            fn(id, title, url, ctx);
        free(id);
        free(title);
        free(url);
        free(obj);
        p = close + 1;
    }
}

struct tab_count {
    int n;
};

static void count_tab(const char *id, const char *title, const char *url,
                      void *ctx)
{
    (void)id;
    (void)title;
    (void)url;
    ((struct tab_count *)ctx)->n++;
}

static void print_tab(const char *id, const char *title, const char *url,
                      void *ctx)
{
    (void)ctx;
    printf("TAB %s\t%s\t%s\n", id, title, url);
}

/* Find the first page tab whose URL equals `want` (the tab Chromium
 * opens with when it is launched with a URL). Captures id/title/url
 * into the context; the caller frees them. */
struct tab_by_url {
    const char *want;
    char *id;
    char *title;
    char *url;
};

static void find_tab_by_url(const char *id, const char *title,
                            const char *url, void *ctx)
{
    struct tab_by_url *t = (struct tab_by_url *)ctx;
    if (t->id)
        return;
    if (strcmp(url, t->want) != 0)
        return;
    t->id = strdup(id);
    t->title = strdup(title);
    t->url = strdup(url);
}

static int cmd_browser_status(void)
{
    if (!browser_running()) {
        printf("running: no\n");
        return 1;
    }
    char body[262144];
    char ver[4096];
    int tabs = 0;
    char *version = NULL;
    if (cdp_request("GET", "/json/list", body, sizeof(body)) == 200) {
        struct tab_count c = { 0 };
        for_each_page_tab(body, count_tab, &c);
        tabs = c.n;
    }
    if (cdp_request("GET", "/json/version", ver, sizeof(ver)) == 200)
        version = json_string_after(ver, NULL, "\"Browser\"");
    printf("running: yes\n");
    printf("cdp: yes\n");
    printf("tabs: %d\n", tabs);
    printf("version: %s\n", version ? version : "unknown");
    free(version);
    return 0;
}

static int cmd_browser(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    const char *verb = argv[2];

    if (strcmp(verb, "status") == 0) {
        if (argc != 3)
            return usage();
        return cmd_browser_status();
    }
    if (strcmp(verb, "tabs") == 0) {
        if (argc != 3)
            return usage();
        if (!browser_running()) {
            fprintf(stderr, "error: Chromium is not running\n");
            return 1;
        }
        char body[262144];
        if (cdp_request("GET", "/json/list", body, sizeof(body)) != 200) {
            fprintf(stderr, "error: CDP /json/list failed\n");
            return 1;
        }
        for_each_page_tab(body, print_tab, NULL);
        return 0;
    }
    if (strcmp(verb, "open") == 0) {
        if (argc != 3 && argc != 4)
            return usage();
        const char *raw = argc == 4 ? argv[3] : "about:blank";
        char url[2048];
        normalize_url(raw, url, sizeof(url));
        if (!browser_running()) {
            /* Cold start: launch Chromium with the URL as its first
             * tab, then wait a BOUNDED time for CDP so a fast start
             * returns the tab synchronously. The wait must stay well
             * under the host's 10 s exec timeout (default 6 s) — a
             * slow start under TCG returns "launched" and the caller
             * polls `browser status` / `browser tabs` for readiness
             * (the URL opens as Chromium's first tab once it is up).
             * SEVYN_CDP_WAIT_S overrides the wait. */
            if (browser_launch(url) != 0)
                return 1;
            const char *wait_s = env_or("SEVYN_CDP_WAIT_S", "6");
            int wait = atoi(wait_s);
            if (wait <= 0)
                wait = 6;
            for (int i = 0; i < wait * 5; i++) {
                if (browser_running())
                    break;
                usleep(200000);
            }
            if (browser_running()) {
                char body[262144];
                struct tab_by_url t = { .want = url };
                if (cdp_request("GET", "/json/list", body,
                                sizeof(body)) == 200)
                    for_each_page_tab(body, find_tab_by_url, &t);
                printf("opened: %s\n", url);
                if (t.id)
                    printf("tab: %s\t%s\t%s\n", t.id,
                           t.title ? t.title : "",
                           t.url ? t.url : url);
                free(t.id);
                free(t.title);
                free(t.url);
                return 0;
            }
            printf("launched: %s\n", url);
            return 0;
        }
        char path[4096];
        snprintf(path, sizeof(path), "/json/new?%s", url);
        char body[65536];
        if (cdp_request("PUT", path, body, sizeof(body)) != 200) {
            fprintf(stderr, "error: CDP /json/new failed for %s\n", url);
            return 1;
        }
        char *id = json_string_after(body, NULL, "\"id\"");
        char *title = json_string_after(body, NULL, "\"title\"");
        char *turl = json_string_after(body, NULL, "\"url\"");
        printf("opened: %s\n", url);
        if (id && title && turl)
            printf("tab: %s\t%s\t%s\n", id, title, turl);
        free(id);
        free(title);
        free(turl);
        return 0;
    }
    if (strcmp(verb, "activate") == 0 || strcmp(verb, "close") == 0) {
        if (argc != 4)
            return usage();
        if (!browser_running()) {
            fprintf(stderr, "error: Chromium is not running\n");
            return 1;
        }
        char path[4096];
        snprintf(path, sizeof(path), "/json/%s/%s", verb, argv[3]);
        if (cdp_request("GET", path, (char[4096]){ 0 }, 4096) != 200) {
            fprintf(stderr, "error: no such tab %s\n", argv[3]);
            return 1;
        }
        printf("%s: %s\n", strcmp(verb, "activate") == 0 ? "activated" : "closed",
               argv[3]);
        return 0;
    }
    return usage();
}

/* ------------------------------------------------------------------ */
/* net (M5) — link state, DNS, and the wifi announce                   */
/* ------------------------------------------------------------------ */

/* First non-loopback interface that is usable: administratively up
 * (IFF_UP) with an IPv4 address, and a link that is up or
 * unreported (operstate "up" or "unknown"). IFF_RUNNING is NOT
 * required — it is a legacy flag modern drivers do not set: the
 * guest's virtio-net eth0 shows <BROADCAST,MULTICAST,UP,LOWER_UP>
 * and the sandbox veth shows flags 0x1003 (UP only), yet both have
 * a working link (operstate "up"). Requiring IFF_RUNNING made
 * `net status` report "interface: none" on a live link (M5 local
 * run, 2026-11-07). operstate is the link signal now: "up" means
 * the link is up, "unknown" means the driver does not report it
 * (common for virtual devices), anything else means no link. */
static int first_up_iface(char *name, size_t name_cap, char *addr,
                          size_t addr_cap)
{
    struct ifaddrs *ifa = NULL;
    if (getifaddrs(&ifa) != 0)
        return 0;
    int found = 0;
    for (struct ifaddrs *p = ifa; p; p = p->ifa_next) {
        if (!p->ifa_name || !p->ifa_addr)
            continue;
        if (strcmp(p->ifa_name, "lo") == 0)
            continue;
        if (p->ifa_addr->sa_family != AF_INET)
            continue;
        if (!(p->ifa_flags & IFF_UP))
            continue;
        char state_path[256];
        snprintf(state_path, sizeof(state_path),
                 "/sys/class/net/%s/operstate", p->ifa_name);
        char *state = read_file_cap(state_path, 32);
        if (!state || (strcmp(state, "up") != 0 &&
                       strcmp(state, "unknown") != 0)) {
            free(state);
            continue;
        }
        free(state);
        snprintf(name, name_cap, "%s", p->ifa_name);
        struct sockaddr_in *sin = (struct sockaddr_in *)p->ifa_addr;
        inet_ntop(AF_INET, &sin->sin_addr, addr, (socklen_t)addr_cap);
        found = 1;
        break;
    }
    freeifaddrs(ifa);
    return found;
}

/* Default gateway from /proc/net/route (first 00000000 destination). */
static int default_gateway(char *out, size_t cap)
{
    FILE *f = fopen("/proc/net/route", "r");
    if (!f)
        return 0;
    char line[512];
    /* Skip the header. */
    if (!fgets(line, sizeof(line), f)) {
        fclose(f);
        return 0;
    }
    while (fgets(line, sizeof(line), f)) {
        char iface[64], dest[64], gw[64];
        if (sscanf(line, "%63s %63s %63s", iface, dest, gw) != 3)
            continue;
        if (strcmp(dest, "00000000") != 0)
            continue;
        unsigned int g = (unsigned int)strtoul(gw, NULL, 16);
        struct in_addr a;
        /* /proc/net/route prints the gateway little-endian. */
        a.s_addr = g;
        inet_ntop(AF_INET, &a, out, (socklen_t)cap);
        fclose(f);
        return 1;
    }
    fclose(f);
    return 0;
}

/* First nameserver from /etc/resolv.conf. */
static int first_nameserver(char *out, size_t cap)
{
    FILE *f = fopen("/etc/resolv.conf", "r");
    if (!f)
        return 0;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char ns[128];
        if (sscanf(line, "nameserver %127s", ns) == 1) {
            snprintf(out, cap, "%s", ns);
            fclose(f);
            return 1;
        }
    }
    fclose(f);
    return 0;
}

/* The live wifi value from statusd (GET over the status socket). */
static int status_wifi(char *out, size_t cap)
{
    int fd = connect_sock("SEVYN_STATUS_SOCK", STATUS_SOCK);
    if (fd < 0)
        return 0;
    if (send_line(fd, "GET") != 0) {
        close(fd);
        return 0;
    }
    char line[512];
    int got = 0;
    for (;;) {
        int n = read_line(fd, line, sizeof(line));
        if (n <= 0)
            break;
        if (strncmp(line, "STATUS wifi ", 12) == 0) {
            size_t vlen = strlen(line + 12);
            if (vlen >= cap)
                vlen = cap - 1;
            memcpy(out, line + 12, vlen);
            out[vlen] = '\0';
            got = 1;
        }
        /* GET sends all three values, then keeps the socket open;
         * stop once wifi has arrived. */
        if (got)
            break;
    }
    close(fd);
    return got;
}

static int cmd_net_status(void)
{
    char name[IFNAMSIZ] = "";
    char addr[INET_ADDRSTRLEN] = "";
    char gw[INET_ADDRSTRLEN] = "";
    char dns[128] = "";
    char wifi[64] = "";
    int up = first_up_iface(name, sizeof(name), addr, sizeof(addr));
    default_gateway(gw, sizeof(gw));
    first_nameserver(dns, sizeof(dns));
    if (!status_wifi(wifi, sizeof(wifi)))
        snprintf(wifi, sizeof(wifi), "%s", up ? "on" : "off");
    printf("interface: %s\n", up ? name : "none");
    printf("address: %s\n", up ? addr : "none");
    printf("gateway: %s\n", gw[0] ? gw : "none");
    printf("dns: %s\n", dns[0] ? dns : "none");
    printf("wifi: %s\n", wifi);
    return 0;
}

static int cmd_net_dns(const char *host)
{
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(host, NULL, &hints, &res);
    if (rc != 0 || !res) {
        fprintf(stderr, "error: cannot resolve %s: %s\n", host,
                gai_strerror(rc));
        return 1;
    }
    char ip[INET_ADDRSTRLEN];
    struct sockaddr_in *sin = (struct sockaddr_in *)res->ai_addr;
    inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
    printf("%s %s\n", host, ip);
    freeaddrinfo(res);
    return 0;
}

/* Read the link state and announce it to statusd (wifi on/off).
 * Init calls this once the interface is up; the value is what the
 * shell tray shows. */
static int cmd_net_announce(void)
{
    char name[IFNAMSIZ] = "";
    char addr[INET_ADDRSTRLEN] = "";
    int up = first_up_iface(name, sizeof(name), addr, sizeof(addr));
    int fd = connect_sock("SEVYN_STATUS_SOCK", STATUS_SOCK);
    if (fd < 0) {
        fprintf(stderr, "error: cannot reach the status daemon\n");
        return 1;
    }
    char cmd[64];
    snprintf(cmd, sizeof(cmd), "SET wifi %s", up ? "on" : "off");
    if (send_line(fd, cmd) != 0) {
        fprintf(stderr, "error: cannot talk to the status daemon\n");
        close(fd);
        return 1;
    }
    close(fd);
    printf("wifi: %s\n", up ? "on" : "off");
    return 0;
}

static int cmd_net(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    if (strcmp(argv[2], "status") == 0) {
        if (argc != 3)
            return usage();
        return cmd_net_status();
    }
    if (strcmp(argv[2], "dns") == 0) {
        if (argc != 4)
            return usage();
        return cmd_net_dns(argv[3]);
    }
    if (strcmp(argv[2], "announce") == 0) {
        if (argc != 3)
            return usage();
        return cmd_net_announce();
    }
    if (strcmp(argv[2], "tcp") == 0) {
        /* net tcp <host> <port>: is anything listening? A plain TCP
         * connect (no HTTP) — separates "nothing listening" from
         * "listening but the HTTP exchange fails" when debugging
         * a service (e.g. Chromium's CDP on 9222). */
        if (argc != 5)
            return usage();
        struct addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        struct addrinfo *res = NULL;
        if (getaddrinfo(argv[3], argv[4], &hints, &res) != 0) {
            printf("tcp: %s:%s resolve failed\n", argv[3], argv[4]);
            return 1;
        }
        int fd = socket(res->ai_family, SOCK_STREAM, 0);
        if (fd < 0) {
            freeaddrinfo(res);
            return 1;
        }
        struct timeval tv = { .tv_sec = 5, .tv_usec = 0 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        int ok = connect(fd, res->ai_addr, res->ai_addrlen) == 0;
        close(fd);
        freeaddrinfo(res);
        printf("tcp: %s:%s %s\n", argv[3], argv[4],
               ok ? "open" : "closed");
        return ok ? 0 : 1;
    }
    return usage();
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
    if (strcmp(argv[1], "ai") == 0)
        return cmd_ai(argc, argv);
    if (strcmp(argv[1], "shell") == 0)
        return cmd_shell(argc, argv);
    if (strcmp(argv[1], "files") == 0)
        return cmd_files(argc, argv);
    if (strcmp(argv[1], "code") == 0)
        return cmd_code(argc, argv);
    if (strcmp(argv[1], "browser") == 0)
        return cmd_browser(argc, argv);
    if (strcmp(argv[1], "net") == 0)
        return cmd_net(argc, argv);
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
