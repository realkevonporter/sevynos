/* SevynOS v2 M1 — status daemon (sevyn-statusd).
 *
 * The live system-status service. It owns three values — battery, wifi,
 * volume — and pushes every change to all subscribers over a Unix socket.
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
 * Build: gcc, libc only. Run as root from the guest init script.
 */
#define _GNU_SOURCE
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
#include <sys/inotify.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

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

static struct value values[] = {
    { "battery", "unknown" },
    { "wifi", "unknown" },
    { "volume", "50" },
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

static void handle_command(const char *line)
{
    char cmd[32], key[64], val[64];
    if (sscanf(line, "%31s %63s %63s", cmd, key, val) < 1)
        return;
    if (strcmp(cmd, "SET") == 0) {
        if (sscanf(line, "%*s %63s %63s", key, val) == 2) {
            log_line("STATUSD SET %s %s", key, val);
            set_value(key, val);
        }
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
    } else if (strncmp(line, "GET", 3) == 0) {
        send_all_values(c->fd);
    } else {
        handle_command(line);
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
    unlink(SOCK_PATH);
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", SOCK_PATH);
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
    log_line("STATUSD READY socket=%s battery=%s wifi=%s volume=%s",
             SOCK_PATH, values[0].current, values[1].current, values[2].current);

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
                        handle_command(ctl_buf);
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
