// SevynOS v2 Stage 5 — Runtime control socket (see
// runtime-control.h).
#include "runtime-control.h"

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <vector>

#include "common.h"

namespace sevyn {

namespace {

// Split a line on spaces. Empty tokens are dropped, so extra
// spaces are harmless.
std::vector<std::string> split(const std::string& line) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < line.size()) {
    while (i < line.size() && line[i] == ' ')
      i++;
    if (i >= line.size())
      break;
    size_t j = line.find(' ', i);
    if (j == std::string::npos)
      j = line.size();
    out.push_back(line.substr(i, j - i));
    i = j;
  }
  return out;
}

// Strict integer parse: the whole token must be a decimal number.
bool parseInt(const std::string& s, int& out) {
  if (s.empty())
    return false;
  size_t i = 0;
  if (s[0] == '-' || s[0] == '+')
    i = 1;
  if (i >= s.size())
    return false;
  for (size_t j = i; j < s.size(); j++) {
    if (s[j] < '0' || s[j] > '9')
      return false;
  }
  out = atoi(s.c_str());
  return true;
}

} // namespace

std::string RuntimeControlServer::defaultSocketPath(
    const std::string& appId) {
  const char* override = getenv("SEVYN_RUNTIME_SOCK");
  if (override && *override)
    return override;
  std::string dir = "/run";
  const char* dirOverride = getenv("SEVYN_RUNTIME_SOCK_DIR");
  if (dirOverride && *dirOverride)
    dir = dirOverride;
  std::string id = appId.empty() ? "shell" : appId;
  return dir + "/sevyn-runtime-" + id + ".sock";
}

RuntimeControlServer::RuntimeControlServer(std::string appId,
                                           std::string socketPath,
                                           std::string sessionId,
                                           std::string compositorSockPath)
    : appId_(std::move(appId)),
      socketPath_(socketPath.empty() ? defaultSocketPath(appId_)
                                     : std::move(socketPath)),
      sessionId_(std::move(sessionId)),
      bridge_(std::make_unique<CompositorBridge>(
          std::move(compositorSockPath))) {
  bridge_->setEventHandler(
      [this](const std::string& line) { onBridgeEvent(line); });
  bridge_->setDisconnectHandler([this] { onBridgeDisconnected(); });
}

RuntimeControlServer::~RuntimeControlServer() { stop(); }

bool RuntimeControlServer::start() {
  if (listening_)
    return true;
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    logLine("BROWSER runtime control socket failed: %s", strerror(errno));
    return false;
  }
  unlink(socketPath_.c_str());
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", socketPath_.c_str());
  if (bind(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    logLine("BROWSER runtime control bind %s failed: %s", socketPath_.c_str(),
            strerror(errno));
    close(fd);
    return false;
  }
  // Mode 0600, like the compositor's bridge socket: only the
  // platform user may drive the Browser's embedding.
  chmod(socketPath_.c_str(), 0600);
  if (listen(fd, 4) != 0) {
    logLine("BROWSER runtime control listen %s failed: %s",
            socketPath_.c_str(), strerror(errno));
    close(fd);
    unlink(socketPath_.c_str());
    return false;
  }
  listenFd_.store(fd);
  stopping_ = false;
  listening_ = true;
  acceptThread_ = std::thread([this] { acceptLoop(); });
  logLine("BROWSER runtime control listening on %s", socketPath_.c_str());
  return true;
}

void RuntimeControlServer::stop() {
  if (stopping_.exchange(true))
    return;
  {
    std::lock_guard<std::mutex> lk(stateMutex_);
    releaseLocked();
  }
  int fd = listenFd_.exchange(-1);
  if (fd >= 0) {
    shutdown(fd, SHUT_RDWR);
    close(fd);
  }
  if (acceptThread_.joinable())
    acceptThread_.join();
  unlink(socketPath_.c_str());
  listening_ = false;
  if (bridge_)
    bridge_->stop();
}

