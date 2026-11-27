// SevynOS v2 Stage 5 — Runtime control socket (see
// runtime-control.cc).
//
// The per-app Unix socket the host listens on
// (/run/sevyn-runtime-<appid>.sock, following the daemon pattern:
// appd/audiod/camd/commsd/statusd all have their own sockets).
// The Browser app and the `sevyn` CLI reach the host through it;
// the host is the ONLY process that issues bridge ops to the
// compositor, so the app and the CLI never talk to the compositor
// directly.
//
// Protocol: one text line per request, one line per reply.
//   browser-embed <chromium-pid> <x> <y> <w> <h>
//       -> "embedded: yes <x>,<y>,<w>x<h>" or "error: <msg>"
//   browser-embedded-status
//       -> "embedded: yes <x>,<y>,<w>x<h>" or "embedded: no"
//   browser-release
//       -> "ok released" or "ok not-embedded"
//
// The adopted state lives here (mutex-guarded): the Runtime is
// the source of truth `browser status` reports. `browser-embed`
// is idempotent: adopt when nothing is adopted, `move` when the
// same size is re-reported (a window move / re-render), `resize`
// when the size changed. A first adoption also sends `resize`
// with the same rect right after `adopt`: Genesis sends no size
// in its initial toplevel configure (xdg_shell.rs new_toplevel
// configures Activated only), so without the resize Chromium
// would keep its launch size and merely be cropped to the rect —
// `resize` is the only bridge op that configures Chromium's
// surface to the content size (adoption.rs resize_adoption).
//
// On `chromium_died` (or a dropped bridge connection) the adopted
// state is cleared, so `browser status` reports `embedded: no`
// and the Browser app empties its content area on its next
// refresh. No Hermes/JS dependency: the unit test
// (test-compositor-bridge.cc) drives this class against a fake
// compositor with no host binary.
#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "compositor-bridge.h"

namespace sevyn {

class RuntimeControlServer {
 public:
  // appId: the host's app id ("browser" for the Browser window,
  // "shell" for the shell host). socketPath: the control socket;
  // empty = defaultSocketPath(appId). sessionId: the bridge
  // session, "runtime:<host-pid>". compositorSockPath: the bridge
  // socket; empty = the bridge default (the test passes a fake).
  RuntimeControlServer(std::string appId, std::string socketPath,
                       std::string sessionId,
                       std::string compositorSockPath = "");
  ~RuntimeControlServer();

  RuntimeControlServer(const RuntimeControlServer&) = delete;
  RuntimeControlServer& operator=(const RuntimeControlServer&) = delete;

  // The control socket path: $SEVYN_RUNTIME_SOCK when set (the
  // test affordance — the same env-override shape the CLI uses
  // for its daemon sockets), else
  // $SEVYN_RUNTIME_SOCK_DIR/sevyn-runtime-<appid>.sock, else
  // /run/sevyn-runtime-<appid>.sock.
  static std::string defaultSocketPath(const std::string& appId);

  // Bind + listen and start the accept thread. False when the
  // socket cannot be bound (logged, never fatal to the host: an
  // embed then fails with a clear error instead of the host
  // refusing to start). Idempotent.
  bool start();
  // Stop the accept thread and release any adoption (best effort:
  // the Browser window is going away, so the compositor drops
  // the record with it anyway). Idempotent.
  void stop();
  bool listening() const { return listening_; }

  // The current adopted state as one status line ("embedded: yes
  // <x>,<y>,<w>x<h>" / "embedded: no"). Thread-safe.
  std::string embeddedStatus();

 private:
  // Idempotent embed, called with stateMutex_ held by handleLine
  // (the accept thread handles one connection at a time, so ops
  // are serialised and the bridge's single-slot waiter is safe).
  // Fills `reply` with the "embedded: ..." / "error: ..." line.
  void embedLocked(int chromiumPid, const ContentRect& rect,
                   std::string& reply);
  // One adopt attempt, including the configure resize. True when
  // the adoption is live AND Chromium's surface is the rect size.
  bool adoptAndConfigureLocked(int chromiumPid, const ContentRect& rect,
                               std::string& error);
  // Release the live adoption, if any. Best effort; clears the
  // state either way (a failed release leaves a record the
  // compositor drops when the Browser surface goes away).
  void releaseLocked();
  // One control-socket request line -> its reply line.
  std::string handleLine(const std::string& line);
  // Accept thread: one connection at a time, lines until EOF.
  void acceptLoop();
  // Bridge event callback (reader thread): chromium_died clears
  // the adopted state. Bridge disconnect callback: the compositor
  // is gone, so the adoption is gone with it.
  void onBridgeEvent(const std::string& line);
  void onBridgeDisconnected();

  std::string appId_;
  std::string socketPath_;
  std::string sessionId_;
  std::unique_ptr<CompositorBridge> bridge_;

  std::atomic<int> listenFd_{-1};
  std::thread acceptThread_;
  std::atomic<bool> stopping_{false};
  bool listening_ = false;

  std::mutex stateMutex_;
  bool embedded_ = false;
  ContentRect rect_;
  int chromiumPid_ = 0;
};

} // namespace sevyn
