// SevynOS v2 Stage 5 — compositor bridge client (see
// compositor-bridge.h).
//
// Bridge v1 wire shape (Genesis compositor/src/runtime_bridge.rs):
// one JSON object per line, {"v":1,"op":"adopt","session":
// "runtime:<pid>","chromium_pid":<pid>,"rect":{"x":..,"y":..,
// "w":..,"h":..}}; the reply is one JSON line, {"v":1,"ok":true,
// "op":"adopt"} or {"v":1,"ok":false,"op":"adopt","error":"..."}.
// Events arrive unsolicited on the same connection:
// {"v":1,"event":"chromium_died","session":"runtime:<pid>"}.
//
// The client parses JSON by substring, not by a JSON library —
// the host links no JSON parser, and the shapes here are fixed:
// "ok":true, "op":"<op>", "error":"<string>",
// "event":"<name>", "session":"<id>". A reply that does not parse
// is a compositor failure, not a retry: the op returns false with
// the line (truncated) as the error.
#include "compositor-bridge.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "common.h"

namespace sevyn {

namespace {

// True when the JSON line carries "ok":true (allowing whitespace).
bool jsonOk(const std::string& line) {
  const char* p = strstr(line.c_str(), "\"ok\"");
  if (!p)
    return false;
  p = strchr(p + 4, ':');
  if (!p)
    return false;
  p++;
  while (*p == ' ' || *p == '\t')
    p++;
  return strncmp(p, "true", 4) == 0;
}

// The string value of "key":"..." in a flat JSON line, or "" when
// absent. No escape handling: the bridge's error/session strings
// never contain quotes or backslashes (they are fixed tokens and
// "runtime:<pid>").
std::string jsonStringField(const std::string& line, const char* key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t at = line.find(pat);
  if (at == std::string::npos)
    return "";
  size_t colon = line.find(':', at + pat.size());
  if (colon == std::string::npos)
    return "";
  size_t q1 = line.find('"', colon + 1);
  if (q1 == std::string::npos)
    return "";
  size_t q2 = line.find('"', q1 + 1);
  if (q2 == std::string::npos)
    return "";
  return line.substr(q1 + 1, q2 - q1 - 1);
}

std::string rectJson(const ContentRect& r) {
  char buf[128];
  snprintf(buf, sizeof(buf), "{\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d}", r.x, r.y,
           r.w, r.h);
  return buf;
}

} // namespace

std::string ContentRect::str() const {
  char buf[64];
  snprintf(buf, sizeof(buf), "%d,%d,%dx%d", x, y, w, h);
  return buf;
}

std::string CompositorBridge::defaultSocketPath() {
  const char* override = getenv("SEVYN_COMPOSITOR_SOCK");
  if (override && *override)
    return override;
  const char* runtimeDir = getenv("XDG_RUNTIME_DIR");
  if (runtimeDir && *runtimeDir)
    return std::string(runtimeDir) + "/sevyn-compositor.sock";
  return "/run/sevyn-compositor.sock";
}

CompositorBridge::CompositorBridge(std::string socketPath)
    : socketPath_(socketPath.empty() ? defaultSocketPath()
                                     : std::move(socketPath)) {}

CompositorBridge::~CompositorBridge() { stop(); }

void CompositorBridge::stop() {
  {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    if (stopping_)
      return;
    stopping_ = true;
  }
  int fd = fd_.exchange(-1);
  if (fd >= 0) {
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
  {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    replyReady_ = true;
    pendingReply_.clear();
  }
  inboxCv_.notify_all();
  if (reader_.joinable())
    reader_.join();
}

bool CompositorBridge::ensureConnected() {
  if (fd_.load() >= 0)
    return true;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return false;
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socketPath_.c_str());
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    close(fd);
    return false;
  }
  int expected = -1;
  if (!fd_.compare_exchange_strong(expected, fd)) {
    // A racing thread connected first; drop ours.
    close(fd);
    return true;
  }
  {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    if (!readerStarted_) {
      readerStarted_ = true;
      reader_ = std::thread([this] { readLoop(); });
    }
  }
  return true;
}