std::string RuntimeControlServer::embeddedStatus() {
  std::lock_guard<std::mutex> lk(stateMutex_);
  if (!embedded_)
    return "embedded: no";
  return "embedded: yes " + rect_.str();
}

void RuntimeControlServer::releaseLocked() {
  if (!embedded_)
    return;
  embedded_ = false;
  if (!bridge_->connected()) {
    // Never connected: nothing was ever adopted, so there is
    // nothing to release — and no point waking a compositor
    // that was never there (every host exit would log a
    // spurious release failure).
    return;
  }
  std::string error;
  if (!bridge_->releaseAdoption(sessionId_, error)) {
    // Best effort: the compositor drops the record when the
    // Browser surface goes away, so a failed release is logged,
    // not fatal.
    logLine("BROWSER release failed: %s", error.c_str());
  }
}

bool RuntimeControlServer::adoptAndConfigureLocked(int chromiumPid,
                                                   const ContentRect& rect,
                                                   std::string& error) {
  if (!bridge_->adopt(sessionId_, chromiumPid, rect, error))
    return false;
  // Genesis sends no size in its initial toplevel configure, so
  // adopt alone leaves Chromium at its launch size, cropped to
  // the rect. resize is the only op that configures the surface
  // to the content size — send it with the same rect. If the
  // configure fails, the adoption is half-live (wrong surface
  // size), so release it and report the failure instead of
  // claiming an embedded rect Chromium never sized to.
  if (!bridge_->resizeAdoption(sessionId_, rect, error)) {
    std::string releaseError;
    bridge_->releaseAdoption(sessionId_, releaseError);
    return false;
  }
  return true;
}

void RuntimeControlServer::embedLocked(int chromiumPid,
                                       const ContentRect& rect,
                                       std::string& reply) {
  if (embedded_) {
    if (chromiumPid_ == chromiumPid) {
      std::string error;
      bool ok = rect.sameSizeAs(rect_)
                     ? bridge_->moveAdoption(sessionId_, rect, error)
                     : bridge_->resizeAdoption(sessionId_, rect, error);
      if (!ok) {
        // The compositor lost the adoption (or the Browser window
        // was recreated under it): clear and re-adopt below
        // instead of reporting a stale embedded state.
        logLine("BROWSER embed %s failed, re-adopting: %s",
                rect.sameSizeAs(rect_) ? "move" : "resize", error.c_str());
        embedded_ = false;
      } else {
        rect_ = rect;
        reply = "embedded: yes " + rect_.str();
        return;
      }
    } else {
      // Chromium relaunched under a new pid: the old adoption
      // references a dead pid. Release it, then adopt fresh.
      releaseLocked();
    }
  }
  std::string error;
  if (!adoptAndConfigureLocked(chromiumPid, rect, error)) {
    if (error == "already adopted") {
      // The compositor still holds an adoption for this session
      // (e.g. the host restarted and the old record survived):
      // adopt refuses, but move/resize address the live record.
      // Move first (it never reconfigures), then resize to set
      // the surface size — the same two steps a fresh adopt
      // takes, in the order the compositor accepts them.
      std::string moveError;
      if (bridge_->moveAdoption(sessionId_, rect, moveError) &&
          bridge_->resizeAdoption(sessionId_, rect, error)) {
        embedded_ = true;
        rect_ = rect;
        chromiumPid_ = chromiumPid;
        logLine("BROWSER embedded yes %s (recovered already-adopted)",
                rect_.str().c_str());
        reply = "embedded: yes " + rect_.str();
        return;
      }
      error = moveError.empty() ? error : moveError;
    }
    logLine("BROWSER embed failed: %s", error.c_str());
    reply = "error: " + error;
    return;
  }
  embedded_ = true;
  rect_ = rect;
  chromiumPid_ = chromiumPid;
  logLine("BROWSER embedded yes %s", rect_.str().c_str());
  reply = "embedded: yes " + rect_.str();
}

