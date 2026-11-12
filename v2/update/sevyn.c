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
 *   sevyn files write <path> <text...>  write text to a file (create/truncate)
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
 *   sevyn poweroff              power the system off (clean teardown)
 *   sevyn reboot                reboot the system (clean teardown)
 *
 * Exit 0 on success, 1 on error. No shell quoting, no pipes, no
 * globbing anywhere in this CLI — the exec bridge splits on
 * whitespace and the CLI takes argv as-is.
 *
 * Build: gcc, libc only.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <limits.h>
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
/* Chromium's stdout/stderr. On /data (not /tmp) so the log survives
 * poweroff and rides along in the uploaded m5-data.img artifact —
 * the CI-only Chromium crash (M5, 2026-11-08) was undiagnosable
 * while the log lived on the guest tmpfs. /data is the persistent
 * data disk, mounted at boot, so it is writable whenever Chromium
 * can launch. */
#define CHROMIUM_LOG "/data/chromium.log"
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
            "  sevyn poweroff            power the system off (clean teardown)\n"
            "  sevyn reboot              reboot the system (clean teardown)\n"
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
            "  sevyn comms [--socket <path>] <verb>\n"
            "                              talk to a commsd other than the\n"
            "                              system one (the M10 check runs a\n"
            "                              second daemon for the peer)\n"
            "  sevyn comms status          Matrix login state + calls\n"
            "  sevyn comms login <user> [password] [homeserver]\n"
            "                              log into Matrix (password from\n"
            "                              argv, --password-file, or stdin)\n"
            "  sevyn comms logout          forget the Matrix account\n"
            "  sevyn comms rooms           list Matrix rooms (JSON)\n"
            "  sevyn comms messages <room> [limit]\n"
            "                              list messages (JSON)\n"
            "  sevyn comms send <room> <text...>\n"
            "                              send a message\n"
            "  sevyn comms call <room|user> [--video|--audio]\n"
            "                              start a 1:1 call\n"
            "  sevyn comms answer <callId> answer an incoming call\n"
            "  sevyn comms hangup <callId> end a call\n"
            "  sevyn comms calls           list calls (JSON)\n"
            "  sevyn comms rcs status      RCS staging state\n"
            "  sevyn comms rcs probe       SIP/MSRP skeleton vs mock ACS\n"
            "  sevyn net status            link, address, gateway, DNS,\n"
            "                              wifi\n"
            "  sevyn net dns <host>        resolve a name (guest DNS)\n"
            "  sevyn net announce          announce the link state to\n"
            "                              statusd (wifi on/off)\n"
            "  sevyn net wifi scan         scan for wireless networks\n"
            "  sevyn net wifi status       association state, SSID,\n"
            "                              address\n"
            "  sevyn net wifi connect <ssid> [password]\n"
            "                              join a network (WPA2 PSK or\n"
            "                              open); saves it for later\n"
            "  sevyn net wifi disconnect   drop the association\n"
            "  sevyn net wifi forget <ssid> remove a saved network\n"
            "  sevyn install probe [--disk <disk>]\n"
            "                              list disks, partitions, and\n"
            "                              detected OSes (read-only)\n"
            "  sevyn install plan --disk <disk> [--target auto|free|<part>]\n"
            "                              show the install plan (what\n"
            "                              will be created, protected,\n"
            "                              replaced)\n"
            "  sevyn install install --disk <disk> [--target ...] --yes\n"
            "                              install SevynOS alongside\n"
            "                              Windows 11 (needs --yes)\n"
            "  sevyn install status        installed? dual-boot?\n"
            "  sevyn net fetch --method <m> <url> [--header <N:V>] [--data <b>]\n"
            "                              one plain HTTP request; prints\n"
            "                              status, headers JSON, body\n"
            "                              (http only; the host fetch bridge)\n"
            "  sevyn tokrah run [--seconds N] [--width W] [--height H]\n"
            "                   [--input <f>] [--out <f>]\n"
            "                              run Tokrah headless (M6 bring-up:\n"
            "                              mounts + presents with no window)\n"
            "  sevyn app run <id> [--seconds N] [--width W] [--height H]\n"
            "                   [--input <f>] [--out <f>] [--name <n>]\n"
            "                   [--color <#hex>] [--glyph <g>]\n"
            "                   [--permissions <csv>]\n"
            "                              run an installed app headless\n"
            "                              (M9: the check drives the app\n"
            "                              screens through it, as tokrah run\n"
            "                              does for Tokrah)\n");
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
 * to page through a long file (e.g. /data/chromium.log). */
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
/* comms (M10) — Matrix messaging + 1:1 calls via commsd               */
/* ------------------------------------------------------------------ */

/* Talk to commsd (the Matrix daemon). One line out, one (possibly
 * long — rooms/messages are JSON arrays) line back. The daemon's
 * replies are a single bare JSON line ({ok:true,...} or
 * {ok:false,error:...}); print_reply prints it verbatim, so the RN
 * apps JSON.parse the payload — and the exit code follows the
 * payload's ok flag, so a failed verb (bad login, failed RCS probe)
 * exits 1 instead of silently succeeding. */
#define COMMS_SOCK "/run/sevyn-comms.sock"

static int connect_comms(void)
{
    return connect_sock("SEVYN_COMMS_SOCK", COMMS_SOCK);
}

/* send_line's 2048 cap is too small for a message; this one takes
 * up to 8192 bytes (room id + text). */
static int comms_send(int fd, const char *line)
{
    size_t n = strlen(line);
    char buf[8192];
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

static int comms_roundtrip(const char *cmd)
{
    int fd = connect_comms();
    if (fd < 0) {
        fprintf(stderr, "error: cannot reach the comms daemon\n");
        return 1;
    }
    if (comms_send(fd, cmd) != 0) {
        fprintf(stderr, "error: cannot talk to the comms daemon\n");
        close(fd);
        return 1;
    }
    static char reply[65536];
    int n = read_line(fd, reply, sizeof(reply));
    close(fd);
    if (n <= 0) {
        fprintf(stderr, "error: no reply from the comms daemon\n");
        return 1;
    }
    /* The daemon answers bare JSON, not the "OK "/"ERR " lines the
     * other daemons speak — print_reply prints it verbatim (the RN
     * apps parse it), but its fallthrough returns 0 even for
     * {ok:false,...}. The exit code must follow the payload: a failed
     * verb exits 1. (ok is always the daemon's first key.) */
    int rc = print_reply(reply);
    if (rc == 0 && strncmp(reply, "{\"ok\":false", 11) == 0)
        return 1;
    return rc;
}

/* Read a password from a file (and unlink it right after — the file
 * must not linger). Returns 0 on success. */
static int read_password_file(const char *path, char *out, size_t cap)
{
    FILE *f = fopen(path, "r");
    if (!f)
        return -1;
    size_t n = fread(out, 1, cap - 1, f);
    fclose(f);
    unlink(path);
    while (n > 0 && (out[n - 1] == '\n' || out[n - 1] == '\r'))
        n--;
    out[n] = '\0';
    return n > 0 ? 0 : -1;
}

static int cmd_comms(int argc, char **argv)
{
    if (argc < 3)
        return usage();
    /* --socket <path> talks to a commsd other than the system one.
     * (The M10 check runs a second daemon for the peer user, and the
     * Terminal has no shell env assignment, so the socket must ride
     * on the command line. setenv is safe here: this process runs
     * one command, then exits.) */
    if (strcmp(argv[2], "--socket") == 0) {
        if (argc < 5)
            return usage();
        setenv("SEVYN_COMMS_SOCK", argv[3], 1);
        argv += 2;
        argc -= 2;
    }
    const char *verb = argv[2];

    if (strcmp(verb, "login") == 0) {
        /* login <user> [--password-file <path> | <password>]
         *        [homeserver]
         * The password comes from argv (the RN apps have no stdin —
         * same root-only visibility as `sevyn files write`), from a
         * --password-file (read + unlinked at once), or from stdin
         * (the Terminal). It travels to the daemon over the local
         * socket only, and is never logged. Passwords with spaces
         * are not supported (the daemon's protocol is whitespace
         * separated). */
        if (argc < 4 || argc > 7)
            return usage();
        const char *user = argv[3];
        const char *homeserver = NULL;
        char password[1024];
        if (argc >= 5 && strcmp(argv[4], "--password-file") == 0) {
            if (argc < 6)
                return usage();
            if (read_password_file(argv[5], password, sizeof(password)) != 0) {
                fprintf(stderr, "error: cannot read password file\n");
                return 1;
            }
            if (argc >= 7)
                homeserver = argv[6];
        } else if (argc >= 5 && strncmp(argv[4], "--", 2) != 0) {
            if (strlen(argv[4]) >= sizeof(password)) {
                fprintf(stderr, "error: password too long\n");
                return 1;
            }
            strcpy(password, argv[4]);
            if (argc >= 6)
                homeserver = argv[5];
        } else if (argc == 4) {
            /* Password from stdin; homeserver is the default. (A
             * homeserver with a stdin password needs --password-file
             * or the argv form — the two are ambiguous otherwise.) */
            if (!fgets(password, (int)sizeof(password), stdin)) {
                fprintf(stderr, "error: no password on stdin\n");
                return 1;
            }
            size_t n = strlen(password);
            while (n > 0 && (password[n - 1] == '\n' || password[n - 1] == '\r'))
                password[--n] = '\0';
            if (n == 0) {
                fprintf(stderr, "error: empty password\n");
                return 1;
            }
        } else {
            return usage();
        }
        char cmd[2048];
        if (homeserver)
            snprintf(cmd, sizeof(cmd), "LOGIN %s %s %s", user, password, homeserver);
        else
            snprintf(cmd, sizeof(cmd), "LOGIN %s %s", user, password);
        memset(password, 0, sizeof(password));
        return comms_roundtrip(cmd);
    }

    if (strcmp(verb, "status") == 0 && argc == 3)
        return comms_roundtrip("STATUS");
    if (strcmp(verb, "logout") == 0 && argc == 3)
        return comms_roundtrip("LOGOUT");
    if (strcmp(verb, "rooms") == 0 && argc == 3)
        return comms_roundtrip("ROOMS");
    if (strcmp(verb, "calls") == 0 && argc == 3)
        return comms_roundtrip("CALLS");
    if (strcmp(verb, "messages") == 0 && (argc == 4 || argc == 5)) {
        char cmd[512];
        if (argc == 5)
            snprintf(cmd, sizeof(cmd), "MESSAGES %s %s", argv[3], argv[4]);
        else
            snprintf(cmd, sizeof(cmd), "MESSAGES %s", argv[3]);
        return comms_roundtrip(cmd);
    }
    if (strcmp(verb, "send") == 0 && argc >= 5) {
        char cmd[8192];
        size_t n = (size_t)snprintf(cmd, sizeof(cmd), "SEND %s", argv[3]);
        for (int i = 4; i < argc && n < sizeof(cmd) - 1; i++)
            n += (size_t)snprintf(cmd + n, sizeof(cmd) - n, " %s", argv[i]);
        if (n >= sizeof(cmd) - 1) {
            fprintf(stderr, "error: message too long\n");
            return 1;
        }
        return comms_roundtrip(cmd);
    }
    if (strcmp(verb, "call") == 0 && (argc == 4 || argc == 5)) {
        char cmd[512];
        if (argc == 5 && strcmp(argv[4], "--video") == 0)
            snprintf(cmd, sizeof(cmd), "CALL %s --video", argv[3]);
        else if (argc == 5 && strcmp(argv[4], "--audio") == 0)
            snprintf(cmd, sizeof(cmd), "CALL %s --audio", argv[3]);
        else if (argc == 4)
            snprintf(cmd, sizeof(cmd), "CALL %s --video", argv[3]);
        else
            return usage();
        return comms_roundtrip(cmd);
    }
    if (strcmp(verb, "answer") == 0 && (argc == 3 || argc == 4)) {
        char cmd[512];
        if (argc == 4)
            snprintf(cmd, sizeof(cmd), "ANSWER %s", argv[3]);
        else
            snprintf(cmd, sizeof(cmd), "ANSWER");
        return comms_roundtrip(cmd);
    }
    if (strcmp(verb, "hangup") == 0 && (argc == 3 || argc == 4)) {
        char cmd[512];
        if (argc == 4)
            snprintf(cmd, sizeof(cmd), "HANGUP %s", argv[3]);
        else
            snprintf(cmd, sizeof(cmd), "HANGUP");
        return comms_roundtrip(cmd);
    }
    if (strcmp(verb, "rcs") == 0 && argc == 4 &&
        (strcmp(argv[3], "status") == 0 || strcmp(argv[3], "probe") == 0)) {
        char cmd[64];
        snprintf(cmd, sizeof(cmd), "RCS %s", argv[3]);
        return comms_roundtrip(cmd);
    }
    return usage();
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
 * via /data/chromium.log (Chromium's stdout/stderr). The URL (if
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
        } else {
            /* The log path is on /data; if it cannot be opened (no data
             * disk, or a host-side run with no /data), send output to
             * /dev/null rather than inheriting the caller's pipes —
             * otherwise the caller blocks on the pipes until Chromium
             * exits, and the host exec would hang past its timeout. */
            int devnull = open("/dev/null", O_WRONLY);
            if (devnull >= 0) {
                dup2(devnull, STDOUT_FILENO);
                dup2(devnull, STDERR_FILENO);
            }
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
         * 2026-11-07 via /data/chromium.log). Software rendering is
         * the right call anyway: the shell's compositor is the pixman
         * CPU renderer, so there is no GPU to use. */
        /* DBUS_SESSION_BUS_ADDRESS=/dev/null: the image runs no
         * D-Bus daemon, so Chromium's startup D-Bus calls (session
         * bus) otherwise block on a ~25s connect timeout each and
         * the browser never reaches CDP in time (diagnosed
         * 2026-11-07 via /data/chromium.log — the log was full of
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
         * lands there for `sevyn files cat /data/chromium.log`. */
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

/* ------------------------------------------------------------------ */
/* net fetch — the host fetch bridge (M6).                              */
/*                                                                      */
/* `sevyn net fetch <method> <url> [body]` performs one plain HTTP/1.1 */
/* request and prints:                                                  */
/*   <status>\n<headers-json>\n<body>                                  */
/* The JS shim (v2/tokrah/shim/env.js) calls this through Sevyn.exec   */
/* whenever Tokrah code uses fetch/XHR, so Tokrah's real axios and     */
/* socket.io-client run against an in-guest server (the M6 mock API)   */
/* with no WebSocket and no TLS in the host.                            */
/*                                                                      */
/* http:// only: the image has no TLS stack for a C client yet, so     */
/* https:// fails loudly instead of silently. The M6 proof is http     */
/* (mock API on 127.0.0.1); a TLS transport is a follow-up, not a      */
/* silent fallback. Body + headers cap: 64 KB (the exec bridge cap).   */
/* Exit 0 on any HTTP response (even 4xx/5xx — the caller decides);    */
/* exit 1 on transport errors.                                          */
/* ------------------------------------------------------------------ */

static void json_escape_into(char *dst, size_t dstsz, const char *src)
{
    size_t o = 0;
    for (const char *p = src; *p && o + 2 < dstsz; p++) {
        if (*p == '"' || *p == '\\') {
            dst[o++] = '\\';
            dst[o++] = *p;
        } else if (*p == '\n') {
            dst[o++] = '\\';
            dst[o++] = 'n';
        } else if (*p == '\r') {
            dst[o++] = '\\';
            dst[o++] = 'r';
        } else if (*p == '\t') {
            dst[o++] = '\\';
            dst[o++] = 't';
        } else if ((unsigned char)*p < 0x20) {
            if (o + 7 < dstsz)
                o += (size_t)snprintf(dst + o, dstsz - o, "\\u%04x",
                                      (unsigned char)*p);
        } else {
            dst[o++] = *p;
        }
    }
    dst[o] = '\0';
}

static void percent_decode(char *dst, size_t dstsz, const char *src)
{
    size_t o = 0;
    for (const char *p = src; *p && o + 1 < dstsz; p++) {
        if (*p == '%' && p[1] && p[2]) {
            char hex[3] = { p[1], p[2], '\0' };
            char *end = NULL;
            long v = strtol(hex, &end, 16);
            if (end && *end == '\0' && v >= 0 && v <= 255) {
                dst[o++] = (char)v;
                p += 2;
                continue;
            }
        }
        dst[o++] = *p;
    }
    dst[o] = '\0';
}

static int cmd_net_fetch(int argc, char **argv)
{
    /* sevyn net fetch --method <m> <url> [--header <Name:value>]...
     *   [--data <body>]
     * The host exec bridge splits the command line on whitespace with
     * no quoting, so the JS shim percent-encodes header values and the
     * body (encodeURIComponent) before passing them; this verb decodes
     * %XX sequences in --header values and --data. A plain body with
     * no %XX sequences passes through unchanged, so the verb stays
     * usable by hand. */
    const char *method = NULL;
    const char *url = NULL;
    const char *data = NULL;
    char headers[4096];
    headers[0] = '\0';
    size_t hlen = 0;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--method") == 0 && i + 1 < argc) {
            method = argv[++i];
        } else if (strcmp(argv[i], "--header") == 0 && i + 1 < argc) {
            const char *hv = argv[++i];
            /* "Name:encoded-value" — decode the value after the colon. */
            const char *colon = strchr(hv, ':');
            if (!colon) {
                fprintf(stderr, "error: net fetch: bad --header %s\n", hv);
                return 1;
            }
            char dec[1024];
            percent_decode(dec, sizeof(dec), colon + 1);
            size_t nlen = (size_t)(colon - hv);
            if (nlen >= 128 || hlen + nlen + strlen(dec) + 4 >= sizeof(headers)) {
                fprintf(stderr, "error: net fetch: header too long\n");
                return 1;
            }
            if (hlen > 0) {
                /* CRLF, not bare LF: Node's HTTP parser 400s a
                 * request whose headers are LF-separated (the login
                 * POST carries two headers; single-header requests
                 * never showed it). */
                headers[hlen++] = '\r';
                headers[hlen++] = '\n';
            }
            memcpy(headers + hlen, hv, nlen);
            hlen += nlen;
            headers[hlen++] = ':';
            headers[hlen++] = ' ';
            strcpy(headers + hlen, dec);
            hlen += strlen(dec);
            headers[hlen] = '\0';
        } else if (strcmp(argv[i], "--data") == 0 && i + 1 < argc) {
            data = argv[++i];
        } else if (argv[i][0] != '-' && !url) {
            url = argv[i];
        } else {
            return usage();
        }
    }
    if (!method || !url) {
        fprintf(stderr,
                "error: usage: sevyn net fetch --method <m> <url> "
                "[--header <Name:value>]... [--data <body>]\n");
        return 1;
    }
    char body_dec[65536];
    const char *body = "";
    if (data) {
        percent_decode(body_dec, sizeof(body_dec), data);
        body = body_dec;
    }

    if (strncmp(url, "http://", 7) != 0) {
        fprintf(stderr,
                "error: net fetch supports http:// only (got %.16s); "
                "https needs a TLS transport (not built yet)\n",
                url);
        return 1;
    }
    const char *rest = url + 7;
    const char *slash = strchr(rest, '/');
    char hostport[256];
    const char *path = "/";
    if (slash) {
        size_t hlen = (size_t)(slash - rest);
        if (hlen >= sizeof(hostport)) {
            fprintf(stderr, "error: net fetch: host too long\n");
            return 1;
        }
        memcpy(hostport, rest, hlen);
        hostport[hlen] = '\0';
        path = slash;
    } else {
        snprintf(hostport, sizeof(hostport), "%s", rest);
    }
    char host[256];
    char portstr[16] = "80";
    const char *colon = strrchr(hostport, ':');
    if (colon && colon != hostport) {
        size_t hlen = (size_t)(colon - hostport);
        if (hlen >= sizeof(host)) {
            fprintf(stderr, "error: net fetch: host too long\n");
            return 1;
        }
        memcpy(host, hostport, hlen);
        host[hlen] = '\0';
        snprintf(portstr, sizeof(portstr), "%s", colon + 1);
    } else {
        snprintf(host, sizeof(host), "%s", hostport);
    }

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, portstr, &hints, &res) != 0 || !res) {
        fprintf(stderr, "error: net fetch: cannot resolve %s\n", host);
        return 1;
    }
    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) {
        freeaddrinfo(res);
        fprintf(stderr, "error: net fetch: socket failed\n");
        return 1;
    }
    struct timeval tv = { .tv_sec = 8, .tv_usec = 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        fprintf(stderr, "error: net fetch: cannot connect to %s:%s\n",
                host, portstr);
        close(fd);
        freeaddrinfo(res);
        return 1;
    }
    freeaddrinfo(res);

    char req[8192];
    int reqlen = snprintf(
        req, sizeof(req),
        "%s %s HTTP/1.1\r\nHost: %s\r\n"
        "%s%s"
        "Content-Length: %zu\r\nConnection: close\r\n\r\n%s",
        method, path, hostport,
        headers[0] ? headers : "", headers[0] ? "\r\n" : "",
        strlen(body), body);
    if (reqlen < 0 || (size_t)reqlen >= sizeof(req)) {
        fprintf(stderr, "error: net fetch: request too long\n");
        close(fd);
        return 1;
    }
    size_t sent = 0;
    while (sent < (size_t)reqlen) {
        ssize_t n = send(fd, req + sent, (size_t)reqlen - sent, 0);
        if (n <= 0) {
            fprintf(stderr, "error: net fetch: send failed\n");
            close(fd);
            return 1;
        }
        sent += (size_t)n;
    }
    /* 64 KB cap, matching the exec bridge. */
    static char resp[65536 + 1];
    size_t got = 0;
    for (;;) {
        if (got >= sizeof(resp) - 1)
            break;
        ssize_t n = recv(fd, resp + got, sizeof(resp) - 1 - got, 0);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            break;
        }
        if (n == 0)
            break;
        got += (size_t)n;
    }
    close(fd);
    resp[got] = '\0';

    /* Split status line / headers / body. */
    char *hdr_end = strstr(resp, "\r\n\r\n");
    size_t hdr_len = hdr_end ? (size_t)(hdr_end - resp) : got;
    char *body_start = hdr_end ? hdr_end + 4 : resp + got;
    int status = 0;
    sscanf(resp, "HTTP/%*d.%*d %d", &status);
    if (status == 0)
        sscanf(resp, "HTTP %d", &status);

    /* Headers -> one JSON object (names lowercased, first wins). */
    char headers_json[8192];
    size_t hj = 0;
    hj += (size_t)snprintf(headers_json + hj, sizeof(headers_json) - hj,
                           "{");
    int first_hdr = 1;
    char *line = resp;
    int is_first_line = 1;
    while (line < resp + (ptrdiff_t)hdr_len) {
        char *eol = strstr(line, "\r\n");
        if (!eol)
            eol = resp + (ptrdiff_t)hdr_len;
        size_t llen = (size_t)(eol - line);
        if (is_first_line) {
            is_first_line = 0;
        } else if (llen > 0) {
            char *colon2 = memchr(line, ':', llen);
            if (colon2) {
                size_t nlen = (size_t)(colon2 - line);
                const char *v = colon2 + 1;
                while (v < line + (ptrdiff_t)llen && (*v == ' ' || *v == '\t'))
                    v++;
                size_t vlen = (size_t)(line + (ptrdiff_t)llen - v);
                if (nlen < 128 && vlen < 1024 && hj + 2048 < sizeof(headers_json)) {
                    char name[128], val[1024], esc[2048];
                    memcpy(name, line, nlen);
                    name[nlen] = '\0';
                    for (size_t i = 0; name[i]; i++)
                        if (name[i] >= 'A' && name[i] <= 'Z')
                            name[i] = (char)(name[i] + 32);
                    memcpy(val, v, vlen);
                    val[vlen] = '\0';
                    json_escape_into(esc, sizeof(esc), val);
                    hj += (size_t)snprintf(
                        headers_json + hj, sizeof(headers_json) - hj,
                        "%s\"%s\":\"%s\"", first_hdr ? "" : ",", name, esc);
                    first_hdr = 0;
                }
            }
        }
        line = eol + 2;
    }
    snprintf(headers_json + hj, sizeof(headers_json) - hj, "}");

    /* Chunked transfer: the mock API sends Content-Length, but be
     * honest — a chunked body is printed raw rather than mis-decoded. */
    printf("%d\n%s\n%s", status, headers_json, body_start);
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