void CompositorBridge::dropLocked() {
  int fd = fd_.exchange(-1);
  if (fd >= 0) {
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
  replyReady_ = true;
  pendingReply_.clear();
  inboxCv_.notify_all();
}

bool CompositorBridge::sendOp(const std::string& op, const std::string& json,
                              std::string& error) {
  // Arm the waiter BEFORE writing: on loopback the reply can
  // arrive before this thread would otherwise set waitingOp_,
  // and the reader would discard it as a reply nobody waits for.
  {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    waitingOp_ = op;
    replyReady_ = false;
    pendingReply_.clear();
  }
  if (!ensureConnected()) {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    waitingOp_.clear();
    error = "compositor unavailable";
    return false;
  }
  int fd = fd_.load();
  if (fd < 0) {
    std::lock_guard<std::mutex> lk(inboxMutex_);
    waitingOp_.clear();
    error = "compositor unavailable";
    return false;
  }
  std::string line = json + "\n";
  ssize_t sent = 0;
  while (sent < (ssize_t)line.size()) {
    ssize_t n = write(fd, line.data() + sent, line.size() - sent);
    if (n <= 0) {
      if (n < 0 && errno == EINTR)
        continue;
      std::lock_guard<std::mutex> lk(inboxMutex_);
      waitingOp_.clear();
      dropLocked();
      error = "compositor unavailable";
      return false;
    }
    sent += n;
  }
  std::unique_lock<std::mutex> lk(inboxMutex_);
  bool got = inboxCv_.wait_for(
      lk, std::chrono::milliseconds(kReplyTimeoutMs),
      [this] { return replyReady_ || stopping_; });
  waitingOp_.clear();
  if (!got || stopping_ || pendingReply_.empty()) {
    // Timed out (or stopped): the connection is suspect — drop it
    // so the next op reconnects instead of reading a stale reply
    // as its own.
    dropLocked();
    error = stopping_ ? "compositor unavailable" : "compositor timeout";
    return false;
  }
  std::string reply = pendingReply_;
  pendingReply_.clear();
  lk.unlock();
  if (jsonOk(reply))
    return true;
  std::string err = jsonStringField(reply, "error");
  error = err.empty() ? "compositor error: " + reply.substr(0, 128) : err;
  return false;
}

void CompositorBridge::readLoop() {
  std::string buf;
  char chunk[4096];
  while (!stopping_) {
    int fd = fd_.load();
    if (fd < 0) {
      // No connection yet (or dropped): wait to be woken by a
      // connect, then re-read the fd.
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }
    pollfd pfd{fd, POLLIN, 0};
    int pr = poll(&pfd, 1, 100);
    if (pr < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (pr == 0)
      continue;
    if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
      // The compositor went away (or closed our connection): the
      // adoption it recorded is gone with it. Read the flag
      // BEFORE dropLocked() clears the fd, or it is always false.
      bool wasConnected = fd_.load() >= 0;
      {
        std::lock_guard<std::mutex> lk(inboxMutex_);
        dropLocked();
      }
      buf.clear();
      if (wasConnected && disconnectHandler_)
        disconnectHandler_();
      continue;
    }
    ssize_t n = read(fd, chunk, sizeof(chunk));
    if (n < 0) {
      if (errno == EINTR || errno == EAGAIN)
        continue;
      break;
    }
    if (n == 0) {
      // EOF: the compositor closed the connection. Same read of
      // the flag before the drop as the POLLERR branch above.
      bool wasConnected = fd_.load() >= 0;
      {
        std::lock_guard<std::mutex> lk(inboxMutex_);
        dropLocked();
      }
      buf.clear();
      if (wasConnected && disconnectHandler_)
        disconnectHandler_();
      continue;
    }
    buf.append(chunk, n);
    size_t nl;
    while ((nl = buf.find('\n')) != std::string::npos) {
      std::string line = buf.substr(0, nl);
      buf.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r')
        line.pop_back();
      if (line.empty())
        continue;
      std::string event = jsonStringField(line, "event");
      if (!event.empty()) {
        if (eventHandler_)
          eventHandler_(line);
        continue;
      }
      std::string op = jsonStringField(line, "op");
      std::lock_guard<std::mutex> lk(inboxMutex_);
      if (!op.empty() && op == waitingOp_) {
        pendingReply_ = line;
        replyReady_ = true;
        inboxCv_.notify_all();
      }
      // A reply for an op nobody is waiting for (a late reply
      // after a timeout dropped the connection) is discarded:
      // the timed-out op already failed, and the line must never
      // be mistaken for the next op's reply.
    }
  }
}

bool CompositorBridge::ping(std::string& error) {
  return sendOp("ping", "{\"v\":1,\"op\":\"ping\"}", error);
}

bool CompositorBridge::adopt(const std::string& session, int chromiumPid,
                             const ContentRect& rect, std::string& error) {
  char buf[512];
  snprintf(buf, sizeof(buf),
           "{\"v\":1,\"op\":\"adopt\",\"session\":\"%s\",\"chromium_pid\":%d,"
           "\"rect\":%s}",
           session.c_str(), chromiumPid, rectJson(rect).c_str());
  return sendOp("adopt", buf, error);
}

bool CompositorBridge::moveAdoption(const std::string& session,
                                    const ContentRect& rect,
                                    std::string& error) {
  char buf[512];
  snprintf(buf, sizeof(buf),
           "{\"v\":1,\"op\":\"move\",\"session\":\"%s\",\"rect\":%s}",
           session.c_str(), rectJson(rect).c_str());
  return sendOp("move", buf, error);
}

bool CompositorBridge::resizeAdoption(const std::string& session,
                                      const ContentRect& rect,
                                      std::string& error) {
  char buf[512];
  snprintf(buf, sizeof(buf),
           "{\"v\":1,\"op\":\"resize\",\"session\":\"%s\",\"rect\":%s}",
           session.c_str(), rectJson(rect).c_str());
  return sendOp("resize", buf, error);
}

bool CompositorBridge::releaseAdoption(const std::string& session,
                                       std::string& error) {
  char buf[256];
  snprintf(buf, sizeof(buf), "{\"v\":1,\"op\":\"release\",\"session\":\"%s\"}",
           session.c_str());
  return sendOp("release", buf, error);
}

} // namespace sevyn