std::string RuntimeControlServer::handleLine(const std::string& line) {
  std::vector<std::string> parts = split(line);
  if (parts.empty())
    return "error: empty command";
  if (parts[0] == "browser-embedded-status") {
    if (parts.size() != 1)
      return "error: usage: browser-embedded-status";
    return embeddedStatus();
  }
  if (parts[0] == "browser-release") {
    if (parts.size() != 1)
      return "error: usage: browser-release";
    std::lock_guard<std::mutex> lk(stateMutex_);
    bool was = embedded_;
    releaseLocked();
    return was ? "ok released" : "ok not-embedded";
  }
  if (parts[0] == "browser-embed") {
    if (parts.size() != 6)
      return "error: usage: browser-embed <chromium-pid> <x> <y> <w> <h>";
    int pid, x, y, w, h;
    if (!parseInt(parts[1], pid) || !parseInt(parts[2], x) ||
        !parseInt(parts[3], y) || !parseInt(parts[4], w) ||
        !parseInt(parts[5], h))
      return "error: browser-embed arguments must be integers";
    if (pid <= 0 || x < 0 || y < 0 || w <= 0 || h <= 0)
      return "error: browser-embed needs a live pid and a positive rect";
    ContentRect rect{x, y, w, h};
    std::lock_guard<std::mutex> lk(stateMutex_);
    std::string reply;
    embedLocked(pid, rect, reply);
    return reply;
  }
  return "error: unknown command";
}

void RuntimeControlServer::acceptLoop() {
  while (!stopping_) {
    int fd = listenFd_.load();
    if (fd < 0)
      return;
    int conn = accept(fd, nullptr, nullptr);
    if (conn < 0) {
      if (stopping_)
        return;
      if (errno == EINTR)
        continue;
      // A transient accept failure must not spin the thread:
      // back off briefly, then try again.
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }
    // One connection at a time, lines until EOF: ops are
    // serialised, which the bridge's single-slot waiter needs.
    // A 5 s read timeout bounds a client that connects and
    // never writes (the CLI never does this; a stuck client
    // must not wedge the accept thread).
    timeval tv{};
    tv.tv_sec = 5;
    setsockopt(conn, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    std::string buf;
    char chunk[1024];
    while (!stopping_) {
      ssize_t n = read(conn, chunk, sizeof(chunk));
      if (n <= 0)
        break;
      buf.append(chunk, n);
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl);
        buf.erase(0, nl + 1);
        if (!line.empty() && line.back() == '\r')
          line.pop_back();
        std::string reply = handleLine(line);
        reply += "\n";
        ssize_t sent = 0;
        while (sent < (ssize_t)reply.size()) {
          ssize_t w = write(conn, reply.data() + sent, reply.size() - sent);
          if (w < 0) {
            if (errno == EINTR)
              continue;
            break;
          }
          sent += w;
        }
        if (sent < (ssize_t)reply.size())
          break;
      }
    }
    close(conn);
  }
}

void RuntimeControlServer::onBridgeEvent(const std::string& line) {
  // The only event the bridge sends today is chromium_died, with
  // the session it belongs to. One host = one session, but check
  // the session anyway: a foreign session's death is not ours.
  size_t at = line.find("\"event\"");
  if (at == std::string::npos)
    return;
  if (line.find("chromium_died", at) == std::string::npos)
    return;
  size_t sess = line.find(sessionId_);
  if (sess == std::string::npos)
    return;
  std::lock_guard<std::mutex> lk(stateMutex_);
  if (!embedded_)
    return;
  embedded_ = false;
  logLine("BROWSER embedded died (chromium_died, session %s)",
          sessionId_.c_str());
}

void RuntimeControlServer::onBridgeDisconnected() {
  // The compositor is gone: any adoption it recorded is gone
  // with it. Clear, so `browser status` reports `embedded: no`
  // and the next embed re-adopts (with the already-adopted
  // recovery if the compositor kept the record).
  std::lock_guard<std::mutex> lk(stateMutex_);
  if (!embedded_)
    return;
  embedded_ = false;
  logLine("BROWSER embedded cleared (compositor disconnected)");
}

} // namespace sevyn