/* ------------------------------------------------------------------ */
/* net wifi (M9) — wireless scan / connect via wpa_supplicant.        */
/*                                                                      */
/* The Settings wifi section drives these verbs. Credentials live     */
/* only in /data/wifi/wpa_supplicant.conf (0600, root-only, on the    */
/* data partition — never in the repo, never logged). The PSK travels  */
/* to wpa_cli as an argv element (visible in ps for the milliseconds  */
/* that call runs — the same exposure every wpa_cli-based tool has;    */
/* the CLI never echoes it). QEMU has no wlan device, so scan/status  */
/* there print the clean no-hardware state and exit 1.                  */

#define WIFI_CONF_PATH "/data/wifi/wpa_supplicant.conf"
#define WIFI_CTRL_DIR "/run/wpa_supplicant"
#define WIFI_SCAN_MAX 32

/* Run argv (NULL-terminated, no shell) and capture stdout. Returns
 * the exit code, or -1 when the spawn failed; *out gets a malloc'd
 * NUL-terminated stdout ("" when nothing was printed). Capped at
 * 64 KiB — wpa_cli output is small. */
static int run_capture(char *const argv[], char **out)
{
    *out = calloc(1, 1);
    if (!*out)
        return -1;
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return -1;
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        /* stderr goes to the console (wpa_cli errors are one-liners
         * the user should see); stdout is the captured channel. */
        close(pipefd[1]);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(pipefd[1]);
    size_t cap = 65536, len = 0;
    char *buf = malloc(cap);
    if (!buf) {
        close(pipefd[0]);
        return -1;
    }
    for (;;) {
        if (len + 4096 >= cap)
            break;
        ssize_t n = read(pipefd[0], buf + len, 4096);
        if (n <= 0)
            break;
        len += (size_t)n;
    }
    close(pipefd[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    buf[len] = '\0';
    free(*out);
    *out = buf;
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return -1;
}

/* Like run_capture, but the child's stderr goes to /dev/null:
 * for probes where "not found" is an expected answer (mtools
 * looking for a bootloader file that simply isn't there). */
static int run_capture_quiet(char *const argv[], char **out)
{
    *out = calloc(1, 1);
    if (!*out)
        return -1;
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return -1;
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return -1;
    }
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        int dn = open("/dev/null", O_WRONLY);
        if (dn >= 0)
            dup2(dn, STDERR_FILENO);
        close(pipefd[1]);
        execvp(argv[0], argv);
        _exit(127);
    }
    close(pipefd[1]);
    size_t cap = 65536, len = 0;
    char *buf = malloc(cap);
    if (!buf) {
        close(pipefd[0]);
        return -1;
    }
    for (;;) {
        if (len + 4096 >= cap)
            break;
        ssize_t n = read(pipefd[0], buf + len, 4096);
        if (n <= 0)
            break;
        len += (size_t)n;
    }
    close(pipefd[0]);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    buf[len] = '\0';
    free(*out);
    *out = buf;
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return -1;
}

/* First wireless interface (wlan* / wlp*) in /sys/class/net, or 0. */
static int wifi_iface(char *name, size_t cap)
{
    DIR *d = opendir("/sys/class/net");
    if (!d)
        return 0;
    struct dirent *e;
    int found = 0;
    while ((e = readdir(d)) != NULL) {
        if (strncmp(e->d_name, "wlan", 4) == 0 ||
            strncmp(e->d_name, "wlp", 3) == 0) {
            /* Interface names are at most IFNAMSIZ-1 chars; a
             * truncation here means a bogus entry — skip it. */
            if (snprintf(name, cap, "%s", e->d_name) >= (int)cap)
                continue;
            found = 1;
            break;
        }
    }
    closedir(d);
    return found;
}

/* Escape a value for wpa_cli's quoted-string syntax: \ and " only. */
static void wifi_escape(const char *in, char *out, size_t cap)
{
    size_t o = 0;
    for (size_t i = 0; in[i] && o + 2 < cap; i++) {
        if (in[i] == '\\' || in[i] == '"')
            out[o++] = '\\';
        out[o++] = in[i];
    }
    out[o] = '\0';
}

/* `wpa_cli -p /run/wpa_supplicant -i <iface> <args...>` with stdout
 * captured. args is a NULL-terminated list of at most 5 extra
 * arguments.
 * GF65 wifi fix: absolute path — the daemon runs under init's PATH,
 * which has no /usr/sbin, so a bare name fails ENOENT in execvp.
 * GF65 wifi fix 2: `-p /run/wpa_supplicant` — wpa_cli's compiled-in
 * default ctrl path is /var/run/wpa_supplicant, but the daemon
 * creates its socket at /run/wpa_supplicant (ctrl_interface in
 * /data/wifi/wpa_supplicant.conf) and /var/run does not exist in
 * the image, so every wpa_cli call failed to connect (ENOENT) even
 * though the daemon was healthy. Point at the real socket. */
static int wpa_cli(const char *iface, char **out, const char **args)
{
    char *argv[11];
    argv[0] = "/usr/sbin/wpa_cli";
    argv[1] = "-p";
    argv[2] = WIFI_CTRL_DIR;
    argv[3] = "-i";
    argv[4] = (char *)iface;
    int n = 5;
    for (int i = 0; args[i] && n < 10; i++)
        argv[n++] = (char *)args[i];
    argv[n] = NULL;
    return run_capture(argv, out);
}

/* Make sure wpa_supplicant is running for this interface: write the
 * minimal config (0600) when missing, start the daemon when a ping
 * fails. Returns 0 when a ping answers, 1 otherwise. */
static int wifi_ensure_supplicant(const char *iface)
{
    char *out = NULL;
    if (wpa_cli(iface, &out, (const char *[]){"ping", NULL}) == 0 &&
        out && strncmp(out, "PONG", 4) == 0) {
        free(out);
        return 0;
    }
    free(out);
    out = NULL;
    mkdir("/data/wifi", 0755);
    mkdir(WIFI_CTRL_DIR, 0755);
    FILE *f = fopen(WIFI_CONF_PATH, "a");
    if (f) {
        /* A fresh file gets the two lines the daemon needs; an
         * existing file (with saved networks) is left alone. */
        fseek(f, 0, SEEK_END);
        if (ftell(f) == 0)
            fprintf(f, "ctrl_interface=%s\nupdate_config=1\n",
                    WIFI_CTRL_DIR);
        fclose(f);
        chmod(WIFI_CONF_PATH, 0600);
    }
    /* GF65 wifi fix: absolute path (see wpa_cli above) — init's
     * PATH has no /usr/sbin. */
    char *sargv[] = {"/usr/sbin/wpa_supplicant", "-B", "-i", (char *)iface,
                     "-c", WIFI_CONF_PATH, "-Dnl80211", NULL};
    char *discard = NULL;
    if (run_capture(sargv, &discard) != 0) {
        free(discard);
        fprintf(stderr, "error: cannot start wpa_supplicant\n");
        return 1;
    }
    free(discard);
    for (int i = 0; i < 10; i++) {
        sleep(1);
        if (wpa_cli(iface, &out, (const char *[]){"ping", NULL}) == 0 &&
            out && strncmp(out, "PONG", 4) == 0) {
            free(out);
            return 0;
        }
        free(out);
        out = NULL;
    }
    fprintf(stderr, "error: wpa_supplicant did not answer\n");
    return 1;
}

