// SevynOS v2 M3 — appd client for the RN host (see appclient.cc).
//
// The shell host talks to sevyn-appd over /run/sevyn-apps.sock:
//   - listApps()/launchApp() open a short-lived connection, send one
//     command, read the reply (retried briefly: appd starts before
//     Weston but the shell must not fail hard if it is a moment late).
//   - start() opens a persistent SUBSCRIBE connection on a background
//     thread and queues EVENT lines for the host's main loop to drain
//     into JS (Sevyn.onAppEvent). Same shape as StatusClient.
#pragma once

#include <atomic>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

namespace sevyn {

struct AppInfo {
  std::string id;
  std::string name;
  std::string version;
  std::string color;
  std::string glyph;
  bool system = false;
  bool protected_ = false;
  std::vector<std::string> permissions;
};

class AppClient {
 public:
  // Called on the subscriber thread for each EVENT line (raw, e.g.
  // "EVENT LAUNCHED files"). The host queues it for its main loop.
  using EventHandler = std::function<void(const std::string& line)>;

  AppClient();
  ~AppClient();

  AppClient(const AppClient&) = delete;
  AppClient& operator=(const AppClient&) = delete;

  void setEventHandler(EventHandler h) { eventHandler_ = h; }
  void start();
  void stop();

  // Synchronous one-shot commands (each opens its own connection).
  // listApps retries for up to ~5s; launchApp for up to ~2s.
  std::vector<AppInfo> listApps();
  bool launchApp(const std::string& id);

 private:
  void run();
  // One command round-trip on a fresh connection. Returns the reply
  // lines (without trailing newlines); empty on failure.
  std::vector<std::string> command(const std::vector<std::string>& lines,
                                   int retries, int retryMs);

  EventHandler eventHandler_;
  std::thread thread_;
  std::atomic<bool> stopping_{false};
  // Connected socket, so stop() can wake the blocking read in run()
  // with shutdown() instead of joining until the next event.
  std::atomic<int> fd_{-1};
};

} // namespace sevyn
