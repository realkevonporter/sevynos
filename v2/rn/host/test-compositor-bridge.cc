// SevynOS v2 Stage 5 — host bridge + control-socket test.
//
// Drives the real CompositorBridge and RuntimeControlServer
// against a fake compositor (a thread speaking bridge v1 on a
// temp Unix socket: adopt/move/resize/release/ping + the
// chromium_died event), proving, with no Genesis, no Wayland and
// no Hermes:
//   1. embed round-trips: adopt + the configure resize, and the
//      control socket reports "embedded: yes <rect>".
//   2. idempotent re-embed: same size -> move, new size -> resize.
//   3. chromium_died clears the adopted state (status -> no) and
//      a later embed re-adopts.
//   4. "already adopted" recovery (a record that survived a host
//      restart): adopt refuses, move + resize recover it.
//   5. a dead compositor fails fast ("compositor unavailable") and
//      a dropped bridge connection clears the state.
//   6. bad embed arguments and unknown verbs are errors, never a
//      hang or a crash.
//
// Build: g++ -O2 -std=c++17 -Wall -Wextra -I. -o /tmp/test-stage5
//        compositor-bridge.cc runtime-control.cc common.cc
//        test-compositor-bridge.cc -lpthread
// (common.cc is only needed for logLine; the test never opens a
// Wayland display.)
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <poll.h>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#include <vector>

#include "compositor-bridge.h"
#include "runtime-control.h"

using namespace sevyn;

