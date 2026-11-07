/* SevynOS v2 M1 — status subscriber (sevyn-status-client).
 *
 * Connects to sevyn-statusd, subscribes, and logs every STATUS line it
 * receives. This is the proof that status changes travel as pushed events:
 * the M1 harness injects a change on the host control serial and asserts
 * this client logs the new value promptly.
 *
 * Logs go to /dev/console (the host harness reads the serial stream) and
 * to /tmp/sevyn-m1-status.log. Lines are prefixed with monotonic ms.
 *
 * Build: gcc, libc only.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define SOCK_PATH "/run/sevyn-status.sock"

static int console_fd = -1;
static int log_fd = -1;
static long long start_ms;

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void log_line(const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    int n = snprintf(buf, sizeof(buf), "[%lld] ", now_ms() - start_ms);
    n += vsnprintf(buf + n, sizeof(buf) - (size_t)n, fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    if ((size_t)n >= sizeof(buf))
        n = (int)sizeof(buf) - 1;
    if (buf[n - 1] != '\n')
        buf[n++] = '\n';
    if (console_fd >= 0)
        (void)!write(console_fd, buf, (size_t)n);
    if (log_fd >= 0)
        (void)!write(log_fd, buf, (size_t)n);
}

static int connect_statusd(void)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0)
        return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", SOCK_PATH);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int main(void)
{
    start_ms = now_ms();
    console_fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
    log_fd = open("/tmp/sevyn-m1-status.log", O_WRONLY | O_CREAT | O_TRUNC, 0644);

    for (;;) {
        int fd = connect_statusd();
        if (fd >= 0) {
            log_line("STATUSCLIENT connected, subscribing");
            (void)!write(fd, "SUBSCRIBE\n", 10);
            char buf[256];
            ssize_t n;
            while ((n = read(fd, buf, sizeof(buf))) > 0) {
                /* Lines may arrive coalesced; split on \n. */
                char *p = buf;
                char *end = buf + n;
                while (p < end) {
                    char *nl = memchr(p, '\n', (size_t)(end - p));
                    if (!nl)
                        break;
                    *nl = '\0';
                    log_line("STATUS %s", p);
                    p = nl + 1;
                }
            }
            log_line("STATUSCLIENT disconnected (%s), reconnecting",
                     n == 0 ? "eof" : strerror(errno));
            close(fd);
        }
        sleep(1);
    }
}
