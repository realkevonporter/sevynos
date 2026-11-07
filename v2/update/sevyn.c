/* SevynOS v2 M8 — the `sevyn` CLI (seed).
 *
 * The Terminal app's command surface (the locked rule: the Terminal
 * exposes only the `sevyn` CLI, never bash). M8 seeds it with the
 * update verbs only; M4 grows it (Settings, Files, app management).
 *
 * Usage:
 *   sevyn update check            check the feed for a newer version
 *   sevyn update apply            download + install into the idle
 *                                 slot and reboot (prints progress
 *                                 until the update is applied or fails)
 *   sevyn update status           show version, channel, slots
 *   sevyn update channel <c>      set the update channel
 *                                 (nightly|stable)
 *
 * Talks to sevyn-updated over /run/sevyn-update.sock
 * (SEVYN_UPDATE_SOCK). Exit 0 on success, 1 on error.
 *
 * Build: gcc, libc only.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define DEFAULT_SOCK "/run/sevyn-update.sock"

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

static int usage(void)
{
    fprintf(stderr,
            "usage: sevyn update <check|apply|status|channel>\n"
            "  sevyn update check            check for a newer version\n"
            "  sevyn update apply            install into the idle slot "
            "and reboot\n"
            "  sevyn update status           show version, channel, "
            "slots\n"
            "  sevyn update channel <c>      set channel (nightly|stable)\n");
    return 1;
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

int main(int argc, char **argv)
{
    if (argc < 3 || strcmp(argv[1], "update") != 0)
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