namespace {

int failures = 0;

void check(bool ok, const std::string& name, const std::string& detail = "") {
  if (ok) {
    printf("ok - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
  } else {
    printf("FAIL - %s%s\n", name.c_str(),
           detail.empty() ? "" : (" (" + detail + ")").c_str());
    failures++;
  }
}

std::string tmpDir() {
  char tmpl[] = "/tmp/stage5-test-XXXXXX";
  char* d = mkdtemp(tmpl);
  assert(d);
  return d;
}

// One JSON string field, same minimal parse as the bridge client.
std::string field(const std::string& line, const char* key) {
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

int fieldInt(const std::string& line, const char* key) {
  std::string pat = std::string("\"") + key + "\"";
  size_t at = line.find(pat);
  if (at == std::string::npos)
    return 0;
  size_t colon = line.find(':', at + pat.size());
  if (colon == std::string::npos)
    return 0;
  return atoi(line.c_str() + colon + 1);
}

// --- fake compositor (bridge v1, minimal but faithful) ---------------
class FakeCompositor {
 public:
  explicit FakeCompositor(std::string path) : path_(std::move(path)) {}
  ~FakeCompositor() { stop(); }

  void start() {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    assert(fd >= 0);
    unlink(path_.c_str());
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", path_.c_str());
    assert(bind(fd, (sockaddr*)&addr, sizeof(addr)) == 0);
    assert(listen(fd, 4) == 0);
    listenFd_ = fd;
    thread_ = std::thread([this] { acceptLoop(); });
  }

  void stop() {
    if (stopping_.exchange(true))
      return;
    closeConn();
    int fd = listenFd_.exchange(-1);
    if (fd >= 0) {
      shutdown(fd, SHUT_RDWR);
      close(fd);
    }
    if (thread_.joinable())
      thread_.join();
    unlink(path_.c_str());
  }

  // Drop the live bridge connection (compositor death) without
  // stopping the listener: the next op reconnects.
  void dropConnection() { closeConn(); }

  // Push an unsolicited event line to the connected bridge client.
  void sendEvent(const std::string& line) {
    std::lock_guard<std::mutex> lk(connMutex_);
    if (connFd_ < 0)
      return;
    std::string l = line + "\n";
    (void)!write(connFd_, l.data(), l.size());
  }

  // Pretend the compositor already holds an adoption for the
  // session (a record that survived a host restart).
  void forceAdopted(const std::string& session, int pid, ContentRect rect) {
    std::lock_guard<std::mutex> lk(mutex_);
    adopted_ = true;
    session_ = session;
    pid_ = pid;
    rect_ = rect;
  }

  std::vector<std::string> ops() {
    std::lock_guard<std::mutex> lk(mutex_);
    return ops_;
  }
  void clearOps() {
    std::lock_guard<std::mutex> lk(mutex_);
    ops_.clear();
  }
  bool adopted() {
    std::lock_guard<std::mutex> lk(mutex_);
    return adopted_;
  }

 private:
  void closeConn() {
    std::lock_guard<std::mutex> lk(connMutex_);
    if (connFd_ >= 0) {
      shutdown(connFd_, SHUT_RDWR);
      close(connFd_);
      connFd_ = -1;
    }
  }

  std::string handle(const std::string& line) {
    std::string op = field(line, "op");
    if (op.empty())
      return "{\"v\":1,\"ok\":false,\"op\":\"(unparsed)\",\"error\":\"malformed "
             "request\"}";
    std::string ok = "{\"v\":1,\"ok\":true,\"op\":\"" + op + "\"}";
    std::string err = "{\"v\":1,\"ok\":false,\"op\":\"" + op +
                      "\",\"error\":\"%s\"}";
    char buf[256];
    std::lock_guard<std::mutex> lk(mutex_);
    ops_.push_back(op);
    if (op == "ping")
      return ok;
    if (op == "adopt") {
      if (adopted_) {
        snprintf(buf, sizeof(buf), err.c_str(), "already adopted");
        return buf;
      }
      int pid = fieldInt(line, "chromium_pid");
      if (pid == 9999) {
        snprintf(buf, sizeof(buf), err.c_str(), "dead chromium pid");
        return buf;
      }
      adopted_ = true;
      session_ = field(line, "session");
      pid_ = pid;
      return ok;
    }
    if (op == "move" || op == "resize") {
      if (!adopted_) {
        snprintf(buf, sizeof(buf), err.c_str(), "unknown session");
        return buf;
      }
      return ok;
    }
    if (op == "release") {
      if (!adopted_) {
        snprintf(buf, sizeof(buf), err.c_str(), "unknown session");
        return buf;
      }
      adopted_ = false;
      return ok;
    }
    snprintf(buf, sizeof(buf), err.c_str(), "unknown op");
    return buf;
  }

  void serveConn(int conn) {
    std::string buf;
    char chunk[4096];
    while (!stopping_) {
      pollfd pfd{conn, POLLIN, 0};
      int pr = poll(&pfd, 1, 100);
      if (pr <= 0)
        continue;
      ssize_t n = read(conn, chunk, sizeof(chunk));
      if (n <= 0)
        break;
      buf.append(chunk, n);
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl);
        buf.erase(0, nl + 1);
        std::string reply = handle(line) + "\n";
        ssize_t sent = 0;
        while (sent < (ssize_t)reply.size()) {
          ssize_t w = write(conn, reply.data() + sent, reply.size() - sent);
          if (w <= 0)
            break;
          sent += w;
        }
      }
    }
  }

  void acceptLoop() {
    while (!stopping_) {
      int fd = listenFd_.load();
      if (fd < 0)
        return;
      int conn = accept(fd, nullptr, nullptr);
      if (conn < 0) {
        if (stopping_)
          return;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        continue;
      }
      {
        std::lock_guard<std::mutex> lk(connMutex_);
        connFd_ = conn;
      }
      serveConn(conn);
      {
        std::lock_guard<std::mutex> lk(connMutex_);
        connFd_ = -1;
      }
      close(conn);
    }
  }

  std::string path_;
  std::atomic<int> listenFd_{-1};
  std::thread thread_;
  std::atomic<bool> stopping_{false};
  std::mutex connMutex_;
  int connFd_ = -1;
  std::mutex mutex_;
  std::vector<std::string> ops_;
  bool adopted_ = false;
  std::string session_;
  int pid_ = 0;
  ContentRect rect_;
};

// --- one-shot control-socket client -----------------------------------
std::string controlRoundTrip(const std::string& sockPath,
                             const std::string& line) {
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return "";
  timeval tv{};
  tv.tv_sec = 5;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", sockPath.c_str());
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
    close(fd);
    return "";
  }
  std::string req = line + "\n";
  (void)!write(fd, req.data(), req.size());
  std::string out;
  char buf[1024];
  while (true) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n <= 0)
      break;
    out.append(buf, n);
    if (out.find('\n') != std::string::npos)
      break;
  }
  close(fd);
  size_t nl = out.find('\n');
  if (nl != std::string::npos)
    out.erase(nl);
  return out;
}

