// SevynOS v2 Stage 5 — compositor bridge client (see
// compositor-bridge.cc).
//
// The RN host is the ONLY process that talks to the Genesis
// compositor: the Browser app and the `sevyn` CLI go through the
// host's Runtime control socket (runtime-control.h), never to the
// compositor directly. This client speaks bridge v1
// (newline-delimited JSON over
// $XDG_RUNTIME_DIR/sevyn-compositor.sock, ops ping/close/adopt/move/
// resize/release, SO_PEERCRED auth on the compositor side) as
// documented in Genesis compositor/src/runtime_bridge.rs and
// adoption.rs.
//
// One persistent connection, one reader thread: the compositor
// delivers the `chromium_died` event as an unsolicited line on the
// same connection, so a request/response client that only reads
// when it writes would miss it. The reader thread demuxes lines:
// replies (a line carrying `"op": "<op>"`) wake the op that is
// waiting for them; event lines (a line carrying `"event": ...`)
// go straight to the event handler. Ops that never get a reply
// time out after kReplyTimeoutMs and drop the connection, so a
// dead compositor fails an embed fast instead of hanging the
// host's control socket (and the CLI behind it).
//
// No Hermes/JS dependency: the unit test (test-compositor-bridge.cc)
// drives this class against a fake compositor with no host binary.
#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace sevyn {

// A content rect in Browser-window-local coordinates — the same
// shape the bridge sends in adopt/move/resize (adoption.rs
// ContentRect) and the control socket receives in browser-embed.
struct ContentRect {
  int x = 0;
  int y = 0;
  int w = 0;
  int h = 0;
  bool sameSizeAs(const ContentRect& o) const { return w == o.w && h == o.h; }
  bool operator==(const ContentRect& o) const {
    return x == o.x && y == o.y && w == o.w && h == o.h;
  }
  std::string str() const;
};

class CompositorBridge {
 public:
  // Called (on the reader thread, never holding the inbox lock)
  // for each unsolicited event line, e.g.
  // {"v":1,"event":"chromium_died","session":"runtime:123"}.
  using EventHandler = std::function<void(const std::string& line)>;
  // Called (on the reader thread) when the connection drops: the
  // compositor is gone, so any adoption it recorded is gone with
  // it and the caller must clear its adopted state.
  using DisconnectHandler = std::function<void()>;

  // socketPath: the bridge socket. Empty = defaultSocketPath().
  explicit CompositorBridge(std::string socketPath = "");
  ~CompositorBridge();

  CompositorBridge(const CompositorBridge&) = delete;
  CompositorBridge& operator=(const CompositorBridge&) = delete;

  void setEventHandler(EventHandler h) { eventHandler_ = std::move(h); }
  void setDisconnectHandler(DisconnectHandler h) {
    disconnectHandler_ = std::move(h);
  }

  // The bridge socket path: $SEVYN_COMPOSITOR_SOCK when set (the
  // test affordance — the same env-override shape the CLI uses for
  // its daemon sockets), else
  // $XDG_RUNTIME_DIR/sevyn-compositor.sock, else
  // /run/sevyn-compositor.sock.
  static std::string defaultSocketPath();

  bool connected() const {
    return fd_.load() >= 0;
  }

  // One bridge op each. True on {"ok":true}; false fills `error`
  // with "compositor unavailable" (no socket / connect failed),
  // "compositor timeout" (no reply in time), or the compositor's
  // own error string ("unknown session", "already adopted",
  // "dead chromium pid", "rect outside browser window",
  // "runtime disconnected", "malformed request").
  bool ping(std::string& error);
  bool adopt(const std::string& session, int chromiumPid,
             const ContentRect& rect, std::string& error);
  bool moveAdoption(const std::string& session, const ContentRect& rect,
                    std::string& error);
  bool resizeAdoption(const std::string& session, const ContentRect& rect,
                      std::string& error);
  bool releaseAdoption(const std::string& session, std::string& error);

  // Close the connection and stop the reader thread. Idempotent.
  void stop();

 private:
  // How long one op waits for its reply before giving up (and
  // dropping the connection). The compositor flushes its reply in
  // the same poll that handles the request, so a healthy round
  // trip is milliseconds; 3 s is a dead compositor, not a slow one.
  static constexpr int kReplyTimeoutMs = 3000;

  // Connect (and start the reader thread on first connect).
  // Returns false when the socket cannot be reached.
  bool ensureConnected();
  // Send one JSON line and wait for the reply line whose "op"
  // matches `op`. False on connect/timeout/write failure, with
  // `error` filled. The caller holds no lock.
  bool sendOp(const std::string& op, const std::string& json,
              std::string& error);
  // Reader thread: split the stream into lines; replies go to the
  // inbox (waking sendOp), events go to the event handler.
  void readLoop();
  // Drop the connection (called with inboxMutex_ held, or from
  // stop()). Wakes any waiting sendOp with an empty reply.
  void dropLocked();

  std::string socketPath_;
  EventHandler eventHandler_;
  DisconnectHandler disconnectHandler_;

  std::atomic<int> fd_{-1};
  std::thread reader_;
  bool readerStarted_ = false;
  bool stopping_ = false;
  std::mutex inboxMutex_;
  std::condition_variable inboxCv_;
  // The reply line for the op currently waiting, if one arrived.
  std::string pendingReply_;
  bool replyReady_ = false;
  // The op the current waiter is waiting for ("" = none).
  std::string waitingOp_;
};

} // namespace sevyn
