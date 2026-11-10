// SevynOS v2 M2 — shared helpers for the RN host.
#include "common.h"

#include <cstdarg>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <time.h>
#include <unistd.h>

namespace sevyn {

long long nowMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

namespace {
int consoleFd() {
  static int fd = -2;
  if (fd == -2)
    fd = open("/dev/console", O_WRONLY | O_NONBLOCK);
  return fd;
}

// logLine is called from several threads (JS present, headless beat,
// input, EXEC). Without a lock, two concurrent writes to the same
// serial console interleave mid-line and corrupt the ops JSON the
// check harness parses (~9% of ops lines in m9-check run5, which
// cost Phase C its End-button read). Serialize the whole call so
// each line lands intact.
std::mutex logMutex;

// Best-effort complete write: the serial console drains slowly, so
// a 6 KB ops line does not fit in one non-blocking write — a bare
// write() returns a short count and the tail is lost, which is why
// ~15% of ops lines in m9-check run6 were truncated mid-JSON and
// the host-screen End read failed. Poll for writability and retry
// until the line lands or a bounded wait expires — never stall the
// host indefinitely on a backlogged serial (2 s per line, max).
void writeAll(int fd, const char* buf, size_t n) {
  const long long deadline = nowMs() + 2000;
  while (n > 0) {
    ssize_t w = write(fd, buf, n);
    if (w > 0) {
      buf += w;
      n -= (size_t)w;
      continue;
    }
    if (w < 0 && errno == EINTR)
      continue;
    if (w < 0 && errno != EAGAIN)
      return; // Real error: drop the rest.
    // EAGAIN (or w == 0): the console buffer is full — wait for
    // room, bounded by the deadline.
    long long left = deadline - nowMs();
    if (left <= 0)
      return;
    struct pollfd pfd = {fd, POLLOUT, 0};
    if (poll(&pfd, 1, (int)left) <= 0)
      return; // Timeout or error: drop the rest.
  }
}
} // namespace

void logLine(const char* fmt, ...) {
  std::lock_guard<std::mutex> lock(logMutex);
  // 32 KB: headless mode logs a compact ops JSON per screen (M6),
  // which does not fit the old 1 KB buffer (texts + pressables +
  // coloured rects on a busy feed).
  char buf[32768];
  int n = snprintf(buf, sizeof(buf), "[%lld] ", nowMs());
  va_list ap;
  va_start(ap, fmt);
  n += vsnprintf(buf + n, sizeof(buf) - (size_t)n, fmt, ap);
  va_end(ap);
  if (n < 0)
    return;
  if ((size_t)n >= sizeof(buf))
    n = (int)sizeof(buf) - 1;
  if (n == 0 || buf[n - 1] != '\n')
    buf[n++] = '\n';
  int cfd = consoleFd();
  if (cfd >= 0)
    writeAll(cfd, buf, (size_t)n);
  writeAll(STDERR_FILENO, buf, (size_t)n);
}

bool parseColor(const std::string& s, uint32_t& out) {
  if (s.empty())
    return false;
  if (s[0] == '#') {
    if (s.size() != 7 && s.size() != 9)
      return false;
    auto hex = [](char c) -> int {
      if (c >= '0' && c <= '9')
        return c - '0';
      if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
      if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
      return -1;
    };
    uint32_t v = 0;
    for (size_t i = 1; i < s.size(); i++) {
      int d = hex(s[i]);
      if (d < 0)
        return false;
      v = (v << 4) | (uint32_t)d;
    }
    if (s.size() == 7)
      out = (v << 8) | 0xff; // #RRGGBB -> opaque
    else
      out = v; // #RRGGBBAA
    return true;
  }
  // rgb(r, g, b) / rgba(r, g, b, a)
  int r = -1, g = -1, b = -1;
  float a = 1.0f;
  if (sscanf(s.c_str(), "rgba(%d,%d,%d,%f)", &r, &g, &b, &a) == 4 ||
      sscanf(s.c_str(), "rgb(%d,%d,%d)", &r, &g, &b) == 3) {
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
      return false;
    if (a < 0)
      a = 0;
    if (a > 1)
      a = 1;
    out = ((uint32_t)r << 24) | ((uint32_t)g << 16) | ((uint32_t)b << 8) |
        (uint32_t)(a * 255.0f + 0.5f);
    return true;
  }
  // A few named colours the shell uses.
  if (s == "white") {
    out = 0xffffffff;
    return true;
  }
  if (s == "black") {
    out = 0x000000ff;
    return true;
  }
  if (s == "transparent") {
    out = 0x00000000;
    return true;
  }
  return false;
}

} // namespace sevyn