bool waitStatus(const std::string& sockPath, const std::string& want,
                int timeoutMs = 5000) {
  auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  while (std::chrono::steady_clock::now() < deadline) {
    if (controlRoundTrip(sockPath, "browser-embedded-status") == want)
      return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return false;
}

struct Fixture {
  std::string dir;
  std::string compSock;
  std::string ctlSock;
  FakeCompositor fake;
  explicit Fixture()
      : dir(tmpDir()),
        compSock(dir + "/compositor.sock"),
        ctlSock(dir + "/runtime.sock"),
        fake(compSock) {
    fake.start();
  }
  ~Fixture() { fake.stop(); }
};

std::unique_ptr<RuntimeControlServer> makeServer(Fixture& f,
                                                 const std::string& session) {
  auto srv = std::make_unique<RuntimeControlServer>("browser", f.ctlSock,
                                                    session, f.compSock);
  if (!srv->start()) {
    printf("FAIL - control server would not start\n");
    failures++;
  }
  return srv;
}

} // namespace

int main() {
  const std::string session = "runtime:424242";

  // 1-2. Embed round-trip + idempotent re-embed.
  {
    Fixture f;
    auto srv = makeServer(f, session);
    std::string r = controlRoundTrip(
        f.ctlSock, "browser-embed 4242 0 152 800 348");
    check(r == "embedded: yes 0,152,800x348", "embed adopts", r);
    std::vector<std::string> ops = f.fake.ops();
    check(ops.size() == 2 && ops[0] == "adopt" && ops[1] == "resize",
          "first embed is adopt + configure resize",
          ops.size() == 2 ? ops[0] + "," + ops[1] : "wrong op count");
    check(f.fake.adopted(), "fake compositor holds the adoption");
    check(controlRoundTrip(f.ctlSock, "browser-embedded-status") ==
              "embedded: yes 0,152,800x348",
          "status reports the adopted rect");

    f.fake.clearOps();
    r = controlRoundTrip(f.ctlSock, "browser-embed 4242 10 152 800 348");
    check(r == "embedded: yes 10,152,800x348", "same-size re-embed moves",
          r);
    ops = f.fake.ops();
    check(ops.size() == 1 && ops[0] == "move", "same size sends only move",
          ops.empty() ? "no ops" : ops[0]);

    f.fake.clearOps();
    r = controlRoundTrip(f.ctlSock, "browser-embed 4242 0 152 800 300");
    check(r == "embedded: yes 0,152,800x300", "new-size re-embed resizes",
          r);
    ops = f.fake.ops();
    check(ops.size() == 1 && ops[0] == "resize",
          "new size sends only resize", ops.empty() ? "no ops" : ops[0]);

    // 3. chromium_died clears the state; a later embed re-adopts.
    f.fake.sendEvent("{\"v\":1,\"event\":\"chromium_died\",\"session\":\"" +
                     session + "\"}");
    check(waitStatus(f.ctlSock, "embedded: no"),
          "chromium_died clears embedded state");
    f.fake.clearOps();
    r = controlRoundTrip(f.ctlSock, "browser-embed 4242 0 152 800 348");
    check(r == "embedded: yes 0,152,800x348", "re-embed after death", r);
    ops = f.fake.ops();
    // The fake still held the old adoption (it never dropped it),
    // so the host's adopt hits "already adopted" and recovers
    // with move + resize.
    check(ops.size() == 3 && ops[0] == "adopt" && ops[1] == "move" &&
              ops[2] == "resize",
          "re-embed after death recovers via move+resize",
          ops.size() == 3 ? ops[0] + "," + ops[1] + "," + ops[2]
                          : "wrong op count");

    // Release verb.
    r = controlRoundTrip(f.ctlSock, "browser-release");
    check(r == "ok released", "browser-release releases", r);
    check(controlRoundTrip(f.ctlSock, "browser-embedded-status") ==
              "embedded: no",
          "status is no after release");
    r = controlRoundTrip(f.ctlSock, "browser-release");
    check(r == "ok not-embedded", "second release is a no-op", r);
    srv->stop();
  }

  // 4. Already-adopted recovery from a clean host state.
  {
    Fixture f;
    f.fake.forceAdopted(session, 4242, ContentRect{0, 152, 800, 348});
    auto srv = makeServer(f, session);
    std::string r = controlRoundTrip(
        f.ctlSock, "browser-embed 4242 0 152 800 348");
    check(r == "embedded: yes 0,152,800x348",
          "already-adopted record is recovered", r);
    std::vector<std::string> ops = f.fake.ops();
    check(ops.size() == 3 && ops[0] == "adopt" && ops[1] == "move" &&
              ops[2] == "resize",
          "recovery is adopt (refused) + move + resize",
          ops.size() == 3 ? ops[0] + "," + ops[1] + "," + ops[2]
                          : "wrong op count");
    srv->stop();
  }

  // 5. Compositor down: fast failure, no hang; disconnect clears.
  {
    Fixture f;
    auto srv = makeServer(f, session);
    std::string r = controlRoundTrip(
        f.ctlSock, "browser-embed 4242 0 152 800 348");
    check(r == "embedded: yes 0,152,800x348", "embed before drop", r);
    f.fake.dropConnection();
    check(waitStatus(f.ctlSock, "embedded: no"),
          "dropped bridge connection clears embedded state");
    srv->stop();
  }
  {
    // No compositor socket at all.
    std::string dir = tmpDir();
    std::string ctlSock = dir + "/runtime.sock";
    auto srv = std::make_unique<RuntimeControlServer>(
        "browser", ctlSock, session, dir + "/no-such-compositor.sock");
    check(srv->start(), "control server starts without a compositor");
    auto start = std::chrono::steady_clock::now();
    std::string r = controlRoundTrip(ctlSock, "browser-embed 4242 0 152 800 348");
    auto took = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - start)
                    .count();
    check(r == "error: compositor unavailable",
          "embed without a compositor fails fast", r);
    check(took < 2000, "no-compositor embed fails in under 2 s",
          std::to_string(took) + " ms");
    check(controlRoundTrip(ctlSock, "browser-embedded-status") ==
              "embedded: no",
          "status is no without a compositor");
    srv->stop();
  }

  // 6. Bad arguments + unknown verbs are errors, never a hang.
  {
    Fixture f;
    auto srv = makeServer(f, session);
    check(controlRoundTrip(f.ctlSock, "browser-embed 0 0 152 800 348")
              .rfind("error:", 0) == 0,
          "pid 0 is an error");
    check(controlRoundTrip(f.ctlSock, "browser-embed 4242 0 152 0 348")
              .rfind("error:", 0) == 0,
          "zero width is an error");
    check(controlRoundTrip(f.ctlSock, "browser-embed 4242 x y w h")
              .rfind("error:", 0) == 0,
          "non-integer args are an error");
    check(controlRoundTrip(f.ctlSock, "browser-embed 4242 0 152 800")
              .rfind("error:", 0) == 0,
          "short embed line is an error");
    check(controlRoundTrip(f.ctlSock, "bogus-verb").rfind("error:", 0) == 0,
          "unknown verb is an error");
    check(controlRoundTrip(f.ctlSock, "browser-embed 9999 0 152 800 348") ==
              "error: dead chromium pid",
          "dead chromium pid surfaces the compositor error");
    srv->stop();
  }

  // 7. Direct bridge client: ping + malformed line handling.
  {
    Fixture f;
    {
      // The bridge holds the fake's single connection while
      // alive, so scope it: the raw client below can only be
      // accepted once the bridge has disconnected.
      CompositorBridge bridge(f.compSock);
      std::string error;
      check(bridge.ping(error), "bridge ping", error);
    }
    // A raw garbage line gets a malformed reply (the fake's
    // behaviour mirrors runtime_bridge.rs).
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    assert(fd >= 0);
    timeval tv{};
    tv.tv_sec = 5;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", f.compSock.c_str());
    assert(connect(fd, (sockaddr*)&addr, sizeof(addr)) == 0);
    const char* garbage = "not json\n";
    (void)!write(fd, garbage, strlen(garbage));
    char buf[512];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    check(n > 0 && std::string(buf, n).find("malformed request") !=
                       std::string::npos,
          "garbage line gets a malformed reply");
    close(fd);
  }

  if (failures == 0) {
    printf("STAGE5-BRIDGE-TEST all checks passed\n");
    return 0;
  }
  printf("STAGE5-BRIDGE-TEST %d failure(s)\n", failures);
  return 1;
}