/* One scan hit, for the sort. */
struct wifi_hit {
    char ssid[64];
    int signal;
    int secured;
};

static int cmd_net_wifi_scan(void)
{
    char iface[IFNAMSIZ] = "";
    if (!wifi_iface(iface, sizeof(iface))) {
        printf("wifi: unavailable (no wireless interface)\n");
        return 1;
    }
    if (wifi_ensure_supplicant(iface) != 0)
        return 1;
    char *out = NULL;
    if (wpa_cli(iface, &out, (const char *[]){"scan", NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: scan failed\n");
        return 1;
    }
    free(out);
    out = NULL;
    sleep(3);
    if (wpa_cli(iface, &out, (const char *[]){"scan_results", NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: scan_results failed\n");
        return 1;
    }
    struct wifi_hit hits[WIFI_SCAN_MAX];
    int n = 0;
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    while (line) {
        if (strncmp(line, "bssid", 5) != 0 && n < WIFI_SCAN_MAX) {
            /* bssid<TAB>frequency<TAB>signal<TAB>flags<TAB>ssid */
            char *f1 = strchr(line, '\t');
            char *f2 = f1 ? strchr(f1 + 1, '\t') : NULL;
            char *f3 = f2 ? strchr(f2 + 1, '\t') : NULL;
            char *f4 = f3 ? strchr(f3 + 1, '\t') : NULL;
            if (f1 && f2 && f3 && f4 && f4[1]) {
                struct wifi_hit *h = &hits[n];
                snprintf(h->ssid, sizeof(h->ssid), "%s", f4 + 1);
                h->signal = atoi(f2 + 1);
                /* [WPA2-PSK-CCMP] / [WPA-PSK-...] / [RSN-...] mean
                 * secured; bare [ESS] is an open network. */
                char flags[256];
                size_t flen = (size_t)(f4 - (f3 + 1));
                if (flen >= sizeof(flags))
                    flen = sizeof(flags) - 1;
                memcpy(flags, f3 + 1, flen);
                flags[flen] = '\0';
                h->secured = strstr(flags, "WPA") != NULL ||
                             strstr(flags, "RSN") != NULL;
                n++;
            }
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    /* Strongest first — the list the Settings UI shows. */
    for (int i = 0; i < n; i++)
        for (int j = i + 1; j < n; j++)
            if (hits[j].signal > hits[i].signal) {
                struct wifi_hit t = hits[i];
                hits[i] = hits[j];
                hits[j] = t;
            }
    for (int i = 0; i < n; i++)
        printf("%s\t%d\t%s\n", hits[i].ssid, hits[i].signal,
               hits[i].secured ? "secured" : "open");
    return 0;
}

/* `wpa_cli status` field, or NULL. */
static const char *wpa_status_field(const char *out, const char *key)
{
    static char val[256];
    size_t klen = strlen(key);
    for (const char *p = out; *p; p++) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *e = strchr(p + klen + 1, '\n');
            size_t len = e ? (size_t)(e - (p + klen + 1))
                           : strlen(p + klen + 1);
            if (len >= sizeof(val))
                len = sizeof(val) - 1;
            memcpy(val, p + klen + 1, len);
            val[len] = '\0';
            return val;
        }
        p = strchr(p, '\n');
        if (!p)
            break;
    }
    return NULL;
}

static int cmd_net_wifi_status(void)
{
    char iface[IFNAMSIZ] = "";
    if (!wifi_iface(iface, sizeof(iface))) {
        printf("wifi: unavailable (no wireless interface)\n");
        return 1;
    }
    if (wifi_ensure_supplicant(iface) != 0)
        return 1;
    char *out = NULL;
    if (wpa_cli(iface, &out, (const char *[]){"status", NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: status failed\n");
        return 1;
    }
    const char *state = wpa_status_field(out, "wpa_state");
    const char *ssid = wpa_status_field(out, "ssid");
    const char *addr = wpa_status_field(out, "ip_address");
    printf("state: %s\n", state ? state : "unknown");
    printf("ssid: %s\n", ssid ? ssid : "none");
    printf("address: %s\n", addr ? addr : "none");
    free(out);
    return 0;
}

static int cmd_net_wifi_connect(int argc, char **argv)
{
    if (argc < 4 || argc > 5)
        return usage();
    const char *ssid = argv[3];
    const char *psk = argc == 5 ? argv[4] : NULL;
    if (strlen(ssid) == 0 || strlen(ssid) > 32) {
        fprintf(stderr, "error: ssid must be 1-32 characters\n");
        return 1;
    }
    if (psk && (strlen(psk) < 8 || strlen(psk) > 63)) {
        fprintf(stderr, "error: password must be 8-63 characters\n");
        return 1;
    }
    char iface[IFNAMSIZ] = "";
    if (!wifi_iface(iface, sizeof(iface))) {
        printf("wifi: unavailable (no wireless interface)\n");
        return 1;
    }
    if (wifi_ensure_supplicant(iface) != 0)
        return 1;
    char *out = NULL;
    char id[16] = "";
    /* Reuse the saved network when one exists for this SSID. */
    if (wpa_cli(iface, &out,
                (const char *[]){"list_networks", NULL}) == 0) {
        char *save = NULL;
        char *line = strtok_r(out, "\n", &save);
        while (line) {
            char *tab = strchr(line, '\t');
            if (tab && tab[1] == '"') {
                char *end = strchr(tab + 2, '"');
                if (end && (size_t)(end - (tab + 2)) == strlen(ssid) &&
                    strncmp(tab + 2, ssid, strlen(ssid)) == 0) {
                    size_t idlen = (size_t)(tab - line);
                    if (idlen < sizeof(id)) {
                        memcpy(id, line, idlen);
                        id[idlen] = '\0';
                    }
                    break;
                }
            }
            line = strtok_r(NULL, "\n", &save);
        }
    }
    free(out);
    out = NULL;
    if (!id[0]) {
        if (wpa_cli(iface, &out, (const char *[]){"add_network", NULL}) != 0) {
            free(out);
            fprintf(stderr, "error: add_network failed\n");
            return 1;
        }
        /* add_network prints the new id alone ("0"). */
        char *nl = strchr(out, '\n');
        size_t idlen = nl ? (size_t)(nl - out) : strlen(out);
        if (idlen == 0 || idlen >= sizeof(id)) {
            free(out);
            fprintf(stderr, "error: add_network returned no id\n");
            return 1;
        }
        memcpy(id, out, idlen);
        id[idlen] = '\0';
        free(out);
        out = NULL;
    }
    char esc[128], val[256];
    wifi_escape(ssid, esc, sizeof(esc));
    snprintf(val, sizeof(val), "ssid \"%s\"", esc);
    if (wpa_cli(iface, &out,
                (const char *[]){"set_network", id, val, NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: set ssid failed\n");
        return 1;
    }
    free(out);
    out = NULL;
    if (psk) {
        wifi_escape(psk, esc, sizeof(esc));
        snprintf(val, sizeof(val), "psk \"%s\"", esc);
    } else {
        snprintf(val, sizeof(val), "key_mgmt NONE");
    }
    if (wpa_cli(iface, &out,
                (const char *[]){"set_network", id, val, NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: set key failed\n");
        return 1;
    }
    free(out);
    out = NULL;
    wpa_cli(iface, &out, (const char *[]){"enable_network", id, NULL});
    free(out);
    out = NULL;
    wpa_cli(iface, &out, (const char *[]){"save_config", NULL});
    free(out);
    out = NULL;
    wpa_cli(iface, &out, (const char *[]){"select_network", id, NULL});
    free(out);
    out = NULL;
    /* Wait for association (up to ~10 s), then DHCP on the wifi
     * interface — association alone gives no address. */
    int associated = 0;
    for (int i = 0; i < 10; i++) {
        sleep(1);
        if (wpa_cli(iface, &out, (const char *[]){"status", NULL}) != 0) {
            free(out);
            out = NULL;
            continue;
        }
        const char *state = wpa_status_field(out, "wpa_state");
        if (state && strcmp(state, "COMPLETED") == 0) {
            associated = 1;
            free(out);
            out = NULL;
            break;
        }
        free(out);
        out = NULL;
    }
    if (!associated) {
        printf("error: association timed out (%s)\n", ssid);
        return 1;
    }
    char *dhcp_out = NULL;
    char *dhcp_argv[] = {"/bin/busybox", "udhcpc", "-i", iface,
                         "-s", "/etc/udhcpc.script",
                         "-q", "-t", "5", "-n", NULL};
    if (run_capture(dhcp_argv, &dhcp_out) != 0) {
        /* BusyBox multi-call binary not at /bin/busybox (dev host):
         * try a standalone udhcpc. */
        free(dhcp_out);
        dhcp_out = NULL;
        char *dhcp_argv2[] = {"udhcpc", "-i", iface,
                              "-s", "/etc/udhcpc.script",
                              "-q", "-t", "5", "-n", NULL};
        run_capture(dhcp_argv2, &dhcp_out);
    }
    free(dhcp_out);
    cmd_net_announce();
    char name[IFNAMSIZ] = "";
    char addr[INET_ADDRSTRLEN] = "";
    first_up_iface(name, sizeof(name), addr, sizeof(addr));
    printf("connected: %s\n", ssid);
    printf("address: %s\n", addr[0] ? addr : "none");
    return 0;
}

static int cmd_net_wifi_disconnect(void)
{
    char iface[IFNAMSIZ] = "";
    if (!wifi_iface(iface, sizeof(iface))) {
        printf("wifi: unavailable (no wireless interface)\n");
        return 1;
    }
    if (wifi_ensure_supplicant(iface) != 0)
        return 1;
    char *out = NULL;
    int rc = wpa_cli(iface, &out, (const char *[]){"disconnect", NULL});
    free(out);
    if (rc != 0) {
        fprintf(stderr, "error: disconnect failed\n");
        return 1;
    }
    cmd_net_announce();
    printf("disconnected\n");
    return 0;
}

static int cmd_net_wifi_forget(const char *ssid)
{
    char iface[IFNAMSIZ] = "";
    if (!wifi_iface(iface, sizeof(iface))) {
        printf("wifi: unavailable (no wireless interface)\n");
        return 1;
    }
    if (wifi_ensure_supplicant(iface) != 0)
        return 1;
    char *out = NULL;
    if (wpa_cli(iface, &out,
                (const char *[]){"list_networks", NULL}) != 0) {
        free(out);
        fprintf(stderr, "error: list_networks failed\n");
        return 1;
    }
    char id[16] = "";
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    while (line) {
        char *tab = strchr(line, '\t');
        if (tab && tab[1] == '"') {
            char *end = strchr(tab + 2, '"');
            if (end && (size_t)(end - (tab + 2)) == strlen(ssid) &&
                strncmp(tab + 2, ssid, strlen(ssid)) == 0) {
                size_t idlen = (size_t)(tab - line);
                if (idlen < sizeof(id)) {
                    memcpy(id, line, idlen);
                    id[idlen] = '\0';
                }
                break;
            }
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    out = NULL;
    if (!id[0]) {
        printf("error: no saved network %s\n", ssid);
        return 1;
    }
    wpa_cli(iface, &out, (const char *[]){"remove_network", id, NULL});
    free(out);
    out = NULL;
    wpa_cli(iface, &out, (const char *[]){"save_config", NULL});
    free(out);
    printf("forgotten: %s\n", ssid);
    return 0;
}

static int cmd_net_wifi(int argc, char **argv)
{
    if (argc < 4)
        return usage();
    if (strcmp(argv[3], "scan") == 0) {
        if (argc != 4)
            return usage();
        return cmd_net_wifi_scan();
    }
    if (strcmp(argv[3], "status") == 0) {
        if (argc != 4)
            return usage();
        return cmd_net_wifi_status();
    }
    if (strcmp(argv[3], "connect") == 0)
        return cmd_net_wifi_connect(argc, argv);
    if (strcmp(argv[3], "disconnect") == 0) {
        if (argc != 4)
            return usage();
        return cmd_net_wifi_disconnect();
    }
    if (strcmp(argv[3], "forget") == 0) {
        if (argc != 5)
            return usage();
        return cmd_net_wifi_forget(argv[4]);
    }
    return usage();
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
    if (strcmp(argv[2], "wifi") == 0) {
        return cmd_net_wifi(argc, argv);
    }
    if (strcmp(argv[2], "fetch") == 0) {
        return cmd_net_fetch(argc, argv);
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
/* tokrah — the M6 third-party bring-up.                                */
/*                                                                      */
/* `sevyn app run <appId> [--seconds N] [--width W] [--height H]
 * [--input <path>] [--out <path>] [--name <n>] [--color <#hex>]
 * [--glyph <g>] [--permissions <csv>]` launches any installed
 * system app headless in the RN host (M9): no window, the bundle
 * still mounts and presents, ops go to --out as JSON and to the
 * console as compact ops lines, input arrives from --input. The
 * check drives the M9 app screens through it (Settings wifi UI,
 * calculator arithmetic, calendar, store list, notes) — the same
 * pattern as `sevyn tokrah run` (M6), generalised. The bundle
 * resolves from the installed registry
 * (/var/lib/sevyn/apps/<id>/app.hbc, seeded from pristine on first
 * boot); the identity flags default to the app id itself (the
 * template apps switch on Sevyn.appId, so name/color/glyph only
 * matter for the header). The host runs DETACHED, as in cmd_tokrah:
 * a headless run outlasts the exec bridge's 10 s synchronous window.
 * ------------------------------------------------------------------ */

#define APPS_DIR "/var/lib/sevyn/apps"

static int cmd_app(int argc, char **argv)
{
    if (argc < 4 || strcmp(argv[2], "run") != 0)
        return usage();
    const char *app_id = argv[3];
    /* App ids are registry directory names: reject anything that
     * could escape /var/lib/sevyn/apps (no slashes, no dots). */
    for (const char *p = app_id; *p; p++) {
        if (!(isalnum((unsigned char)*p) || *p == '-' || *p == '_'))
            return usage();
    }
    int seconds = 30;
    int width = 800;
    int height = 500;
    const char *input = NULL;
    const char *out = NULL;
    const char *name = app_id;
    const char *color = "#6b7280";
    const char *glyph = "?";
    const char *permissions = NULL;
    for (int i = 4; i < argc; i++) {
        if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
            seconds = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--input") == 0 && i + 1 < argc) {
            input = argv[++i];
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out = argv[++i];
        } else if (strcmp(argv[i], "--name") == 0 && i + 1 < argc) {
            name = argv[++i];
        } else if (strcmp(argv[i], "--color") == 0 && i + 1 < argc) {
            color = argv[++i];
        } else if (strcmp(argv[i], "--glyph") == 0 && i + 1 < argc) {
            glyph = argv[++i];
        } else if (strcmp(argv[i], "--permissions") == 0 && i + 1 < argc) {
            permissions = argv[++i];
        } else {
            return usage();
        }
    }
    char bundle[PATH_MAX];
    if (snprintf(bundle, sizeof(bundle), "%s/%s/app.hbc", APPS_DIR,
                 app_id) >= (int)sizeof(bundle)) {
        fprintf(stderr, "error: app id too long\n");
        return 1;
    }
    struct stat st;
    if (stat(bundle, &st) != 0) {
        fprintf(stderr, "error: %s is not installed (no %s)\n", app_id,
                bundle);
        return 1;
    }
    char secs[16], wbuf[16], hbuf[16];
    snprintf(secs, sizeof(secs), "%d", seconds);
    snprintf(wbuf, sizeof(wbuf), "%d", width);
    snprintf(hbuf, sizeof(hbuf), "%d", height);
    const char *args[40];
    int n = 0;
    args[n++] = SHELL_BIN;
    args[n++] = "--bundle";
    args[n++] = bundle;
    args[n++] = "--width";
    args[n++] = wbuf;
    args[n++] = "--height";
    args[n++] = hbuf;
    args[n++] = "--app";
    args[n++] = app_id;
    args[n++] = "--name";
    args[n++] = name;
    args[n++] = "--color";
    args[n++] = color;
    args[n++] = "--glyph";
    args[n++] = glyph;
    if (permissions) {
        args[n++] = "--permissions";
        args[n++] = permissions;
    }
    args[n++] = "--headless";
    args[n++] = "--headless-seconds";
    args[n++] = secs;
    if (input) {
        args[n++] = "--headless-input";
        args[n++] = input;
    }
    if (out) {
        args[n++] = "--headless-out";
        args[n++] = out;
    }
    args[n] = NULL;
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "error: cannot fork for the headless host\n");
        return 1;
    }
    if (pid == 0) {
        setsid();
        int nullfd = open("/dev/null", O_RDONLY);
        if (nullfd >= 0)
            dup2(nullfd, STDIN_FILENO);
        int consolefd = open("/dev/console", O_WRONLY);
        if (consolefd >= 0) {
            dup2(consolefd, STDOUT_FILENO);
            dup2(consolefd, STDERR_FILENO);
        }
        execv(SHELL_BIN, (char *const *)args);
        fprintf(stderr, "error: cannot exec %s\n", SHELL_BIN);
        _exit(1);
    }
    printf("app run started (pid %d, %ds, detached)\n", (int)pid,
           seconds);
    return 0;
}

/* `sevyn tokrah run [--seconds N] [--input <path>] [--out <path>]`    */
/* launches Tokrah headless in the RN host: no window, the bundle       */
/* still mounts and presents, ops go to --out as JSON, input arrives    */
/* from --input. The M6 check drives a full live session through it.    */
/* The host runs DETACHED: a headless run outlasts the exec bridge's    */
/* 10 s synchronous window, so the CLI forks, the parent returns at    */
/* once, and the child logs to the console until the run ends.          */
/*                                                                      */
/* Bundle lookup: the installed registry copy first, then the image's   */
/* staged copy, then the pristine bundle (which the loader would        */
/* install — here we just point at the staged hbc the image build      */
/* leaves next to it). A missing bundle is a plain error, not a        */
/* silent no-op: Tokrah is a third-party app, not part of the image.   */
/* ------------------------------------------------------------------ */

#define TOKRAH_REGISTRY_HBC "/var/lib/sevyn/apps/tokrah/app.hbc"
#define TOKRAH_STAGED_HBC "/usr/share/sevyn/tokrah/tokrah.hbc"

static int cmd_tokrah(int argc, char **argv)
{
    if (argc < 3 || strcmp(argv[2], "run") != 0)
        return usage();
    int seconds = 30;
    int width = 800;
    int height = 500;
    const char *input = NULL;
    const char *out = NULL;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
            seconds = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--input") == 0 && i + 1 < argc) {
            input = argv[++i];
        } else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) {
            out = argv[++i];
        } else {
            return usage();
        }
    }
    const char *bundle = NULL;
    struct stat st;
    if (stat(TOKRAH_REGISTRY_HBC, &st) == 0)
        bundle = TOKRAH_REGISTRY_HBC;
    else if (stat(TOKRAH_STAGED_HBC, &st) == 0)
        bundle = TOKRAH_STAGED_HBC;
    if (!bundle) {
        fprintf(stderr,
                "error: Tokrah is not installed (no %s and no %s); "
                "install the .sevyn bundle first\n",
                TOKRAH_REGISTRY_HBC, TOKRAH_STAGED_HBC);
        return 1;
    }
    char secs[16], wbuf[16], hbuf[16];
    snprintf(secs, sizeof(secs), "%d", seconds);
    snprintf(wbuf, sizeof(wbuf), "%d", width);
    snprintf(hbuf, sizeof(hbuf), "%d", height);
    const char *args[] = {
        SHELL_BIN,      "--bundle",   bundle,
        "--width",      wbuf,         "--height",
        hbuf,           "--app",      "tokrah",
        "--name",       "Tokrah",     "--color",
        "#E52B42",      "--glyph",    "T",
        "--permissions", "cli.exec",  "--headless",
        "--headless-seconds", secs,  NULL,
        NULL,           NULL,         NULL,
        NULL,           NULL,         NULL,
    };
    /* The host runs detached: a headless run lasts longer than the
     * exec bridge's 10 s synchronous window, so the CLI forks and
     * the parent returns at once. The child takes a new session,
     * points stdin at /dev/null and stdout/stderr at the console
     * (so its HOST lines still reach the serial log and it no
     * longer holds the bridge's pipe), then execs the host. The
     * ops JSON lands in --out when the run finishes. */
    int n = 0;
    while (args[n])
        n++;
    if (input) {
        args[n++] = "--headless-input";
        args[n++] = input;
    }
    if (out) {
        args[n++] = "--headless-out";
        args[n++] = out;
    }
    args[n] = NULL;
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "error: cannot fork for the headless host\n");
        return 1;
    }
    if (pid == 0) {
        setsid();
        int nullfd = open("/dev/null", O_RDONLY);
        if (nullfd >= 0)
            dup2(nullfd, STDIN_FILENO);
        int consolefd = open("/dev/console", O_WRONLY);
        if (consolefd >= 0) {
            dup2(consolefd, STDOUT_FILENO);
            dup2(consolefd, STDERR_FILENO);
        }
        execv(SHELL_BIN, (char *const *)args);
        fprintf(stderr, "error: cannot exec %s\n", SHELL_BIN);
        _exit(1);
    }
    printf("tokrah run started (pid %d, %ds, detached)\n", (int)pid,
           seconds);
    return 0;
}

/* ------------------------------------------------------------------ */
/* install (M11): dual-boot installer                                 */
/*                                                                    */
/* The live image boots from USB; the installer puts SevynOS onto    */
/* an internal disk ALONGSIDE Windows 11 without wiping it. It       */
/* never touches a Windows partition, never installs onto the boot    */
/* disk, and never writes without an explicit confirmation (the RN    */
/* Confirm button, or --yes on the CLI).                              */
/*                                                                    */
/* Why its own ESP: a Windows 11 ESP is typically 100-260 MiB,       */
/* while the SevynOS kernel + initramfs is ~380 MiB (and the M9 ESP  */
/* sync peaks near 1100 MiB) — SevynOS cannot live on the Windows    */
/* ESP. The installer creates a SevynOS ESP (1152 MiB, the USB      */
/* image's size) in free space, and GRUB on it chainloads the        */
/* Windows Boot Manager from the Windows ESP.                         */
/*                                                                    */
/* All disk work goes through the staged tools (sgdisk, mkfs.vfat,   */
/* mkfs.ext4, mtools, debugfs, blkid, efibootmgr) via run_capture.   */
/* The verbs accept a disk IMAGE file as well as a device, so the    */
/* host tests drive the same code against fixture images.            */
/* ------------------------------------------------------------------ */

#define INST_ESP_TYPE "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
#define INST_LINUX_TYPE "0FC63DAF-8483-4772-8E79-3D69D8477DE4"
#define INST_MS_BASIC_TYPE "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"
#define INST_ESP_MB 1152
#define INST_DATA_MIN_MB 864
#define INST_DATA_MAX_MB 8192
#define INST_MIN_FREE_MB (INST_ESP_MB + INST_DATA_MIN_MB)
#define INST_ALIGN_SECTORS 2048
#define INST_SECTOR 512
#define INST_FILES_DIR "/usr/share/sevyn/install"
#define INST_OS_VERSION_FILE "/usr/share/sevyn/os-version"

typedef struct {
    int num;
    char partuuid[64];
    char type[64]; /* type GUID, upper case */
    char name[64];
    unsigned long long start; /* sectors */
    unsigned long long end;   /* sectors */
    char fs[32];              /* blkid TYPE, or "" */
    char fs_uuid[64];         /* blkid UUID, or "" */
    char label[64];           /* blkid LABEL, or "" */
    int is_esp;
    int is_windows_esp; /* ESP + /EFI/Microsoft/Boot/bootmgfw.efi */
    int is_sevyn_esp;   /* ESP + /EFI/ubuntu/grub.cfg mentioning SevynOS */
    int is_windows_data; /* MS basic data + ntfs */
    int is_sevyn_data;   /* label == SEVYN_DATA */
} inst_part;

typedef struct {
    char disk[256]; /* /dev/nvme0n1, or an image file path */
    char devname[64];
    int is_file; /* a regular file, not a block device */
    unsigned long long size_sectors;
    unsigned long long first_usable;
    unsigned long long last_usable;
    inst_part parts[32];
    int nparts;
    /* Largest trailing free run (1 MiB aligned), sectors; 0 when none. */
    unsigned long long free_start;
    unsigned long long free_end;
    int is_boot_disk;
    int has_windows;
    int has_sevyn;
    int gpt; /* sgdisk read the table */
} inst_disk;

typedef struct {
    char disk[256];
    int mode; /* 0 = free space, 1 = replace old SevynOS */
    unsigned long long esp_start, esp_end;   /* sectors */
    unsigned long long data_start, data_end; /* sectors */
    int esp_num, data_num;                   /* new partition numbers */
    int replaced[32];
    int nreplaced;
    /* Protected partitions (Windows + Windows ESP + anything else
     * that is not being replaced), with edge hashes taken at plan
     * time so install can prove they are untouched afterwards. */
    int prot[32];
    int nprot;
    char prot_hash[32][2][65];
    char win_esp_uuid[64];
    char win_esp_partuuid[64];
    int has_windows;
} inst_plan;

static const char *inst_files_dir(void)
{
    return env_or("SEVYN_INSTALL_FILES_DIR", INST_FILES_DIR);
}

static const char *inst_live_esp_dir(void)
{
    return env_or("SEVYN_INSTALL_LIVE_ESP_DIR", "");
}

static const char *inst_version(void)
{
    const char *v = env_or("SEVYN_INSTALL_VERSION", "");
    if (*v)
        return v;
    static char buf[128];
    char *f = read_file_cap(INST_OS_VERSION_FILE, sizeof(buf) - 1);
    if (f) {
        snprintf(buf, sizeof(buf), "%s", f);
        free(f);
        return buf;
    }
    return "unknown";
}

/* Run a command, discarding stdout/stderr. Returns the exit code. */
static int inst_run_quiet(char **argv)
{
    pid_t pid = fork();
    if (pid < 0)
        return -1;
    if (pid == 0) {
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0) {
            dup2(nullfd, STDOUT_FILENO);
            dup2(nullfd, STDERR_FILENO);
        }
        execvp(argv[0], argv);
        _exit(127);
    }
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return -1;
}

/* Trim leading/trailing whitespace in place. */
static void inst_trim(char *s)
{
    size_t n = strlen(s);
    while (n > 0 && (s[n - 1] == ' ' || s[n - 1] == '\t' ||
                     s[n - 1] == '\n' || s[n - 1] == '\r'))
        s[--n] = '\0';
    size_t i = 0;
    while (s[i] == ' ' || s[i] == '\t')
        i++;
    if (i > 0)
        memmove(s, s + i, strlen(s + i) + 1);
}

static int inst_is_file(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

/* Device path of a partition on a real disk: sd-style (sda2) vs
 * p-style (nvme0n1p2). Same rule as the updater's ESP derivation. */
static void inst_part_path(const char *disk, int num, char *out, size_t cap)
{
    const char *base = strrchr(disk, '/');
    base = base ? base + 1 : disk;
    size_t blen = strlen(base);
    if (blen > 0 && isdigit((unsigned char)base[blen - 1]))
        snprintf(out, cap, "%sp%d", disk, num);
    else
        snprintf(out, cap, "%s%d", disk, num);
}

/* mtools -i argument for an ESP partition: the device, or
 * <image>@@<byte-offset> for a partition inside an image file. */
static void inst_esp_arg(const inst_disk *d, const inst_part *p, char *out,
                         size_t cap)
{
    if (d->is_file)
        snprintf(out, cap, "%s@@%llu", d->disk,
                 p->start * INST_SECTOR);
    else
        inst_part_path(d->disk, p->num, out, cap);
}

/* blkid TYPE/UUID/LABEL of a partition (device, or -O offset into
 * an image file). Returns 0 on success (a filesystem was found). */
static int inst_blkid(const inst_disk *d, const inst_part *p)
{
    char *out = NULL;
    char off[32];
    char *argv[12];
    int n = 0;
    argv[n++] = "blkid";
    argv[n++] = "-p";
    argv[n++] = "-o";
    argv[n++] = "export";
    if (d->is_file) {
        snprintf(off, sizeof(off), "%llu", p->start * INST_SECTOR);
        argv[n++] = "-O";
        argv[n++] = off;
        argv[n++] = (char *)d->disk;
    } else {
        char dev[256];
        inst_part_path(d->disk, p->num, dev, sizeof(dev));
        argv[n++] = dev;
    }
    argv[n] = NULL;
    int rc = run_capture(argv, &out);
    if (rc != 0 || !out) {
        free(out);
        return -1;
    }
    int found = 0;
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    while (line) {
        if (strncmp(line, "TYPE=", 5) == 0) {
            snprintf((char *)p->fs, sizeof(p->fs), "%s", line + 5);
            found = 1;
        } else if (strncmp(line, "UUID=", 5) == 0) {
            snprintf((char *)p->fs_uuid, sizeof(p->fs_uuid), "%s", line + 5);
        } else if (strncmp(line, "LABEL=", 6) == 0) {
            snprintf((char *)p->label, sizeof(p->label), "%s", line + 6);
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    return found ? 0 : -1;
}

/* --- FAT access on real disks: mount, don't use mtools ---
 * mtools cannot open a partition device whose CHS geometry
 * disagrees with the FAT hidden-sector field: NVMe reports a
 * synthetic geometry (heads=255, sectors/track=63) and the check
 * fails with "Hidden (2048) does not match sectors (63)" — even
 * with MTOOLS_SKIP_CHECK=1, which only skips the partition-table
 * consistency check, not the geometry validation. (Proven in-guest
 * 2026-11-11: mdir on the live ESP failed exactly this way, and
 * the same failure silently hid every Windows ESP from the probe —
 * win_esp_uuid was always empty.) The kernel's vfat driver has no
 * such check, so on real disks the installer mounts the FAT
 * partition and uses plain file calls. Image files keep mtools
 * (no geometry there, and the host tests cannot mount). */
static int inst_mount_vfat(const char *dev, const char *mnt, int ro)
{
    if (mkdir(mnt, 0755) != 0 && errno != EEXIST)
        return -1;
    char *m_ro[] = {"/bin/busybox", "mount", "-t", "vfat", "-o", "ro",
                    (char *)dev, (char *)mnt, NULL};
    char *m_rw[] = {"/bin/busybox", "mount", "-t", "vfat",
                    (char *)dev, (char *)mnt, NULL};
    if (inst_run_quiet(ro ? m_ro : m_rw) != 0) {
        rmdir(mnt);
        return -1;
    }
    return 0;
}

static void inst_umount(const char *mnt)
{
    char *u[] = {"/bin/busybox", "umount", (char *)mnt, NULL};
    inst_run_quiet(u);
    rmdir(mnt);
}

/* "::/EFI/foo/bar" (mtools guest path) -> "<mnt>/EFI/foo/bar". */
static void inst_guest_path(const char *mnt, const char *guest,
                            char *out, size_t cap)
{
    const char *p = guest;
    if (p[0] == ':' && p[1] == ':')
        p += 2;
    snprintf(out, cap, "%s%s", mnt, p);
}

/* Does a FAT (ESP) partition contain this guest path? On a real
 * disk, mount (read-only) and test the file; in an image file,
 * mdir exits 0 when the file exists. */
static int inst_fat_has(const inst_disk *d, const inst_part *p,
                        const char *guest_path)
{
    if (!d->is_file) {
        char dev[256];
        inst_part_path(d->disk, p->num, dev, sizeof(dev));
        char mnt[256];
        snprintf(mnt, sizeof(mnt), "/tmp/sevyn-inst-mnt-%d",
                 (int)getpid());
        if (inst_mount_vfat(dev, mnt, 1) != 0)
            return 0;
        char host[PATH_MAX];
        inst_guest_path(mnt, guest_path, host, sizeof(host));
        int ok = inst_is_file(host);
        inst_umount(mnt);
        return ok;
    }
    char esp[512];
    inst_esp_arg(d, p, esp, sizeof(esp));
    char *argv[] = {"mdir", "-i", esp, (char *)guest_path, NULL};
    char *out = NULL;
    int rc = run_capture_quiet(argv, &out);
    free(out);
    return rc == 0;
}

/* Read a file off a FAT (ESP) partition into a malloc'd buffer.
 * On a real disk, mount (read-only) and read it; in an image
 * file, mcopy to stdout. Returns NULL when the file is missing. */
static char *inst_fat_read(const inst_disk *d, const inst_part *p,
                           const char *guest_path)
{
    if (!d->is_file) {
        char dev[256];
        inst_part_path(d->disk, p->num, dev, sizeof(dev));
        char mnt[256];
        snprintf(mnt, sizeof(mnt), "/tmp/sevyn-inst-mnt-%d",
                 (int)getpid());
        if (inst_mount_vfat(dev, mnt, 1) != 0)
            return NULL;
        char host[PATH_MAX];
        inst_guest_path(mnt, guest_path, host, sizeof(host));
        char *text = read_file_cap(host, 65536);
        inst_umount(mnt);
        return text;
    }
    char esp[512];
    inst_esp_arg(d, p, esp, sizeof(esp));
    char *argv[] = {"mcopy", "-i", esp, (char *)guest_path, "-", NULL};
    char *out = NULL;
    if (run_capture_quiet(argv, &out) != 0) {
        free(out);
        return NULL;
    }
    return out;
}

/* Parse one `sgdisk -i <n> <disk>` block into the partition slot.
 * Returns 0 on success. */
static int inst_sgdisk_info(const inst_disk *d, int num, inst_part *p)
{
    char numbuf[16];
    snprintf(numbuf, sizeof(numbuf), "%d", num);
    char *argv[] = {"sgdisk", "-i", numbuf, (char *)d->disk, NULL};
    char *out = NULL;
    if (run_capture(argv, &out) != 0) {
        free(out);
        return -1;
    }
    memset(p, 0, sizeof(*p));
    p->num = num;
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    while (line) {
        if (strncmp(line, "Partition GUID code: ", 21) == 0) {
            char *sp = strchr(line + 21, ' ');
            size_t len = sp ? (size_t)(sp - (line + 21))
                            : strlen(line + 21);
            if (len >= sizeof(p->type))
                len = sizeof(p->type) - 1;
            memcpy(p->type, line + 21, len);
            p->type[len] = '\0';
        } else if (strncmp(line, "Partition unique GUID: ", 23) == 0) {
            snprintf(p->partuuid, sizeof(p->partuuid), "%s", line + 23);
            inst_trim(p->partuuid);
        } else if (strncmp(line, "First sector: ", 14) == 0) {
            p->start = strtoull(line + 14, NULL, 10);
        } else if (strncmp(line, "Last sector: ", 13) == 0) {
            p->end = strtoull(line + 13, NULL, 10);
        } else if (strncmp(line, "Partition name: ", 16) == 0) {
            const char *nm = line + 16;
            if (*nm == '\'')
                nm++;
            snprintf(p->name, sizeof(p->name), "%s", nm);
            size_t nl = strlen(p->name);
            if (nl > 0 && p->name[nl - 1] == '\'')
                p->name[nl - 1] = '\0';
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    if (p->start == 0 && p->end == 0)
        return -1;
    p->is_esp = strcmp(p->type, INST_ESP_TYPE) == 0;
    return 0;
}

/* Read a disk's GPT into d. Returns 0 when the table parsed. */
static int inst_probe_disk(const char *path, inst_disk *d)
{
    memset(d, 0, sizeof(*d));
    snprintf(d->disk, sizeof(d->disk), "%s", path);
    const char *base = strrchr(path, '/');
    snprintf(d->devname, sizeof(d->devname), "%s", base ? base + 1 : path);
    d->is_file = inst_is_file(path);
    char *out = NULL;
    char *argv[] = {"sgdisk", "-p", (char *)path, NULL};
    if (run_capture(argv, &out) != 0) {
        free(out);
        return -1;
    }
    /* Header: "Disk <path>: <N> sectors" + "First usable sector is
     * <A>, last usable sector is <B>". */
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    int nums[32];
    int nnums = 0;
    while (line) {
        if (strncmp(line, "Disk ", 5) == 0) {
            /* "Disk <path>: <N> sectors" — NOT the "Disk identifier
             * (GUID): ..." line: it has no " sectors" marker, and a
             * GUID starting with a digit (or 0) would otherwise
             * clobber the sector count. */
            char *sectors = strstr(line, " sectors");
            char *colon = strchr(line, ':');
            if (sectors && colon && colon < sectors)
                d->size_sectors = strtoull(colon + 1, NULL, 10);
        } else if (strstr(line, "First usable sector is ") != NULL) {
            /* "First usable sector is 34, last usable sector is 4062" */
            char *a = strstr(line, "is ");
            if (a)
                d->first_usable = strtoull(a + 3, NULL, 10);
            char *comma = strchr(line, ',');
            if (comma) {
                char *b = strstr(comma, "is ");
                if (b)
                    d->last_usable = strtoull(b + 3, NULL, 10);
            }
        } else if (line[0] == ' ' || isdigit((unsigned char)line[0])) {
            /* Partition rows: num start end size-num size-unit code name */
            int num = 0;
            unsigned long long start = 0, end = 0;
            char szn[16] = "", szu[8] = "", code[8] = "";
            char name[64] = "";
            int got = sscanf(line, " %d %llu %llu %15s %7s %7s %63[^\n]",
                             &num, &start, &end, szn, szu, code, name);
            if (got >= 6 && num > 0 && nnums < 32) {
                nums[nnums++] = num;
                (void)szn;
                (void)szu;
                (void)code;
            }
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    if (d->size_sectors == 0 || d->last_usable == 0)
        return -1;
    d->gpt = 1;
    for (int i = 0; i < nnums; i++) {
        inst_part *p = &d->parts[d->nparts];
        if (inst_sgdisk_info(d, nums[i], p) != 0)
            continue;
        d->nparts++;
    }
    /* Classify each partition: filesystem + OS detection. */
    for (int i = 0; i < d->nparts; i++) {
        inst_part *p = &d->parts[i];
        inst_blkid(d, p);
        if (p->is_esp && strcmp(p->fs, "vfat") == 0) {
            if (inst_fat_has(d, p, "::/EFI/Microsoft/Boot/bootmgfw.efi"))
                p->is_windows_esp = 1;
            char *cfg = inst_fat_read(d, p, "::/EFI/ubuntu/grub.cfg");
            if (cfg) {
                if (strstr(cfg, "SevynOS") != NULL)
                    p->is_sevyn_esp = 1;
                free(cfg);
            }
        }
        if (strcmp(p->type, INST_MS_BASIC_TYPE) == 0 &&
            strcmp(p->fs, "ntfs") == 0)
            p->is_windows_data = 1;
        if (strcmp(p->label, "SEVYN_DATA") == 0)
            p->is_sevyn_data = 1;
        if (p->is_windows_esp || p->is_windows_data)
            d->has_windows = 1;
        if (p->is_sevyn_esp || p->is_sevyn_data)
            d->has_sevyn = 1;
    }
    /* Largest trailing free run: from the end of the last partition
     * to last_usable, 1 MiB aligned. Only trailing free space is
     * ever used — never carve between existing partitions. */
    unsigned long long end = d->first_usable;
    for (int i = 0; i < d->nparts; i++)
        if (d->parts[i].end >= end)
            end = d->parts[i].end + 1;
    unsigned long long aligned =
        (end + INST_ALIGN_SECTORS - 1) / INST_ALIGN_SECTORS *
        INST_ALIGN_SECTORS;
    if (aligned <= d->last_usable) {
        d->free_start = aligned;
        d->free_end = d->last_usable;
    }
    return 0;
}

/* The disk carrying the mounted /data (the live USB's disk, or the
 * installed system's disk). Returns 0 and fills disk_out. */
static int inst_boot_disk(char *disk_out, size_t cap)
{
    const char *mounts =
        env_or("SEVYN_INSTALL_PROC_MOUNTS", "/proc/mounts");
    FILE *f = fopen(mounts, "r");
    if (!f)
        return -1;
    char line[1024];
    char device[256] = "";
    while (fgets(line, sizeof(line), f)) {
        char *sp1 = strchr(line, ' ');
        if (!sp1)
            continue;
        char *sp2 = strchr(sp1 + 1, ' ');
        if (!sp2)
            continue;
        if ((size_t)(sp2 - (sp1 + 1)) != 5)
            continue;
        if (strncmp(sp1 + 1, "/data", 5) != 0)
            continue;
        size_t dl = (size_t)(sp1 - line);
        if (dl >= sizeof(device))
            dl = sizeof(device) - 1;
        memcpy(device, line, dl);
        device[dl] = '\0';
        break;
    }
    fclose(f);
    if (!device[0])
        return -1;
    char resolved[PATH_MAX];
    if (realpath(device, resolved) != NULL &&
        strlen(resolved) < sizeof(device))
        snprintf(device, sizeof(device), "%s", resolved);
    /* Strip the partition suffix to get the parent disk. */
    const char *base = strrchr(device, '/');
    base = base ? base + 1 : device;
    size_t blen = strlen(base);
    size_t i = blen;
    while (i > 0 && isdigit((unsigned char)base[i - 1]))
        i--;
    if (i == blen) {
        /* Whole disk (e.g. the QEMU -kernel path, or an image file
         * used as the data device in tests): the device IS the
         * disk carrying /data. */
        snprintf(disk_out, cap, "%s", device);
        return 0;
    }
    size_t parent_len = i;
    if (i > 1 && base[i - 1] == 'p' &&
        isdigit((unsigned char)base[i - 2]))
        parent_len = i - 1;
    char parent[256];
    size_t dev_len = (size_t)(base - device);
    if (dev_len + parent_len >= sizeof(parent))
        return -1;
    memcpy(parent, device, dev_len);
    memcpy(parent + dev_len, base, parent_len);
    parent[dev_len + parent_len] = '\0';
    snprintf(disk_out, cap, "%s", parent);
    return 0;
}

/* sha256 of the first and last 1 MiB of a partition (busybox dd +
 * sha256sum; the partition is never fully read). For an image file
 * the offsets are computed from the partition's start sector. */
static int inst_hash_edges(const inst_disk *d, const inst_part *p,
                           char out_first[65], char out_last[65])
{
    unsigned long long size_mb =
        (p->end - p->start + 1) * INST_SECTOR / (1024 * 1024);
    if (size_mb < 2)
        return -1;
    /* Next to the image, not /tmp, for image files: a full tmpfs
     * must not break the install. Real disks hash 1 MiB into /tmp. */
    char hdir[200] = "/tmp";
    if (d->is_file) {
        snprintf(hdir, sizeof(hdir), "%.199s", d->disk);
        char *slash = strrchr(hdir, '/');
        if (slash)
            *slash = '\0';
        else
            snprintf(hdir, sizeof(hdir), ".");
    }
    for (int edge = 0; edge < 2; edge++) {
        char tmpfile[256];
        snprintf(tmpfile, sizeof(tmpfile), "%s/sevyn-inst-hash-%d-%d",
                 hdir, (int)getpid(), edge);
        /* Devices are addressed at the partition start already;
         * image files need the absolute offset. */
        unsigned long long start_mb =
            d->is_file ? p->start * INST_SECTOR / (1024 * 1024) : 0;
        unsigned long long skip_mb =
            edge == 0 ? start_mb : start_mb + size_mb - 1;
        char skip[32], infile[512];
        snprintf(skip, sizeof(skip), "%llu", skip_mb);
        if (d->is_file)
            snprintf(infile, sizeof(infile), "%s", d->disk);
        else
            inst_part_path(d->disk, p->num, infile, sizeof(infile));
        char ifarg[600], ofarg[300], skiparg[48];
        snprintf(ifarg, sizeof(ifarg), "if=%s", infile);
        snprintf(ofarg, sizeof(ofarg), "of=%s", tmpfile);
        snprintf(skiparg, sizeof(skiparg), "skip=%s", skip);
        char *ddv[] = {"/bin/busybox", "dd", "status=none", "bs=1M",
                       "count=1", ifarg, ofarg, skiparg, NULL};
        char *discard = NULL;
        if (run_capture(ddv, &discard) != 0) {
            free(discard);
            unlink(tmpfile);
            return -1;
        }
        free(discard);
        char *sum = NULL;
        char *argv[] = {"/bin/busybox", "sha256sum", tmpfile, NULL};
        if (run_capture(argv, &sum) != 0 || !sum) {
            free(sum);
            unlink(tmpfile);
            return -1;
        }
        char *dst = edge == 0 ? out_first : out_last;
        size_t k = 0;
        while (sum[k] && k < 64 &&
               ((sum[k] >= '0' && sum[k] <= '9') ||
                (sum[k] >= 'a' && sum[k] <= 'f')))
            k++;
        if (k != 64) {
            free(sum);
            unlink(tmpfile);
            return -1;
        }
        memcpy(dst, sum, 64);
        dst[64] = '\0';
        free(sum);
        unlink(tmpfile);
    }
    return 0;
}

/* List disks from /sys/block (sd, nvme, vd, mmcblk, hd, xvd).
 * Returns the count, or -1. */
static int inst_list_disks(char disks[][256], int max)
{
    DIR *d = opendir("/sys/block");
    if (!d)
        return -1;
    int n = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL && n < max) {
        if (e->d_name[0] == '.')
            continue;
        if (strncmp(e->d_name, "loop", 4) == 0 ||
            strncmp(e->d_name, "ram", 3) == 0)
            continue;
        if (strncmp(e->d_name, "sd", 2) != 0 &&
            strncmp(e->d_name, "nvme", 4) != 0 &&
            strncmp(e->d_name, "vd", 2) != 0 &&
            strncmp(e->d_name, "mmcblk", 6) != 0 &&
            strncmp(e->d_name, "hd", 2) != 0 &&
            strncmp(e->d_name, "xvd", 3) != 0)
            continue;
        snprintf(disks[n], 256, "/dev/%.250s", e->d_name);
        n++;
    }
    closedir(d);
    return n;
}

static void inst_print_disk(const inst_disk *d)
{
    printf("disk: %s\n", d->disk);
    printf("disk-size-mb: %llu\n",
           d->size_sectors * INST_SECTOR / (1024 * 1024));
    printf("disk-gpt: %s\n", d->gpt ? "yes" : "no");
    printf("disk-boot-disk: %s\n", d->is_boot_disk ? "yes" : "no");
    printf("disk-windows: %s\n", d->has_windows ? "yes" : "no");
    printf("disk-sevyn: %s\n", d->has_sevyn ? "yes" : "no");
    printf("disk-free-mb: %llu\n",
           d->free_end >= d->free_start
               ? (d->free_end - d->free_start + 1) * INST_SECTOR /
                     (1024 * 1024)
               : 0);
    for (int i = 0; i < d->nparts; i++) {
        const inst_part *p = &d->parts[i];
        const char *os = "";
        if (p->is_windows_esp)
            os = "windows-esp";
        else if (p->is_windows_data)
            os = "windows";
        else if (p->is_sevyn_esp)
            os = "sevyn-esp";
        else if (p->is_sevyn_data)
            os = "sevyn-data";
        else if (p->is_esp)
            os = "esp";
        printf("part: %d type: %s start: %llu end: %llu fs: %s "
               "label: %s uuid: %s partuuid: %s os: %s\n",
               p->num, p->type, p->start, p->end,
               p->fs[0] ? p->fs : "-",
               p->label[0] ? p->label : "-",
               p->fs_uuid[0] ? p->fs_uuid : "-",
               p->partuuid[0] ? p->partuuid : "-", os);
    }
}

static int cmd_install_probe(const char *disk_arg)
{
    char boot[256] = "";
    inst_boot_disk(boot, sizeof(boot));
    if (disk_arg) {
        inst_disk d;
        if (inst_probe_disk(disk_arg, &d) != 0) {
            fprintf(stderr, "error: cannot read GPT on %s\n", disk_arg);
            return 1;
        }
        if (boot[0] && strcmp(boot, disk_arg) == 0)
            d.is_boot_disk = 1;
        inst_print_disk(&d);
        return 0;
    }
    char disks[16][256];
    int n = inst_list_disks(disks, 16);
    if (n < 0) {
        fprintf(stderr, "error: cannot list disks\n");
        return 1;
    }
    if (n == 0) {
        printf("disk: none\n");
        return 0;
    }
    for (int i = 0; i < n; i++) {
        inst_disk d;
        if (inst_probe_disk(disks[i], &d) != 0) {
            printf("disk: %s\n", disks[i]);
            printf("disk-gpt: no\n");
            continue;
        }
        if (boot[0] && strcmp(boot, disks[i]) == 0)
            d.is_boot_disk = 1;
        inst_print_disk(&d);
        if (i + 1 < n)
            printf("\n");
    }
    return 0;
}

/* Compute the install plan for a probed disk. target: "auto",
 * "free", or a partition number (replace mode). Returns 0 on
 * success, 1 with err set on refusal. */
static int inst_compute_plan(inst_disk *d, const char *target,
                             inst_plan *plan, char *err, size_t errcap)
{
    memset(plan, 0, sizeof(*plan));
    snprintf(plan->disk, sizeof(plan->disk), "%s", d->disk);
    plan->has_windows = d->has_windows;
    for (int i = 0; i < d->nparts; i++)
        if (d->parts[i].is_windows_esp) {
            snprintf(plan->win_esp_uuid, sizeof(plan->win_esp_uuid),
                     "%s", d->parts[i].fs_uuid);
            snprintf(plan->win_esp_partuuid,
                     sizeof(plan->win_esp_partuuid), "%s",
                     d->parts[i].partuuid);
            break;
        }
    if (d->is_boot_disk) {
        snprintf(err, errcap,
                 "refusing to install onto the boot disk %s", d->disk);
        return 1;
    }
    if (!d->gpt) {
        snprintf(err, errcap, "disk %s has no GPT partition table",
                 d->disk);
        return 1;
    }
    if (!d->has_windows) {
        /* A dual-boot install needs Windows to dual-boot with; a
         * Windows-less disk is a fresh-install case, not M11. */
        snprintf(err, errcap,
                 "no Windows install found on %s (dual-boot needs "
                 "Windows to install alongside)",
                 d->disk);
        return 1;
    }
    unsigned long long free_mb =
        d->free_end >= d->free_start
            ? (d->free_end - d->free_start + 1) * INST_SECTOR /
                  (1024 * 1024)
            : 0;
    int want_free = 0, replace_num = 0;
    if (!target || strcmp(target, "auto") == 0) {
        if (free_mb >= INST_MIN_FREE_MB)
            want_free = 1;
    } else if (strcmp(target, "free") == 0) {
        want_free = 1;
    } else {
        replace_num = atoi(target);
        if (replace_num <= 0) {
            snprintf(err, errcap, "bad --target %s", target);
            return 1;
        }
    }
    if (want_free) {
        if (free_mb < INST_MIN_FREE_MB) {
            snprintf(err, errcap,
                     "not enough free space on %s: %llu MiB free, "
                     "%d MiB needed",
                     d->disk, free_mb, INST_MIN_FREE_MB);
            return 1;
        }
        plan->mode = 0;
        plan->esp_start = d->free_start;
        plan->esp_end = plan->esp_start + INST_ESP_MB * 2048 - 1;
        plan->data_start = plan->esp_end + 1;
        unsigned long long data_max_end =
            plan->data_start + INST_DATA_MAX_MB * 2048 - 1;
        plan->data_end = data_max_end < d->free_end ? data_max_end
                                                    : d->free_end;
        if ((plan->data_end - plan->data_start + 1) * INST_SECTOR /
                (1024 * 1024) <
            INST_DATA_MIN_MB) {
            snprintf(err, errcap,
                     "not enough free space on %s for the data "
                     "partition",
                     d->disk);
            return 1;
        }
        /* New partition numbers: first free numbers above the max. */
        int maxn = 0;
        for (int i = 0; i < d->nparts; i++)
            if (d->parts[i].num > maxn)
                maxn = d->parts[i].num;
        if (maxn + 2 > 128) {
            snprintf(err, errcap, "no free partition numbers on %s",
                     d->disk);
            return 1;
        }
        plan->esp_num = maxn + 1;
        plan->data_num = maxn + 2;
    } else {
        /* Replace mode: every old SevynOS partition on the disk is
         * removed, and the new ESP + data go into the freed run —
         * which must be one contiguous run of at least the minimum. */
        int old[32];
        int nold = 0;
        for (int i = 0; i < d->nparts; i++)
            if (d->parts[i].is_sevyn_esp || d->parts[i].is_sevyn_data)
                old[nold++] = i;
        if (nold == 0) {
            snprintf(err, errcap,
                     "no existing SevynOS install to replace on %s "
                     "(and only %llu MiB free)",
                     d->disk, free_mb);
            return 1;
        }
        if (replace_num > 0) {
            int found = 0;
            for (int i = 0; i < nold; i++)
                if (d->parts[old[i]].num == replace_num)
                    found = 1;
            if (!found) {
                snprintf(err, errcap,
                         "partition %d on %s is not part of an "
                         "existing SevynOS install",
                         replace_num, d->disk);
                return 1;
            }
        }
        /* Sort the old partitions by start and require adjacency. */
        for (int i = 0; i < nold; i++)
            for (int j = i + 1; j < nold; j++)
                if (d->parts[old[j]].start < d->parts[old[i]].start) {
                    int t = old[i];
                    old[i] = old[j];
                    old[j] = t;
                }
        unsigned long long run_start = d->parts[old[0]].start;
        unsigned long long run_end = d->parts[old[0]].end;
        for (int i = 1; i < nold; i++) {
            if (d->parts[old[i]].start != run_end + 1) {
                snprintf(err, errcap,
                         "existing SevynOS partitions on %s are not "
                         "contiguous — cannot replace in place",
                         d->disk);
                return 1;
            }
            run_end = d->parts[old[i]].end;
        }
        unsigned long long run_mb =
            (run_end - run_start + 1) * INST_SECTOR / (1024 * 1024);
        if (run_mb < INST_MIN_FREE_MB) {
            snprintf(err, errcap,
                     "existing SevynOS install on %s is only %llu "
                     "MiB — too small to replace in place",
                     d->disk, run_mb);
            return 1;
        }
        plan->mode = 1;
        plan->esp_start = run_start;
        plan->esp_end = plan->esp_start + INST_ESP_MB * 2048 - 1;
        plan->data_start = plan->esp_end + 1;
        plan->data_end = run_end;
        if ((plan->data_end - plan->data_start + 1) * INST_SECTOR /
                (1024 * 1024) <
            INST_DATA_MIN_MB) {
            snprintf(err, errcap,
                     "existing SevynOS install on %s leaves too "
                     "little room for the data partition",
                     d->disk);
            return 1;
        }
        /* Reuse the old partition numbers, in start order. With a
         * single old partition the data partition takes the lowest
         * free number (esp_num + 1 may already be taken). */
        plan->esp_num = d->parts[old[0]].num;
        if (nold > 1) {
            plan->data_num = d->parts[old[1]].num;
        } else {
            int cand = 1;
            for (;;) {
                int taken = 0;
                for (int i = 0; i < d->nparts; i++)
                    if (d->parts[i].num == cand ||
                        cand == plan->esp_num)
                        taken = 1;
                if (!taken)
                    break;
                cand++;
                if (cand > 128) {
                    snprintf(err, errcap,
                             "no free partition numbers on %s", d->disk);
                    return 1;
                }
            }
            plan->data_num = cand;
        }
        for (int i = 0; i < nold; i++)
            plan->replaced[plan->nreplaced++] =
                d->parts[old[i]].num;
    }
    /* Protected partitions: everything not being replaced. Their
     * edge hashes are the proof they stay untouched. */
    for (int i = 0; i < d->nparts; i++) {
        int is_repl = 0;
        for (int j = 0; j < plan->nreplaced; j++)
            if (d->parts[i].num == plan->replaced[j])
                is_repl = 1;
        if (is_repl)
            continue;
        plan->prot[plan->nprot] = d->parts[i].num;
        unsigned long long size_mb =
            (d->parts[i].end - d->parts[i].start + 1) * INST_SECTOR /
            (1024 * 1024);
        if (size_mb >= 2) {
            char h0[65] = "", h1[65] = "";
            if (inst_hash_edges(d, &d->parts[i], h0, h1) == 0) {
                snprintf(plan->prot_hash[plan->nprot][0], 65, "%s", h0);
                snprintf(plan->prot_hash[plan->nprot][1], 65, "%s", h1);
            }
        }
        plan->nprot++;
    }
    return 0;
}

static void inst_print_plan(const inst_disk *d, const inst_plan *plan)
{
    printf("plan: ok\n");
    printf("disk: %s\n", plan->disk);
    printf("mode: %s\n", plan->mode == 0 ? "free-space" : "replace");
    printf("new-esp: %d start: %llu end: %llu size-mb: %d\n",
           plan->esp_num, plan->esp_start, plan->esp_end, INST_ESP_MB);
    printf("new-data: %d start: %llu end: %llu size-mb: %llu\n",
           plan->data_num, plan->data_start, plan->data_end,
           (plan->data_end - plan->data_start + 1) * INST_SECTOR /
               (1024 * 1024));
    printf("windows: %s\n", plan->has_windows ? "yes" : "no");
    printf("windows-esp-uuid: %s\n",
           plan->win_esp_uuid[0] ? plan->win_esp_uuid : "-");
    if (plan->nreplaced > 0) {
        printf("replaced:");
        for (int i = 0; i < plan->nreplaced; i++)
            printf(" %d", plan->replaced[i]);
        printf("\n");
    }
    printf("protected:");
    for (int i = 0; i < plan->nprot; i++)
        printf(" %d", plan->prot[i]);
    printf("\n");
    printf("boot-entry: SevynOS (first in BootOrder)\n");
    printf("grub: SevynOS + Windows 11\n");
    (void)d;
}

static int inst_plan_equal(const inst_plan *a, const inst_plan *b)
{
    if (strcmp(a->disk, b->disk) != 0 || a->mode != b->mode ||
        a->esp_start != b->esp_start || a->esp_end != b->esp_end ||
        a->data_start != b->data_start || a->data_end != b->data_end ||
        a->esp_num != b->esp_num || a->data_num != b->data_num ||
        a->nreplaced != b->nreplaced || a->nprot != b->nprot)
        return 0;
    for (int i = 0; i < a->nreplaced; i++)
        if (a->replaced[i] != b->replaced[i])
            return 0;
    for (int i = 0; i < a->nprot; i++) {
        if (a->prot[i] != b->prot[i])
            return 0;
        if (strcmp(a->prot_hash[i][0], b->prot_hash[i][0]) != 0 ||
            strcmp(a->prot_hash[i][1], b->prot_hash[i][1]) != 0)
            return 0;
    }
    return 1;
}

static int cmd_install_plan(const char *disk_arg, const char *target)
{
    if (!disk_arg) {
        fprintf(stderr, "error: install plan needs --disk <disk>\n");
        return 1;
    }
    inst_disk d;
    if (inst_probe_disk(disk_arg, &d) != 0) {
        fprintf(stderr, "error: cannot read GPT on %s\n", disk_arg);
        return 1;
    }
    char boot[256] = "";
    if (inst_boot_disk(boot, sizeof(boot)) == 0 &&
        strcmp(boot, disk_arg) == 0)
        d.is_boot_disk = 1;
    inst_plan plan;
    char err[512];
    if (inst_compute_plan(&d, target, &plan, err, sizeof(err)) != 0) {
        printf("plan: impossible\n");
        fprintf(stderr, "error: %s\n", err);
        return 1;
    }
    inst_print_plan(&d, &plan);
    return 0;
}

/* Partition I/O: on a real disk, operations run against the device
 * directly; inside an image file, they run against a temp file of
 * the partition's size, which is dd'd into place at the end. */
typedef struct {
    int is_file;
    char dev[256]; /* device path (real disk) */
    char tmp[256]; /* temp file (image-file case) */
    char img[256]; /* image path (image-file case) */
    char mnt[256]; /* mountpoint (real-disk ESP staging) */
    unsigned long long offset; /* bytes into the image */
    unsigned long long size;   /* bytes */
} inst_part_io;

static int inst_io_init(const inst_disk *d, const inst_part *p,
                        inst_part_io *io)
{
    memset(io, 0, sizeof(*io));
    io->is_file = d->is_file;
    io->offset = p->start * INST_SECTOR;
    io->size = (p->end - p->start + 1) * INST_SECTOR;
    if (d->is_file) {
        snprintf(io->img, sizeof(io->img), "%s", d->disk);
        /* Next to the image, not /tmp: the staging file is as big
         * as the partition (1152 MiB ESP) and /tmp is a small tmpfs
         * in the sandbox and RAM-backed in the live image. */
        char dir[200];
        snprintf(dir, sizeof(dir), "%.199s", d->disk);
        char *slash = strrchr(dir, '/');
        if (slash)
            *slash = '\0';
        else
            snprintf(dir, sizeof(dir), ".");
        snprintf(io->tmp, sizeof(io->tmp),
                 "%s/sevyn-inst-part-%d-%d", dir, (int)getpid(),
                 p->num);
        int fd = open(io->tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0)
            return -1;
        if (ftruncate(fd, (off_t)io->size) != 0) {
            close(fd);
            unlink(io->tmp);
            return -1;
        }
        close(fd);
    } else {
        inst_part_path(d->disk, p->num, io->dev, sizeof(io->dev));
    }
    return 0;
}

static const char *inst_io_target(const inst_part_io *io)
{
    return io->is_file ? io->tmp : io->dev;
}

/* dd the staged temp file into the image at the partition offset. */
static int inst_io_dd_in(const inst_part_io *io)
{
    if (!io->is_file)
        return 0;
    char seek[32];
    snprintf(seek, sizeof(seek), "%llu", io->offset / (1024 * 1024));
    char ifarg[300], ofarg[300], seekarg[48];
    snprintf(ifarg, sizeof(ifarg), "if=%s", io->tmp);
    snprintf(ofarg, sizeof(ofarg), "of=%s", io->img);
    snprintf(seekarg, sizeof(seekarg), "seek=%s", seek);
    char *argv[] = {"/bin/busybox", "dd", "status=none", "bs=1M",
                    "conv=notrunc", ifarg, ofarg, seekarg, NULL};
    char *out = NULL;
    int rc = run_capture(argv, &out);
    free(out);
    return rc == 0 ? 0 : -1;
}

static void inst_io_cleanup(inst_part_io *io)
{
    if (io->is_file && io->tmp[0])
        unlink(io->tmp);
}

static int inst_io_mkfs_vfat(inst_part_io *io)
{
    char *argv[] = {"mkfs.vfat", "-F", "32", "-n", "SEVYNESP",
                    (char *)inst_io_target(io), NULL};
    char *out = NULL;
    int rc = run_capture(argv, &out);
    free(out);
    return rc == 0 ? 0 : -1;
}

static int inst_io_mkfs_ext4(inst_part_io *io)
{
    char *argv[] = {"mkfs.ext4", "-q", "-F", "-L", "SEVYN_DATA",
                    (char *)inst_io_target(io), NULL};
    char *out = NULL;
    int rc = run_capture(argv, &out);
    free(out);
    return rc == 0 ? 0 : -1;
}

/* Mount a real-disk ESP for staging (mtools cannot write to it:
 * same CHS geometry validation as the reads). No-op for image
 * files, which keep mtools on the temp slice. */
static int inst_esp_mount(inst_part_io *io)
{
    if (io->is_file || io->mnt[0])
        return 0;
    snprintf(io->mnt, sizeof(io->mnt), "/tmp/sevyn-inst-esp-%d",
             (int)getpid());
    if (inst_mount_vfat(io->dev, io->mnt, 0) != 0) {
        io->mnt[0] = '\0';
        return -1;
    }
    return 0;
}

static void inst_esp_umount(inst_part_io *io)
{
    if (io->mnt[0]) {
        inst_umount(io->mnt);
        io->mnt[0] = '\0';
    }
}

/* mmd on the ESP (ignores "already exists"). On a real disk, the
 * ESP is mounted (see inst_esp_mount) and the directory is made
 * with mkdir; in an image file, mmd on the temp slice. */
static void inst_esp_mkdir(inst_part_io *io, const char *dir)
{
    if (!io->is_file && io->mnt[0]) {
        char host[PATH_MAX];
        inst_guest_path(io->mnt, dir, host, sizeof(host));
        mkdir(host, 0755); /* parent created by the earlier call */
        return;
    }
    char *argv[] = {"mmd", "-i", (char *)inst_io_target(io),
                    (char *)dir, NULL};
    char *out = NULL;
    run_capture(argv, &out);
    free(out);
}

/* Copy one or more host files into an ESP directory. On a real
 * disk, the ESP is mounted and the files are cp'd in; in an image
 * file, mcopy onto the temp slice. */
static int inst_esp_copy(inst_part_io *io, char **srcs, int nsrcs,
                         const char *dest)
{
    if (!io->is_file && io->mnt[0]) {
        char host[PATH_MAX];
        inst_guest_path(io->mnt, dest, host, sizeof(host));
        for (int i = 0; i < nsrcs; i++) {
            char *argv[] = {"/bin/busybox", "cp", srcs[i], host, NULL};
            char *out = NULL;
            int rc = run_capture(argv, &out);
            free(out);
            if (rc != 0)
                return -1;
        }
        return 0;
    }
    char **argv = malloc(sizeof(char *) * (size_t)(nsrcs + 5));
    if (!argv)
        return -1;
    int n = 0;
    argv[n++] = "mcopy";
    argv[n++] = "-i";
    argv[n++] = (char *)inst_io_target(io);
    for (int i = 0; i < nsrcs; i++)
        argv[n++] = srcs[i];
    argv[n++] = (char *)dest;
    argv[n] = NULL;
    char *out = NULL;
    int rc = run_capture(argv, &out);
    free(out);
    free(argv);
    return rc == 0 ? 0 : -1;
}

/* Copy the live kernel + initramfs into tmpdir. In-guest, they come
 * from the boot disk's ESP (mounted read-only); in host tests, from
 * SEVYN_INSTALL_LIVE_ESP_DIR. */
static int inst_live_kernel(char *tmpdir, size_t cap)
{
    const char *dir = inst_live_esp_dir();
    if (dir[0]) {
        char k[PATH_MAX], i[PATH_MAX];
        snprintf(k, sizeof(k), "%s/vmlinuz", dir);
        snprintf(i, sizeof(i), "%s/initramfs.cpio.gz", dir);
        if (!inst_is_file(k) || !inst_is_file(i))
            return -1;
        snprintf(tmpdir, cap, "%s", dir);
        return 0;
    }
    char boot[256] = "";
    if (inst_boot_disk(boot, sizeof(boot)) != 0)
        return -1;
    /* The boot ESP is partition 1 of the boot disk (USB layout).
     * Mount it and test for the files directly: an mdir pre-check
     * cannot open an NVMe partition device (mtools CHS geometry
     * validation fails on it), but the kernel's vfat driver can. */
    char esp_dev[256];
    inst_part_path(boot, 1, esp_dev, sizeof(esp_dev));
    char mnt[256];
    snprintf(mnt, sizeof(mnt), "/tmp/sevyn-live-esp-%d", (int)getpid());
    if (inst_mount_vfat(esp_dev, mnt, 1) != 0)
        return -1;
    char k[PATH_MAX], i[PATH_MAX];
    snprintf(k, sizeof(k), "%s/vmlinuz", mnt);
    snprintf(i, sizeof(i), "%s/initramfs.cpio.gz", mnt);
    int ok = inst_is_file(k) && inst_is_file(i);
    if (ok) {
        /* Copy out, then unmount: the temp copies are what the
         * staging steps read. */
        char td[256];
        snprintf(td, sizeof(td), "/tmp/sevyn-live-kern-%d", (int)getpid());
        if (mkdir(td, 0755) != 0 && errno != EEXIST)
            ok = 0;
        else {
            char k2[PATH_MAX], i2[PATH_MAX];
            snprintf(k2, sizeof(k2), "%s/vmlinuz", td);
            snprintf(i2, sizeof(i2), "%s/initramfs.cpio.gz", td);
            char *cp1[] = {"/bin/busybox", "cp", k, k2, NULL};
            char *cp2[] = {"/bin/busybox", "cp", i, i2, NULL};
            if (inst_run_quiet(cp1) != 0 || inst_run_quiet(cp2) != 0)
                ok = 0;
            else
                snprintf(tmpdir, cap, "%s", td);
        }
    }
    inst_umount(mnt);
    return ok ? 0 : -1;
}

static int inst_write_grub_cfg(const char *path, const char *data_partuuid,
                               const char *win_esp_uuid)
{
    FILE *f = fopen(path, "w");
    if (!f)
        return -1;
    fprintf(f,
            "# SevynOS boot menu (GRUB, loaded by shim under Secure Boot).\n"
            "# Written by the SevynOS installer: SevynOS + Windows 11.\n"
            "set timeout=5\n"
            "set default=0\n"
            "menuentry \"SevynOS\" {\n"
            "    linux /vmlinuz console=tty0 console=ttyS0 sevyn.slot=A "
            "sevyn.data=PARTUUID=%s\n"
            "    initrd /initramfs.cpio.gz\n"
            "}\n",
            data_partuuid);
    if (win_esp_uuid && win_esp_uuid[0])
        fprintf(f,
                "menuentry \"Windows 11\" {\n"
                "    search --fs-uuid %s --set=root\n"
                "    chainloader /EFI/Microsoft/Boot/bootmgfw.efi\n"
                "}\n",
                win_esp_uuid);
    fclose(f);
    return 0;
}

/* Write the A/B slot layout into a fresh ext4 data partition
 * (mirrors make-data-disk.py): /slots/A with the live kernel +
 * initramfs, empty /slots/B, /slot-state.json. */
static int inst_write_slots(inst_part_io *io, const char *kern_dir,
                            const char *version)
{
    char cmds[PATH_MAX];
    snprintf(cmds, sizeof(cmds), "/tmp/sevyn-inst-debugfs-%d",
             (int)getpid());
    char state[PATH_MAX];
    snprintf(state, sizeof(state), "/tmp/sevyn-inst-state-%d",
             (int)getpid());
    FILE *f = fopen(state, "w");
    if (!f)
        return -1;
    fprintf(f,
            "{\n  \"active\": \"A\",\n  \"good\": \"A\",\n  \"attempts\": 0,\n"
            "  \"version\": \"%s\"\n}\n",
            version);
    fclose(f);
    f = fopen(cmds, "w");
    if (!f) {
        unlink(state);
        return -1;
    }
    fprintf(f,
            "mkdir /slots\n"
            "mkdir /slots/A\n"
            "mkdir /slots/B\n"
            "write %s/vmlinuz /slots/A/vmlinuz\n"
            "write %s/initramfs.cpio.gz /slots/A/initramfs.cpio.gz\n"
            "write %s /slot-state.json\n",
            kern_dir, kern_dir, state);
    fclose(f);
    char *argv[] = {"debugfs", "-w", "-f", cmds,
                    (char *)inst_io_target(io), NULL};
    char *out = NULL;
    int rc = run_capture(argv, &out);
    free(out);
    unlink(cmds);
    unlink(state);
    return rc == 0 ? 0 : -1;
}

/* Collect *.mod / *.lst / moddep.lst basenames from the install
 * files dir (the GRUB modules staged by the image build). */
static int inst_grub_mods(char ***out_names, int *out_n)
{
    const char *dir = inst_files_dir();
    DIR *d = opendir(dir);
    if (!d)
        return -1;
    char **names = NULL;
    int n = 0, cap = 0;
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
        size_t len = strlen(e->d_name);
        int is_mod = (len > 4 && strcmp(e->d_name + len - 4, ".mod") == 0) ||
                     (len > 4 && strcmp(e->d_name + len - 4, ".lst") == 0) ||
                     strcmp(e->d_name, "moddep.lst") == 0;
        if (!is_mod)
            continue;
        if (n >= cap) {
            cap = cap ? cap * 2 : 32;
            char **nn = realloc(names, sizeof(char *) * (size_t)cap);
            if (!nn) {
                closedir(d);
                return -1;
            }
            names = nn;
        }
        names[n] = malloc(strlen(dir) + len + 2);
        if (!names[n]) {
            closedir(d);
            return -1;
        }
        sprintf(names[n], "%s/%s", dir, e->d_name);
        n++;
    }
    closedir(d);
    *out_names = names;
    *out_n = n;
    return 0;
}

static int inst_require_file(const char *dir, const char *name)
{
    char p[PATH_MAX];
    snprintf(p, sizeof(p), "%s/%s", dir, name);
    return inst_is_file(p) ? 0 : -1;
}

/* Register the UEFI boot entry (best-effort: without efivars the
 * fallback /EFI/BOOT/BOOTX64.EFI still boots the new ESP). */
static void inst_register_boot_entry(const inst_disk *d, int esp_num)
{
    if (d->is_file)
        return; /* image files have no firmware to register with */
    struct stat st;
    if (stat("/sys/firmware/efi/efivars", &st) != 0) {
        printf("warning: no UEFI variables (not booted via UEFI?) — "
               "boot entry not registered; the fallback BOOTX64.EFI "
               "still boots the new ESP\n");
        return;
    }
    if (access("/usr/sbin/efibootmgr", X_OK) != 0 &&
        access("efibootmgr", X_OK) != 0) {
        printf("warning: efibootmgr not found — boot entry not "
               "registered; the fallback BOOTX64.EFI still boots "
               "the new ESP\n");
        return;
    }
    char partnum[16];
    snprintf(partnum, sizeof(partnum), "%d", esp_num);
    char *create[] = {"efibootmgr", "--create", "--disk",
                      (char *)d->disk, "--part", partnum,
                      "--label", "SevynOS",
                      "--loader", "/EFI/ubuntu/shimx64.efi", NULL};
    char *out = NULL;
    if (run_capture(create, &out) != 0) {
        free(out);
        printf("warning: efibootmgr --create failed — boot entry "
               "not registered; the fallback BOOTX64.EFI still "
               "boots the new ESP\n");
        return;
    }
    free(out);
    out = NULL;
    /* Find the new entry number in the verbose listing. */
    char *argv[] = {"efibootmgr", "-v", NULL};
    if (run_capture(argv, &out) != 0 || !out) {
        free(out);
        printf("warning: efibootmgr -v failed — cannot confirm the "
               "new boot entry\n");
        return;
    }
    char newnum[8] = "";
    char *save = NULL;
    char *line = strtok_r(out, "\n", &save);
    while (line) {
        if (strncmp(line, "Boot", 4) == 0 && strlen(line) >= 8 &&
            strstr(line, "SevynOS") != NULL) {
            memcpy(newnum, line + 4, 4);
            newnum[4] = '\0';
            break;
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    if (!newnum[0]) {
        printf("warning: new boot entry not found in efibootmgr -v\n");
        return;
    }
    /* Put the new entry first in BootOrder, preserving the rest. */
    out = NULL;
    char *argv2[] = {"efibootmgr", NULL};
    if (run_capture(argv2, &out) != 0 || !out) {
        free(out);
        return;
    }
    char order[1024] = "";
    line = strtok_r(out, "\n", &save);
    while (line) {
        if (strncmp(line, "BootOrder: ", 11) == 0) {
            snprintf(order, sizeof(order), "%s", line + 11);
            break;
        }
        line = strtok_r(NULL, "\n", &save);
    }
    free(out);
    if (!order[0])
        return;
    /* Rebuild the order: new first, then the old entries minus new. */
    char rebuilt[1024];
    snprintf(rebuilt, sizeof(rebuilt), "%s", newnum);
    char *tok_save = NULL;
    char *tok = strtok_r(order, ",", &tok_save);
    while (tok) {
        if (strcmp(tok, newnum) != 0) {
            strncat(rebuilt, ",", sizeof(rebuilt) - strlen(rebuilt) - 1);
            strncat(rebuilt, tok, sizeof(rebuilt) - strlen(rebuilt) - 1);
        }
        tok = strtok_r(NULL, ",", &tok_save);
    }
    char *argv3[] = {"efibootmgr", "-o", rebuilt, NULL};
    char *discard = NULL;
    if (run_capture(argv3, &discard) != 0)
        printf("warning: efibootmgr -o failed — BootOrder unchanged\n");
    else
        printf("boot-entry: SevynOS (%s) first in BootOrder\n", newnum);
    free(discard);
}

static int cmd_install_install(const char *disk_arg, const char *target,
                               int yes)
{
    if (!disk_arg) {
        fprintf(stderr, "error: install needs --disk <disk>\n");
        return 1;
    }
    if (!yes) {
        fprintf(stderr,
                "error: refusing to install without --yes — run "
                "`sevyn install plan --disk %s` first, review it, "
                "then re-run with --yes\n",
                disk_arg);
        return 1;
    }
    inst_disk d;
    if (inst_probe_disk(disk_arg, &d) != 0) {
        fprintf(stderr, "error: cannot read GPT on %s\n", disk_arg);
        return 1;
    }
    char boot[256] = "";
    if (inst_boot_disk(boot, sizeof(boot)) == 0 &&
        strcmp(boot, disk_arg) == 0)
        d.is_boot_disk = 1;
    inst_plan plan;
    char err[512];
    if (inst_compute_plan(&d, target, &plan, err, sizeof(err)) != 0) {
        fprintf(stderr, "error: %s\n", err);
        return 1;
    }
    /* Re-probe: the plan must be identical to the confirmed one —
     * a disk that changed under us aborts the install. */
    inst_disk d2;
    if (inst_probe_disk(disk_arg, &d2) != 0) {
        fprintf(stderr, "error: cannot re-read GPT on %s\n", disk_arg);
        return 1;
    }
    if (inst_boot_disk(boot, sizeof(boot)) == 0 &&
        strcmp(boot, disk_arg) == 0)
        d2.is_boot_disk = 1;
    inst_plan plan2;
    if (inst_compute_plan(&d2, target, &plan2, err, sizeof(err)) != 0) {
        fprintf(stderr, "error: disk changed: %s\n", err);
        return 1;
    }
    if (!inst_plan_equal(&plan, &plan2)) {
        fprintf(stderr,
                "error: disk changed since the plan was computed — "
                "re-run `sevyn install plan` and confirm again\n");
        return 1;
    }
    /* Pre-flight: bootloader files + live kernel must exist before
     * anything writes. */
    const char *files = inst_files_dir();
    const char *need[] = {"shimx64.efi", "grubx64.efi", "mmx64.efi",
                          "fbx64.efi", "BOOTX64.CSV", "unicode.pf2"};
    for (size_t i = 0; i < sizeof(need) / sizeof(need[0]); i++)
        if (inst_require_file(files, need[i]) != 0) {
            fprintf(stderr, "error: install files missing %s/%s\n",
                    files, need[i]);
            return 1;
        }
    char kern_dir[PATH_MAX] = "";
    if (inst_live_kernel(kern_dir, sizeof(kern_dir)) != 0) {
        fprintf(stderr,
                "error: cannot find the live kernel + initramfs "
                "(boot ESP not found)\n");
        return 1;
    }
    char **mods = NULL;
    int nmods = 0;
    if (inst_grub_mods(&mods, &nmods) != 0) {
        fprintf(stderr, "error: cannot list GRUB modules in %s\n", files);
        return 1;
    }
    printf("install: %s mode=%s esp=%d data=%d\n", plan.disk,
           plan.mode == 0 ? "free-space" : "replace", plan.esp_num,
           plan.data_num);
    /* Replace mode: delete the old SevynOS partitions first. */
    if (plan.nreplaced > 0) {
        char *argv[8 + 32];
        int n = 0;
        argv[n++] = "sgdisk";
        for (int i = 0; i < plan.nreplaced; i++) {
            char *a = malloc(32);
            snprintf(a, 32, "--delete=%d", plan.replaced[i]);
            argv[n++] = a;
        }
        argv[n++] = (char *)disk_arg;
        argv[n] = NULL;
        char *out = NULL;
        int rc = run_capture(argv, &out);
        free(out);
        for (int i = 1; i < n - 1; i++)
            free(argv[i]);
        if (rc != 0) {
            fprintf(stderr, "error: sgdisk delete failed\n");
            return 1;
        }
    }
    /* Create the new partitions. */
    char newesp[64], newdata[64], typeesp[64], typedata[64],
        nameesp[48], namedata[48];
    snprintf(newesp, sizeof(newesp), "--new=%d:%llu:%llu", plan.esp_num,
             plan.esp_start, plan.esp_end);
    snprintf(newdata, sizeof(newdata), "--new=%d:%llu:%llu",
             plan.data_num, plan.data_start, plan.data_end);
    snprintf(typeesp, sizeof(typeesp), "--typecode=%d:%s", plan.esp_num,
             INST_ESP_TYPE);
    snprintf(typedata, sizeof(typedata), "--typecode=%d:%s",
             plan.data_num, INST_LINUX_TYPE);
    snprintf(nameesp, sizeof(nameesp), "--change-name=%d:SevynOS ESP",
             plan.esp_num);
    snprintf(namedata, sizeof(namedata),
             "--change-name=%d:SevynOS data", plan.data_num);
    char *argv[] = {"sgdisk", newesp, newdata, typeesp, typedata,
                    nameesp, namedata, (char *)disk_arg, NULL};
    char *out = NULL;
    if (run_capture(argv, &out) != 0) {
        free(out);
        fprintf(stderr, "error: sgdisk create failed\n");
        return 1;
    }
    free(out);
    /* Re-probe: confirm the new partitions + read their PARTUUIDs. */
    inst_disk d3;
    if (inst_probe_disk(disk_arg, &d3) != 0) {
        fprintf(stderr, "error: cannot re-read GPT after create\n");
        return 1;
    }
    inst_part *esp_part = NULL, *data_part = NULL;
    for (int i = 0; i < d3.nparts; i++) {
        if (d3.parts[i].num == plan.esp_num)
            esp_part = &d3.parts[i];
        if (d3.parts[i].num == plan.data_num)
            data_part = &d3.parts[i];
    }
    if (!esp_part || !data_part || !esp_part->is_esp ||
        strcmp(data_part->type, INST_LINUX_TYPE) != 0) {
        fprintf(stderr,
                "error: new partitions not found after create\n");
        return 1;
    }
    /* Stage the ESP. */
    inst_part_io esp_io, data_io;
    if (inst_io_init(&d3, esp_part, &esp_io) != 0) {
        fprintf(stderr, "error: cannot stage the new ESP\n");
        return 1;
    }
    if (inst_io_mkfs_vfat(&esp_io) != 0) {
        fprintf(stderr, "error: mkfs.vfat failed on the new ESP\n");
        inst_io_cleanup(&esp_io);
        return 1;
    }
    if (inst_esp_mount(&esp_io) != 0) {
        fprintf(stderr, "error: cannot mount the new ESP\n");
        inst_io_cleanup(&esp_io);
        return 1;
    }
    inst_esp_mkdir(&esp_io, "::/EFI");
    inst_esp_mkdir(&esp_io, "::/EFI/BOOT");
    inst_esp_mkdir(&esp_io, "::/EFI/ubuntu");
    char shim[PATH_MAX], grub[PATH_MAX], mmx[PATH_MAX], fbx[PATH_MAX],
        csv[PATH_MAX], pf2[PATH_MAX], kern[PATH_MAX], initrd[PATH_MAX];
    snprintf(shim, sizeof(shim), "%s/shimx64.efi", files);
    snprintf(grub, sizeof(grub), "%s/grubx64.efi", files);
    snprintf(mmx, sizeof(mmx), "%s/mmx64.efi", files);
    snprintf(fbx, sizeof(fbx), "%s/fbx64.efi", files);
    snprintf(csv, sizeof(csv), "%s/BOOTX64.CSV", files);
    snprintf(pf2, sizeof(pf2), "%s/unicode.pf2", files);
    snprintf(kern, sizeof(kern), "%s/vmlinuz", kern_dir);
    snprintf(initrd, sizeof(initrd), "%s/initramfs.cpio.gz", kern_dir);
    char *boot_srcs[] = {shim, grub, mmx, fbx};
    char *ubuntu_srcs[] = {shim, grub, mmx, csv, pf2};
    int ok = 1;
    if (inst_esp_copy(&esp_io, boot_srcs, 1, "::/EFI/BOOT/BOOTX64.EFI") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, boot_srcs + 1, 1,
                            "::/EFI/BOOT/grubx64.efi") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, boot_srcs + 2, 1,
                            "::/EFI/BOOT/MokManager.efi") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, boot_srcs + 3, 1,
                            "::/EFI/BOOT/fbx64.efi") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, ubuntu_srcs, 5,
                            "::/EFI/ubuntu/") != 0)
        ok = 0;
    if (ok && nmods > 0 &&
        inst_esp_copy(&esp_io, mods, nmods, "::/EFI/ubuntu/") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, (char *[]){kern}, 1,
                            "::/vmlinuz") != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, (char *[]){initrd}, 1,
                            "::/initramfs.cpio.gz") != 0)
        ok = 0;
    char grubcfg[PATH_MAX];
    snprintf(grubcfg, sizeof(grubcfg), "/tmp/sevyn-inst-grub-%d",
             (int)getpid());
    if (ok && inst_write_grub_cfg(grubcfg, data_part->partuuid,
                                  plan.win_esp_uuid) != 0)
        ok = 0;
    if (ok && inst_esp_copy(&esp_io, (char *[]){grubcfg}, 1,
                            "::/EFI/ubuntu/grub.cfg") != 0)
        ok = 0;
    unlink(grubcfg);
    inst_esp_umount(&esp_io);
    if (ok && inst_io_dd_in(&esp_io) != 0)
        ok = 0;
    if (!ok) {
        fprintf(stderr, "error: staging the new ESP failed\n");
        inst_esp_umount(&esp_io);
        inst_io_cleanup(&esp_io);
        return 1;
    }
    inst_io_cleanup(&esp_io);
    /* Stage the data partition: slots + slot-state. */
    if (inst_io_init(&d3, data_part, &data_io) != 0) {
        fprintf(stderr, "error: cannot stage the new data partition\n");
        return 1;
    }
    if (inst_io_mkfs_ext4(&data_io) != 0) {
        fprintf(stderr, "error: mkfs.ext4 failed on the new data "
                        "partition\n");
        inst_io_cleanup(&data_io);
        return 1;
    }
    if (inst_write_slots(&data_io, kern_dir, inst_version()) != 0) {
        fprintf(stderr, "error: writing the slot layout failed\n");
        inst_io_cleanup(&data_io);
        return 1;
    }
    if (inst_io_dd_in(&data_io) != 0) {
        fprintf(stderr, "error: writing the data partition failed\n");
        inst_io_cleanup(&data_io);
        return 1;
    }
    inst_io_cleanup(&data_io);
    /* UEFI boot entry (best-effort; the fallback still boots). */
    inst_register_boot_entry(&d3, plan.esp_num);
    /* Verify: re-probe, ESP contents, protected partitions. */
    inst_disk d4;
    if (inst_probe_disk(disk_arg, &d4) != 0) {
        fprintf(stderr, "error: cannot re-read GPT after install\n");
        return 1;
    }
    inst_part *vesp = NULL, *vdata = NULL;
    for (int i = 0; i < d4.nparts; i++) {
        if (d4.parts[i].num == plan.esp_num)
            vesp = &d4.parts[i];
        if (d4.parts[i].num == plan.data_num)
            vdata = &d4.parts[i];
    }
    if (!vesp || !vdata || !vesp->is_esp ||
        strcmp(vdata->label, "SEVYN_DATA") != 0) {
        fprintf(stderr, "error: verification failed — new partitions "
                        "not found\n");
        return 1;
    }
    if (!inst_fat_has(&d4, vesp, "::/EFI/ubuntu/grub.cfg") ||
        !inst_fat_has(&d4, vesp, "::/vmlinuz") ||
        !inst_fat_has(&d4, vesp, "::/initramfs.cpio.gz") ||
        !inst_fat_has(&d4, vesp, "::/EFI/BOOT/BOOTX64.EFI")) {
        fprintf(stderr, "error: verification failed — ESP files "
                        "missing\n");
        return 1;
    }
    char *cfg = inst_fat_read(&d4, vesp, "::/EFI/ubuntu/grub.cfg");
    if (!cfg || !strstr(cfg, "SevynOS") ||
        (plan.has_windows && !strstr(cfg, "Windows 11"))) {
        free(cfg);
        fprintf(stderr, "error: verification failed — grub.cfg "
                        "incomplete\n");
        return 1;
    }
    free(cfg);
    for (int i = 0; i < plan.nprot; i++) {
        inst_part *p = NULL;
        for (int j = 0; j < d4.nparts; j++)
            if (d4.parts[j].num == plan.prot[i])
                p = &d4.parts[j];
        if (!p) {
            fprintf(stderr,
                    "error: verification failed — protected "
                    "partition %d vanished\n",
                    plan.prot[i]);
            return 1;
        }
        if (plan.prot_hash[i][0][0]) {
            char h0[65] = "", h1[65] = "";
            if (inst_hash_edges(&d4, p, h0, h1) != 0 ||
                strcmp(h0, plan.prot_hash[i][0]) != 0 ||
                strcmp(h1, plan.prot_hash[i][1]) != 0) {
                fprintf(stderr,
                        "error: verification failed — protected "
                        "partition %d changed during install\n",
                        plan.prot[i]);
                return 1;
            }
        }
    }
    printf("install: ok\n");
    printf("disk: %s\n", plan.disk);
    printf("esp: %d\n", plan.esp_num);
    printf("data: %d\n", plan.data_num);
    printf("windows: untouched\n");
    return 0;
}

static int cmd_install_status(void)
{
    char boot[256] = "";
    if (inst_boot_disk(boot, sizeof(boot)) != 0) {
        printf("installed: no (live image, no data disk)\n");
        printf("dual-boot: no\n");
        return 0;
    }
    inst_disk d;
    if (inst_probe_disk(boot, &d) != 0) {
        printf("installed: unknown (cannot read %s)\n", boot);
        printf("dual-boot: no\n");
        return 0;
    }
    d.is_boot_disk = 1;
    int installed = d.has_windows && d.has_sevyn;
    int dual = 0;
    for (int i = 0; i < d.nparts; i++) {
        if (d.parts[i].is_sevyn_esp) {
            char *cfg = inst_fat_read(&d, &d.parts[i],
                                      "::/EFI/ubuntu/grub.cfg");
            if (cfg) {
                if (strstr(cfg, "Windows 11") != NULL)
                    dual = 1;
                free(cfg);
            }
        }
    }
    printf("installed: %s\n", installed ? "yes" : "no");
    printf("dual-boot: %s\n", dual ? "yes" : "no");
    printf("disk: %s\n", boot);
    printf("version: %s\n", inst_version());
    return 0;
}

static int cmd_install(int argc, char **argv)
{
    /* mtools reads the drive-letter config unless told to skip it
     * (the image builders set the same variable). */
    setenv("MTOOLS_SKIP_CHECK", "1", 1);
    if (argc < 3) {
        fprintf(stderr,
                "usage: sevyn install "
                "probe|plan|install|status [...]\n");
        return 1;
    }
    const char *disk = NULL, *target = NULL;
    int yes = 0;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--disk") == 0 && i + 1 < argc)
            disk = argv[++i];
        else if (strcmp(argv[i], "--target") == 0 && i + 1 < argc)
            target = argv[++i];
        else if (strcmp(argv[i], "--yes") == 0)
            yes = 1;
        else {
            fprintf(stderr, "error: unknown install argument %s\n",
                    argv[i]);
            return 1;
        }
    }
    /* Resolve the disk to its canonical device: a /dev/disk/by-id/
     * symlink (stable across NVMe enumeration swaps) must become
     * the real /dev/nvmeNn1, or the partition-path derivation and
     * the boot-disk comparison below would use the symlink text.
     * A path that does not exist is left as-is; the probe then
     * fails with "cannot read GPT" as before. */
    char disk_canon[PATH_MAX] = "";
    if (disk && realpath(disk, disk_canon) != NULL)
        disk = disk_canon;
    if (strcmp(argv[2], "probe") == 0)
        return cmd_install_probe(disk);
    if (strcmp(argv[2], "plan") == 0)
        return cmd_install_plan(disk, target);
    if (strcmp(argv[2], "install") == 0)
        return cmd_install_install(disk, target, yes);
    if (strcmp(argv[2], "status") == 0)
        return cmd_install_status();
    fprintf(stderr, "error: unknown install verb %s\n", argv[2]);
    return 1;
}

/* --- M11 installer, part 3b ends here --- */

/* --- M11 installer, part 3a ends here --- */

/* --- M11 installer, part 2 ends here --- */

/* --- M11 installer, part 1 ends here --- */

/* ------------------------------------------------------------------ */
/* dispatch + REPL                                                     */
/* `sevyn poweroff` / `sevyn reboot`: ask statusd to power the
 * system off or reboot it (statusd signals init, which does the
 * clean teardown). Prints "<action> requested" and exits 0 once the
 * request is sent — the guest goes down a second later, so callers
 * must not expect anything after it. */
static int cmd_power(const char *action, const char *verb)
{
    int fd = connect_sock("SEVYN_STATUS_SOCK", STATUS_SOCK);
    if (fd < 0) {
        fprintf(stderr, "error: cannot reach the status daemon\n");
        return 1;
    }
    if (send_line(fd, verb) != 0) {
        fprintf(stderr, "error: cannot talk to the status daemon\n");
        close(fd);
        return 1;
    }
    close(fd);
    printf("%s requested\n", action);
    return 0;
}

/* ------------------------------------------------------------------ */

static int dispatch(int argc, char **argv)
{
    if (argc < 2)
        return usage();
    if (strcmp(argv[1], "help") == 0) {
        print_usage(stdout);
        return 0;
    }
    if (strcmp(argv[1], "poweroff") == 0) {
        if (argc != 2)
            return usage();
        return cmd_power("poweroff", "POWEROFF");
    }
    if (strcmp(argv[1], "reboot") == 0) {
        if (argc != 2)
            return usage();
        return cmd_power("reboot", "REBOOT");
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
    if (strcmp(argv[1], "comms") == 0)
        return cmd_comms(argc, argv);
    if (strcmp(argv[1], "net") == 0)
        return cmd_net(argc, argv);
    if (strcmp(argv[1], "tokrah") == 0)
        return cmd_tokrah(argc, argv);
    if (strcmp(argv[1], "app") == 0)
        return cmd_app(argc, argv);
    if (strcmp(argv[1], "install") == 0)
        return cmd_install(argc, argv);
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
