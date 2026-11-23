// SevynOS v2 — audiod client for the RN host (see audiod-client.h).
#include "audiod-client.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace sevyn {

namespace {

// The daemon's replies are small (STATUS is one line; SCAN grows with
// the library). A reply past this cap is a broken daemon, not a
// library — fail closed instead of growing a buffer without bound.
constexpr size_t kMaxReplyBytes = 1024 * 1024;

std::string jsonEscape(const std::string& s) {
  std::string out;
  for (char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char buf[8];
          snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out;
}

// Milliseconds left until deadline (steady clock), or 0 when past it.
int msLeft(struct timespec deadline) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  long ms = (deadline.tv_sec - now.tv_sec) * 1000 +
            (deadline.tv_nsec - now.tv_nsec) / 1000000;
  return ms > 0 ? (int)ms : 0;
}

struct timespec deadlineFromMs(int timeoutMs) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  struct timespec d = now;
  d.tv_sec += timeoutMs / 1000;
  d.tv_nsec += (timeoutMs % 1000) * 1000000L;
  if (d.tv_nsec >= 1000000000L) {
    d.tv_sec += 1;
    d.tv_nsec -= 1000000000L;
  }
  return d;
}

} // namespace

std::string AudiodClient::defaultSocketPath() {
  const char* env = getenv("SEVYN_AUDIO_SOCK");
  if (env != nullptr && env[0] != '\0')
    return std::string(env);
  return std::string(kDefaultSocketPath);
}

std::string AudiodClient::errorJson(const std::string& code,
                                    const std::string& message) {
  return std::string("{\"ok\":false,\"code\":\"") + jsonEscape(code) +
         "\",\"error\":\"" + jsonEscape(message) + "\"}";
}

AudiodClient::AudiodClient(std::string socketPath, int timeoutMs)
    : socketPath_(std::move(socketPath)), timeoutMs_(timeoutMs) {}

std::string AudiodClient::play(const std::string& path) const {
  if (path.empty())
    return errorJson("bad-argument", "Audio playback requires a file path.");
  if (path[0] != '/')
    return errorJson("bad-argument",
                     "Audio playback requires an absolute path.");
  return roundtrip("PLAY " + path);
}

std::string AudiodClient::pause() const { return roundtrip("PAUSE"); }

std::string AudiodClient::resume() const { return roundtrip("RESUME"); }

std::string AudiodClient::stop() const { return roundtrip("STOP"); }

std::string AudiodClient::seek(double seconds) const {
  if (!std::isfinite(seconds) || seconds < 0)
    return errorJson(
        "bad-argument",
        "Seek requires a finite number of seconds (0 or more).");
  char buf[64];
  snprintf(buf, sizeof(buf), "%.3f", seconds);
  return roundtrip(std::string("SEEK ") + buf);
}

std::string AudiodClient::setVolume(double volume) const {
  if (!std::isfinite(volume))
    return errorJson("bad-argument", "Volume requires a finite number 0..100.");
  // The daemon clamps out-of-range values (amixer-style) and the
  // reply reports the volume actually applied — never an error.
  char buf[64];
  snprintf(buf, sizeof(buf), "%.3f", volume);
  return roundtrip(std::string("VOLUME ") + buf);
}

std::string AudiodClient::status() const { return roundtrip("STATUS"); }

std::string AudiodClient::scan(const std::optional<std::string>& directory) const {
  if (!directory.has_value())
    return roundtrip("SCAN");
  if (directory->empty())
    return errorJson("bad-argument", "Scan requires a directory path.");
  return roundtrip("SCAN " + *directory);
}

std::string AudiodClient::roundtrip(const std::string& line) const {
  struct timespec deadline = deadlineFromMs(timeoutMs_);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return errorJson("audio-unavailable", "Cannot reach the audio service.");

  // Non-blocking connect so a wedged daemon can never stall us past
  // the deadline (a blocking connect to a full backlog would).
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0)
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socketPath_.c_str());
  int rc = connect(fd, (sockaddr*)&addr, sizeof(addr));
  if (rc != 0 && errno != EINPROGRESS) {
    close(fd);
    return errorJson("audio-unavailable",
                     "Cannot reach the audio service.");
  }
  if (rc != 0) {
    struct pollfd pfd {};
    pfd.fd = fd;
    pfd.events = POLLOUT;
    int pr = poll(&pfd, 1, msLeft(deadline));
    if (pr <= 0) {
      close(fd);
      return errorJson(
          "audio-unavailable",
          pr == 0 ? "Timed out waiting for the audio service."
                  : "Cannot reach the audio service.");
    }
    int soError = 0;
    socklen_t len = sizeof(soError);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &len) != 0 ||
        soError != 0) {
      close(fd);
      return errorJson("audio-unavailable",
                       "Cannot reach the audio service.");
    }
  }
  // Back to blocking I/O with a receive timeout as the backstop.
  if (flags >= 0)
    fcntl(fd, F_SETFL, flags);
  struct timeval tv;
  tv.tv_sec = timeoutMs_ / 1000;
  tv.tv_usec = (timeoutMs_ % 1000) * 1000;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

  std::string out = line + "\n";
  size_t written = 0;
  while (written < out.size()) {
    ssize_t n = write(fd, out.data() + written, out.size() - written);
    if (n < 0) {
      if (errno == EINTR)
        continue;
      close(fd);
      return errorJson("audio-unavailable",
                       "Cannot reach the audio service.");
    }
    written += (size_t)n;
  }

  std::string reply;
  char buf[4096];
  for (;;) {
    if (reply.size() >= kMaxReplyBytes) {
      close(fd);
      return errorJson("audio-unavailable",
                       "Audio service sent a bad reply.");
    }
    struct pollfd pfd {};
    pfd.fd = fd;
    pfd.events = POLLIN;
    int pr = poll(&pfd, 1, msLeft(deadline));
    if (pr == 0) {
      close(fd);
      return errorJson("audio-unavailable",
                       "Timed out waiting for the audio service.");
    }
    if (pr < 0) {
      if (errno == EINTR)
        continue;
      close(fd);
      return errorJson("audio-unavailable",
                       "Cannot reach the audio service.");
    }
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n < 0) {
      if (errno == EINTR)
        continue;
      close(fd);
      return errorJson("audio-unavailable",
                       "Cannot reach the audio service.");
    }
    if (n == 0) {
      close(fd);
      return errorJson(
          "audio-unavailable",
          "Audio service closed the connection without answering.");
    }
    reply.append(buf, (size_t)n);
    size_t nl = reply.find('\n');
    if (nl != std::string::npos) {
      std::string first = reply.substr(0, nl);
      close(fd);
      // Minimal sanity check — full parsing lives in JS, where JSON
      // is native. A non-JSON line is a broken daemon, not a reply.
      size_t start = first.find_first_not_of(" \t\r");
      if (start == std::string::npos || first[start] != '{')
        return errorJson("audio-unavailable",
                         "Audio service sent a bad reply.");
      return first;
    }
  }
}

} // namespace sevyn
