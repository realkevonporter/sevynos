// SevynOS v2 M2 — statusd subscriber for the RN host.
//
// Connects to sevyn-statusd, subscribes, and forwards STATUS broadcasts
// to the host on a background thread. Same line-buffering as the
// status-client fix: a STATUS line can arrive split across reads (or
// coalesced with the next one), so bytes accumulate into a line buffer
// and only complete lines are delivered.
#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace sevyn {

class StatusClient {
 public:
  // Called on the subscriber thread for each STATUS broadcast.
  using Handler = std::function<void(const std::string& key,
                                     const std::string& value)>;
  StatusClient();
  ~StatusClient();

  StatusClient(const StatusClient&) = delete;
  StatusClient& operator=(const StatusClient&) = delete;

  void setHandler(Handler h) { handler_ = h; }
  void start();
  void stop();

 private:
  void run();

  Handler handler_;
  std::thread thread_;
  std::atomic<bool> stopping_{false};
  // Connected socket, so stop() can wake the blocking read in run()
  // with shutdown() instead of joining until the next broadcast.
  std::atomic<int> fd_{-1};
};

} // namespace sevyn
